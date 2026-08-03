/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Preset resolution.
 *
 * presets.js imports nothing, which is what lets this run headless. The drawing
 * code it feeds cannot be tested this way, so pushing every decision that can
 * be made without a display into this module is what keeps the untested surface
 * small.
 */

import {
    AXES,
    DEFAULT_PRESET,
    PRESETS,
    isDegenerate,
    isUnidentifiable,
    matchPreset,
    normaliseAxes,
    resolveStyle,
} from '../src/ui/renderers/presets.js';
import {assert, assertEqual, assertNull, suite, test} from './harness.js';

suite('presets');

test('there are eight presets', () => {
    assertEqual(Object.keys(PRESETS).length, 8);
});

test('every preset sets every axis', () => {
    // A missing axis would silently take a fallback at render time, making the
    // table lie about what a preset does.
    for (const [name, preset] of Object.entries(PRESETS)) {
        for (const axis of Object.keys(AXES)) {
            assert(preset[axis] !== undefined,
                `preset "${name}" is missing axis "${axis}"`);
        }
    }
});

test('every preset value is legal for its axis', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
        for (const [axis, definition] of Object.entries(AXES)) {
            assert(definition.values.includes(preset[axis]),
                `preset "${name}" has illegal ${axis}="${preset[axis]}"`);
        }
    }
});

test('no shipped preset is unidentifiable', () => {
    // The rule that forced icon: true onto the four glyph presets. A bare
    // sparkline shows that something spiked but not what.
    for (const [name, preset] of Object.entries(PRESETS)) {
        assertEqual(isUnidentifiable(preset), false,
            `preset "${name}" has no icon and no label, so nothing says what it is`);
    }
});

test('no shipped preset is degenerate', () => {
    for (const [name, preset] of Object.entries(PRESETS))
        assertEqual(isDegenerate(preset), false, `preset "${name}" renders nothing`);
});

test('the four glyph presets carry an icon', () => {
    for (const name of ['dot', 'sparkline', 'bars', 'rings'])
        assertEqual(PRESETS[name].icon, true, `${name} should show an icon`);
});

test('resolves a known preset by name', () => {
    const axes = resolveStyle('rings');
    assertEqual(axes.glyph, 'ring');
    assertEqual(axes.icon, true);
});

test('resolving returns a copy, not the shared table', () => {
    // Mutating a resolved style must not corrupt the preset for every other
    // metric using it.
    const axes = resolveStyle('rings');
    axes.glyph = 'spark';
    assertEqual(PRESETS.rings.glyph, 'ring', 'the table should be untouched');
});

test('an unknown preset name falls back rather than breaking', () => {
    // Settings can hold a value written by a newer version.
    const axes = resolveStyle('no-such-preset');
    assertEqual(axes.glyph, PRESETS[DEFAULT_PRESET].glyph);
    assertEqual(axes.icon, PRESETS[DEFAULT_PRESET].icon);
});

test('custom with nothing set falls back to a working preset', () => {
    // Selecting custom before changing anything should not drop the label and
    // leave a bare number.
    const axes = resolveStyle('custom', {});
    assertEqual(matchPreset(axes), DEFAULT_PRESET);
});

test('custom axes override the defaults', () => {
    const axes = resolveStyle('custom', {glyph: 'ring', colour: 'heat'});
    assertEqual(axes.glyph, 'ring');
    assertEqual(axes.colour, 'heat');
});

test('booleans survive the trip through GSettings as strings', () => {
    // The custom dictionary is a{ss}, so booleans arrive spelled out.
    assertEqual(resolveStyle('custom', {icon: 'false'}).icon, false);
    assertEqual(resolveStyle('custom', {icon: 'true'}).icon, true);
    assertEqual(resolveStyle('custom', {icon: 'TRUE'}).icon, true);
    assertEqual(resolveStyle('custom', {icon: 'true', value: 'false'}).value, false);
});

test('real booleans work too', () => {
    assertEqual(normaliseAxes({icon: false}).icon, false);
    assertEqual(normaliseAxes({icon: true}).icon, true);
});

test('illegal values fall back instead of reaching the renderer', () => {
    assertEqual(normaliseAxes({glyph: 'hologram'}).glyph, AXES.glyph.fallback);
    assertEqual(normaliseAxes({label: 'enormous'}).label, AXES.label.fallback);
    assertEqual(normaliseAxes({colour: 'plaid'}).colour, AXES.colour.fallback);
    assertEqual(normaliseAxes({icon: 'perhaps'}).icon, AXES.icon.fallback);
});

test('normalising fills in every axis', () => {
    const axes = normaliseAxes({});
    for (const axis of Object.keys(AXES))
        assert(axes[axis] !== undefined, `${axis} should be filled in`);
});

test('normalising tolerates null and undefined', () => {
    for (const input of [null, undefined]) {
        const axes = normaliseAxes(input);
        for (const axis of Object.keys(AXES))
            assert(axes[axis] !== undefined, `${axis} should be filled in`);
    }
});

test('unknown keys in the custom dictionary are ignored', () => {
    const axes = normaliseAxes({glyph: 'ring', somethingElse: 'yes'});
    assertEqual(axes.glyph, 'ring');
    assertEqual(axes.somethingElse, undefined, 'stray keys should not pass through');
});

test('detects the combination that renders nothing', () => {
    // The preferences window must block this. An invisible indicator reads as
    // a crash rather than as a choice.
    assertEqual(isDegenerate({
        icon: false, label: 'none', glyph: 'none', value: false, colour: 'theme',
    }), true);
});

test('anything visible is not degenerate', () => {
    const invisible = {
        icon: false, label: 'none', glyph: 'none', value: false, colour: 'theme',
    };
    assertEqual(isDegenerate({...invisible, icon: true}), false, 'an icon is enough');
    assertEqual(isDegenerate({...invisible, label: 'short'}), false, 'a label is enough');
    assertEqual(isDegenerate({...invisible, glyph: 'ring'}), false, 'a glyph is enough');
    assertEqual(isDegenerate({...invisible, value: true}), false, 'a value is enough');
});

test('detects a visible but unidentifiable combination', () => {
    // Allowed in custom mode for someone who knows the positions, never as a
    // shipped default.
    assertEqual(isUnidentifiable({
        icon: false, label: 'none', glyph: 'spark', value: true, colour: 'theme',
    }), true);
});

test('either identity cue is enough', () => {
    const bare = {icon: false, label: 'none', glyph: 'spark', value: true, colour: 'theme'};
    assertEqual(isUnidentifiable({...bare, icon: true}), false);
    assertEqual(isUnidentifiable({...bare, label: 'short'}), false);
});

test('guards tolerate missing input', () => {
    assertEqual(isDegenerate(null), true);
    assertEqual(isUnidentifiable(null), true);
});

test('matchPreset names an exact preset', () => {
    for (const name of Object.keys(PRESETS))
        assertEqual(matchPreset(PRESETS[name]), name);
});

test('matchPreset returns null for a genuine custom combination', () => {
    const custom = {...PRESETS.rings, colour: 'heat'};
    assertNull(matchPreset(custom));
});

test('matchPreset ignores stray keys', () => {
    assertEqual(matchPreset({...PRESETS.text, extra: 'ignored'}), 'text');
});

test('round trip: every preset resolves back to its own name', () => {
    for (const name of Object.keys(PRESETS))
        assertEqual(matchPreset(resolveStyle(name)), name, `${name} should round trip`);
});
