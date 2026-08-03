/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * The single shared timer.
 *
 * ONE GLib timeout drives every provider. Do not split this into a timer per
 * metric, however much cleaner the separation looks: wakeups are the dominant
 * power cost of a tool like this, not the arithmetic, and five timers means
 * five times as many of them. A system monitor that measurably drains the
 * battery undermines its own reason to exist.
 *
 * This module imports GLib only. It is deliberately unaware of St, of the
 * panel, and of what any provider actually measures.
 */

import GLib from 'gi://GLib';

export class Poller {
    /**
     * @param {object} [options] - configuration
     * @param {number} [options.intervalSeconds] - seconds between ticks
     */
    constructor(options = {}) {
        const {intervalSeconds = 2} = options;

        this._intervalSeconds = intervalSeconds;
        this._providers = [];
        this._listeners = new Set();
        this._sourceId = 0;
        this._lastReadings = new Map();
    }

    /** @returns {boolean} true while the timer is running */
    get isRunning() {
        return this._sourceId !== 0;
    }

    /** @returns {number} current interval in seconds */
    get intervalSeconds() {
        return this._intervalSeconds;
    }

    /**
     * Replaces the set of providers that get sampled.
     *
     * Anything not in this list is never read, so a metric the user has turned
     * off costs nothing at runtime rather than being sampled and discarded.
     *
     * @param {object[]} providers - providers implementing sample() and reset()
     */
    setProviders(providers) {
        this._providers = providers ?? [];
        this._lastReadings = new Map();

        // Baselines belong to the old set and mean nothing to the new one.
        for (const provider of this._providers)
            provider.reset?.();
    }

    /**
     * Registers a callback invoked with each tick's readings.
     *
     * @param {Function} listener - receives a Map of provider id to sample
     * @returns {Function} call to unregister
     */
    addListener(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /**
     * Changes the tick interval, restarting the timer if it is running.
     *
     * @param {number} seconds - new interval
     */
    setInterval(seconds) {
        if (!Number.isFinite(seconds) || seconds < 1)
            return;

        if (this._intervalSeconds === seconds)
            return;

        this._intervalSeconds = seconds;

        if (this.isRunning) {
            this.stop();
            this.start();
        }
    }

    /**
     * Starts ticking, and takes one reading immediately so the panel is not
     * blank for a whole interval after enable.
     */
    start() {
        if (this.isRunning)
            return;

        this._tick();

        this._sourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._intervalSeconds,
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    /**
     * Stops ticking and clears every provider's baseline.
     *
     * Clearing baselines matters for rate metrics. Resuming after a lock or a
     * suspend with a stale baseline would report the entire elapsed gap as one
     * enormous spike.
     */
    stop() {
        if (this._sourceId !== 0) {
            GLib.Source.remove(this._sourceId);
            this._sourceId = 0;
        }

        for (const provider of this._providers)
            provider.reset?.();
    }

    /**
     * Re-sends the most recent readings without sampling anything.
     *
     * For settings that change only how a value is written, such as whether a
     * percent sign is shown. Taking a fresh sample would be wasteful, and for
     * rate metrics it would also produce a reading over a tiny interval and
     * make the panel jump.
     */
    refresh() {
        if (this._lastReadings.size === 0)
            return;

        for (const listener of this._listeners)
            listener(this._lastReadings);
    }

    /**
     * Stops the timer and drops every reference. The instance is unusable
     * afterwards.
     */
    destroy() {
        this.stop();
        this._listeners.clear();
        this._providers = [];
        this._lastReadings.clear();
    }

    /**
     * Samples every provider once and notifies listeners.
     */
    _tick() {
        const readings = new Map();

        for (const provider of this._providers) {
            try {
                readings.set(provider.id, provider.sample());
            } catch (error) {
                // One misbehaving provider must not stop the others or kill the
                // timer, which would silently freeze the whole panel.
                logError(error, `system-monitor: provider "${provider.id}" failed to sample`);
                readings.set(provider.id, null);
            }
        }

        this._lastReadings = readings;

        for (const listener of this._listeners)
            listener(readings);
    }
}
