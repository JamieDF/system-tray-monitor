/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Dropdown detail data.
 *
 * The menu widgets need a running shell, but the data behind them does not.
 * These cover what each provider reports when asked for detail, which is where
 * the interesting behaviour is: the menu is a list of labels and values, and
 * getting those wrong is what would show a wrong number.
 */

import GLib from 'gi://GLib';

import {CpuProvider} from '../src/metrics/cpu.js';
import {DiskProvider} from '../src/metrics/disk.js';
import {MemoryProvider} from '../src/metrics/memory.js';
import {NetworkProvider} from '../src/metrics/network.js';
import {ThermalProvider} from '../src/metrics/thermal.js';
import {assert, assertEqual, assertNull, suite, test} from './harness.js';

suite('detail');

const GIB = 1024 ** 3;

/**
 * Burns CPU until /proc/stat has had time to move.
 *
 * The kernel accounts CPU time in jiffies, ticking at 100 Hz on a normal build.
 * Two reads a few milliseconds apart therefore show a zero delta, and the
 * provider correctly reports "unknown" rather than inventing a figure. Any test
 * wanting a real percentage has to let at least a few jiffies pass, and it has
 * to do it by burning rather than sleeping, since sleeping accrues idle time on
 * this thread but no busy time anywhere.
 *
 * @param {number} [ms] - how long to burn for
 */
function burnUntilCountersMove(ms = 80) {
    const deadline = GLib.get_monotonic_time() + ms * 1000;
    let sink = 0;

    while (GLib.get_monotonic_time() < deadline)
        sink += Math.sqrt(sink + 1);

    return sink;
}

test('every provider answers detail without throwing on a null sample', () => {
    // The menu can open before the first reading has landed.
    for (const Provider of [CpuProvider, MemoryProvider, ThermalProvider,
        NetworkProvider, DiskProvider]) {
        const provider = new Provider();
        const rows = provider.detail?.(null, {}) ?? [];
        assert(Array.isArray(rows), `${provider.id} should return an array`);
    }
});

test('detail rows all carry a label and a text value', () => {
    const memory = new MemoryProvider();
    const rows = memory.detail(memory.sample());

    assert(rows.length > 0, 'memory should report detail');
    for (const row of rows) {
        assert(typeof row.label === 'string' && row.label.length > 0, 'label');
        assert(typeof row.text === 'string' && row.text.length > 0, 'text');
    }
});

test('memory detail shows used against total', () => {
    const memory = new MemoryProvider();
    const rows = memory.detail({
        usedBytes: 6 * GIB,
        totalBytes: 16 * GIB,
        percent: 37.5,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
    });

    assertEqual(rows[0].label, 'Used');
    assertEqual(rows[0].text, '6.0GiB of 16.0GiB');
    assertEqual(rows[0].fraction, 0.375);
});

test('swap is omitted entirely when there is none', () => {
    // A permanent "0B of 0B" row is noise on a machine with no swap.
    const memory = new MemoryProvider();
    const rows = memory.detail({
        usedBytes: GIB, totalBytes: 8 * GIB, percent: 12.5,
        swapUsedBytes: 0, swapTotalBytes: 0,
    });

    assertEqual(rows.length, 1, 'only the used row');
});

test('swap appears when configured', () => {
    const memory = new MemoryProvider();
    const rows = memory.detail({
        usedBytes: GIB, totalBytes: 8 * GIB, percent: 12.5,
        swapUsedBytes: GIB / 2, swapTotalBytes: 4 * GIB,
    });

    assertEqual(rows.length, 2);
    assertEqual(rows[1].label, 'Swap');
});

test('network detail separates the directions the panel sums', () => {
    // The panel answers "is the network busy?". This answers "which way?",
    // which the sum cannot.
    const network = new NetworkProvider();
    const rows = network.detail({rxRate: 2000000, txRate: 500000, totalRate: 2500000});

    assertEqual(rows.length, 2);
    assertEqual(rows[0].label, 'Down');
    assertEqual(rows[0].text, '2.0MB/s');
    assertEqual(rows[1].label, 'Up');
    assertEqual(rows[1].text, '500kB/s');
});

test('network detail honours the bits setting', () => {
    const network = new NetworkProvider();
    const rows = network.detail({rxRate: 1000000, txRate: 0}, {netAsBits: true});

    assertEqual(rows[0].text, '8.0Mb/s');
});

test('disk detail separates reads from writes', () => {
    const disk = new DiskProvider();
    const rows = disk.detail({readRate: 12000000, writeRate: 3000000, totalRate: 15000000});

    assertEqual(rows[0].label, 'Read');
    assertEqual(rows[0].text, '12MB/s');
    assertEqual(rows[1].label, 'Write');
    assertEqual(rows[1].text, '3.0MB/s');
});

