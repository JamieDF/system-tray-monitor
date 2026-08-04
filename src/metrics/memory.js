/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Memory and swap usage from /proc/meminfo.
 *
 * gi://GLib only, via procfs.js. See that file for why.
 */

import {readLines} from './procfs.js';
import {formatGibibytes, kibToBytes} from './units.js';

const MEMINFO_PATH = '/proc/meminfo';

// Only these four lines are of interest. /proc/meminfo has around 58 of them.
const WANTED = new Set(['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']);

/**
 * Parses the fields we care about out of /proc/meminfo.
 *
 * Every value in that file is in kibibytes despite the "kB" suffix, which is a
 * long-standing kernel misnomer. Values are converted to bytes here so nothing
 * downstream has to remember it.
 *
 * @param {string[]} lines - lines of /proc/meminfo
 * @returns {{memTotal: number, memAvailable: number, swapTotal: number, swapFree: number}|null}
 *   byte counts, or null if the required fields were missing
 */
export function parseMeminfo(lines) {
    if (!Array.isArray(lines))
        return null;

    const found = new Map();

    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;

        const key = line.slice(0, colon);
        if (!WANTED.has(key))
            continue;

        const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
        if (Number.isFinite(value) && value >= 0)
            found.set(key, kibToBytes(value));

        if (found.size === WANTED.size)
            break;
    }

    // MemTotal and MemAvailable are the two we cannot work without. Swap fields
    // are absent on systems with no swap configured, which is legitimate.
    if (!found.has('MemTotal') || !found.has('MemAvailable'))
        return null;

    return {
        memTotal: found.get('MemTotal'),
        memAvailable: found.get('MemAvailable'),
        swapTotal: found.get('SwapTotal') ?? 0,
        swapFree: found.get('SwapFree') ?? 0,
    };
}

/**
 * Derives used memory from a parsed meminfo reading.
 *
 * Used is MemTotal minus MemAvailable, not MemTotal minus MemFree. MemFree
 * excludes reclaimable page cache, so using it reports almost all memory as
 * used on any machine that has been running a while, which is the single most
 * common way system monitors mislead people.
 *
 * @param {{memTotal: number, memAvailable: number, swapTotal: number, swapFree: number}|null} parsed
 *   output of parseMeminfo
 * @returns {{usedBytes: number, totalBytes: number, percent: number,
 *            swapUsedBytes: number, swapTotalBytes: number}|null} derived values
 */
export function deriveUsage(parsed) {
    if (parsed === null || parsed === undefined)
        return null;

    const {memTotal, memAvailable, swapTotal, swapFree} = parsed;

    if (!Number.isFinite(memTotal) || memTotal <= 0)
        return null;

    // MemAvailable is an estimate and can, rarely, exceed MemTotal.
    const available = Math.min(Math.max(memAvailable, 0), memTotal);
    const usedBytes = memTotal - available;

    return {
        usedBytes,
        totalBytes: memTotal,
        percent: (usedBytes / memTotal) * 100,
        swapUsedBytes: Math.max(swapTotal - swapFree, 0),
        swapTotalBytes: swapTotal,
    };
}

/**
 * Memory metric provider.
 *
 * Stateless: /proc/meminfo reports levels rather than cumulative counters, so
 * unlike CPU there is no previous reading to hold and no first-tick gap.
 */
export class MemoryProvider {
    /** @returns {string} stable identifier used in settings keys */
    get id() {
        return 'memory';
    }

    /**
     * Short form for the panel, where width is scarce.
     *
     * @returns {string} abbreviated name
     */
    get label() {
        return 'RAM';
    }

    /**
     * Full form for the preferences window, where there is room and clarity
     * matters more than width.
     *
     * @returns {string} human readable name
     */
    get name() {
        return 'Memory';
    }

    /**
     * Logical icon name, resolved to a real icon by the UI layer. Bundled
     * because Adwaita's nearest match is a solid state drive, which reads as
     * storage rather than memory.
     *
     * @returns {string} symbolic icon name
     */
    get iconName() {
        return 'system-monitor-memory-symbolic';
    }

    /**
     * @returns {boolean} true if /proc/meminfo is readable and parseable
     */
    isAvailable() {
        return parseMeminfo(readLines(MEMINFO_PATH)) !== null;
    }

    /**
     * Takes a reading.
     *
     * @returns {{usedBytes: number, totalBytes: number, percent: number,
     *            swapUsedBytes: number, swapTotalBytes: number}|null} current usage
     */
    sample() {
        return deriveUsage(parseMeminfo(readLines(MEMINFO_PATH)));
    }

    /**
     * Formats a sample for the panel.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {string} display text, always carrying an explicit GiB unit
     */
    format(sample) {
        if (!sample)
            return formatGibibytes(null);

        return formatGibibytes(sample.usedBytes);
    }

    /**
     * Fill level for a ring, bar or dot.
     *
     * Memory is the metric a ring suits best: it is a fraction of a known
     * total, which is exactly what a ring represents.
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
     * Used and swap, for the dropdown.
     *
     * Swap is omitted entirely when none is configured, rather than shown as a
     * permanent 0B row. A machine with no swap has nothing to report there.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {Array<{label: string, text: string, fraction: number|null}>} detail rows
     */
    detail(sample) {
        if (!sample)
            return [];

        const rows = [{
            label: 'Used',
            text: `${formatGibibytes(sample.usedBytes)} of ${formatGibibytes(sample.totalBytes)}`,
            fraction: sample.percent / 100,
        }];

        if (sample.swapTotalBytes > 0) {
            rows.push({
                label: 'Swap',
                text: `${formatGibibytes(sample.swapUsedBytes)} of ${formatGibibytes(sample.swapTotalBytes)}`,
                fraction: sample.swapUsedBytes / sample.swapTotalBytes,
            });
        }

        return rows;
    }

    /**
     * No state to drop, present so every provider has the same shape.
     */
    reset() {
    }
}
