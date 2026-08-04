/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {readLines} from '../src/metrics/procfs.js';
import {isPhysicalDisk, parseDiskstats, totalPhysical} from '../src/metrics/disk.js';
import {assert, assertEqual, fixturePath, suite, test} from './harness.js';

suite('disk');

const fixture = readLines(fixturePath('proc-diskstats.txt'));

// A fake /sys/block containing only nvme0n1. Pointing isPhysicalDisk here
// instead of at the host's real /sys/block keeps these tests hermetic: they
// pass on a machine with nvme0n1 and on a CI runner whose only disk is sda.
const sysBlock = fixturePath('sys/block');

test('fixture loads', () => {
    assert(fixture !== null, 'proc-diskstats.txt fixture should be readable');
});

test('parses a real /proc/diskstats', () => {
    const parsed = parseDiskstats(fixture);
    assert(parsed.has('nvme0n1'), 'the whole disk should be present');
    assert(parsed.has('nvme0n1p1'), 'partitions are parsed, then filtered later');
    assert(parsed.has('loop0'), 'loop devices are parsed, then filtered later');
});

test('converts sectors to bytes at a fixed 512', () => {
    // diskstats sectors are always 512 bytes regardless of the device's real
    // sector size. An NVMe with 4096 byte hardware sectors still reports
    // diskstats in 512 byte units, so using hw_sector_size would be eight times
    // too large.
    //     major minor name reads merged sectorsRead ms writes merged sectorsWritten
    const lines = ['259 0 nvme0n1 10 0 100 5 20 0 200 7'];
    const parsed = parseDiskstats(lines);
    assertEqual(parsed.get('nvme0n1').readBytes, 100 * 512);
    assertEqual(parsed.get('nvme0n1').writeBytes, 200 * 512);
});

test('reads sectors written from the tenth field', () => {
    // Off by one here silently reports milliseconds spent writing as bytes.
    const lines = ['8 0 sda 1 2 3 4 5 6 7 8'];
    const parsed = parseDiskstats(lines);
    assertEqual(parsed.get('sda').readBytes, 3 * 512, 'field 6 is sectors read');
    assertEqual(parsed.get('sda').writeBytes, 7 * 512, 'field 10 is sectors written');
});

test('ignores short and malformed lines', () => {
    assertEqual(parseDiskstats(['8 0 sda 1 2 3']).size, 0, 'too few fields');
    assertEqual(parseDiskstats(['garbage']).size, 0);
    assertEqual(parseDiskstats([]).size, 0);
    assertEqual(parseDiskstats(null).size, 0);
});

test('loop and other virtual devices are excluded', () => {
    // Reading from a loop device also reads from the real disk underneath, so
    // counting both doubles it. This machine has 25 loop devices from snaps.
    for (const name of ['loop0', 'loop25', 'ram0', 'zram0'])
        assertEqual(isPhysicalDisk(name), false, `${name} should be excluded`);
});

test('partitions are excluded so the whole disk is not double counted', () => {
    // /sys/block lists whole disks only. Without this check nvme0n1p1 and
    // nvme0n1p2 would be added on top of nvme0n1, roughly doubling the figure.
    // The fake sysBlock has nvme0n1 but not nvme0n1p1, modelling a real /sys/block.
    assertEqual(isPhysicalDisk('nvme0n1p1', sysBlock), false);
    assertEqual(isPhysicalDisk('nvme0n1', sysBlock), true, 'the whole disk should count');
});

test('rejects malformed names', () => {
    assertEqual(isPhysicalDisk(''), false);
    assertEqual(isPhysicalDisk(null), false);
    assertEqual(isPhysicalDisk(undefined), false);
});

test('total sums only whole physical disks', () => {
    // The predicate is injected so this does not depend on the machine's sysfs.
    const parsed = new Map([
        ['nvme0n1', {readBytes: 100, writeBytes: 200}],
        ['nvme0n1p1', {readBytes: 90, writeBytes: 190}],
        ['loop0', {readBytes: 5000, writeBytes: 5000}],
        ['sda', {readBytes: 7, writeBytes: 9}],
    ]);
    const isPhysical = name => name === 'nvme0n1' || name === 'sda';

    const total = totalPhysical(parsed, isPhysical);
    assertEqual(total.readBytes, 107);
    assertEqual(total.writeBytes, 209);
});

test('total of nothing is zero, not NaN', () => {
    const total = totalPhysical(new Map(), () => true);
    assertEqual(total.readBytes, 0);
    assertEqual(total.writeBytes, 0);
});

test('the real fixture yields a nonzero physical total', () => {
    const total = totalPhysical(parseDiskstats(fixture), name => isPhysicalDisk(name, sysBlock));
    assert(total.readBytes > 0, 'this machine has read from disk');
});

test('the fixture really does contain the traps being filtered', () => {
    // Guards the fixture itself. If someone regenerates it on a machine with no
    // snaps and no partitions, the filtering tests above stop proving anything.
    const names = [...parseDiskstats(fixture).keys()];
    assert(names.some(n => n.startsWith('loop')), 'fixture should contain loop devices');
    assert(names.some(n => /p\d+$/.test(n)), 'fixture should contain partitions');
});
