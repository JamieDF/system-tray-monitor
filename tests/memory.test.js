/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {readLines} from '../src/metrics/procfs.js';
import {deriveUsage, parseMeminfo} from '../src/metrics/memory.js';
import {assert, assertClose, assertEqual, assertNull, fixturePath, suite, test} from './harness.js';

suite('memory');

const fixture = readLines(fixturePath('proc-meminfo.txt'));

test('fixture loads', () => {
    assert(fixture !== null, 'proc-meminfo.txt fixture should be readable');
});

test('parses a real /proc/meminfo', () => {
    const parsed = parseMeminfo(fixture);
    assert(parsed !== null, 'should parse');
    assert(parsed.memTotal > 0, 'MemTotal should be positive');
    assert(parsed.memAvailable > 0, 'MemAvailable should be positive');
});

test('converts kibibytes to bytes', () => {
    // The file says "kB" but the values are kibibytes. A machine reporting
    // 15381264 kB has 15381264 * 1024 bytes.
    const parsed = parseMeminfo(['MemTotal: 15381264 kB', 'MemAvailable: 8938720 kB']);
    assertEqual(parsed.memTotal, 15381264 * 1024);
    assertEqual(parsed.memAvailable, 8938720 * 1024);
});

test('stops reading once every wanted field is found', () => {
    // /proc/meminfo has around 58 lines and we need four of them.
    const parsed = parseMeminfo([
        'MemTotal: 1000 kB',
        'MemAvailable: 400 kB',
        'SwapTotal: 200 kB',
        'SwapFree: 150 kB',
        'NotAField',
        'Malformed line with no colon',
    ]);
    assert(parsed !== null, 'trailing junk should not matter');
    assertEqual(parsed.swapFree, 150 * 1024);
});

test('requires MemTotal and MemAvailable', () => {
    assertNull(parseMeminfo(['MemFree: 100 kB']), 'MemFree alone is not enough');
    assertNull(parseMeminfo(['MemTotal: 100 kB']), 'MemAvailable is required');
    assertNull(parseMeminfo([]), 'empty input');
    assertNull(parseMeminfo(null), 'null input');
});

test('missing swap fields are treated as no swap, not as failure', () => {
    // A machine with no swap configured omits these entirely.
    const parsed = parseMeminfo(['MemTotal: 1000 kB', 'MemAvailable: 400 kB']);
    assert(parsed !== null, 'absent swap should still parse');
    assertEqual(parsed.swapTotal, 0);
    assertEqual(parsed.swapFree, 0);
});

test('used is total minus available, not total minus free', () => {
    // MemFree excludes reclaimable page cache, so using it would report almost
    // all memory as used on any machine that has been running a while.
    const usage = deriveUsage({
        memTotal: 1000,
        memAvailable: 400,
        swapTotal: 0,
        swapFree: 0,
    });
    assertEqual(usage.usedBytes, 600);
    assertClose(usage.percent, 60, 1e-9);
});

test('derives swap used', () => {
    const usage = deriveUsage({
        memTotal: 1000,
        memAvailable: 400,
        swapTotal: 500,
        swapFree: 200,
    });
    assertEqual(usage.swapUsedBytes, 300);
    assertEqual(usage.swapTotalBytes, 500);
});

test('MemAvailable above MemTotal is clamped', () => {
    // MemAvailable is a kernel estimate and can exceed MemTotal, which would
    // otherwise produce negative usage.
    const usage = deriveUsage({
        memTotal: 1000,
        memAvailable: 1200,
        swapTotal: 0,
        swapFree: 0,
    });
    assertEqual(usage.usedBytes, 0, 'usage should not go negative');
    assertClose(usage.percent, 0, 1e-9);
});

test('rejects a zero or missing total rather than dividing by zero', () => {
    assertNull(deriveUsage({memTotal: 0, memAvailable: 0, swapTotal: 0, swapFree: 0}));
    assertNull(deriveUsage(null));
});

test('real fixture produces a plausible reading', () => {
    const usage = deriveUsage(parseMeminfo(fixture));
    assert(usage.percent >= 0 && usage.percent <= 100, 'percent should be in range');
    assert(usage.usedBytes <= usage.totalBytes, 'used cannot exceed total');
});
