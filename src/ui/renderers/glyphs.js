/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * The St widget that hosts a Cairo drawn glyph.
 *
 * Deliberately thin. All the actual drawing lives in draw.js as pure functions
 * that take a Cairo context and plain numbers, so it can be rendered to an
 * offscreen surface and tested under plain gjs. What remains here is the part
 * that genuinely needs a running shell: theme colour lookup, repaint plumbing
 * and the widget lifecycle.
 *
 * Patterned on the shell's own barLevel.js. Four things it does that are easy
 * to miss:
 *
 *   1. Colours are read from the theme node, never hardcoded. Cairo has no idea
 *      the stylesheet exists, so a literal hex breaks in light mode and ignores
 *      the user's accent colour.
 *   2. Theme colours are cached in vfunc_style_changed rather than looked up on
 *      every repaint.
 *   3. queue_repaint must be called whenever the data changes. Miss it and the
 *      graph silently freezes while the numbers beside it keep updating.
 *   4. cr.$dispose() at the end of every repaint.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {drawBar, drawDot, drawRing, drawSpark, parseColour} from './draw.js';
import {History} from './history.js';
import {heatLevel} from './presets.js';

/** Used only if the stylesheet fails to load entirely. */
const FALLBACK_TRACK = 'rgba(255, 255, 255, 0.22)';
const FALLBACK_ACCENT = '#78aeed';

/** How visible the unfilled part of a gauge is against the panel. */
const TRACK_ALPHA = 0.22;

/**
 * Reads a colour from the theme node and converts it to plain components.
 *
 * lookup_color returns [found, colour] rather than raising, which matters
 * because a custom property that is absent is a stylesheet bug we should render
 * through rather than crash on.
 *
 * The colour is converted via to_string() instead of by reading its fields.
 * That keeps this working whether the shell hands back a Clutter.Color or a
 * Cogl.Color, which has changed between versions.
 *
 * @param {St.ThemeNode} themeNode - node to read from
 * @param {string} property - custom CSS property name
 * @param {string} fallback - CSS colour used if the property is missing
 * @returns {{r: number, g: number, b: number, a: number}} components 0 to 1
 */
function themeColour(themeNode, property, fallback) {
    const [found, colour] = themeNode.lookup_color(property, false);

    if (!found)
        return parseColour(fallback);

    try {
        return parseColour(colour.to_string());
    } catch {
        return parseColour(fallback);
    }
}

/**
 * The unfilled part of a gauge, derived from the theme's own foreground colour.
 *
 * Deliberately not a stylesheet value. The shell chooses between
 * stylesheet.css and stylesheet-light.css from the colour-scheme setting, which
 * does not reliably match what the panel actually renders as: on Ubuntu the
 * panel can be dark while the setting says light. A hardcoded light or dark
 * track is then invisible against its own background.
 *
 * The foreground colour cannot be wrong in that way, because the theme has
 * already picked something that contrasts with whatever it is drawing on.
 *
 * @param {St.ThemeNode} themeNode - node to read from
 * @returns {{r: number, g: number, b: number, a: number}} components 0 to 1
 */
function trackColour(themeNode) {
    try {
        const base = parseColour(themeNode.get_foreground_color().to_string());
        return {...base, a: TRACK_ALPHA};
    } catch {
        return parseColour(FALLBACK_TRACK);
    }
}

