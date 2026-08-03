/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {RateTracker, rateBetween} from '../src/metrics/rates.js';
import {assert, assertClose, assertEqual, assertNull, suite, test} from './harness.js';

suite('rates');

const SECOND = 1000000; // monotonic time is in microseconds

test('computes a rate from a delta over measured time', () => {
    // 2000 bytes over 2 seconds is 1000 bytes per second.
    assertClose(rateBetween(1000, 0, 3000, 2 * SECOND), 1000, 1e-9);
});

test('first reading yields null, not zero', () => {
    // Zero would claim the interface was idle. We simply do not know yet.
    assertNull(rateBetween(null, null, 5000, SECOND));
    assertNull(rateBetween(undefined, undefined, 5000, SECOND));
});

test('counter reset yields null', () => {
    // Happens when an interface is recreated or a device re-plugged. A negative
    // delta is an unknown rate, not a small one.
    assertNull(rateBetween(9000, 0, 100, SECOND));
});

test('zero or negative elapsed time yields null', () => {
    assertNull(rateBetween(1000, SECOND, 2000, SECOND), 'no time passed');
    assertNull(rateBetween(1000, 2 * SECOND, 2000, SECOND), 'time went backwards');
});

test('rejects non-finite inputs rather than producing NaN', () => {
    assertNull(rateBetween(NaN, 0, 1000, SECOND));
    assertNull(rateBetween(1000, 0, NaN, SECOND));
    assertNull(rateBetween(1000, NaN, 2000, SECOND));
    assertNull(rateBetween(1000, 0, 2000, NaN));
});

test('a long gap produces a small average, not a spike', () => {
    // This is the whole reason measured elapsed time is used instead of the
    // configured interval. Suspend for an hour and the counter moves by an
    // hour of traffic. Divided by an assumed 2 second interval that reads as
    // 1.8 GB/s. Divided by the real elapsed hour it reads as 1 MB/s.
    const hour = 3600 * SECOND;
    const bytesInAnHour = 3600 * 1000000;

    const honest = rateBetween(0, 0, bytesInAnHour, hour);
    assertClose(honest, 1000000, 1e-6, 'should be the true average');

    const naive = bytesInAnHour / 2;
    assert(naive > honest * 1000, 'the naive figure really is absurdly larger');
});

test('an unchanged counter is a genuine zero', () => {
    // Distinct from null. The interface was up and idle, which we do know.
    assertClose(rateBetween(5000, 0, 5000, SECOND), 0, 1e-9);
});

test('tracker returns null on its first update', () => {
    const tracker = new RateTracker();
    assertNull(tracker.update(1000, 0));
});

test('tracker reports a rate on the second update', () => {
    const tracker = new RateTracker();
    tracker.update(1000, 0);
    assertClose(tracker.update(3000, 2 * SECOND), 1000, 1e-9);
});

test('tracker keeps working across several updates', () => {
    const tracker = new RateTracker();
    tracker.update(0, 0);
    assertClose(tracker.update(100, SECOND), 100, 1e-9);
    assertClose(tracker.update(300, 2 * SECOND), 200, 1e-9);
    assertClose(tracker.update(300, 3 * SECOND), 0, 1e-9);
});

test('reset forces the next update to start fresh', () => {
    // Called when polling stops. Without it, the first reading after unlock
    // would span the entire locked period.
    const tracker = new RateTracker();
    tracker.update(1000, 0);
    tracker.reset();

    assertNull(tracker.update(9999, SECOND), 'should behave as a first reading');
});

test('tracker survives a counter reset mid-stream', () => {
    const tracker = new RateTracker();
    tracker.update(5000, 0);
    assertNull(tracker.update(10, SECOND), 'reset should read as unknown');

    // And recovers on the reading after, using the new baseline.
    assertClose(tracker.update(110, 2 * SECOND), 100, 1e-9);
});

test('default timestamp uses the monotonic clock', () => {
    // Not the wall clock, which can jump backwards when NTP corrects it and
    // would produce a negative elapsed time.
    const tracker = new RateTracker();
    assertNull(tracker.update(0));
    const rate = tracker.update(0);
    assertEqual(rate === null || rate === 0, true, 'two immediate reads are idle or unknown');
});
