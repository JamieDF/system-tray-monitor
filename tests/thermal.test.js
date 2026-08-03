/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
    SENSOR_PRIORITY,
    discoverSensors,
    millidegreesToCelsius,
    selectSensor,
} from '../src/metrics/thermal.js';
import {assert, assertClose, assertEqual, assertNull, suite, test} from './harness.js';

suite('thermal');

test('Intel is supported, not just the machine this was written on', () => {
    // The development machine is AMD and reports k10temp. A sensor list written
    // from what it happens to expose would leave every Intel user with no
    // temperature at all and no clue why.
    assert(SENSOR_PRIORITY.includes('coretemp'), 'Intel coretemp must be recognised');
    assert(SENSOR_PRIORITY.includes('k10temp'), 'AMD k10temp must be recognised');
});

test('a dedicated CPU driver beats the generic fallback', () => {
    // acpitz is a motherboard thermal zone that may be measuring something else
    // entirely, so it is a last resort rather than an equal option.
    const entries = [
        {name: 'acpitz', path: '/sys/class/hwmon/hwmon0'},
        {name: 'coretemp', path: '/sys/class/hwmon/hwmon1'},
    ];
    assertEqual(selectSensor(entries).name, 'coretemp');
});

test('priority holds regardless of discovery order', () => {
    // hwmon numbering is not stable, so the same two sensors can appear either
    // way round between boots. The choice must not depend on that.
    const a = [
        {name: 'k10temp', path: '/a'},
        {name: 'acpitz', path: '/b'},
    ];
    const b = [
        {name: 'acpitz', path: '/b'},
        {name: 'k10temp', path: '/a'},
    ];
    assertEqual(selectSensor(a).name, 'k10temp');
    assertEqual(selectSensor(b).name, 'k10temp');
});

test('falls back when no CPU driver is present', () => {
    const entries = [{name: 'acpitz', path: '/x'}];
    assertEqual(selectSensor(entries).name, 'acpitz');
});

test('unrecognised sensors produce no reading rather than a wrong one', () => {
    // A wifi card and a battery both expose temperatures. Picking one and
    // labelling it CPU would be worse than showing nothing.
    const entries = [
        {name: 'iwlwifi_1', path: '/w'},
        {name: 'BAT0', path: '/b'},
        {name: 'ADP0', path: '/a'},
    ];
    assertNull(selectSensor(entries));
});

test('handles an empty or malformed sensor list', () => {
    assertNull(selectSensor([]));
    assertNull(selectSensor(null));
    assertNull(selectSensor(undefined));
});

test('converts millidegrees to Celsius', () => {
    assertClose(millidegreesToCelsius(58000), 58, 1e-9);
    assertClose(millidegreesToCelsius(41500), 41.5, 1e-9);
});

test('rejects implausible readings instead of displaying them', () => {
    // Some drivers return 0 or a sentinel when a sensor exists but is not yet
    // initialised. A panel confidently showing 0 °C is worse than a placeholder.
    assertNull(millidegreesToCelsius(0), 'zero is a sentinel, not a reading');
    assertNull(millidegreesToCelsius(-40000), 'below freezing');
    assertNull(millidegreesToCelsius(200000), 'above thermal shutdown');
    assertNull(millidegreesToCelsius(null));
    assertNull(millidegreesToCelsius(NaN));
});

test('accepts the plausible range', () => {
    assertClose(millidegreesToCelsius(1000), 1, 1e-9, 'just above freezing');
    assertClose(millidegreesToCelsius(150000), 150, 1e-9, 'at the upper bound');
});

test('discovery finds this machine sensors by name, never by index', () => {
    // hwmon numbering changes across reboots. This asserts discovery returns
    // named entries; the ordering must never be relied on.
    const entries = discoverSensors();
    assert(Array.isArray(entries), 'should return an array');

    for (const entry of entries) {
        assert(typeof entry.name === 'string' && entry.name.length > 0,
            'every entry should carry a driver name');
        assert(entry.path.includes('hwmon'), 'every entry should carry its path');
    }
});

test('this machine resolves to a real CPU sensor', () => {
    // Machine specific, and skipped rather than failed elsewhere. On this AMD
    // laptop the answer should be k10temp and not the acpitz fallback.
    const entries = discoverSensors();
    const names = entries.map(entry => entry.name);

    if (!names.includes('k10temp'))
        return;

    assertEqual(selectSensor(entries).name, 'k10temp',
        'k10temp should win over anything else present here');
});