test('disk detail uses its own bits setting, not the network one', () => {
    // These are separate keys. A shared flag would make one of them do nothing.
    const disk = new DiskProvider();
    const asBits = disk.detail({readRate: 1000000, writeRate: 0}, {diskAsBits: true});
    const asBytes = disk.detail({readRate: 1000000, writeRate: 0}, {netAsBits: true});

    assertEqual(asBits[0].text, '8.0Mb/s');
    assertEqual(asBytes[0].text, '1.0MB/s', 'netAsBits must not affect disk');
});

test('network series separates the directions the panel sums', () => {
    // The plot draws the same split the detail rows show, so a line's colour
    // identifies a row of the same name just below it.
    const network = new NetworkProvider();
    const values = network.series({rxRate: 2000000, txRate: 500000});

    assertEqual(values.length, 2);
    assertEqual(values[0], 2000000);
    assertEqual(values[1], 500000);
});

test('disk series separates reads from writes', () => {
    const disk = new DiskProvider();
    const values = disk.series({readRate: 12000000, writeRate: 3000000});

    assertEqual(values.length, 2);
    assertEqual(values[0], 12000000);
    assertEqual(values[1], 3000000);
});

test('a missing reading is a gap in the plot, not a zero', () => {
    // History records nulls so the line breaks across them. Reporting zero
    // instead would draw a plausible dip to the baseline on the first tick
    // after polling resumes.
    const network = new NetworkProvider();
    const values = network.series(null);

    assertEqual(values.length, 2);
    assertNull(values[0]);
    assertNull(values[1]);
});

test('series lengths match the detail rows beneath them', () => {
    // Two lines in a plot only earn their place if two rows explain them.
    for (const [Provider, sample] of [[NetworkProvider, {rxRate: 1, txRate: 1}],
        [DiskProvider, {readRate: 1, writeRate: 1}]]) {
        const provider = new Provider();
        assertEqual(provider.series(sample).length,
            provider.detail(sample).length);
    }
});

test('every provider offers series or magnitude for the dropdown plot', () => {
    // The menu plots magnitude alone when a metric has nothing to split, so a
    // provider with neither would open onto a permanently empty plot.
    for (const Provider of [CpuProvider, MemoryProvider, ThermalProvider,
        NetworkProvider, DiskProvider]) {
        const provider = new Provider();
        assert(provider.series !== undefined || provider.magnitude !== undefined,
            `${provider.id} has nothing to plot`);
    }
});

test('temperature detail names the sensor being read', () => {
    // A machine exposes several temperatures. "Which one is this?" is the first
    // question a bare number invites.
    const thermal = new ThermalProvider();
    const rows = thermal.detail({celsius: 58, sensor: 'k10temp'});

    assertEqual(rows.length, 1);
    assertEqual(rows[0].label, 'k10temp');
    assertEqual(rows[0].text, '58°C');
});

test('temperature detail honours the unit setting', () => {
    const thermal = new ThermalProvider();
    const rows = thermal.detail({celsius: 100, sensor: 'coretemp'}, {tempUnit: 'fahrenheit'});

    assertEqual(rows[0].text, '212°F');
});

test('temperature detail is empty when no sensor was found', () => {
    const thermal = new ThermalProvider();
    assertEqual(thermal.detail({celsius: null, sensor: null}).length, 0);
});

test('cpu detail reports one row per core', () => {
    const cpu = new CpuProvider();
    const rows = cpu.detail();

    assert(rows.length > 0, 'this machine has cores');
    assertEqual(rows[0].label, 'Core 0');
});

test('cpu detail is unknown on its first call, then real', () => {
    // Per-core baselines only exist once the menu has been open for a tick.
    // Reporting 0 percent instead would claim every core was idle.
    const cpu = new CpuProvider();

    const first = cpu.detail();
    assertEqual(first[0].text, '--%', 'no baseline yet');
    assertEqual(first[0].fraction, null);

    burnUntilCountersMove();

    const second = cpu.detail();
    assert(second[0].text !== '--%', 'should report a real figure once baselined');
    assert(second[0].fraction >= 0 && second[0].fraction <= 1, 'fraction in range');
});

test('closing the menu drops per-core baselines but not the panel one', () => {
    // resetDetail is deliberately narrower than reset. Clearing the aggregate
    // too would make the panel show a placeholder for a tick every time the
    // menu was dismissed.
    const cpu = new CpuProvider();

    cpu.sample();
    cpu.detail();
    cpu.resetDetail();

    assertEqual(cpu.detail()[0].text, '--%', 'per-core baseline was dropped');

    burnUntilCountersMove();
    const sample = cpu.sample();
    assert(sample.percent !== null, 'the aggregate baseline survived');
});

test('the core count matches the aggregate line being excluded', () => {
    // parsePerCore must not count the "cpu " aggregate as a core, which would
    // report one core too many on every machine.
    const cpu = new CpuProvider();
    const rows = cpu.detail();

    for (const row of rows)
        assert(/^Core \d+$/.test(row.label), `unexpected label "${row.label}"`);
});
