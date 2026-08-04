/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Stylesheet correctness.
 *
 * There is one stylesheet, deliberately. The shell picks
 * stylesheet-<variant>.css from the colour-scheme setting, and on Ubuntu that
 * does not reliably describe what the panel renders as: a session reporting
 * "light" can have a black panel. A per-variant palette is a coin flip, and
 * losing it means drawing dark on dark, which is invisible rather than ugly.
 *
 * A single sheet only works if every colour in it is legible on either
 * background, so that is measured here rather than trusted.
 */

import GLib from 'gi://GLib';

import {assert, assertEqual, suite, test} from './harness.js';

suite('stylesheet');

const [self] = GLib.filename_from_uri(import.meta.url);
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(self));

/** The two backgrounds a panel is actually drawn on. */
const DARK_PANEL = '#000000';
const LIGHT_PANEL = '#fafafb';

/**
 * Minimum contrast ratio.
 *
 * 3:1 is the WCAG threshold for graphical objects and large text, which is what
 * these are: bold panel numbers and small gauges, never body copy.
 */
const MIN_CONTRAST = 3;

/**
 * @param {string} name - file name relative to the repo root
 * @returns {string|null} contents, or null if absent
 */
function read(name) {
    // file_get_contents throws on a missing file rather than returning false,
    // so absence has to be caught rather than tested.
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([ROOT, name]));
        return ok ? new TextDecoder('utf-8').decode(bytes) : null;
    } catch {
        return null;
    }
}

/**
 * Relative luminance, per WCAG.
 *
 * @param {string} hex - colour as #rrggbb
 * @returns {number} luminance from 0 to 1
 */
function luminance(hex) {
    const channel = offset => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * @param {string} a - colour as #rrggbb
 * @param {string} b - colour as #rrggbb
 * @returns {number} contrast ratio, 1 to 21
 */
function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {string} css - stylesheet source
 * @returns {string[]} every hex colour, deduplicated
 */
function colours(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...new Set(withoutComments.match(/#[0-9a-f]{6}/gi) ?? [])];
}

/**
 * @param {string} css - stylesheet source
 * @returns {string[]} declared custom property names
 */
function customProperties(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = new Set();

    for (const match of withoutComments.matchAll(/(-system-monitor-[a-z-]+)\s*:/g))
        found.add(match[1]);

    return [...found].sort();
}

const sheet = read('stylesheet.css');

test('the stylesheet exists', () => {
    assert(sheet !== null && sheet.length > 0, 'stylesheet.css should be readable');
});

test('there is no light variant', () => {
    // Not an arbitrary rule. The shell loads stylesheet-light.css INSTEAD of
    // this one whenever it believes the session is light, and that belief comes
    // from a setting rather than from what the panel is actually painted. Adding
    // one back reintroduces the black-on-black bug this design removed. If you
    // genuinely need one, verify the variant matches the rendered panel first.
    assertEqual(read('stylesheet-light.css'), null,
        'a light variant was added back, see the comment in this test');
});

test('every colour is legible on a dark panel', () => {
    for (const colour of colours(sheet)) {
        const ratio = contrast(colour, DARK_PANEL);
        assert(ratio >= MIN_CONTRAST,
            `${colour} is ${ratio.toFixed(2)}:1 on ${DARK_PANEL}, needs ${MIN_CONTRAST}`);
    }
});

test('every colour is legible on a light panel', () => {
    // The half that a dark-only palette silently fails. Anything in the yellow
    // to amber range cannot pass this, which is why the heat scale runs green,
    // orange, red rather than green, amber, red.
    for (const colour of colours(sheet)) {
        const ratio = contrast(colour, LIGHT_PANEL);
        assert(ratio >= MIN_CONTRAST,
            `${colour} is ${ratio.toFixed(2)}:1 on ${LIGHT_PANEL}, needs ${MIN_CONTRAST}`);
    }
});

test('muted text sets no colour of its own', () => {
    // It has to inherit the theme's foreground and dim with opacity. A literal
    // colour here is the exact bug that made the separator invisible.
    const withoutComments = sheet.replace(/\/\*[\s\S]*?\*\//g, '');

    for (const selector of ['.system-monitor-separator', '.system-monitor-label']) {
        const rule = withoutComments.match(
            new RegExp(`\\${selector} \\{[^}]*\\}`));
        assert(rule !== null, `${selector} should be defined`);
        assert(!/[^-]color\s*:/.test(rule[0]),
            `${selector} hardcodes a colour instead of inheriting`);
        assert(/opacity\s*:/.test(rule[0]),
            `${selector} should dim with opacity`);
    }
});

test('the properties the drawing code reads are declared', () => {
    // The track colour is deliberately absent: glyphs.js derives it from the
    // theme foreground rather than reading a hardcoded per-variant value.
    const declared = customProperties(sheet);

    for (const property of [
        '-system-monitor-accent-color',
        '-system-monitor-heat-low',
        '-system-monitor-heat-mid',
        '-system-monitor-heat-high',
    ])
        assert(declared.includes(property), `${property} is read but not declared`);

    assertEqual(declared.includes('-system-monitor-track-color'), false,
        'the track is derived from the theme, not declared here');
});

test('every metric has an accent colour and a reserved width', () => {
    for (const metric of ['cpu', 'memory', 'temperature', 'network', 'disk']) {
        assert(sheet.includes(`.system-monitor-metric-${metric}`),
            `${metric} has no accent colour`);
        assert(new RegExp(`\\.system-monitor-value-${metric}\\s*\\{[^}]*min-width`)
            .test(sheet), `${metric} has no reserved width`);
    }
});

test('the metric accents are distinguishable from each other', () => {
    // Five metrics sit side by side. Two that read as the same colour defeat
    // the point of colouring them at all.
    const accents = [...sheet.matchAll(
        /\.system-monitor-metric-\w+ \{ -system-monitor-accent-color: (#[0-9a-f]{6})/gi)]
        .map(m => m[1].toLowerCase());

    assertEqual(accents.length, 5, 'expected five metric accents');
    assertEqual(new Set(accents).size, 5, 'two metrics share a colour');
});
