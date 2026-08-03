/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Shared value formatting.
 *
 * Pure functions with no imports at all, so they are trivially testable and can
 * be used from both the metrics layer and the renderers.
 */

/**
 * Bytes in a gibibyte, 2^30.
 *
 * Memory is reported in binary multiples and labelled GiB, so the arithmetic
 * and the label agree. Since IEC 80000-13, GB means 10^9 and GiB means 2^30;
 * writing "GB" over a binary figure is the one combination that is plainly
 * wrong, and it is also the most common.
 *
 * Two reasons this is the right unit for memory specifically:
 *
 *   - RAM is physically addressed in powers of two, so binary units describe
 *     real hardware. A DIMM is 16 GiB. The same part expressed decimally is
 *     17.18 GB, a number that matches no product anyone sells.
 *   - It agrees with `free -h`, `htop` and GNOME System Monitor, which all
 *     default to binary. Cross-checking our output against them works.
 *
 * Worth knowing before anyone "fixes" this: the total will read lower than the
 * capacity printed on the machine. That gap is firmware, not arithmetic. On an
 * AMD APU the integrated GPU carves its frame buffer out of system RAM before
 * the kernel boots, so a 16 GiB laptop reports about 14.7 GiB of usable memory.
 * Windows shows the same shortfall and words it "16.0 GB (14.7 GB usable)".
 *
 * Storage and network rates do not follow this. Both are conventionally
 * decimal, since neither has a power-of-two constraint.
 */
const BYTES_PER_GIB = 1024 * 1024 * 1024;

/** Placeholder shown when a value is not yet known. */
export const UNKNOWN = '--';

/**
 * Formats a byte count as gibibytes.
 *
 * The unit is always written out. A bare "G" is ambiguous between the two
 * conventions and reads as sloppy in a panel.
 *
 * @param {number|null} bytes - value to format
 * @param {object} [options] - formatting options
 * @param {number} [options.decimals] - digits after the point, default 1
 * @param {boolean} [options.withUnit] - append the unit, default true
 * @returns {string} formatted value, or a placeholder if the input is unknown
 */
export function formatGibibytes(bytes, options = {}) {
    const {decimals = 1, withUnit = true} = options;

    if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
        return withUnit ? `${UNKNOWN}GiB` : UNKNOWN;

    const value = (bytes / BYTES_PER_GIB).toFixed(decimals);
    return withUnit ? `${value}GiB` : `${value}`;
}

/**
 * Formats a percentage.
 *
 * @param {number|null} percent - value from 0 to 100
 * @param {object} [options] - formatting options
 * @param {boolean} [options.withSign] - append a percent sign, default true
 * @returns {string} formatted value, or a placeholder if the input is unknown
 */
export function formatPercent(percent, options = {}) {
    const {withSign = true} = options;

    if (percent === null || percent === undefined || !Number.isFinite(percent))
        return withSign ? `${UNKNOWN}%` : UNKNOWN;

    const rounded = Math.round(percent);
    return withSign ? `${rounded}%` : `${rounded}`;
}

/**
 * Converts kibibytes, the unit /proc/meminfo uses, to bytes.
 *
 * @param {number|null} kib - value in kibibytes
 * @returns {number|null} value in bytes, or null if the input was null
 */
export function kibToBytes(kib) {
    if (kib === null || kib === undefined || !Number.isFinite(kib))
        return null;

    return kib * 1024;
}

/*
 * Throughput uses decimal steps of 1000, unlike memory.
 *
 * This is not an inconsistency. Network hardware and ISPs are rated decimally,
 * so a link that negotiates 100 Mb/s means 100,000,000 bits, and storage
 * throughput follows the same convention. Memory is binary because RAM is
 * physically addressed in powers of two. The units differ because the things
 * being measured differ.
 */
const RATE_STEP = 1000;
const BYTE_UNITS = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
const BIT_UNITS = ['b/s', 'kb/s', 'Mb/s', 'Gb/s'];

/**
 * Formats a throughput figure, scaling to a sensible unit.
 *
 * @param {number|null} bytesPerSecond - rate to format
 * @param {object} [options] - formatting options
 * @param {boolean} [options.asBits] - report bits rather than bytes
 * @returns {string} formatted rate, or a placeholder if the input is unknown
 */
export function formatRate(bytesPerSecond, options = {}) {
    const {asBits = false} = options;
    const units = asBits ? BIT_UNITS : BYTE_UNITS;

    if (bytesPerSecond === null || bytesPerSecond === undefined ||
        !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return `${UNKNOWN}${units[1]}`;

    let value = asBits ? bytesPerSecond * 8 : bytesPerSecond;
    let index = 0;

    while (value >= RATE_STEP && index < units.length - 1) {
        value /= RATE_STEP;
        index++;
    }

    // Below a megabyte the fractional part is noise, and it costs panel width
    // that has to be reserved permanently.
    const decimals = index >= 2 ? 1 : 0;

    return `${value.toFixed(decimals)}${units[index]}`;
}

/**
 * Formats a temperature.
 *
 * @param {number|null} celsius - temperature in degrees Celsius
 * @param {object} [options] - formatting options
 * @param {string} [options.unit] - "celsius" or "fahrenheit"
 * @returns {string} formatted temperature, or a placeholder if unknown
 */
export function formatTemperature(celsius, options = {}) {
    const {unit = 'celsius'} = options;
    const suffix = unit === 'fahrenheit' ? '°F' : '°C';

    if (celsius === null || celsius === undefined || !Number.isFinite(celsius))
        return `${UNKNOWN}${suffix}`;

    const value = unit === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius;

    return `${Math.round(value)}${suffix}`;
}
