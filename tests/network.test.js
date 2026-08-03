/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {readLines} from '../src/metrics/procfs.js';
import {isPhysicalInterface, parseNetDev, totalPhysical} from '../src/metrics/network.js';
import {assert, assertEqual, fixturePath, suite, test} from './harness.js';

suite('network');

const fixture = readLines(fixturePath('proc-net-dev.txt'));

test('fixture loads', () => {
    assert(fixture !== null, 'proc-net-dev.txt fixture should be readable');
});

test('skips the two header lines', () => {
    // /proc/net/dev opens with "Inter-|   Receive ..." and a column legend.
    // Neither contains a colon followed by 16 numeric fields, so both fall out
    // naturally, but this pins the behaviour.
    const parsed = parseNetDev(fixture);
    assert(!parsed.has('Inter-|'), 'header should not be parsed as an interface');
    assert(!parsed.has('face'), 'column legend should not be parsed as an interface');
});

test('parses a real /proc/net/dev', () => {
    const parsed = parseNetDev(fixture);
    assert(parsed.has('lo'), 'loopback should be present in the parse');
    assert(parsed.has('wlp1s0'), 'the wifi interface should be present');
    assert(parsed.get('wlp1s0').rxBytes > 0, 'wifi should have received bytes');
});

test('handles names with and without leading whitespace', () => {
    // Short names are right-aligned so the colon has a space before it; long
    // ones butt straight up against it. Splitting on whitespace alone breaks.
    const lines = [
        'Inter-|   Receive                        |  Transmit',
        ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
        '    lo:  100 1 0 0 0 0 0 0  200 2 0 0 0 0 0 0',
        'averyLongInterfaceName: 300 3 0 0 0 0 0 0  400 4 0 0 0 0 0 0',
    ];
    const parsed = parseNetDev(lines);
    assertEqual(parsed.get('lo').rxBytes, 100);
    assertEqual(parsed.get('averyLongInterfaceName').txBytes, 400);
});

test('reads transmit bytes from the ninth field, not the second', () => {
    // Eight receive columns come first. Getting this wrong reports receive
    // twice and transmit never, which looks plausible and is entirely wrong.
    const lines = ['eth0: 111 1 0 0 0 0 0 0 999 9 0 0 0 0 0 0'];
    const parsed = parseNetDev(lines);
    assertEqual(parsed.get('eth0').rxBytes, 111);
    assertEqual(parsed.get('eth0').txBytes, 999);
});

test('ignores lines with too few fields', () => {
    assertEqual(parseNetDev(['eth0: 1 2 3']).size, 0);
    assertEqual(parseNetDev(['no colon here']).size, 0);
    assertEqual(parseNetDev([]).size, 0);
    assertEqual(parseNetDev(null).size, 0);
});

test('loopback is excluded from the total', () => {
    // Every local connection appears on lo, so counting it makes a local
    // database look like external traffic.
    assertEqual(isPhysicalInterface('lo'), false);
});

test('container veth pairs are excluded', () => {
    // The bytes also traverse the host interface, so counting both doubles them.
    assertEqual(isPhysicalInterface('veth1a2b3c'), false);
});

test('bridges are deliberately included', () => {
    // They can double count on a bridged VM host, but on such a machine the
    // bridge may be the only interface carrying traffic. Over counting is the
    // less harmful failure than reporting zero.
    assertEqual(isPhysicalInterface('br0'), true);
    assertEqual(isPhysicalInterface('virbr0'), true);
});

test('real interfaces are included', () => {
    for (const name of ['eth0', 'wlp1s0', 'enp3s0', 'wlan0', 'eno1'])
        assertEqual(isPhysicalInterface(name), true, `${name} should count`);
});

test('an interface merely starting with lo is not mistaken for loopback', () => {
    // Prefix matching here would silently drop a real interface.
    assertEqual(isPhysicalInterface('lol0'), true);
    assertEqual(isPhysicalInterface('lo0'), true);
});

test('rejects malformed names', () => {
    assertEqual(isPhysicalInterface(''), false);
    assertEqual(isPhysicalInterface(null), false);
    assertEqual(isPhysicalInterface(undefined), false);
});

test('total sums only the physical interfaces', () => {
    const parsed = new Map([
        ['lo', {rxBytes: 1000, txBytes: 1000}],
        ['eth0', {rxBytes: 10, txBytes: 20}],
        ['wlan0', {rxBytes: 5, txBytes: 7}],
        ['veth99', {rxBytes: 9999, txBytes: 9999}],
    ]);

    const total = totalPhysical(parsed);
    assertEqual(total.rxBytes, 15, 'lo and veth must not be counted');
    assertEqual(total.txBytes, 27);
});

test('total of nothing is zero, not NaN', () => {
    const total = totalPhysical(new Map());
    assertEqual(total.rxBytes, 0);
    assertEqual(total.txBytes, 0);
});

test('the real fixture yields a nonzero physical total', () => {
    const total = totalPhysical(parseNetDev(fixture));
    assert(total.rxBytes > 0, 'this machine has received traffic on wifi');
});
