/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * The actual glyph drawing, as pure functions.
 *
 * Separated from glyphs.js on purpose. These take a Cairo context and plain
 * numbers, import nothing, and touch no St or Clutter types, which means they
 * can be run against an offscreen ImageSurface under plain gjs. The drawing is
 * therefore testable and renderable to a PNG, where a method on an
 * St.DrawingArea subclass would need a running shell and human eyes.
 *
 * Colours arrive as {r, g, b, a} with components from 0 to 1, converted from
 * theme colours by the caller. Keeping Clutter's colour type out of here is
 * what makes these runnable headlessly, and it also means this code does not
 * care whether the shell hands back a Clutter.Color or a Cogl.Color.
 */

/**
 * Fills a circle.
 *
 * @param {object} cr - Cairo context
 * @param {{width: number, height: number}} geometry - surface size
 * @param {{track: object, fill: object}} colours - RGBA colours
 * @param {number|null} fraction - 0 to 1, or null when unknown
 */
export function drawDot(cr, geometry, colours, fraction) {
    const {width, height} = geometry;
    const radius = Math.min(width, height) / 2;

    const colour = fraction === null ? colours.track : colours.fill;

    cr.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
    setColour(cr, colour);
    cr.fill();
}

/**
 * A vertical level, filling upward from the bottom.
 *
 * @param {object} cr - Cairo context
 * @param {{width: number, height: number}} geometry - surface size
 * @param {{track: object, fill: object}} colours - RGBA colours
 * @param {number|null} fraction - 0 to 1, or null when unknown
 */
export function drawBar(cr, geometry, colours, fraction) {
    const {width, height} = geometry;

    cr.rectangle(0, 0, width, height);
    setColour(cr, colours.track);
    cr.fill();

    if (fraction === null || fraction <= 0)
        return;

    // A minimum height so a small but nonzero load is still visible rather than
    // rounding away to nothing.
    const filled = Math.max(width / 2, height * fraction);

    cr.rectangle(0, height - filled, width, filled);
    setColour(cr, colours.fill);
    cr.fill();
}

/**
 * A full width progress bar, drawn beneath the text.
 *
 * @param {object} cr - Cairo context
 * @param {{width: number, height: number}} geometry - surface size
 * @param {{track: object, fill: object}} colours - RGBA colours
 * @param {number|null} fraction - 0 to 1, or null when unknown
 */
export function drawUnderline(cr, geometry, colours, fraction) {
    const {width, height} = geometry;

    cr.rectangle(0, 0, width, height);
    setColour(cr, colours.track);
    cr.fill();

    if (fraction === null || fraction <= 0)
        return;

    cr.rectangle(0, 0, width * fraction, height);
    setColour(cr, colours.fill);
    cr.fill();
}

/**
 * A ring gauge.
 *
 * @param {object} cr - Cairo context
 * @param {{width: number, height: number}} geometry - surface size
 * @param {{track: object, fill: object}} colours - RGBA colours
 * @param {number|null} fraction - 0 to 1, or null when unknown
 */
export function drawRing(cr, geometry, colours, fraction) {
    const {width, height} = geometry;

    const lineWidth = Math.max(2, Math.round(Math.min(width, height) / 7));
    const radius = (Math.min(width, height) - lineWidth) / 2;

    if (radius <= 0)
        return;

    const cx = width / 2;
    const cy = height / 2;

    cr.setLineWidth(lineWidth);
    cr.setLineCap(CAIRO_LINE_CAP_ROUND);

    cr.arc(cx, cy, radius, 0, Math.PI * 2);
    setColour(cr, colours.track);
    cr.stroke();

    if (fraction === null || fraction <= 0)
        return;

    // Twelve o'clock, running clockwise, which is how every gauge a user has
    // ever seen behaves.
    const start = -Math.PI / 2;

    cr.arc(cx, cy, radius, start, start + Math.PI * 2 * fraction);
    setColour(cr, colours.fill);
    cr.stroke();
}

/**
 * A sparkline over a series of samples.
 *
 * Nulls in the series are gaps rather than zeroes. The line breaks across them
 * instead of interpolating, so a period with no readings is visibly absent
 * rather than invented.
 *
 * @param {object} cr - Cairo context
 * @param {{width: number, height: number}} geometry - surface size
 * @param {{track: object, fill: object}} colours - RGBA colours
 * @param {Array<number|null>} values - samples, oldest first
 * @param {{min: number, max: number}|null} range - the span to scale against
 */
export function drawSpark(cr, geometry, colours, values, range) {
    const {width, height} = geometry;

    if (!Array.isArray(values) || values.length < 2 || range === null)
        return;

    const lineWidth = Math.max(1, Math.round(height / 10));
    const usable = height - lineWidth;
    const span = range.max - range.min;

    const yFor = value => {
        // A flat series has zero span. Dividing by it would give NaN
        // coordinates and Cairo would silently draw nothing at all.
        if (span === 0)
            return height / 2;

        return lineWidth / 2 + usable - ((value - range.min) / span) * usable;
    };

    cr.setLineWidth(lineWidth);
    cr.setLineJoin(CAIRO_LINE_JOIN_ROUND);
    cr.setLineCap(CAIRO_LINE_CAP_ROUND);
    setColour(cr, colours.fill);

    let drawing = false;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];

        if (value === null || !Number.isFinite(value)) {
            drawing = false;
            continue;
        }

        const x = (i / (values.length - 1)) * width;
        const y = yFor(value);

        if (drawing) {
            cr.lineTo(x, y);
        } else {
            cr.moveTo(x, y);
            drawing = true;
        }
    }

    cr.stroke();
}

/** Cairo enum values, spelled out so this file needs no imports at all. */
const CAIRO_LINE_CAP_ROUND = 1;
const CAIRO_LINE_JOIN_ROUND = 1;

/**
 * Applies an RGBA colour to the context.
 *
 * @param {object} cr - Cairo context
 * @param {{r: number, g: number, b: number, a: number}} colour - components 0 to 1
 */
function setColour(cr, colour) {
    const {r = 0, g = 0, b = 0, a = 1} = colour ?? {};
    cr.setSourceRGBA(r, g, b, a);
}

/**
 * Parses a CSS colour string into the component form these functions expect.
 *
 * Accepts the "#rrggbbaa" that St theme colours stringify to, the shorter
 * "#rrggbb", and "rgba(r, g, b, a)". Falls back to opaque mid grey rather than
 * throwing, since a colour that fails to parse should render visibly wrong
 * rather than take the panel down.
 *
 * @param {string} text - colour string
 * @returns {{r: number, g: number, b: number, a: number}} components 0 to 1
 */
export function parseColour(text) {
    const fallback = {r: 0.5, g: 0.5, b: 0.5, a: 1};

    if (typeof text !== 'string')
        return fallback;

    const hex = text.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (hex) {
        const value = Number.parseInt(hex[1], 16);
        return {
            r: ((value >> 16) & 0xff) / 255,
            g: ((value >> 8) & 0xff) / 255,
            b: (value & 0xff) / 255,
            a: hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255,
        };
    }

    const rgba = text.trim().match(
        /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (rgba) {
        return {
            r: Number(rgba[1]) / 255,
            g: Number(rgba[2]) / 255,
            b: Number(rgba[3]) / 255,
            a: rgba[4] === undefined ? 1 : Number(rgba[4]),
        };
    }

    return fallback;
}
