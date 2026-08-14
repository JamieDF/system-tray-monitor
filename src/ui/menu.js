/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * The dropdown shown when the indicator is clicked.
 *
 * Its job is the detail the panel has no room for: which core is busy rather
 * than the average, which direction the network traffic is going, whether swap
 * is in use, which sensor the temperature comes from.
 *
 * Detail is only computed while this is open. That is not a micro-optimisation:
 * per-core parsing walks one line per core on every tick, forever, to serve a
 * menu that is closed almost all of the time. The providers keep it out of
 * sample() for that reason, and this file is what turns it on and off.
 *
 * The graphs are the exception to that gating. Their histories are fed on
 * every tick, because a plot of the last minute is worth nothing if it only
 * covers the seconds since the menu was opened, and the cost is one bounded
 * array push per line, which is not in the same class as the parsing above.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {resolveIcon} from './icons.js';
import {MenuGraphArea} from './renderers/glyphs.js';

/**
 * A metric's heading inside the menu: icon, full name, and the same value the
 * panel is showing.
 */
const HeaderItem = GObject.registerClass(
class HeaderItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} provider - the metric
     * @param {string} extensionPath - for resolving bundled icons
     */
    _init(provider, extensionPath) {
        // Not reactive: this is a label, not a control. Leaving it clickable
        // would give it a hover highlight that invites a click doing nothing.
        super._init({reactive: false, can_focus: false});

        this.add_child(new St.Icon({
            gicon: resolveIcon(extensionPath, provider.iconName),
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this.add_child(new St.Label({
            text: provider.name,
            style_class: 'system-tray-monitor-menu-heading',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._value = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-total',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    /**
     * @param {string} text - the current panel value
     */
    setValue(text) {
        if (this._value.text !== text)
            this._value.text = text;
    }
});

/**
 * One detail line: a name on the left, a value on the right.
 */
const DetailItem = GObject.registerClass(
class DetailItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false});

        this._label = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._value = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    /**
     * @param {{label: string, text: string}} row - the detail to show
     */
    setRow(row) {
        if (this._label.text !== row.label)
            this._label.text = row.label;

        if (this._value.text !== row.text)
            this._value.text = row.text;
    }
});

/**
 * A metric's plot inside the menu: a history graph filling the row.
 */
const GraphItem = GObject.registerClass(
class GraphItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} provider - the metric being plotted
     * @param {object} graphs - plot configuration drawn from settings
     * @param {number} graphs.historyLength - samples retained per line
     * @param {number} graphs.height - plot height in logical pixels
     */
    _init(provider, graphs) {
        super._init({reactive: false, can_focus: false});

        // series(null) is a valid call and reveals the line count without
        // needing a reading, the same way detail(null) reveals the row shape.
        this._area = new MenuGraphArea({
            metricId: provider.id,
            seriesCount: provider.series ? provider.series(null).length : 1,
            historyLength: graphs.historyLength,
            height: graphs.height,
        });
        this.add_child(this._area);
    }

    /**
     * @param {Array<number|null>} values - one sample per line
     */
    setValues(values) {
        this._area.setValues(values);
    }

    /**
     * @param {number} length - number of samples to retain
     */
    setHistoryLength(length) {
        this._area.setHistoryLength(length);
    }

    /**
     * Discards history, so a resumed plot does not draw a line across a period
     * when polling was stopped.
     */
    clearHistory() {
        this._area.clearHistory();
    }
});

/**
 * Builds and maintains the contents of the indicator's menu.
 */
