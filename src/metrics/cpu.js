/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * CPU utilisation from /proc/stat.
 *
 * gi://GLib only, via procfs.js. See that file for why.
 */

import {readLines} from './procfs.js';
import {formatPercent} from './units.js';

const STAT_PATH = '/proc/stat';

/**
 * Parses one "cpu" or "cpuN" line from /proc/stat into busy and idle totals.
 *
 * Fields are: user nice system idle iowait irq softirq steal guest guest_nice.
 * guest and guest_nice are deliberately excluded: the kernel already counts
 * them inside user and nice, so adding them again inflates the total and makes
 * utilisation read low. Trailing fields are optional because older kernels
 * published fewer of them.
 *
 * @param {string} line - a single line from /proc/stat
 * @returns {{idle: number, total: number}|null} counters, or null if unparseable
 */
export function parseCpuLine(line) {
    if (typeof line !== 'string')
        return null;

    const parts = line.trim().split(/\s+/);

    // Label plus at least user, nice, system and idle.
    if (parts.length < 5 || !parts[0].startsWith('cpu'))
        return null;

    const required = [];
    for (let i = 1; i <= 4; i++) {
        const value = Number.parseInt(parts[i], 10);
        if (!Number.isFinite(value) || value < 0)
            return null;
        required.push(value);
    }

    const optional = index => {
        const value = Number.parseInt(parts[index], 10);
        return Number.isFinite(value) && value >= 0 ? value : 0;
    };

    const [user, nice, system, idle] = required;
    const iowait = optional(5);
    const irq = optional(6);
    const softirq = optional(7);
    const steal = optional(8);

    // Time spent waiting on IO is idle time as far as the CPU is concerned.
    const idleAll = idle + iowait;
    const busy = user + nice + system + irq + softirq + steal;

    return {idle: idleAll, total: idleAll + busy};
}

/**
 * Parses the aggregate CPU line.
 *
 * The kernel always writes the aggregate first, so only the first line is
 * examined. The file is read in full either way, since that is how
 * GLib.file_get_contents works; what this avoids is parsing one line per core
 * on every tick when the panel only ever shows the aggregate.
 *
 * @param {string[]} lines - lines of /proc/stat
 * @returns {{idle: number, total: number}|null} counters, or null if unparseable
 */
export function parseAggregate(lines) {
    if (!Array.isArray(lines) || lines.length === 0)
        return null;

    // "cpu " with the trailing space, so this cannot match "cpu0".
    if (!lines[0].startsWith('cpu '))
        return null;

    return parseCpuLine(lines[0]);
}

/**
 * Parses the per-core lines. Only needed when the dropdown is open.
 *
 * @param {string[]} lines - lines of /proc/stat
 * @returns {Array<{idle: number, total: number}>} one entry per core, in order
 */
export function parsePerCore(lines) {
    if (!Array.isArray(lines))
        return [];

    const cores = [];
    for (const line of lines) {
        // Per-core lines are contiguous and start at index 1. Anything else
        // means we have run past them into intr, ctxt and the rest.
        if (!/^cpu\d/.test(line)) {
            if (cores.length > 0)
                break;

            continue;
        }

        const parsed = parseCpuLine(line);
        if (parsed !== null)
            cores.push(parsed);
    }

    return cores;
}

/**
 * Turns two counter readings into a utilisation percentage.
 *
 * Returns null rather than a number in three cases, all of which mean "we
 * cannot know yet" rather than "zero":
 *
 *   - no previous sample, which is every first tick after enable
 *   - the counters went backwards, which happens across a suspend or a
 *     namespace change
 *   - no time passed between samples, so the ratio would divide by zero
 *
 * Callers render null as a placeholder. Rendering it as 0 would show an idle
 * CPU during the first two seconds after every login, which is wrong.
 *
 * @param {{idle: number, total: number}|null} prev - earlier reading
 * @param {{idle: number, total: number}|null} curr - later reading
 * @returns {number|null} percentage from 0 to 100, or null if not computable
 */
export function usageBetween(prev, curr) {
    if (prev === null || curr === null || prev === undefined || curr === undefined)
        return null;

    const totalDelta = curr.total - prev.total;
    const idleDelta = curr.idle - prev.idle;

    if (totalDelta <= 0 || idleDelta < 0)
        return null;

    const busyDelta = totalDelta - idleDelta;
    const percent = (busyDelta / totalDelta) * 100;

    // Clamp rather than trust the arithmetic: counters are read non-atomically
    // and can produce a busy delta a hair above the total.
    return Math.min(100, Math.max(0, percent));
}

