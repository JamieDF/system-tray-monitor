/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Guards the two stylesheets against drifting apart.
 *
 * The shell loads stylesheet-light.css INSTEAD of stylesheet.css in a light
 * session, not in addition to it, so the light file has to be complete rather
 * than a set of overrides. That makes drift the obvious failure mode: add a
 * selector to one file, forget the other, and the feature silently does nothing
 * for half the users. Nobody notices because most developers test in one theme.
 */

import GLib from 'gi://GLib';

import {assert, assertEqual, suite, test} from './harness.js';

suite('stylesheet');

const [self] = GLib.filename_from_uri(import.meta.url);
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(self));

/**
 * @param {string} name - file name relative to the repo root
 * @returns {string} file contents
 */
function read(name) {
    const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([ROOT, name]));
    assert(ok, `${name} should be readable`);
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Extracts selectors, ignoring comments and whitespace.
 *
 * @param {string} css - stylesheet source
 * @returns {string[]} sorted, deduplicated selectors
 */
function selectors(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = new Set();

    for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
        for (const part of match[1].split(','))
            found.add(part.trim().replace(/\s+/g, ' '));
    }

    found.delete('');
    return [...found].sort();
}

/**
 * Extracts declared custom property names.
 *
 * @param {string} css - stylesheet source
 * @returns {string[]} sorted, deduplicated property names
 */
function customProperties(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = new Set();

    for (const match of withoutComments.matchAll(/(-system-monitor-[a-z-]+)\s*:/g))
        found.add(match[1]);

    return [...found].sort();
}

const dark = read('stylesheet.css');
const light = read('stylesheet-light.css');

test('both stylesheets exist and have content', () => {
    assert(dark.length > 0, 'stylesheet.css should not be empty');
    assert(light.length > 0, 'stylesheet-light.css should not be empty');
});

test('both declare exactly the same selectors', () => {
    const inDark = selectors(dark);
    const inLight = selectors(light);

    const onlyDark = inDark.filter(s => !inLight.includes(s));
    const onlyLight = inLight.filter(s => !inDark.includes(s));

    assertEqual(onlyDark.join(', '), '', 'selectors missing from the light stylesheet');
    assertEqual(onlyLight.join(', '), '', 'selectors missing from the dark stylesheet');
});

test('both declare exactly the same custom properties', () => {
    // These are looked up by name from the drawing code. One missing in a
    // variant means that glyph falls back to a hardcoded colour in that theme.
    const inDark = customProperties(dark);
    const inLight = customProperties(light);

    assert(inDark.length > 0, 'the dark stylesheet should declare custom properties');
    assertEqual(inDark.join(', '), inLight.join(', '),
        'custom properties differ between the two stylesheets');
});

test('the properties the drawing code reads are actually declared', () => {
    // Names are duplicated between glyphs.js and the stylesheets, so a typo in
    // either would silently fall back to the built in colour.
    const required = [
        '-system-monitor-track-color',
        '-system-monitor-accent-color',
        '-system-monitor-heat-low',
        '-system-monitor-heat-mid',
        '-system-monitor-heat-high',
    ];

    for (const property of required) {
        assert(customProperties(dark).includes(property),
            `${property} is read by glyphs.js but not declared in stylesheet.css`);
    }
});

test('every metric has an accent colour in both variants', () => {
    for (const metric of ['cpu', 'memory', 'temperature', 'network', 'disk']) {
        const selector = `.system-monitor-metric-${metric}`;
        assert(selectors(dark).includes(selector), `${selector} missing from dark`);
        assert(selectors(light).includes(selector), `${selector} missing from light`);
    }
});

test('the two palettes are actually different', () => {
    // If someone copies the dark file over the light one to fix a drift
    // failure, the test above would pass while light mode became unreadable.
    const darkColours = dark.match(/#[0-9a-f]{6}/gi) ?? [];
    const lightColours = light.match(/#[0-9a-f]{6}/gi) ?? [];

    assert(darkColours.length > 0, 'dark should define colours');
    assertEqual(darkColours.join(',') === lightColours.join(','), false,
        'the light stylesheet is using the dark palette, so it will be unreadable');
});
