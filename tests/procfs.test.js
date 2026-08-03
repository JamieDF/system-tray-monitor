/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {canRead, readFile, readInt, readLines} from '../src/metrics/procfs.js';
import {assert, assertEqual, assertNull, fixturePath, suite, test} from './harness.js';

suite('procfs');

test('reads a file as text', () => {
    const text = readFile(fixturePath('proc-stat.txt'));
    assert(typeof text === 'string', 'should return a string');
    assert(text.startsWith('cpu '), 'should start with the aggregate line');
});

test('unreadable paths return null instead of throwing', () => {
    // Sysfs attributes disappear when hardware is removed, and some exist but
    // error on read. That is an ordinary outcome, not an exception.
    assertNull(readFile('/proc/definitely-not-a-real-file'));
    assertNull(readLines('/proc/definitely-not-a-real-file'));
    assertNull(readInt('/proc/definitely-not-a-real-file'));
});

test('a real unreadable sysfs attribute returns null', () => {
    // gpu_busy_percent on this amdgpu returns EOPNOTSUPP on read, which is the
    // exact case isAvailable() exists to handle. Skipped when absent so the
    // test is not tied to one machine's hardware.
    const path = '/sys/class/drm/card1/device/gpu_busy_percent';
    if (canRead(path))
        assertNull(readInt(path), 'a sensor that errors on read should yield null');
});

test('splits into lines and drops the trailing empty one', () => {
    const lines = readLines(fixturePath('proc-stat.txt'));
    assert(Array.isArray(lines), 'should return an array');
    assert(lines.length > 0, 'should have lines');
    assertEqual(lines[lines.length - 1] === '', false, 'trailing empty line should be dropped');
});

test('reads a single integer', () => {
    const value = readInt(fixturePath('single-int.txt'));
    assertEqual(value, 42);
});

test('non-numeric content yields null', () => {
    assertNull(readInt(fixturePath('proc-stat.txt')), 'a whole stat file is not an integer');
});

test('canRead distinguishes present from absent', () => {
    assertEqual(canRead(fixturePath('proc-stat.txt')), true);
    assertEqual(canRead('/proc/definitely-not-a-real-file'), false);
});
