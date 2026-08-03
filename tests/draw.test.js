/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Glyph drawing.
 *
 * The plan assumed this code could not be tested, on the grounds that Cairo
 * drawing needs a running shell. That turned out to be wrong: the drawing only
 * needs a Cairo context, and gjs can make one against an offscreen image
 * surface with no display server at all. Keeping draw.js free of St and Clutter
 * types is what buys that.
 *
 * These assert what was actually drawn by counting pixels, not merely that
 * nothing threw. A repaint that silently draws nothing is the failure mode that
 * matters here, and it looks identical to a layout bug from the outside.
 */

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {
    drawBar,
    drawDot,
    drawRing,
    drawSpark,
    parseColour,
} from '../src/ui/renderers/draw.js';
import {assert, assertClose, assertEqual, suite, test} from './harness.js';

suite('draw');

const COLOURS = {
    track: parseColour('rgba(255, 255, 255, 0.22)'),
    fill: parseColour('#78aeed'),
};

let counter = 0;

/**
 * Runs a drawing function against an offscreen surface and returns its pixels.
 *
 * Cairo's own surface data is not exposed through the gjs bindings, so this
 * goes out through a PNG and back in via GdkPixbuf. Slower than reading memory,
 * but it is the only route and these surfaces are tiny.
 *
 * @param {number} width - surface width
 * @param {number} height - surface height
 * @param {Function} fn - receives (cr, geometry)
 * @returns {GdkPixbuf.Pixbuf} what was drawn
 */
function render(width, height, fn) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);

    fn(cr, {width, height});

    cr.$dispose();
    surface.flush();

    const path = GLib.build_filenamev([
        GLib.get_tmp_dir(), `system-monitor-draw-${counter++}.png`,
    ]);
    surface.writeToPNG(path);
    surface.finish();

    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    GLib.unlink(path);

    return pixbuf;
}

/**
 * Counts pixels with any opacity at all.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - rendered output
 * @returns {number} number of pixels that were painted
 */
function paintedPixels(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    let count = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * rowstride + x * channels;
            const alpha = channels === 4 ? pixels[offset + 3] : 255;
            if (alpha > 0)
                count++;
        }
    }

    return count;
}

test('parses the hex form St theme colours stringify to', () => {
    const colour = parseColour('#78aeedff');
    assertClose(colour.r, 0x78 / 255, 1e-6);
    assertClose(colour.g, 0xae / 255, 1e-6);
    assertClose(colour.b, 0xed / 255, 1e-6);
    assertClose(colour.a, 1, 1e-6);
});

test('parses hex without an alpha channel', () => {
    const colour = parseColour('#000000');
    assertClose(colour.r, 0, 1e-6);
    assertClose(colour.a, 1, 1e-6, 'missing alpha means opaque');
});

test('parses the rgba form used for track colours', () => {
    const colour = parseColour('rgba(255, 255, 255, 0.22)');
    assertClose(colour.r, 1, 1e-6);
    assertClose(colour.a, 0.22, 1e-6);
});

test('an unparseable colour falls back visibly rather than throwing', () => {
    // Rendering in the wrong colour is recoverable. Taking the panel down over
    // a stylesheet typo is not.
    const colour = parseColour('not a colour');
    assertClose(colour.a, 1, 1e-6);
    assertEqual(Number.isFinite(colour.r), true);

    for (const input of [null, undefined, 42, {}])
        assertEqual(Number.isFinite(parseColour(input).r), true, `${input} should fall back`);
});

test('a dot is actually drawn', () => {
    const painted = paintedPixels(render(16, 16, (cr, g) => drawDot(cr, g, COLOURS, 0.5)));
    assert(painted > 100, `expected a filled circle, only ${painted} pixels painted`);
});

test('a dot with no reading still draws, in the track colour', () => {
    // It must remain visible so the metric does not appear to vanish while a
    // rate provider waits for its second sample.
    const painted = paintedPixels(render(16, 16, (cr, g) => drawDot(cr, g, COLOURS, null)));
    assert(painted > 100, 'an unknown dot should still be visible');
});

test('a fuller bar paints more than an emptier one', () => {
    const low = paintedPixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, 0.1)));
    const high = paintedPixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, 0.9)));

    // Both cover the whole track, so compare opaque coverage instead: the track
    // is 22 percent alpha and the fill is opaque.
    assertEqual(low, high, 'the track covers the full area in both cases');

    const lowOpaque = opaquePixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, 0.1)));
    const highOpaque = opaquePixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, 0.9)));
    assert(highOpaque > lowOpaque,
        `expected a taller fill, got ${lowOpaque} then ${highOpaque}`);
});