export const GlyphArea = GObject.registerClass(
class GlyphArea extends St.DrawingArea {
    /**
     * @param {object} params - construction parameters
     * @param {string} params.kind - dot, vbar, ring or spark
     * @param {string} params.metricId - used to pick the accent colour class
     * @param {number} [params.historyLength] - sparkline buffer size
     * @param {number} [params.graphWidth] - sparkline width in logical pixels
     */
    _init(params) {
        const {kind, metricId, historyLength = 20, graphWidth = 0, ...rest} = params;

        super._init({
            style_class: `system-monitor-glyph system-monitor-glyph-${kind} system-monitor-metric-${metricId}`,
            y_align: Clutter.ActorAlign.CENTER,
            ...rest,
        });

        // Width comes from the stylesheet by default. A configured width has to
        // be applied inline, since CSS cannot read settings. St scales the value
        // for HiDPI either way.
        if (kind === 'spark' && graphWidth > 0)
            this.set_style(`width: ${graphWidth}px;`);

        this._kind = kind;
        this._fraction = null;
        this._heat = null;
        this._useHeat = false;
        this._history = kind === 'spark' ? new History(historyLength) : null;

        this._trackColour = parseColour(FALLBACK_TRACK);
        this._accentColour = parseColour(FALLBACK_ACCENT);
        this._heatColours = {};
    }

    /**
     * Updates what the glyph shows.
     *
     * Two different numbers, because the glyphs need different things. A ring,
     * bar or dot fills against a known maximum, so it needs a fraction from 0
     * to 1. A sparkline has no fixed maximum and scales itself against the
     * range in its own history, so it needs the raw magnitude. Network and disk
     * rates have no natural ceiling at all, which is exactly why they get
     * sparklines by default and why their fraction is null.
     *
     * @param {object} reading - what to display
     * @param {number|null} reading.fraction - fill level from 0 to 1
     * @param {number|null} reading.magnitude - raw value for self-scaling graphs
     * @param {object} [options] - display options
     * @param {boolean} [options.useHeat] - colour by load rather than by metric
     */
    setValue(reading, options = {}) {
        const {fraction = null, magnitude = null} = reading ?? {};
        const {useHeat = false} = options;

        const clamped = Number.isFinite(fraction)
            ? Math.min(1, Math.max(0, fraction))
            : null;

        if (this._kind === 'spark')
            this._history?.push(magnitude);

        const heat = clamped === null ? null : heatLevel(clamped * 100);
        const changed = clamped !== this._fraction ||
            heat !== this._heat ||
            useHeat !== this._useHeat ||
            this._kind === 'spark';

        this._fraction = clamped;
        this._heat = heat;
        this._useHeat = useHeat;

        // Repainting when nothing moved is wasted work on the compositor's main
        // thread, which is where jank comes from. Sparklines always redraw
        // because their window advances even when the value is unchanged.
        if (changed)
            this.queue_repaint();
    }

    /**
     * Resizes the sparkline buffer after a settings change.
     *
     * @param {number} length - number of samples to retain
     */
    setHistoryLength(length) {
        this._history?.resize(length);
        this.queue_repaint();
    }

    /**
     * Discards history, so a graph does not draw a line across a period when
     * polling was stopped.
     */
    clearHistory() {
        this._history?.clear();
        this._fraction = null;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        const themeNode = this.get_theme_node();

        this._trackColour = trackColour(themeNode);
        this._accentColour = themeColour(themeNode,
            '-system-monitor-accent-color', FALLBACK_ACCENT);
        this._heatColours = {
            low: themeColour(themeNode, '-system-monitor-heat-low', FALLBACK_ACCENT),
            mid: themeColour(themeNode, '-system-monitor-heat-mid', FALLBACK_ACCENT),
            high: themeColour(themeNode, '-system-monitor-heat-high', FALLBACK_ACCENT),
        };

        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        try {
            if (width <= 0 || height <= 0)
                return;

            const geometry = {width, height};
            const colours = {track: this._trackColour, fill: this._fillColour()};

            switch (this._kind) {
            case 'dot':
                drawDot(cr, geometry, colours, this._fraction);
                break;
            case 'vbar':
                drawBar(cr, geometry, colours, this._fraction);
                break;
            case 'ring':
                drawRing(cr, geometry, colours, this._fraction);
                break;
            case 'spark':
                drawSpark(cr, geometry, colours,
                    this._history?.values() ?? [], this._history?.range() ?? null);
                break;
            }
        } finally {
            // Must happen even if drawing threw, or the context leaks and GJS
            // complains on every subsequent frame.
            cr.$dispose();
        }
    }

    /**
     * @returns {object} RGBA components the filled part should use
     */
    _fillColour() {
        if (this._useHeat && this._heat !== null)
            return this._heatColours[this._heat] ?? this._accentColour;

        return this._accentColour;
    }
});
