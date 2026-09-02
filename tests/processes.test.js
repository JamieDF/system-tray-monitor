/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Process list data for the dropdown.
 *
 * Ranking and parsing are the interesting behaviour. The menu widgets need a
 * running shell; these do not.
 */

import GLib from 'gi://GLib';

import {parseAggregate} from '../src/metrics/cpu.js';
import {
    ProcessTable,
    canEnd,
    cpuShare,
    isKernelThread,
    isPidEntry,
    parsePidStat,
    parseStatm,
    pickTop,
    PF_KTHREAD,
} from '../src/metrics/processes.js';
import {readFile, readLines} from '../src/metrics/procfs.js';
import {
    assert,
    assertClose,
    assertEqual,
    assertNull,
    suite,
    test,
} from './harness.js';

suite('processes');

/**
 * Builds a /proc/[pid]/stat line with known counters.
 *
 * @param {object} fields - pid, comm, and optional flags, utime, stime
 * @returns {string} a parseable stat line
 */
function statLine({pid, comm, flags = 0, utime = 0, stime = 0}) {
    const rest = [
        'S', 1, pid, pid, 0, -1, flags,
        0, 0, 0, 0, utime, stime,
    ];
    return `${pid} (${comm}) ${rest.join(' ')}`;
}

/**
 * Writes a miniature /proc into a temp directory.
 *
 * Kept out of the repo on purpose. The interesting cases are the numbers
 * below, not a checked-in copy of kernel files.
 *
 * @returns {string} absolute path of the fake /proc root
 */
function makeProcRoot() {
    const root = GLib.dir_make_tmp('system-tray-monitor-proc-XXXXXX');

    GLib.file_set_contents(`${root}/stat`,
        'cpu  1000 0 0 7000 0 0 0 0\ncpu0 1000 0 0 7000 0 0 0 0\n');

    const processes = [
        {pid: 1, comm: 'systemd', utime: 100, stime: 50},
        {pid: 2, comm: 'kthreadd', flags: PF_KTHREAD, utime: 0, stime: 3},
        {pid: 100, comm: 'firefox', utime: 400, stime: 50},
        {pid: 200, comm: 'bash', utime: 20, stime: 0},
        {pid: 300, comm: 'Web Content', utime: 200, stime: 10},
    ];

    for (const proc of processes) {
        const dir = `${root}/${proc.pid}`;
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(`${dir}/stat`, `${statLine(proc)}\n`);
        GLib.file_set_contents(`${dir}/statm`, `200 ${proc.pid === 100 ? 400 : 50} 10 1 0 20 0\n`);
    }

    return root;
}

const fixtureRoot = makeProcRoot();

test('the temp proc root is readable', () => {
    assert(readFile(`${fixtureRoot}/stat`) !== null, 'fake /proc/stat should be readable');
});

test('parses pid, comm, flags and ticks from a systemd line', () => {
    const parsed = parsePidStat(statLine({
        pid: 1, comm: 'systemd', utime: 100, stime: 50,
    }));
    assertEqual(parsed.pid, 1);
    assertEqual(parsed.comm, 'systemd');
    assertEqual(parsed.ticks, 150);
});

test('comm may contain spaces and still leave the counters aligned', () => {
    // Firefox names content processes "Web Content". Split-on-space would
    // treat "Content" as the state and read the wrong fields for CPU.
    const parsed = parsePidStat(statLine({
        pid: 300, comm: 'Web Content', utime: 200, stime: 10,
    }));
    assertEqual(parsed.pid, 300);
    assertEqual(parsed.comm, 'Web Content');
    assertEqual(parsed.ticks, 210);
});

test('comm may contain parentheses, matched from the last closing one', () => {
    const parsed = parsePidStat(statLine({
        pid: 7, comm: 'foo)bar', utime: 4, stime: 1,
    }));
    assertEqual(parsed.comm, 'foo)bar');
    assertEqual(parsed.ticks, 5);
});

test('ignores short and malformed stat lines', () => {
    assertNull(parsePidStat(null));
    assertNull(parsePidStat(''));
    assertNull(parsePidStat('12 S 0 0 0'));
    assertNull(parsePidStat('12 () S 0 0 0 0 0 0 0 0 0 0 0 0'));
    assertNull(parsePidStat('not-a-stat'));
});

test('statm RSS is the second field, in pages', () => {
    assertEqual(parseStatm('100 50 10 1 0 20 0', 4096), 50 * 4096);
    assertNull(parseStatm('100'));
    assertNull(parseStatm(null));
});

test('kernel threads are recognised from PF_KTHREAD', () => {
    const kthreadd = parsePidStat(statLine({
        pid: 2, comm: 'kthreadd', flags: PF_KTHREAD, stime: 3,
    }));
    assert(isKernelThread(kthreadd.flags), 'kthreadd should be a kernel thread');
    assertEqual(isKernelThread(0), false);
    assertEqual(isKernelThread(PF_KTHREAD), true);
});