/**
 * Counts fully opaque pixels, which distinguishes fill from the translucent
 * track.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - rendered output
 * @returns {number} number of fully opaque pixels
 */
function opaquePixels(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();

    let count = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const offset = y * rowstride + x * channels;

            // A PNG with no transparency anywhere loads back as three channel
            // RGB. Treating a missing alpha channel as zero opacity would
            // report a completely filled glyph as completely empty.
            if (channels < 4 || pixels[offset + 3] === 255)
                count++;
        }
    }

    return count;
}

test('a bar with no reading draws the track and no fill', () => {
    const opaque = opaquePixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, null)));
    assertEqual(opaque, 0, 'nothing should be filled when the value is unknown');
});

test('a small but nonzero bar is still visible', () => {
    // Rounding a real load away to nothing would report an idle system.
    const opaque = opaquePixels(render(8, 32, (cr, g) => drawBar(cr, g, COLOURS, 0.001)));
    assert(opaque > 0, 'a tiny load should still paint something');
});

test('a fuller ring paints more arc than an emptier one', () => {
    const quarter = opaquePixels(render(32, 32, (cr, g) => drawRing(cr, g, COLOURS, 0.25)));
    const full = opaquePixels(render(32, 32, (cr, g) => drawRing(cr, g, COLOURS, 1)));

    assert(full > quarter * 2, `expected a much longer arc, got ${quarter} then ${full}`);
});

test('a ring with no reading draws only its track', () => {
    const opaque = opaquePixels(render(32, 32, (cr, g) => drawRing(cr, g, COLOURS, null)));
    assertEqual(opaque, 0, 'no progress arc should be drawn');

    const painted = paintedPixels(render(32, 32, (cr, g) => drawRing(cr, g, COLOURS, null)));
    assert(painted > 0, 'the track should still be visible');
});

test('a ring too small to draw does not throw', () => {
    // Can happen mid-allocation before the widget has its real size. The
    // surface itself stays 4x4 because Cairo rejects a zero sized one; what is
    // under test is the drawing code's handling of a tiny geometry.
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 4, 4);
    const cr = new Cairo.Context(surface);

    for (const size of [0, 1, 2, 3])
        drawRing(cr, {width: size, height: size}, COLOURS, 0.5);

    cr.$dispose();
    surface.finish();
});

test('a sparkline is actually drawn', () => {
    const values = [1, 5, 2, 8, 3, 9, 4];
    const range = {min: 1, max: 9};
    const painted = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS, values, range)));

    assert(painted > 20, `expected a visible line, only ${painted} pixels painted`);
});

test('a flat series draws a line rather than vanishing', () => {
    // Zero span. Dividing by it would give NaN coordinates and Cairo would
    // silently draw nothing, which looks exactly like a broken graph.
    const painted = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS, [5, 5, 5, 5], {min: 5, max: 5})));

    assert(painted > 20, `a flat line should still be drawn, got ${painted}`);
});

test('gaps break the line instead of being interpolated across', () => {
    // A line drawn straight through a period with no readings claims data we
    // do not have.
    const withGap = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS,
            [1, 9, 1, null, null, 1, 9, 1], {min: 1, max: 9})));
    const without = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS,
            [1, 9, 1, 5, 5, 1, 9, 1], {min: 1, max: 9})));

    assert(withGap < without,
        `a gapped series should paint less, got ${withGap} against ${without}`);
});

test('too few points draws nothing rather than a degenerate line', () => {
    for (const values of [[], [5], [null]]) {
        const painted = paintedPixels(render(48, 16,
            (cr, g) => drawSpark(cr, g, COLOURS, values, {min: 0, max: 10})));
        assertEqual(painted, 0, `${JSON.stringify(values)} should draw nothing`);
    }
});

test('a null range draws nothing', () => {
    const painted = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS, [1, 2, 3], null)));
    assertEqual(painted, 0);
});

test('an all-gap series draws nothing', () => {
    const painted = paintedPixels(render(48, 16,
        (cr, g) => drawSpark(cr, g, COLOURS, [null, null, null], {min: 0, max: 1})));
    assertEqual(painted, 0);
});

test('every glyph survives a zero sized surface', () => {
    // Actors are allocated before they have a real size, and a repaint can land
    // in that window.
    const geometry = {width: 0, height: 0};
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
    const cr = new Cairo.Context(surface);

    drawDot(cr, geometry, COLOURS, 0.5);
    drawBar(cr, geometry, COLOURS, 0.5);
    drawRing(cr, geometry, COLOURS, 0.5);
    drawSpark(cr, geometry, COLOURS, [1, 2], {min: 1, max: 2});

    cr.$dispose();
    surface.finish();
});
