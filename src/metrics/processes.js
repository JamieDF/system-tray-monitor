/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A compact top-N of userspace processes, ranked by CPU share.
 *
 * This is dropdown-only on purpose. Walking /proc for every pid is cheap
 * enough while a menu is open and far too much work to do on the panel's
 * timer, where nobody is looking. The same gating as per-core CPU: the
 * table is asked for rows only while the dropdown is visible, and its
 * baselines are dropped when it closes so the next open does not report
 * the whole closed period as one spike.
 *
 * gi://GLib only, via procfs.js. See that file for why.
 */

import GLib from 'gi://GLib';

import {parseAggregate} from './cpu.js';
import {listDir, readFile, readLines} from './procfs.js';
import {formatPercent} from './units.js';

const PROC_ROOT = '/proc';

/** linux/sched.h: PF_KTHREAD. Kernel workers are noise in a five-row menu. */
export const PF_KTHREAD = 0x00200000;

/**
 * True when a /proc entry name is a process directory.
 *
 * @param {string} name - a directory entry under /proc
 * @returns {boolean} true if the name is a pid
 */
export function isPidEntry(name) {
    return typeof name === 'string' && /^\d+$/.test(name);
}

/**
 * Parses one /proc/[pid]/stat line.
 *
 * comm sits between the first '(' and the last ')', because a thread name
 * can contain spaces and parentheses. Using split-on-space here would
 * shift every field after a name like "Web Content" and silently read
 * the state letter as the CPU counters.
 *
 * @param {string|null} text - contents of a stat file
 * @returns {{pid: number, comm: string, flags: number, ticks: number}|null}
 *     parsed fields, or null if unparseable
 */
export function parsePidStat(text) {
    if (typeof text !== 'string')
        return null;

    const line = text.trim();
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');

    if (open < 1 || close <= open)
        return null;

    const pid = Number.parseInt(line.slice(0, open).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0)
        return null;

    const comm = line.slice(open + 1, close);
    if (comm.length === 0)
        return null;

    // After comm: state ppid pgrp session tty tpgid flags minflt cminflt
    // majflt cmajflt utime stime. flags is rest[6], utime rest[11],
    // stime rest[12]. cutime and cstime are deliberately left out: those
    // are the children, who appear as their own rows, so adding them here
    // would count the same work twice.
    const rest = line.slice(close + 1).trim().split(/\s+/);
    if (rest.length < 13)
        return null;

    const flags = Number.parseInt(rest[6], 10);
    const utime = Number.parseInt(rest[11], 10);
    const stime = Number.parseInt(rest[12], 10);

    if (![flags, utime, stime].every(n => Number.isFinite(n) && n >= 0))
        return null;

    return {pid, comm, flags, ticks: utime + stime};
}

/**
 * @param {number} flags - the flags field from /proc/[pid]/stat
 * @returns {boolean} true if this is a kernel thread
 */
export function isKernelThread(flags) {
    return (flags & PF_KTHREAD) !== 0;
}

/**
 * A process's share of all CPU time between two readings.
 *
 * The divisor is the aggregate /proc/stat total, so the figures use the
 * same units as the panel: a process pegging one core on an eight-core
 * machine reads about 12.5 percent, not 100. Returning null rather than
 * zero covers the same "we cannot know yet" cases as usageBetween.
 *
 * @param {number|null} prevTicks - earlier process utime+stime
 * @param {number|null} prevTotal - earlier aggregate CPU total
 * @param {number} currTicks - later process utime+stime
 * @param {number|null} currTotal - later aggregate CPU total
 * @returns {number|null} percentage from 0 to 100, or null if not computable
 */
export function cpuShare(prevTicks, prevTotal, currTicks, currTotal) {
    if (prevTicks === null || prevTicks === undefined ||
        prevTotal === null || prevTotal === undefined ||
        currTotal === null || currTotal === undefined)
        return null;

    if (!Number.isFinite(prevTicks) || !Number.isFinite(prevTotal) ||
        !Number.isFinite(currTicks) || !Number.isFinite(currTotal))
        return null;

    const tickDelta = currTicks - prevTicks;
    const totalDelta = currTotal - prevTotal;

    if (totalDelta <= 0 || tickDelta < 0)
        return null;

    return Math.min(100, Math.max(0, (tickDelta / totalDelta) * 100));
}

/**
 * @param {number} pid - candidate process
 * @param {number} selfPid - the process running this code
 * @returns {boolean} true if sending SIGTERM is a reasonable thing to offer
 */
