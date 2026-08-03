/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Style presets, as data.
 *
 * The nine presets are not nine renderers. They are nine named points in a
 * space of six orthogonal axes, and compose.js is the single renderer that
 * reads those axes. Complexity belongs in this table, never in code paths: if
 * adding a tenth preset ever requires touching anything but this file, the
 * design has drifted and should be corrected rather than worked around.
 *
 * This module imports nothing at all. That is deliberate, and it is why the
 * resolution and validation logic below can be unit tested under plain gjs
 * while the drawing code cannot.
 */

/**
 * Axis definitions: every legal value, and the fallback when a stored value is
 * unrecognised. Settings can hold anything, including values written by an
 * older or newer version, so nothing here trusts its input.
 */
export const AXES = {
    // Identity: what metric is this?
    icon: {values: [true, false], fallback: true},
    label: {values: ['none', 'short', 'full'], fallback: 'none'},

    // Data: how much, trending where?
    glyph: {values: ['none', 'dot', 'vbar', 'ring', 'spark'], fallback: 'none'},
    value: {values: [true, false], fallback: true},
    under: {values: [true, false], fallback: false},

    // Presentation.
    colour: {values: ['theme', 'heat', 'metric'], fallback: 'theme'},
};

/**
 * The nine shipped presets.
 *
 * Every one carries an identity cue, an icon or a label. The four glyph presets
 * changed to icon: true for exactly that reason: a bare sparkline tells you
 * something spiked but not what, which is unusable on a fresh install where
 * nobody has learned the positions yet.
 */
export const PRESETS = Object.freeze({
    'text': {icon: false, label: 'full', glyph: 'none', value: true, colour: 'theme', under: false},
    'icon-text': {icon: true, label: 'none', glyph: 'none', value: true, colour: 'theme', under: false},
    'abbreviated': {icon: false, label: 'short', glyph: 'none', value: true, colour: 'theme', under: false},
    'colour-coded': {icon: false, label: 'full', glyph: 'none', value: true, colour: 'heat', under: false},
    'dot': {icon: true, label: 'none', glyph: 'dot', value: true, colour: 'theme', under: false},
    'sparkline': {icon: true, label: 'none', glyph: 'spark', value: true, colour: 'theme', under: false},
    'bars': {icon: true, label: 'none', glyph: 'vbar', value: true, colour: 'theme', under: false},
    'rings': {icon: true, label: 'none', glyph: 'ring', value: true, colour: 'theme', under: false},
    'underline': {icon: false, label: 'full', glyph: 'none', value: true, colour: 'theme', under: true},
});

/** Used when a preset name is unknown, and when custom mode has nothing set. */
export const DEFAULT_PRESET = 'icon-text';

/**
 * Coerces a settings value to the type its axis expects.
 *
 * GSettings stores the custom axes as a dictionary of strings, so booleans
 * arrive as "true" and "false" rather than as real booleans.
 *
 * @param {string} axis - axis name
 * @param {*} raw - stored value
 * @returns {*} a legal value for that axis, or its fallback
 */
function coerce(axis, raw) {
    const definition = AXES[axis];
    if (!definition)
        return undefined;

    if (raw === undefined || raw === null)
        return definition.fallback;

    // Boolean axes accept real booleans and their string spellings.
    if (definition.values.includes(true)) {
        if (typeof raw === 'boolean')
            return raw;

        const text = String(raw).toLowerCase();
        if (text === 'true')
            return true;
        if (text === 'false')
            return false;

        return definition.fallback;
    }

    return definition.values.includes(raw) ? raw : definition.fallback;
}

/**
 * Fills in every axis, replacing anything missing or unrecognised.
 *
 * @param {object} axes - partial or untrusted axis values
 * @returns {object} a complete, legal axis set
 */
export function normaliseAxes(axes) {
    const source = axes ?? {};
    const result = {};

    for (const axis of Object.keys(AXES))
        result[axis] = coerce(axis, source[axis]);

    return result;
}

/**
 * Renders nothing at all: no icon, no label, no glyph, no value.
 *
 * The preferences window must block this combination. An invisible indicator
 * reads as a crash rather than as a choice.
 *
 * @param {object} axes - a complete axis set
 * @returns {boolean} true if the metric would be invisible
 */
export function isDegenerate(axes) {
    if (!axes)
        return true;

    return !axes.icon &&
        axes.label === 'none' &&
        axes.glyph === 'none' &&
        !axes.value;
}

/**
 * Visible, but with nothing saying which metric it is.
 *
 * Legitimate for someone who has learned the positions, so this is allowed in
 * custom mode. It must never be true of a shipped preset.
 *
 * @param {object} axes - a complete axis set
 * @returns {boolean} true if the metric cannot be identified
 */
export function isUnidentifiable(axes) {
    if (!axes)
        return true;

    return !axes.icon && axes.label === 'none';
}

/**
 * Resolves a style setting into a complete axis set.
 *
 * @param {string} styleName - preset name, or "custom"
 * @param {object} [customAxes] - the per-metric custom dictionary
 * @returns {object} a complete, legal axis set
 */
export function resolveStyle(styleName, customAxes = {}) {
    if (styleName !== 'custom') {
        const preset = PRESETS[styleName] ?? PRESETS[DEFAULT_PRESET];
        return {...preset};
    }

    // An empty custom dictionary means the user selected custom but has not
    // changed anything yet. Falling back to a working preset is friendlier than
    // rendering the axis fallbacks, which would drop the label and show a bare
    // number.
    if (!customAxes || Object.keys(customAxes).length === 0)
        return {...PRESETS[DEFAULT_PRESET]};

    return normaliseAxes(customAxes);
}

/**
 * Load thresholds for heat mapped colouring, as percentages.
 *
 * Chosen so the common case is quiet. A machine sitting at 40 percent should
 * not be shouting amber at its owner, and a colour that is always on carries no
 * information.
 */
export const HEAT_THRESHOLDS = Object.freeze({mid: 50, high: 80});

/**
 * Maps a load percentage to a heat band.
 *
 * Note this returns a band name rather than a colour. The actual colours come
 * from the stylesheet through the theme node, so they follow light and dark
 * mode and the user's accent choice. Hardcoding hex here would defeat that.
 *
 * @param {number|null} percent - load from 0 to 100
 * @returns {string|null} "low", "mid", "high", or null if not known
 */
export function heatLevel(percent) {
    if (percent === null || percent === undefined || !Number.isFinite(percent))
        return null;

    if (percent >= HEAT_THRESHOLDS.high)
        return 'high';

    if (percent >= HEAT_THRESHOLDS.mid)
        return 'mid';

    return 'low';
}

/**
 * Finds the preset matching a given axis set, if any.
 *
 * Lets the preferences window show "sparkline" rather than "custom" when the
 * axes happen to land exactly on a shipped preset.
 *
 * @param {object} axes - a complete axis set
 * @returns {string|null} preset name, or null if this is a custom combination
 */
export function matchPreset(axes) {
    if (!axes)
        return null;

    for (const [name, preset] of Object.entries(PRESETS)) {
        const same = Object.keys(AXES).every(axis => preset[axis] === axes[axis]);
        if (same)
            return name;
    }

    return null;
}
