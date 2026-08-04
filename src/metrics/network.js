/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Network throughput from /proc/net/dev.
 *
 * gi://GLib only, via procfs.js and rates.js. See procfs.js for why.
 */

import {readLines} from './procfs.js';
import {RateTracker} from './rates.js';
import {formatRate} from './units.js';

const NET_DEV_PATH = '/proc/net/dev';

/*
 * Interfaces excluded from the total.
 *
 * Kept deliberately short. Every exclusion is a case where the same bytes are
 * provably counted twice:
 *
 *   lo      loopback, so every local connection appears on it as well as
 *           nowhere else. Including it makes a local database or a container
 *           registry look like external traffic.
 *   veth    the container side of a virtual ethernet pair. The bytes also
 *           traverse the host interface, so counting both doubles them.
 *
 * Bridges (br0, virbr0) are deliberately NOT excluded, even though they can
 * double count on a bridged VM host. On such a machine the bridge may be the
 * only interface carrying traffic, so excluding it would report zero. Over
 * counting is the less harmful failure, and per-interface selection is the
 * proper fix rather than a longer guess list here.
 */
const VIRTUAL_PREFIXES = ['veth'];
const LOOPBACK = 'lo';

/**
 * Decides whether an interface should count toward the total.
 *
 * @param {string} name - interface name without the trailing colon
 * @returns {boolean} true if it represents traffic worth counting once
 */
export function isPhysicalInterface(name) {
    if (typeof name !== 'string' || name.length === 0)
        return false;

    // Exact match, not a prefix, so a real interface whose name merely starts
    // with those letters is not swallowed.
    if (name === LOOPBACK)
        return false;

    return !VIRTUAL_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * Parses /proc/net/dev into per-interface byte counters.
 *
 * The file opens with two header lines describing the column layout, which are
 * skipped. Each remaining line is an interface name, a colon, then eight
 * receive fields followed by eight transmit fields. The colon may or may not
 * have a space before it depending on name length, so the name is split off
 * rather than assumed to be a whitespace-delimited token.
 *
 * @param {string[]} lines - lines of /proc/net/dev
 * @returns {Map<string, {rxBytes: number, txBytes: number}>} counters by interface
 */
export function parseNetDev(lines) {
    const interfaces = new Map();

    if (!Array.isArray(lines))
        return interfaces;

    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;

        const name = line.slice(0, colon).trim();
        if (name.length === 0)
            continue;

        const fields = line.slice(colon + 1).trim().split(/\s+/);

        // Eight receive columns then eight transmit columns.
        if (fields.length < 16)
            continue;

        const rxBytes = Number.parseInt(fields[0], 10);
        const txBytes = Number.parseInt(fields[8], 10);

        if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes))
            continue;

        interfaces.set(name, {rxBytes, txBytes});
    }

    return interfaces;
}

/**
 * Sums the counters of every interface that counts as real.
 *
 * @param {Map<string, {rxBytes: number, txBytes: number}>} interfaces - parsed counters
 * @returns {{rxBytes: number, txBytes: number}} combined totals
 */
export function totalPhysical(interfaces) {
    let rxBytes = 0;
    let txBytes = 0;

    for (const [name, counters] of interfaces) {
        if (!isPhysicalInterface(name))
            continue;

        rxBytes += counters.rxBytes;
        txBytes += counters.txBytes;
    }

    return {rxBytes, txBytes};
}

/**
 * Network metric provider.
 *
 * Tracks receive and transmit separately so the dropdown can show both, while
 * the panel shows their sum.
 */
export class NetworkProvider {
    constructor() {
        this._rx = new RateTracker();
        this._tx = new RateTracker();
    }

    /** @returns {string} stable identifier used in settings keys */
    get id() {
        return 'network';
    }

    /**
     * Short form for the panel, where width is scarce.
     *
     * @returns {string} abbreviated name
     */
    get label() {
        return 'NET';
    }

    /**
     * Full form for the preferences window, where there is room and clarity
     * matters more than width.
     *
     * @returns {string} human readable name
     */
    get name() {
        return 'Network';
    }

    /**
     * Themed rather than bundled: Adwaita has a suitable icon for this one.
     *
     * @returns {string} symbolic icon name
     */
    get iconName() {
        return 'network-transmit-receive-symbolic';
    }

    /**
     * @returns {boolean} true if at least one real interface exists
     */
    isAvailable() {
        const lines = readLines(NET_DEV_PATH);
        if (lines === null)
            return false;

        for (const name of parseNetDev(lines).keys()) {
            if (isPhysicalInterface(name))
                return true;
        }

        return false;
    }

    /**
     * Takes a reading.
     *
     * @returns {{rxRate: number|null, txRate: number|null, totalRate: number|null}}
     *   bytes per second, null until the second tick
     */
    sample() {
        const lines = readLines(NET_DEV_PATH);
        if (lines === null)
            return {rxRate: null, txRate: null, totalRate: null};

        const {rxBytes, txBytes} = totalPhysical(parseNetDev(lines));

        const rxRate = this._rx.update(rxBytes);
        const txRate = this._tx.update(txBytes);

        const totalRate = rxRate === null || txRate === null
            ? null
            : rxRate + txRate;

        return {rxRate, txRate, totalRate};
    }

    /**
     * Formats a sample for the panel.
     *
     * @param {object|null} sample - reading from sample()
     * @param {object} [options] - formatting options
     * @param {boolean} [options.netAsBits] - report bits rather than bytes
     * @returns {string} display text
     */
    format(sample, options = {}) {
        // Named netAsBits, not asBits, because disk carries its own separate
        // setting and a shared key would make one of them do nothing.
        return formatRate(sample?.totalRate ?? null, {asBits: options.netAsBits ?? false});
    }

    /**
     * Fill level for a ring, bar or dot.
     *
     * Always null. Throughput has no ceiling to be a fraction of: a link can be
     * saturated at 200 kB/s on one machine and idle at that rate on another.
     * A ring would have to invent a maximum, so it renders as an empty track
     * instead of lying. This is precisely why network gets a sparkline by default,
     * which scales against what it has actually seen.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {null} always, see above
     */
    fraction(sample) {
        return null;
    }

    /**
     * Raw value for a self-scaling sparkline.
     *
     * @param {object|null} sample - reading from sample()
     * @returns {number|null} bytes per second, or null if not known
     */
    magnitude(sample) {
        return sample?.totalRate ?? null;
    }

    /**
     * Receive and transmit separately, for the dropdown.
     *
     * The panel shows the sum, which answers "is the network busy?". This
     * answers "busy which way?", which the sum cannot.
     *
     * @param {object|null} sample - reading from sample()
     * @param {object} [options] - formatting options
     * @returns {Array<{label: string, text: string, fraction: number|null}>} detail rows
     */
    detail(sample, options = {}) {
        if (!sample)
            return [];

        const asBits = options.netAsBits ?? false;

        return [
            {label: 'Down', text: formatRate(sample.rxRate, {asBits}), fraction: null},
            {label: 'Up', text: formatRate(sample.txRate, {asBits}), fraction: null},
        ];
    }

    /**
     * Drops both baselines so the next sample starts fresh.
     */
    reset() {
        this._rx.reset();
        this._tx.reset();
    }
}
