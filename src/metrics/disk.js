/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Disk throughput from /proc/diskstats.
 *
 * gi://GLib only, via procfs.js and rates.js. See procfs.js for why.
 */

import {canRead, readLines} from './procfs.js';
import {RateTracker} from './rates.js';
import {formatRate} from './units.js';

const DISKSTATS_PATH = '/proc/diskstats';
const SYS_BLOCK = '/sys/block';

/*
 * Sectors in /proc/diskstats are always 512 bytes.
 *
 * This is fixed by the kernel's stats interface and is unrelated to the
 * device's real sector size. An NVMe reporting hw_sector_size 512 or 4096 still
 * counts diskstats sectors in 512 byte units, so reading the device's sector
 * size and using that would be wrong by a factor of eight.
 */
const BYTES_PER_SECTOR = 512;

/*
 * Virtual block devices, excluded because their traffic is not physical IO.
 * loop devices back snap packages and mounted images, and every read from one
 * is also a read from the real disk underneath, so counting both doubles it.
 */
const VIRTUAL_PREFIXES = ['loop', 'ram', 'zram', 'dm-', 'md'];

/**
 * Decides whether a device name is a whole physical disk.
 *
 * Two conditions, and both are needed. /sys/block lists whole disks only, never
 * partitions, which is what stops nvme0n1p1 and nvme0n1p2 being added on top of
 * nvme0n1. But it does list loop and ram devices, so those are filtered by name.
 *
 * @param {string} name - device name from /proc/diskstats
 * @returns {boolean} true if this is a real whole disk
 */
export function isPhysicalDisk(name) {
    if (typeof name !== 'string' || name.length === 0)
        return false;

    if (VIRTUAL_PREFIXES.some(prefix => name.startsWith(prefix)))
        return false;

    return canRead(`${SYS_BLOCK}/${name}`);
}

/**
 * Parses /proc/diskstats into per-device byte counters.
 *
 * Columns are major, minor, name, then reads completed, reads merged, sectors
 * read, milliseconds reading, writes completed, writes merged, sectors written.
 * Sectors are converted to bytes here so nothing downstream carries the unit.
 *
 * @param {string[]} lines - lines of /proc/diskstats
 * @returns {Map<string, {readBytes: number, writeBytes: number}>} counters by device
 */
export function parseDiskstats(lines) {
    const devices = new Map();

    if (!Array.isArray(lines))
        return devices;

    for (const line of lines) {
        const fields = line.trim().split(/\s+/);

        // Up to and including sectors written.
        if (fields.length < 10)
            continue;

        const name = fields[2];
        const sectorsRead = Number.parseInt(fields[5], 10);
        const sectorsWritten = Number.parseInt(fields[9], 10);

        if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten))
            continue;

        devices.set(name, {
            readBytes: sectorsRead * BYTES_PER_SECTOR,
            writeBytes: sectorsWritten * BYTES_PER_SECTOR,
        });
    }

    return devices;
}

/**
 * Sums the counters of every whole physical disk.
 *
 * @param {Map<string, {readBytes: number, writeBytes: number}>} devices - parsed counters
 * @param {Function} [isPhysical] - predicate, injectable so tests need no real /sys
 * @returns {{readBytes: number, writeBytes: number}} combined totals
 */
export function totalPhysical(devices, isPhysical = isPhysicalDisk) {
    let readBytes = 0;
    let writeBytes = 0;

    for (const [name, counters] of devices) {
        if (!isPhysical(name))
            continue;

        readBytes += counters.readBytes;
        writeBytes += counters.writeBytes;
    }

    return {readBytes, writeBytes};
}

/**
 * Disk metric provider.
 *
 * Tracks reads and writes separately so the dropdown can show both, while the
 * panel shows their sum.
 */
export class DiskProvider {
    constructor() {
        this._read = new RateTracker();
        this._write = new RateTracker();
    }

    /** @returns {string} stable identifier used in settings keys */
    get id() {
        return 'disk';
    }

    /**
     * Short form for the panel, where width is scarce.
     *
     * @returns {string} abbreviated name
     */
    get label() {
        return 'DSK';
    }

    /**
     * Full form for the preferences window, where there is room and clarity
     * matters more than width.
     *
     * @returns {string} human readable name
     */
    get name() {
        return 'Disk';
    }

    /**
     * Themed rather than bundled: Adwaita's solid state drive icon fits here,
     * where it did not fit memory.
     *
     * @returns {string} symbolic icon name
     */
    get iconName() {
        return 'drive-harddisk-solidstate-symbolic';
    }

    /**
     * @returns {boolean} true if at least one whole physical disk is visible
     */
    isAvailable() {
        const lines = readLines(DISKSTATS_PATH);
        if (lines === null)
            return false;

        for (const name of parseDiskstats(lines).keys()) {
            if (isPhysicalDisk(name))
                return true;
        }

        return false;
    }

    /**
     * Takes a reading.
     *
     * @returns {{readRate: number|null, writeRate: number|null, totalRate: number|null}}
     *   bytes per second, null until the second tick
     */
    sample() {
        const lines = readLines(DISKSTATS_PATH);
        if (lines === null)
            return {readRate: null, writeRate: null, totalRate: null};

        const {readBytes, writeBytes} = totalPhysical(parseDiskstats(lines));

        const readRate = this._read.update(readBytes);
        const writeRate = this._write.update(writeBytes);

        const totalRate = readRate === null || writeRate === null
            ? null
            : readRate + writeRate;

        return {readRate, writeRate, totalRate};
    }

    /**
     * Formats a sample for the panel.
     *
     * @param {object|null} sample - reading from sample()
     * @param {object} [options] - formatting options
     * @param {boolean} [options.diskAsBits] - report bits rather than bytes
     * @returns {string} display text
     */
    format(sample, options = {}) {
        // Named diskAsBits, not asBits, because network carries its own
        // separate setting and a shared key would make one of them do nothing.
        return formatRate(sample?.totalRate ?? null, {asBits: options.diskAsBits ?? false});
    }

    /**
     * Fill level for a ring, bar or dot.
     *
     * Always null. Throughput has no ceiling to be a fraction of: a link can be
     * saturated at 200 kB/s on one machine and idle at that rate on another.
     * A ring would have to invent a maximum, so it renders as an empty track
     * instead of lying. This is precisely why disk gets a sparkline by default,
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
     * Drops both baselines so the next sample starts fresh.
     */
    reset() {
        this._read.reset();
        this._write.reset();
    }
}
