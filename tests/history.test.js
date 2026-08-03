/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {History} from '../src/ui/renderers/history.js';
import {assert, assertEqual, assertNull, suite, test} from './harness.js';

suite('history');

test('retains samples in order, oldest first', () => {
    const history = new History(5);
    history.push(1);
    history.push(2);
    history.push(3);

    assertEqual(history.values().join(','), '1,2,3');
});

test('never exceeds capacity', () => {
    // The bound is the whole point. This is allocated per metric on enable and
    // an unbounded version would grow for the life of the session while looking
    // perfectly correct on screen.
    const history = new History(4);

    for (let i = 0; i < 10000; i++)
        history.push(i);

    assertEqual(history.length, 4, 'length must stay at capacity');
    assertEqual(history.values().join(','), '9996,9997,9998,9999', 'newest retained');
});

test('discards the oldest, not the newest', () => {
    const history = new History(3);
    history.push('a');
    history.push('b');
    history.push('c');
    history.push('d');

    // Strings are not finite numbers, so they store as null. What matters here
    // is the position, which the range test covers with real numbers.
    assertEqual(history.length, 3);
});

test('capacity is clamped to a sane range', () => {
    assertEqual(new History(0).capacity, 2, 'fewer than two points is not a line');
    assertEqual(new History(-5).capacity, 2);
    assertEqual(new History(99999).capacity, 120, 'clamped to the schema maximum');
    assertEqual(new History(NaN).capacity, 2);
    assertEqual(new History(undefined).capacity, 2);
});

test('fractional capacity is floored, not left fractional', () => {
    // A fractional capacity would make the while loop never settle.
    assertEqual(new History(4.7).capacity, 4);
});

test('missing readings are stored as gaps, not dropped', () => {
    // A sparkline needs to know a reading was missing. Dropping it would draw a
    // straight line through a period when nothing was measured, which claims
    // data we do not have.
    const history = new History(5);
    history.push(10);
    history.push(null);
    history.push(30);

    assertEqual(history.length, 3, 'the gap occupies a slot');
    assertNull(history.values()[1]);
});

test('non-numeric input becomes a gap rather than corrupting the range', () => {
    const history = new History(5);
    history.push(NaN);
    history.push(undefined);
    history.push('nonsense');

    for (const value of history.values())
        assertNull(value);
});

test('range spans the retained samples', () => {
    const history = new History(5);
    history.push(10);
    history.push(50);
    history.push(30);

    const range = history.range();
    assertEqual(range.min, 10);
    assertEqual(range.max, 50);
});

test('range ignores gaps', () => {
    const history = new History(5);
    history.push(10);
    history.push(null);
    history.push(20);

    const range = history.range();
    assertEqual(range.min, 10);
    assertEqual(range.max, 20);
});

test('range of nothing is null, so the renderer can skip drawing', () => {
    assertNull(new History(5).range(), 'empty');

    const allGaps = new History(5);
    allGaps.push(null);
    allGaps.push(null);
    assertNull(allGaps.range(), 'nothing but gaps');
});

test('a flat line has a zero width range rather than being null', () => {
    // The renderer must handle this without dividing by zero.
    const history = new History(5);
    history.push(42);
    history.push(42);

    const range = history.range();
    assertEqual(range.min, 42);
    assertEqual(range.max, 42);
});

test('values returns a copy, so callers cannot corrupt the buffer', () => {
    const history = new History(3);
    history.push(1);

    const values = history.values();
    values.push(999);

    assertEqual(history.length, 1, 'the buffer should be untouched');
});

test('resizing smaller keeps the most recent samples', () => {
    const history = new History(10);
    for (let i = 1; i <= 6; i++)
        history.push(i);

    history.resize(3);

    assertEqual(history.capacity, 3);
    assertEqual(history.values().join(','), '4,5,6');
});

test('resizing larger keeps what it has', () => {
    const history = new History(3);
    history.push(1);
    history.push(2);

    history.resize(10);

    assertEqual(history.capacity, 10);
    assertEqual(history.values().join(','), '1,2');
});

test('clear empties the buffer', () => {
    // Called when polling stops, so the graph does not draw a line across the
    // period the machine was asleep.
    const history = new History(5);
    history.push(1);
    history.push(2);
    history.clear();

    assertEqual(history.length, 0);
    assertNull(history.range());
});

test('a cleared buffer still works afterwards', () => {
    const history = new History(3);
    history.push(1);
    history.clear();
    history.push(9);

    assertEqual(history.values().join(','), '9');
    assert(history.range() !== null, 'should report a range again');
});
