/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Provider registration and lookup.
 *
 * The one place that knows which metrics exist. Adding a metric means adding it
 * to the list here and nowhere else: the panel, the poller and the preferences
 * window all discover what to offer by asking this module.
 *
 * gi://GLib only, transitively. See procfs.js for why that matters.
 */

import {CpuProvider} from './cpu.js';
import {DiskProvider} from './disk.js';
import {MemoryProvider} from './memory.js';
import {NetworkProvider} from './network.js';
import {ThermalProvider} from './thermal.js';

/**
 * Constructors for every metric this extension knows about, in the order they
 * appear by default. The settings key enabled-metrics overrides both which of
 * these appear and in what order.
 */
const REGISTERED = [
    CpuProvider,
    MemoryProvider,
    ThermalProvider,
    NetworkProvider,
    DiskProvider,
];

/**
 * Builds one instance of every registered provider.
 *
 * @returns {object[]} freshly constructed providers
 */
export function createAllProviders() {
    return REGISTERED.map(Provider => new Provider());
}

/**
 * Builds the providers that should actually be polled and displayed.
 *
 * Two filters apply, and the order matters. First the user's chosen list, so a
 * metric they turned off is never even constructed as available. Then
 * isAvailable(), so a metric whose data source cannot be read is dropped rather
 * than sitting in the panel showing a permanent placeholder. The amdgpu
 * gpu_busy_percent attribute is the motivating case: it exists, and reading it
 * returns an error.
 *
 * @param {string[]} enabledIds - ordered metric ids from settings
 * @returns {object[]} providers to use, in the order given
 */
export function createActiveProviders(enabledIds) {
    if (!Array.isArray(enabledIds))
        return [];

    const byId = new Map(createAllProviders().map(p => [p.id, p]));

    return enabledIds
        .map(id => byId.get(id))
        .filter(provider => provider !== undefined)
        .filter(provider => provider.isAvailable());
}

/**
 * Every known metric id, for validating settings and building the preferences
 * list.
 *
 * @returns {string[]} ids in default order
 */
export function knownMetricIds() {
    return createAllProviders().map(provider => provider.id);
}
