/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * THE renderer.
 *
 * There is one of these, not nine. Every preset is a set of axis values that
 * this class reads, so adding a tenth preset is an entry in presets.js and
 * nothing else. If a change ever requires a branch in here keyed on a preset
 * name, the design has drifted and should be corrected rather than worked
 * around.
 *
 * Parts are laid out identity first, then data: icon, label, glyph, value. That
 * ordering means the eye lands on what a number measures before the number
 * itself, which is the whole reason the identity axes exist.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {GlyphArea} from './glyphs.js';
import {heatLevel} from './presets.js';
import {resolveIcon} from '../icons.js';

export const MetricWidget = GObject.registerClass(
class MetricWidget extends St.BoxLayout {
    /**
     * @param {object} params - construction parameters
     * @param {object} params.provider - the metric provider
     * @param {object} params.axes - a complete axis set from presets.js
     * @param {string} params.extensionPath - for resolving bundled icons
     * @param {number} [params.historyLength] - sparkline buffer size
     * @param {number} [params.graphWidth] - sparkline width in logical pixels
     */
    _init(params) {
        const {provider, axes, extensionPath, historyLength = 20, graphWidth = 0} = params;

        super._init({
            style_class: 'system-monitor-metric',
            y_align: Clutter.ActorAlign.CENTER,
            // The underline variant stacks a progress bar beneath the row, so
            // the outer box runs vertically in that case only.
            orientation: axes.under
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        });

        this._provider = provider;
        this._axes = axes;

        // With an underline the parts live in their own row inside the vertical
        // outer box. Without one the outer box is the row.
        this._row = axes.under
            ? new St.BoxLayout({
                style_class: 'system-monitor-parts',
                y_align: Clutter.ActorAlign.CENTER,
            })
            : this;

        if (axes.under)
            this.add_child(this._row);

        this._buildParts(extensionPath, historyLength, graphWidth);

        this._underline = null;
        if (axes.under) {
            this._underline = new GlyphArea({
                kind: 'hbar',
                metricId: provider.id,
                x_expand: true,
            });
            this.add_child(this._underline);
        }
    }

    /**
     * Creates the parts the axes call for, and only those. A part that is
     * switched off is never constructed rather than being built and hidden.
     *
     * @param {string} extensionPath - for resolving bundled icons
     * @param {number} historyLength - sparkline buffer size
     * @param {number} graphWidth - sparkline width in logical pixels
     */
    _buildParts(extensionPath, historyLength, graphWidth) {
        const {icon, label, glyph, value} = this._axes;

        this._icon = null;
        this._label = null;
        this._glyph = null;
        this._value = null;

        if (icon) {
            this._icon = new St.Icon({
                gicon: resolveIcon(extensionPath, this._provider.iconName),
                style_class: 'system-status-icon system-monitor-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._row.add_child(this._icon);
        }

        if (label !== 'none') {
            this._label = new St.Label({
                text: this._labelText(label),
                style_class: 'system-monitor-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._row.add_child(this._label);
        }

        if (glyph !== 'none') {
            this._glyph = new GlyphArea({
                kind: glyph,
                metricId: this._provider.id,
                historyLength,
                graphWidth,
            });
            this._row.add_child(this._glyph);
        }

        if (value) {
            this._value = new St.Label({
                text: this._provider.format(null, {}),
                style_class: 'system-monitor-value',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._row.add_child(this._value);
        }
    }

    /**
     * @param {string} style - "short" or "full"
     * @returns {string} the identity text for this metric
     */
    _labelText(style) {
        const full = this._provider.label;

        return style === 'short' ? full.charAt(0) : full;
    }

    /**
     * Applies a reading.
     *
     * @param {object|null} sample - reading from the provider
     * @param {object} options - formatting options drawn from settings
     */
    update(sample, options) {
        const fraction = this._provider.fraction?.(sample) ?? null;
        const magnitude = this._provider.magnitude?.(sample) ?? null;
        const useHeat = this._axes.colour === 'heat';

        if (this._value) {
            const text = this._provider.format(sample, options);

            // Assigning an unchanged string still triggers a relayout. At one
            // tick every couple of seconds forever, skipping that adds up.
            if (this._value.text !== text)
                this._value.text = text;

            this._applyValueColour(fraction);
        }

        this._glyph?.setValue({fraction, magnitude}, {useHeat});
        this._underline?.setValue({fraction, magnitude}, {useHeat});
    }

    /**
     * Colours the value text according to the colour axis.
     *
     * Done with style classes rather than inline colours so the actual values
     * stay in the stylesheet, where they follow light and dark mode.
     *
     * @param {number|null} fraction - current load from 0 to 1
     */
    _applyValueColour(fraction) {
        const {colour} = this._axes;

        let suffix = '';
        if (colour === 'metric') {
            suffix = ` system-monitor-tint-${this._provider.id}`;
        } else if (colour === 'heat') {
            const band = fraction === null ? null : heatLevel(fraction * 100);
            suffix = band === null ? '' : ` system-monitor-heat-${band}`;
        }

        const wanted = `system-monitor-value${suffix}`;

        // Setting style_class re-runs the CSS cascade for this actor, so only
        // do it when the class actually changes.
        if (this._value.style_class !== wanted)
            this._value.style_class = wanted;
    }

    /**
     * Resizes the sparkline buffer after a settings change.
     *
     * @param {number} length - samples to retain
     */
    setHistoryLength(length) {
        this._glyph?.setHistoryLength(length);
    }

    /**
     * Discards graph history, so a resumed graph does not draw a line across
     * the period polling was stopped.
     */
    clearHistory() {
        this._glyph?.clearHistory();
        this._underline?.clearHistory();
    }

    destroy() {
        this._icon = null;
        this._label = null;
        this._glyph = null;
        this._value = null;
        this._underline = null;
        this._row = null;
        this._provider = null;

        super.destroy();
    }
});