export class MetricMenu {
    /**
     * @param {PopupMenu.PopupMenu} menu - the indicator's menu
     * @param {object[]} providers - active providers, in panel order
     * @param {string} extensionPath - for resolving bundled icons
     * @param {Function} onOpenPreferences - invoked by the settings item
     * @param {Function} [onOpened] - invoked when the menu becomes visible
     * @param {object} [graphs] - plot configuration drawn from settings
     * @param {Set<string>} [graphs.enabled] - provider ids that get a plot
     * @param {number} [graphs.historyLength] - samples retained per line
     * @param {number} [graphs.height] - plot height in logical pixels
     */
    constructor(menu, providers, extensionPath, onOpenPreferences,
        onOpened = () => {}, graphs = null) {
        this._menu = menu;
        this._providers = providers;
        this._sections = new Map();
        this._isOpen = false;

        const plotted = graphs?.enabled ?? new Set();

        providers.forEach((provider, index) => {
            if (index > 0)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const header = new HeaderItem(provider, extensionPath);
            menu.addMenuItem(header);

            // The plot sits between the heading and the detail rows. It is
            // what the menu was opened to see; the rows are the numbers
            // behind it.
            let graph = null;

            if (plotted.has(provider.id)) {
                graph = new GraphItem(provider, graphs);
                menu.addMenuItem(graph);
            }

            // Detail rows are created lazily, because how many there are is not
            // known until the metric is asked. Core count is the obvious case.
            this._sections.set(provider.id, {header, graph, rows: [], provider});
        });

        if (providers.length > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settings = new PopupMenu.PopupImageMenuItem(
            'Settings', 'preferences-system-symbolic');
        settings.connect('activate', () => onOpenPreferences());
        menu.addMenuItem(settings);

        this._openStateId = menu.connect('open-state-changed', (_menu, open) => {
            this._isOpen = open;

            if (open) {
                // Fill in from the readings already in hand rather than showing
                // an empty menu until the next tick, which at the default
                // interval would be up to two seconds of nothing.
                onOpened();
                return;
            }

            // Providers holding per-core baselines have nothing useful on the
            // first tick after opening. Dropping them on close means the next
            // open starts clean rather than reporting the whole closed period.
            for (const {provider} of this._sections.values())
                provider.resetDetail?.();
        });
    }

    /** @returns {boolean} whether the menu is currently visible */
    get isOpen() {
        return this._isOpen;
    }

    /**
     * Applies a tick's readings.
     *
     * The plots record first, on every tick, so their histories cover the
     * closed period. The rest returns immediately when closed, which is what
     * keeps per-core parsing off the normal path.
     *
     * @param {Map<string, object|null>} readings - provider id to sample
     * @param {object} options - formatting options drawn from settings
     */
    update(readings, options) {
        for (const [id, section] of this._sections) {
            if (readings.has(id))
                section.graph?.setValues(this._lineValues(section.provider, readings.get(id)));
        }

        if (!this._isOpen)
            return;

        for (const [id, section] of this._sections) {
            if (!readings.has(id))
                continue;

            const sample = readings.get(id);
            section.header.setValue(section.provider.format(sample, options));

            this._updateRows(section, section.provider.detail?.(sample, options) ?? []);
        }
    }

    /**
     * Resizes each plot's buffers after a settings change.
     *
     * @param {number} length - samples to retain per line
     */
    setHistoryLength(length) {
        for (const {graph} of this._sections.values())
            graph?.setHistoryLength(length);
    }

    /**
     * Discards plot history alongside the panel's, so a resumed plot does not
     * draw a line across the period polling was stopped.
     */
    clearHistory() {
        for (const {graph} of this._sections.values())
            graph?.clearHistory();
    }

    /**
     * The values a section's plot should record.
     *
     * Metrics with a direction to separate say so through series(). The rest
     * plot the same single magnitude the panel sparkline uses, which keeps
     * this from growing a per-metric branch.
     *
     * @param {object} provider - the metric being plotted
     * @param {object|null} sample - reading from sample()
     * @returns {Array<number|null>} one value per line
     */
    _lineValues(provider, sample) {
        if (provider.series)
            return provider.series(sample);

        return [provider.magnitude?.(sample) ?? null];
    }

    /**
     * Syncs a section's detail rows to the data, creating or hiding rows as the
     * count changes.
     *
     * @param {object} section - the section being updated
     * @param {Array<{label: string, text: string}>} rows - current detail
     */
    _updateRows(section, rows) {
        while (section.rows.length < rows.length) {
            const item = new DetailItem();

            // Inserted directly after the heading, or the plot when there is
            // one, and any rows already there, so a section's rows stay
            // together rather than landing at the end of the whole menu.
            const anchor = section.graph ?? section.header;
            const position = this._menu._getMenuItems().indexOf(anchor) +
                section.rows.length + 1;
            this._menu.addMenuItem(item, position);
            section.rows.push(item);
        }

        section.rows.forEach((item, index) => {
            if (index < rows.length) {
                item.setRow(rows[index]);
                item.visible = true;
            } else {
                // Kept rather than destroyed. Core count does not change, and a
                // metric that briefly reports fewer rows should not thrash the
                // widget tree.
                item.visible = false;
            }
        });
    }

    /**
     * Disconnects and drops everything. The menu's own items are destroyed by
     * the indicator that owns it.
     */
    destroy() {
        if (this._openStateId) {
            this._menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }

        this._sections.clear();
        this._menu = null;
        this._providers = [];
    }
}
