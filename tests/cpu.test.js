/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {readLines} from '../src/metrics/procfs.js';
import {parseAggregate, parseCpuLine, parsePerCore, usageBetween} from '../src/metrics/cpu.js';
import {assert, assertClose, assertEqual, assertNull, fixturePath, suite, test} from './harness.js';

suite('cpu');

const fixture = readLines(fixturePath('proc-stat.txt'));

test('fixture loads', () => {
    assert(fixture !== null, 'proc-stat.txt fixture should be readable');
    assert(fixture.length > 1, 'fixture should have an aggregate line and per-core lines');
});

test('parses the aggregate line from a real /proc/stat', () => {
    const parsed = parseAggregate(fixture);
    assert(parsed !== null, 'aggregate should parse');
    assert(parsed.total > 0, 'total should be positive');
    assert(parsed.idle > 0, 'idle should be positive');
    assert(parsed.idle <= parsed.total, 'idle cannot exceed total');
});

test('idle includes iowait', () => {
    // user nice system idle iowait irq softirq steal
    const parsed = parseCpuLine('cpu  100 0 0 700 200 0 0 0');
    assertEqual(parsed.idle, 900, 'idle should be idle plus iowait');
    assertEqual(parsed.total, 1000, 'total should be every counted field');
});

test('guest fields are excluded to avoid double counting', () => {
    // The kernel already counts guest inside user, so adding it again would
    // inflate the total and make utilisation read artificially low.
    const withGuest = parseCpuLine('cpu 100 0 0 900 0 0 0 0 500 500');
    assertEqual(withGuest.total, 1000, 'guest and guest_nice must not be added');
});

test('tolerates short lines from older kernels', () => {
    const parsed = parseCpuLine('cpu 100 0 0 900');
    assertEqual(parsed.total, 1000);
    assertEqual(parsed.idle, 900);
});

test('rejects malformed input rather than guessing', () => {
    assertNull(parseCpuLine('cpu'), 'label alone is not parseable');
    assertNull(parseCpuLine('cpu a b c d'), 'non-numeric counters');
    assertNull(parseCpuLine(''), 'empty line');
    assertNull(parseCpuLine(null), 'null input');
    assertNull(parseAggregate([]), 'empty file');
    assertNull(parseAggregate(['intr 1 2 3']), 'aggregate must be the first line');
});

test('aggregate does not match a per-core line', () => {
    // "cpu " with the trailing space, otherwise "cpu0" would be taken as the
    // aggregate and the panel would report a single core's load as the whole.
    assertNull(parseAggregate(['cpu0 100 0 0 900']), 'cpu0 is not the aggregate');
});

test('per-core parsing finds one entry per core', () => {
    const cores = parsePerCore(fixture);
    assert(cores.length > 0, 'should find at least one core');
    assertEqual(cores.length, 8, 'this machine reports 8 cores');
    for (const core of cores)
        assert(core.total > 0, 'each core should have a positive total');
});

test('per-core parsing stops at the end of the cpu block', () => {
    const lines = ['cpu 1 1 1 1', 'cpu0 1 1 1 1', 'cpu1 1 1 1 1', 'intr 5 5 5', 'cpu9 1 1 1 1'];
    assertEqual(parsePerCore(lines).length, 2, 'must not pick up lines after intr');
});

test('first sample yields null, not zero', () => {
    // Rendering null as 0 would show an idle CPU for the first interval after
    // every login, which is wrong rather than merely imprecise.
    assertNull(usageBetween(null, {idle: 900, total: 1000}));
    assertNull(usageBetween(undefined, {idle: 900, total: 1000}));
});

test('computes utilisation across two samples', () => {
    const prev = {idle: 900, total: 1000};
    const curr = {idle: 950, total: 1100};
    // 100 ticks passed, 50 of them idle, so 50 percent busy.
    assertClose(usageBetween(prev, curr), 50, 1e-9);
});

test('fully idle and fully busy', () => {
    assertClose(usageBetween({idle: 0, total: 0}, {idle: 100, total: 100}), 0, 1e-9);
    assertClose(usageBetween({idle: 0, total: 0}, {idle: 0, total: 100}), 100, 1e-9);
});

test('counter reset yields null', () => {
    // Happens across suspend and namespace changes. Reporting a negative or
    // wildly large percentage would be worse than reporting nothing.
    assertNull(usageBetween({idle: 900, total: 1000}, {idle: 10, total: 20}), 'total went backwards');
    assertNull(usageBetween({idle: 900, total: 1000}, {idle: 800, total: 1100}), 'idle went backwards');
});

test('zero elapsed time yields null rather than dividing by zero', () => {
    assertNull(usageBetween({idle: 900, total: 1000}, {idle: 900, total: 1000}));
});

test('result is clamped to 0..100', () => {
    // Counters are read non-atomically and can produce a busy delta slightly
    // above the total.
    const value = usageBetween({idle: 100, total: 100}, {idle: 100, total: 300});
    assert(value >= 0 && value <= 100, `expected 0..100, got ${value}`);
});
