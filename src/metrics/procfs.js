/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Reading helpers for /proc and /sys.
 *
 * This module, and everything else under src/metrics/, imports gi://GLib and
 * nothing else. No St, no Clutter, no resource:///org/gnome/shell/. That is
 * what lets the whole metrics layer run and be tested under plain gjs with no
 * display server, and it is also an extensions.gnome.org review requirement:
 * shell libraries must not leak into code that the preferences process shares.
 *
 * There is deliberately no libgtop dependency. Everything these providers need
 * is already in /proc and /sys, so pulling in a C library would add a package
 * requirement and a version-skew failure mode for no benefit.
 */

import GLib from 'gi://GLib';

// Reused across every read. Allocating a decoder per tick would produce garbage
// every couple of seconds for as long as the session lives.
const DECODER = new TextDecoder('utf-8');

/**
 * Reads a file as text.
 *
 * Never throws. An unreadable path is an ordinary outcome here: sysfs
 * attributes disappear when hardware is removed, and some are present but
 * return errors on read. Callers treat null as "this metric is unavailable"
 * rather than as a failure.
 *
 * @param {string} path - absolute path to read
 * @returns {string|null} file contents, or null if it could not be read
 */
export function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;

        return DECODER.decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Reads a file and splits it into lines, dropping a trailing empty line.
 *
 * @param {string} path - absolute path to read
 * @returns {string[]|null} lines, or null if the file could not be read
 */
export function readLines(path) {
    const text = readFile(path);
    if (text === null)
        return null;

    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();

    return lines;
}

/**
 * Reads a file expected to hold a single integer, as most sysfs attributes do.
 *
 * @param {string} path - absolute path to read
 * @returns {number|null} the value, or null if unreadable or not a number
 */
export function readInt(path) {
    const text = readFile(path);
    if (text === null)
        return null;

    const value = Number.parseInt(text.trim(), 10);
    return Number.isFinite(value) ? value : null;
}

/**
 * Tests whether a path exists and is readable, without reading it.
 *
 * @param {string} path - absolute path to test
 * @returns {boolean} true if the path can be read
 */
export function canRead(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/**
 * Lists the entries of a directory.
 *
 * Never throws, for the same reason readFile does not: sysfs directories come
 * and go with the hardware they describe.
 *
 * @param {string} path - absolute directory path
 * @returns {string[]} entry names, empty if the directory could not be read
 */
export function listDir(path) {
    const names = [];

    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return names;
    }

    let entry;
    while ((entry = dir.read_name()) !== null)
        names.push(entry);

    dir.close();

    return names;
}