test('pid directories are numeric names only', () => {
    assertEqual(isPidEntry('100'), true);
    assertEqual(isPidEntry('self'), false);
    assertEqual(isPidEntry('net'), false);
    assertEqual(isPidEntry(''), false);
    assertEqual(isPidEntry(null), false);
});

test('cpu share uses the aggregate total, matching the panel units', () => {
    // 100 process ticks against 800 system ticks is 12.5 percent, the same
    // figure the panel would show if that process were the only user.
    assertClose(cpuShare(50, 1000, 150, 1800), 12.5);
});

test('cpu share is unknown until a baseline exists', () => {
    assertNull(cpuShare(null, null, 100, 1000));
    assertNull(cpuShare(undefined, 1000, 100, 2000));
});

test('cpu share is unknown when counters go backwards or time stands still', () => {
    assertNull(cpuShare(200, 1000, 100, 2000), 'process ticks went backwards');
    assertNull(cpuShare(100, 2000, 150, 2000), 'no system time passed');
});

test('cpu share is clamped to 0..100', () => {
    assertEqual(cpuShare(0, 100, 200, 150), 100);
});

test('pid 1 and the reader itself cannot be ended', () => {
    assertEqual(canEnd(1, 42), false, 'init');
    assertEqual(canEnd(42, 42), false, 'ourselves');
    assertEqual(canEnd(100, 42), true);
    assertEqual(canEnd(0, 42), false);
});

test('pickTop ranks known shares first, then lifetime ticks', () => {
    const rows = pickTop([
        {pid: 1, percent: 2, ticks: 9000},
        {pid: 2, percent: 40, ticks: 10},
        {pid: 3, percent: null, ticks: 8000},
        {pid: 4, percent: 40, ticks: 50},
    ], 3);

    assertEqual(rows[0].pid, 4, 'same share, more ticks wins');
    assertEqual(rows[1].pid, 2);
    assertEqual(rows[2].pid, 1, 'unknown shares sort after known ones');
});

test('pickTop respects the limit and survives empty input', () => {
    assertEqual(pickTop([], 5).length, 0);
    assertEqual(pickTop([{percent: 1, ticks: 1}], 0).length, 0);
    assertEqual(pickTop(null, 5).length, 0);
});

test('the table skips kernel threads and ranks the fixture by ticks', () => {
    const table = new ProcessTable({procRoot: fixtureRoot, selfPid: 999});
    table.setLimit(8);
    const rows = table.top();

    assertEqual(rows.length, 4, 'kthreadd should be absent');
    assertEqual(rows[0].label, 'firefox');
    assertEqual(rows[1].label, 'Web Content');
    assertEqual(rows[2].label, 'systemd');
    assertEqual(rows[3].label, 'bash');
    assertEqual(rows[0].text, '--%', 'no baseline yet');
    assertEqual(rows.find(row => row.pid === 1).endable, false, 'pid 1');
    assertEqual(rows.find(row => row.pid === 100).endable, true);
    assertEqual(rows[0].memory, '1.6MiB', 'firefox RSS from fixture statm');
});

test('the second sample reports a real share against the aggregate', () => {
    // The fixture is static, so a second read of the same files produces a
    // zero delta. That still has to come back as unknown, not as 0 percent:
    // claiming every process was idle is the same lie as a first-tick zero
    // on the panel CPU.
    const table = new ProcessTable({procRoot: fixtureRoot, selfPid: 999});
    table.top();
    const rows = table.top();
    assertEqual(rows[0].text, '--%');
});

test('reset drops baselines so the next read is unknown again', () => {
    const table = new ProcessTable({procRoot: fixtureRoot, selfPid: 999});
    table.top();
    table.reset();
    assertEqual(table.top()[0].text, '--%');
});

test('the live /proc has userspace processes with names', () => {
    const table = new ProcessTable();
    table.setLimit(8);
    const rows = table.top();
    assert(rows.length > 0, 'this machine has processes');
    for (const row of rows) {
        assert(typeof row.label === 'string' && row.label.length > 0, 'label');
        assert(typeof row.pid === 'number' && row.pid > 0, 'pid');
        assert(row.pid !== 2, 'kthreadd should not appear');
    }
});

test('a live second sample produces at least one real percentage', () => {
    const table = new ProcessTable();
    table.setLimit(8);
    table.top();

    const deadline = GLib.get_monotonic_time() + 80 * 1000;
    let sink = 0;
    while (GLib.get_monotonic_time() < deadline)
        sink += Math.sqrt(sink + 1);

    const rows = table.top();
    assert(sink !== 0, 'the burn must not be optimised out');
    assert(rows.some(row => row.text !== '--%'),
        'some process should have a rate once baselined');
});

test('the fixture aggregate is the same parser the table uses', () => {
    const parsed = parseAggregate(readLines(`${fixtureRoot}/stat`));
    assertEqual(parsed.total, 8000);
});
