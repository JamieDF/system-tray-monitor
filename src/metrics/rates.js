/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Turning cumulative counters into rates.
 *
 * Network and disk both expose counters that only ever climb, so a rate is a
 * delta divided by the time it took. The subtlety, and the reason this is its
 * own tested module rather than duplicated in two providers, is that the
 * divisor must be *measured* elapsed time and never the configured poll
 * interval.
 *
 * Assuming the interval looks correct until the machine suspends. Resume after
 * an hour asleep and the counter has moved by an hour's worth of traffic, which
 * divided by an assumed 2 seconds reads as a colossal spike. Divided by the
 * real elapsed time it reads as a modest average, which is the truth.
 *
 * gi://GLib only, for the monotonic clock.
 */

import GLib from 'gi://GLib';

const MICROSECONDS_PER_SECOND = 1000000;

/**
 * Computes a rate between two counter readings.
 *
 * Returns null rather than a number whenever a rate cannot be known. Callers
 * render that as a placeholder; rendering it as zero would claim the interface
 * was idle when in fact we have no idea.
 *
 * @param {number|null} prevValue - earlier counter reading
 * @param {number|null} prevTimeUs - when it was taken, monotonic microseconds
 * @param {number} currValue - later counter reading
 * @param {number} currTimeUs - when it was taken, monotonic microseconds
 * @returns {number|null} units per second, or null if not computable
 */
export function rateBetween(prevValue, prevTimeUs, currValue, currTimeUs) {
    if (prevValue === null || prevValue === undefined)
        return null;

    if (!Number.isFinite(prevValue) || !Number.isFinite(currValue))
        return null;

    if (!Number.isFinite(prevTimeUs) || !Number.isFinite(currTimeUs))
        return null;

    const elapsedUs = currTimeUs - prevTimeUs;

    // The monotonic clock cannot go backwards, so this means a bad reading
    // rather than a clock adjustment.
    if (elapsedUs <= 0)
        return null;

    const delta = currValue - prevValue;

    // Counters reset when an interface is recreated, a device is re-plugged, or
    // the 64 bit counter wraps. A negative delta is not a small rate, it is an
    // unknown one.
    if (delta < 0)
        return null;

    return delta / (elapsedUs / MICROSECONDS_PER_SECOND);
}

/**
 * Tracks one counter over time and reports its rate.
 *
 * Holds the previous reading and the monotonic timestamp it was taken at.
 */
export class RateTracker {
    constructor() {
        this._value = null;
        this._timeUs = null;
    }

    /**
     * Records a new counter reading and returns the rate since the last one.
     *
     * @param {number} value - current cumulative counter
     * @param {number} [nowUs] - monotonic microseconds, defaults to now
     * @returns {number|null} units per second, null on the first reading
     */
    update(value, nowUs = GLib.get_monotonic_time()) {
        const rate = rateBetween(this._value, this._timeUs, value, nowUs);

        this._value = value;
        this._timeUs = nowUs;

        return rate;
    }

    /**
     * Drops the baseline.
     *
     * Called when polling stops. Without this, the first reading after a lock
     * or a suspend would span the whole idle period.
     */
    reset() {
        this._value = null;
        this._timeUs = null;
    }
}
