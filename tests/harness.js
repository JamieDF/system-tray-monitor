/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A very small test harness.
 *
 * Deliberately hand-rolled rather than pulled from npm. The whole point of the
 * pure metrics layer is that it runs under plain gjs with no display server and
 * no toolchain, and a test runner that needed node would undermine that. This
 * is about eighty lines and does everything these tests need.
 */

import GLib from 'gi://GLib';

const results = {
    passed: 0,
    failed: 0,
    failures: [],
};

let currentSuite = '';

/**
 * Groups the tests that follow under a heading.
 *
 * @param {string} name - suite name, shown in output
 */
export function suite(name) {
    currentSuite = name;
}

/**
 * Registers and immediately runs a test.
 *
 * @param {string} name - what the test asserts
 * @param {Function} fn - test body, throws on failure
 */
export function test(name, fn) {
    const label = currentSuite ? `${currentSuite}: ${name}` : name;

    try {
        fn();
        results.passed++;
    } catch (error) {
        results.failed++;
        results.failures.push({label, message: error.message ?? String(error)});
    }
}

/**
 * @param {*} condition - value expected to be truthy
 * @param {string} [message] - shown on failure
 */
export function assert(condition, message) {
    if (!condition)
        throw new Error(message ?? 'expected a truthy value');
}

/**
 * @param {*} actual - value under test
 * @param {*} expected - value it should equal
 * @param {string} [message] - shown on failure
 */
export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
        throw new Error(message ? `${message} (${detail})` : detail);
    }
}

/**
 * Compares floats within a tolerance, since exact equality is meaningless here.
 *
 * @param {number} actual - value under test
 * @param {number} expected - value it should approximate
 * @param {number} [tolerance] - permitted absolute difference
 * @param {string} [message] - shown on failure
 */
export function assertClose(actual, expected, tolerance = 1e-6, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
        const detail = `expected ${expected} within ${tolerance}, got ${actual}`;
        throw new Error(message ? `${message} (${detail})` : detail);
    }
}

/**
 * @param {*} value - value expected to be null
 * @param {string} [message] - shown on failure
 */
export function assertNull(value, message) {
    if (value !== null) {
        const detail = `expected null, got ${JSON.stringify(value)}`;
        throw new Error(message ? `${message} (${detail})` : detail);
    }
}

/**
 * Absolute path to the fixtures directory, resolved from this file rather than
 * from the working directory, so tests run correctly from anywhere.
 *
 * @returns {string} fixtures directory path
 */
export function fixturePath(name) {
    const [self] = GLib.filename_from_uri(import.meta.url);
    return GLib.build_filenamev([GLib.path_get_dirname(self), 'fixtures', name]);
}

/**
 * Prints a summary.
 *
 * @returns {number} process exit code, 0 when everything passed
 */
export function report() {
    for (const failure of results.failures)
        printerr(`FAIL  ${failure.label}\n      ${failure.message}`);

    const total = results.passed + results.failed;
    print(`\n${results.passed}/${total} passed`);

    return results.failed === 0 ? 0 : 1;
}
