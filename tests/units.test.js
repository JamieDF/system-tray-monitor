/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {formatGibibytes, formatPercent, kibToBytes} from '../src/metrics/units.js';
import {assertEqual, assertNull, suite, test} from './harness.js';

suite('units');

const GIB = 1024 * 1024 * 1024;

test('memory carries an explicit unit, never a bare G', () => {
    assertEqual(formatGibibytes(4.2 * GIB), '4.2GiB');
    assertEqual(formatGibibytes(0), '0.0GiB');
});

test('uses binary gibibytes, so the label matches the arithmetic', () => {
    // 15381264 kB is 15750414336 bytes. Divided by 2^30 that is 14.7, which is
    // what `free -h` and `htop` show. GiB rather than GB because since
    // IEC 80000-13 the two mean different things, and labelling a binary figure
    // GB is the one combination that is simply wrong.
    assertEqual(formatGibibytes(15381264 * 1024), '14.7GiB');
});

test('the reported total is lower than the capacity on the box, by design', () => {
    // A 16 GiB machine reports about 14.7 GiB because firmware reserves the
    // rest before the kernel boots. On an AMD APU the integrated GPU takes the
    // largest share for its frame buffer. This is not a units bug, and the
    // figure should not be scaled up to "fix" it.
    const sixteenGiB = 16 * GIB;
    assertEqual(formatGibibytes(sixteenGiB), '16.0GiB');
    assertEqual(formatGibibytes(15381264 * 1024), '14.7GiB');
});

test('unknown values render as a placeholder, not as zero', () => {
    assertEqual(formatGibibytes(null), '--GiB');
    assertEqual(formatGibibytes(undefined), '--GiB');
    assertEqual(formatGibibytes(NaN), '--GiB');
});

test('decimals and unit are configurable', () => {
    assertEqual(formatGibibytes(4.25 * GIB, {decimals: 2}), '4.25GiB');
    assertEqual(formatGibibytes(4.2 * GIB, {withUnit: false}), '4.2');
    assertEqual(formatGibibytes(null, {withUnit: false}), '--');
});

test('percentages round and carry an optional sign', () => {
    assertEqual(formatPercent(12.4), '12%');
    assertEqual(formatPercent(12.6), '13%');
    assertEqual(formatPercent(12.4, {withSign: false}), '12');
});

test('unknown percentages render as a placeholder', () => {
    assertEqual(formatPercent(null), '--%');
    assertEqual(formatPercent(null, {withSign: false}), '--');
    assertEqual(formatPercent(NaN), '--%');
});

test('kibToBytes multiplies by 1024', () => {
    assertEqual(kibToBytes(1), 1024);
    assertEqual(kibToBytes(0), 0);
    assertNull(kibToBytes(null));
    assertNull(kibToBytes(NaN));
});
