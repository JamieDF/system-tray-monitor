/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Output width stability.
 *
 * The panel reserves a fixed width per metric so a value getting shorter does
 * not drag every metric to its right leftward. Those reserved widths live in
 * the stylesheets and were measured from what the formatters can produce, which
 * makes them a duplicated fact: change a formatter to emit something longer and
 * the reservation silently stops working, bringing the jitter back with no
 * error anywhere.
 *
 * These tests sweep the entire plausible input range through the real
 * formatters and pin the longest output. They assert character counts rather
 * than pixels, so they hold regardless of which font a user runs.
 */

import GLib from 'gi://GLib';

import {
    formatGibibytes,
    formatPercent,
    formatRate,
    formatTemperature,
} from '../src/metrics/units.js';
import {assert, assertEqual, suite, test} from './harness.js';

suite('width');

/**
 * Longest string a generator can produce across a swept range.
 *
 * @param {Function} generate - receives a number, returns formatted text
 * @param {number[]} inputs - values to sweep
 * @returns {{text: string, length: number}} the longest output
 */
function longest(generate, inputs) {
    let text = '';

    for (const input of inputs) {
        const candidate = generate(input);
        if (candidate.length > text.length)
            text = candidate;
    }

    return {text, length: text.length};
}

/**
 * @param {number} from - first value
 * @param {number} to - last value
 * @param {number} step - increment
 * @returns {number[]} the range
 */
function range(from, to, step) {
    const values = [];
    for (let v = from; v <= to; v += step)
        values.push(v);
    return values;
}

const GIB = 1024 ** 3;

test('percentages never exceed four characters', () => {
    const {text, length} = longest(p => formatPercent(p), range(0, 100, 1));
    assertEqual(text, '100%');
    assert(length <= 4, `percent grew to "${text}"`);
    assert(formatPercent(null).length <= 4, 'the unknown placeholder must fit too');
});

test('memory never exceeds seven characters', () => {
    // Covers machines up to 1024 GiB. Beyond that the reservation would need
    // revisiting, which is precisely what this test would tell you.
    const {text, length} = longest(g => formatGibibytes(g * GIB), range(0, 1024, 0.5));
    assert(length <= 7, `memory grew to "${text}" at ${length} characters`);
    assert(formatGibibytes(null).length <= 7, 'the unknown placeholder must fit too');
});

test('temperature never exceeds five characters', () => {
    const inputs = range(0, 150, 1);
    const celsius = longest(t => formatTemperature(t), inputs);
    const fahrenheit = longest(t => formatTemperature(t, {unit: 'fahrenheit'}), inputs);

    assert(celsius.length <= 5, `celsius grew to "${celsius.text}"`);
    assert(fahrenheit.length <= 5, `fahrenheit grew to "${fahrenheit.text}"`);
    assert(formatTemperature(null).length <= 5, 'the unknown placeholder must fit too');
});

test('rates never exceed seven characters', () => {
    // Every magnitude from bytes per second to gigabytes per second, at the
    // mantissas that produce the longest strings.
    const inputs = [];
    for (let exponent = 0; exponent < 12; exponent++) {
        for (const mantissa of [1, 1.05, 3.3, 5, 8.8, 9.9, 9.99])
            inputs.push(mantissa * 10 ** exponent);
    }

    const bytes = longest(r => formatRate(r), inputs);
    const bits = longest(r => formatRate(r, {asBits: true}), inputs);

    assert(bytes.length <= 7, `byte rate grew to "${bytes.text}" at ${bytes.length}`);
    assert(bits.length <= 7, `bit rate grew to "${bits.text}" at ${bits.length}`);
    assert(formatRate(null).length <= 7, 'the unknown placeholder must fit too');
});

test('rates keep three significant digits, never four', () => {
    // The rule that shrank the worst case from "888.8MB/s" to "888MB/s", which
    // was 71px against 54px of permanently reserved panel width.
    assertEqual(formatRate(888.8 * 1000 * 1000), '889MB/s');
    assertEqual(formatRate(8.84 * 1000 * 1000), '8.8MB/s');
    assertEqual(formatRate(99.9 * 1000 * 1000), '100MB/s');
});

test('a fraction is kept below ten, where it carries information', () => {
    // 1.4MB/s against 1MB/s is a 40 percent difference. 141MB/s against
    // 141.4MB/s is not worth the width.
    assertEqual(formatRate(1.4 * 1000 * 1000), '1.4MB/s');
    assertEqual(formatRate(9.9 * 1000 * 1000), '9.9MB/s');
});

test('bytes per second carry no fraction at all', () => {
    // A tenth of a byte per second is not a meaningful quantity.
    assertEqual(formatRate(5), '5B/s');
    assertEqual(formatRate(5.7), '6B/s');
});

test('every reserved width is declared for every metric', () => {
    // The reservation is per metric, applied by a class the renderer builds
    // from the provider id. A missing rule means that metric silently keeps
    // jittering while the others are fixed.
    const [self] = GLib.filename_from_uri(import.meta.url);
    const root = GLib.path_get_dirname(GLib.path_get_dirname(self));

    for (const sheet of ['stylesheet.css', 'stylesheet-light.css']) {
        const [ok, bytes] = GLib.file_get_contents(
            GLib.build_filenamev([root, sheet]));
        assert(ok, `${sheet} should be readable`);

        const css = new TextDecoder('utf-8').decode(bytes);

        for (const metric of ['cpu', 'memory', 'temperature', 'network', 'disk']) {
            const pattern = new RegExp(
                `\\.system-monitor-value-${metric}\\s*\\{[^}]*min-width`);
            assert(pattern.test(css),
                `${sheet} has no reserved width for ${metric}`);
        }
    }
});
