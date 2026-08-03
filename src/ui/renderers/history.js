/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A bounded history buffer, backing the sparklines.
 *
 * Imports nothing, so the bound can be tested headlessly. That matters more
 * than it sounds: this is allocated per metric on enable and released on
 * disable, and an unbounded version would grow for as long as the session lives
 * while looking perfectly correct on screen. Leaked memory in a tool whose job
 * is reporting memory would be an embarrassing way to fail review.
 */

/** Smallest useful history. Fewer points than this is not a line. */
const MIN_CAPACITY = 2;

/** Upper bound, matching the history-length key's range in the schema. */
const MAX_CAPACITY = 120;

export class History {
    /**
     * @param {number} capacity - how many samples to retain
     */
    constructor(capacity) {
        this._capacity = History.clampCapacity(capacity);
        this._values = [];
    }

    /**
     * Clamps a requested capacity into the supported range.
     *
     * @param {number} capacity - requested capacity
     * @returns {number} a usable capacity
     */
    static clampCapacity(capacity) {
        if (!Number.isFinite(capacity))
            return MIN_CAPACITY;

        return Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, Math.floor(capacity)));
    }

    /** @returns {number} how many samples are retained */
    get capacity() {
        return this._capacity;
    }

    /** @returns {number} how many samples are currently held */
    get length() {
        return this._values.length;
    }

    /**
     * Adds a sample, discarding the oldest once full.
     *
     * Null is accepted and stored. A sparkline needs to know a reading was
     * missing rather than silently closing the gap, which would draw a straight
     * line through a period where nothing was measured.
     *
     * @param {number|null} value - the sample
     */
    push(value) {
        const usable = Number.isFinite(value) ? value : null;

        this._values.push(usable);

        // A single shift per push keeps this at exactly capacity, so the array
        // never grows even across weeks of uptime.
        while (this._values.length > this._capacity)
            this._values.shift();
    }

    /**
     * @returns {Array<number|null>} the retained samples, oldest first
     */
    values() {
        return [...this._values];
    }

    /**
     * The range spanned by the retained samples, ignoring gaps.
     *
     * Returns null when there is nothing to scale against, which the renderer
     * treats as "draw nothing" rather than dividing by zero.
     *
     * @returns {{min: number, max: number}|null} the range, or null
     */
    range() {
        let min = Infinity;
        let max = -Infinity;

        for (const value of this._values) {
            if (value === null)
                continue;

            if (value < min)
                min = value;
            if (value > max)
                max = value;
        }

        if (min === Infinity)
            return null;

        return {min, max};
    }

    /**
     * Changes capacity, keeping the most recent samples.
     *
     * @param {number} capacity - new capacity
     */
    resize(capacity) {
        this._capacity = History.clampCapacity(capacity);

        while (this._values.length > this._capacity)
            this._values.shift();
    }

    /**
     * Discards everything. Called when polling stops, so the graph does not
     * draw a line across the period the machine was asleep.
     */
    clear() {
        this._values = [];
    }
}