export function canEnd(pid, selfPid) {
    return Number.isInteger(pid) && pid > 1 && pid !== selfPid;
}

/**
 * Highest CPU first. Unknown shares fall back to lifetime ticks so the
 * first paint after opening is still a top list, not pid order.
 *
 * @param {Array<{percent: number|null, ticks: number}>} processes - sampled rows
 * @param {number} limit - maximum rows to keep
 * @returns {Array} the first `limit` rows in display order
 */
export function pickTop(processes, limit) {
    if (!Array.isArray(processes) || limit <= 0)
        return [];

    const ranked = processes.slice();
    ranked.sort((a, b) => {
        if (a.percent === null && b.percent === null)
            return b.ticks - a.ticks;

        if (a.percent === null)
            return 1;

        if (b.percent === null)
            return -1;

        if (b.percent !== a.percent)
            return b.percent - a.percent;

        return b.ticks - a.ticks;
    });

    return ranked.slice(0, limit);
}

/**
 * Reads the pid of the process we are running in.
 *
 * /proc/self is a symlink to that pid. When this runs inside gnome-shell,
 * the result is the shell, which we must not offer to end.
 *
 * @param {string} [procRoot=/proc] - /proc root, injectable for tests
 * @returns {number} the pid, or 0 if it could not be read
 */
export function readSelfPid(procRoot = PROC_ROOT) {
    try {
        const pid = Number.parseInt(GLib.file_read_link(`${procRoot}/self`), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : 0;
    } catch {
        return 0;
    }
}

/**
 * Stateful reader that turns two ticks of /proc into ranked menu rows.
 *
 * The proc root is injectable so tests can point at a fixture rather than
 * the host's live /proc, which would otherwise make ranking machine-specific.
 */
export class ProcessTable {
    /**
     * @param {object} [options] - configuration
     * @param {string} [options.procRoot=/proc] - /proc to read
     * @param {number} [options.selfPid] - pid of the reader, detected if omitted
     */
    constructor(options = {}) {
        const {procRoot = PROC_ROOT, selfPid = readSelfPid(procRoot)} = options;

        this._procRoot = procRoot;
        this._selfPid = selfPid;
        this._previous = new Map();
        this._previousTotal = null;
        this._limit = 8;
    }

    /**
     * @param {number} limit - rows to keep, already clamped by settings
     */
    setLimit(limit) {
        if (!Number.isFinite(limit) || limit < 1)
            return;

        this._limit = limit;
    }

    /**
     * Samples /proc and returns the current top rows.
     *
     * Replaces the previous pid map wholesale rather than updating it in
     * place. A pid that has exited would otherwise sit in the map forever,
     * and a reused pid would inherit the dead process's counters.
     *
     * @param {object} [options] - formatting options
     * @param {boolean} [options.showPercentSign] - append a percent sign
     * @returns {Array<{pid: number, label: string, text: string, endable: boolean}>}
     */
    top(options = {}) {
        const {showPercentSign = true} = options;

        const aggregate = parseAggregate(readLines(`${this._procRoot}/stat`));
        const total = aggregate?.total ?? null;

        const processes = [];

        for (const name of listDir(this._procRoot)) {
            if (!isPidEntry(name))
                continue;

            const parsed = parsePidStat(readFile(`${this._procRoot}/${name}/stat`));
            if (parsed === null || isKernelThread(parsed.flags))
                continue;

            const previous = this._previous.get(parsed.pid);
            processes.push({
                pid: parsed.pid,
                comm: parsed.comm,
                ticks: parsed.ticks,
                percent: cpuShare(
                    previous?.ticks ?? null,
                    this._previousTotal,
                    parsed.ticks,
                    total),
            });
        }

        this._previous = new Map(processes.map(proc => [proc.pid, {ticks: proc.ticks}]));
        this._previousTotal = total;

        return pickTop(processes, this._limit).map(proc => ({
            pid: proc.pid,
            label: proc.comm,
            text: formatPercent(proc.percent, {withSign: showPercentSign}),
            endable: canEnd(proc.pid, this._selfPid),
        }));
    }

    /**
     * Drops baselines so the next top() starts fresh.
     *
     * Called when the dropdown closes. Without this, the first reading
     * after reopening would span the whole closed period.
     */
    reset() {
        this._previous = new Map();
        this._previousTotal = null;
    }
}