/**
 * CPU metric provider.
 *
 * Holds the previous counter reading, which is the only state it needs. That
 * state is discarded by reset(), called when polling stops, so resuming after a
 * lock or a suspend recomputes from a fresh baseline instead of reporting a
 * spike covering the whole gap.
 */
export class CpuProvider {
    constructor() {
        this._previous = null;

        // Per-core baselines, held separately because per-core lines are only
        // parsed while the dropdown is open. Keeping them out of sample() is
        // what stops eight extra lines being parsed every tick forever to
        // serve a menu nobody has opened.
        this._previousCores = [];
    }

    /** @returns {string} stable identifier used in settings keys */
    get id() {
        return 'cpu';
    }

    /**
     * Short form for the panel, where width is scarce.
     *
     * @returns {string} abbreviated name
     */
    get label() {
        return 'CPU';
    }

    /**
     * Full form for the preferences window, where there is room and clarity
     * matters more than width.
     *
     * @returns {string} human readable name
     */
    get name() {
        return 'Processor';
    }

    /**
     * Logical icon name, resolved to a real icon by the UI layer. Bundled
     * rather than themed: Adwaita has no processor icon, and the one that looks
     * right on this machine is Ubuntu's Yaru theme, which most users lack.
     *
     * @returns {string} symbolic icon name
     */
    get iconName() {
        return 'system-monitor-cpu-symbolic';
    }

    /**
     * @returns {boolean} true if /proc/stat is readable and parseable
     */
    isAvailable() {
        return parseAggregate(readLines(STAT_PATH)) !== null;
    }

    /**
     * Takes a reading.
     *
     * @returns {{percent: number|null}} utilisation, null until the second tick
     */
    sample() {
        const current = parseAggregate(readLines(STAT_PATH));
        const percent = usageBetween(this._previous, current);

        this._previous = current;

        return {percent};
    }

    /**
     * Formats a sample for the panel.
     *
     * @param {{percent: number|null}} sample - reading from sample()
     * @param {object} [options] - formatting options
     * @param {boolean} [options.showPercentSign] - append a percent sign
     * @returns {string} display text
     */
    format(sample, options = {}) {
        const {showPercentSign = true} = options;

        if (!sample || sample.percent === null)
            return showPercentSign ? '--%' : '--';

        const rounded = Math.round(sample.percent);
        return showPercentSign ? `${rounded}%` : `${rounded}`;
    }

    /**
     * Fill level for a ring, bar or dot.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {number|null} 0 to 1, or null if not known
     */
    fraction(sample) {
        return sample?.percent === null || sample?.percent === undefined
            ? null
            : sample.percent / 100;
    }

    /**
     * Raw value for a self-scaling sparkline.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {number|null} the percentage, or null if not known
     */
    magnitude(sample) {
        return sample?.percent ?? null;
    }

    /**
     * Drops the baseline so the next sample starts fresh.
     */
    /**
     * Per-core utilisation, for the dropdown.
     *
     * Reads /proc/stat a second time rather than having sample() carry the
     * per-core lines around. That costs one extra read per tick, but only while
     * the menu is actually open, which is the cheaper trade for a file this
     * small.
     *
     * @returns {Array<{label: string, text: string, fraction: number|null}>} one row per core
     */
    detail() {
        const cores = parsePerCore(readLines(STAT_PATH));

        const rows = cores.map((core, index) => {
            const percent = usageBetween(this._previousCores[index] ?? null, core);

            return {
                label: `Core ${index}`,
                text: formatPercent(percent),
                fraction: percent === null ? null : percent / 100,
            };
        });

        this._previousCores = cores;

        return rows;
    }

    /**
     * Drops only the per-core baselines.
     *
     * Called when the dropdown closes. The aggregate baseline is deliberately
     * left alone: the panel is still running and would otherwise show a
     * placeholder for a tick every time the menu was dismissed.
     */
    resetDetail() {
        this._previousCores = [];
    }

    reset() {
        this._previous = null;
        this._previousCores = [];
    }
}
