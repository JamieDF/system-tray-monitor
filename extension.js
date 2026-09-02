/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Panel entry point. This file runs inside the gnome-shell process, so it may
 * import St, Clutter and shell modules. It must never import Gtk, Gdk or Adw:
 * that is an extensions.gnome.org review rule, not a style preference.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createActiveProviders} from './src/metrics/registry.js';
import {Poller} from './src/poller.js';
import {MetricMenu} from './src/ui/menu.js';
import {MetricWidget} from './src/ui/renderers/compose.js';
import {resolveStyle} from './src/ui/renderers/presets.js';

/** Characters drawn between metrics, by the separator setting. */
const SEPARATORS = {
    space: null,
    dot: '·',
    pipe: '|',
};

const SystemTrayMonitorIndicator = GObject.registerClass(
class SystemTrayMonitorIndicator extends PanelMenu.Button {
    /**
     * @param {object} params - construction parameters
     * @param {Array<{provider: object, axes: object}>} params.metrics - what to show
     * @param {string} params.extensionPath - for resolving bundled icons
     * @param {string} params.separator - separator style name
     * @param {number} params.historyLength - sparkline buffer size
     * @param {number} params.graphWidth - sparkline width in logical pixels
     * @param {object} [params.menuGraphs] - dropdown plot configuration
     * @param {object} [params.processes] - compact process list configuration
     */
    _init(params) {
        const {
            metrics, extensionPath, separator, historyLength, graphWidth,
            menuGraphs, processes, onOpenPreferences, onMenuOpened,
        } = params;

        super._init(0.5, 'System Tray Monitor', false);

        this._widgets = new Map();

        this._box = new St.BoxLayout({
            style_class: separator === 'space'
                ? 'system-tray-monitor-box'
                : 'system-tray-monitor-box system-tray-monitor-box-tight',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        const separatorText = SEPARATORS[separator] ?? null;

        metrics.forEach(({provider, axes}, index) => {
            if (separatorText !== null && index > 0) {
                this._box.add_child(new St.Label({
                    text: separatorText,
                    style_class: 'system-tray-monitor-separator',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            const widget = new MetricWidget({
                provider,
                axes,
                extensionPath,
                historyLength,
                graphWidth,
            });

            this._widgets.set(provider.id, widget);
            this._box.add_child(widget);
        });

        this._menu = new MetricMenu(
            this.menu,
            metrics.map(m => m.provider),
            extensionPath,
            onOpenPreferences,
            onMenuOpened,
            menuGraphs,
            processes);
    }

    /**
     * Applies a tick's readings.
     *
     * @param {Map<string, object|null>} readings - provider id to sample
     * @param {object} options - formatting options drawn from settings
     */
    update(readings, options) {
        for (const [id, widget] of this._widgets) {
            if (readings.has(id))
                widget.update(readings.get(id), options);
        }

        // Returns immediately unless the dropdown is actually open.
        this._menu.update(readings, options);
    }

    /**
     * @param {number} length - samples to retain per sparkline
     */
    setHistoryLength(length) {
        for (const widget of this._widgets.values())
            widget.setHistoryLength(length);
    }

    /**
     * @param {number} length - samples to retain per plot line
     */
    setMenuHistoryLength(length) {
        this._menu?.setHistoryLength(length);
    }

    /**
     * @param {number} limit - rows to keep in the dropdown process list
     */
    setProcessLimit(limit) {
        this._menu?.setProcessLimit(limit);
    }

    /**
     * Discards graph history, panel and dropdown alike, so a resumed graph does
     * not draw a line across the period polling was stopped.
     */
    clearHistory() {
        for (const widget of this._widgets.values())
            widget.clearHistory();

        this._menu?.clearHistory();
    }

    destroy() {
        this._menu?.destroy();
        this._menu = null;

        this._widgets?.clear();
        this._widgets = null;
        this._box = null;

        super.destroy();
    }
});

export default class SystemTrayMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsIds = [];
        this._sessionModeId = 0;
        this._removeListener = null;

        this._poller = new Poller({
            intervalSeconds: this._settings.get_int('refresh-interval'),
        });
        this._removeListener = this._poller.addListener(
            readings => this._onReadings(readings));

        this._rebuild();
        this._connectSettings();

        this._sessionModeId = Main.sessionMode.connect(
            'updated', () => this._syncPolling());

        this._syncPolling();
    }

    disable() {
        // Everything created in enable() is destroyed here. Leaked timers and
        // signal handlers surviving a lock and unlock cycle are the single most
        // common reason extensions are rejected on review.
        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];

        this._removeListener?.();
        this._removeListener = null;

        this._poller?.destroy();
        this._poller = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }

    /**
     * Subscribes to settings changes.
     *
     * One connection to the generic "changed" signal rather than one per key.
     * The per-metric style keys depend on which metrics are enabled, so keyed
     * connections would have to be torn down and rebuilt every time that list
     * changed, from inside the very handler doing the tearing down. Dispatching
     * on the key here avoids that entirely.
     */
    _connectSettings() {
        this._settingsIds.push(this._settings.connect(
            'changed', (_settings, key) => this._onSettingChanged(key)));
    }

    /**
     * @param {string} key - the setting that changed
     */
    _onSettingChanged(key) {
        // Anything that changes the shape of the widget tree.
        const rebuilds = ['enabled-metrics', 'separator', 'graph-width',
            'menu-graph-height', 'show-processes'];
        if (rebuilds.includes(key) || key.endsWith('-style') ||
            key.endsWith('-custom') || key.endsWith('-menu-graph')) {
            this._rebuild();
            return;
        }

        if (key === 'refresh-interval') {
            this._poller.setInterval(this._settings.get_int('refresh-interval'));
            return;
        }

        // Resizing a buffer keeps the samples already in it, so this needs no
        // rebuild and the graph does not blink.
        if (key === 'history-length') {
            this._indicator?.setHistoryLength(this._settings.get_int('history-length'));
            return;
        }

        if (key === 'menu-history-length') {
            this._indicator?.setMenuHistoryLength(
                this._settings.get_int('menu-history-length'));
            return;
        }

        if (key === 'process-count') {
            this._indicator?.setProcessLimit(this._settings.get_int('process-count'));
            return;
        }

        // Formatting-only changes need no rebuild and no fresh sample, just a
        // redraw from the readings already in hand. Sampling again would also
        // give rate metrics a reading over a tiny interval and make them jump.
        if (['show-percent-sign', 'temp-unit', 'net-unit', 'disk-unit'].includes(key))
            this._poller.refresh();
    }

    /**
     * Rebuilds the indicator from the current settings.
     */
    _rebuild() {
        this._indicator?.destroy();

        const providers = createActiveProviders(
            this._settings.get_strv('enabled-metrics'));

        const metrics = providers.map(provider => ({
            provider,
            axes: resolveStyle(
                this._settings.get_string(`${provider.id}-style`),
                this._readCustomAxes(provider.id)),
        }));

        this._indicator = new SystemTrayMonitorIndicator({
            metrics,
            extensionPath: this.path,
            separator: this._settings.get_string('separator'),
            historyLength: this._settings.get_int('history-length'),
            graphWidth: this._settings.get_int('graph-width'),
            menuGraphs: {
                enabled: new Set(providers
                    .filter(provider =>
                        this._settings.get_boolean(`${provider.id}-menu-graph`))
                    .map(provider => provider.id)),
                historyLength: this._settings.get_int('menu-history-length'),
                height: this._settings.get_int('menu-graph-height'),
            },
            processes: {
                enabled: this._settings.get_boolean('show-processes'),
                limit: this._settings.get_int('process-count'),
            },
            onOpenPreferences: () => this.openPreferences(),
            onMenuOpened: () => this._poller.refresh(),
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._poller.setProviders(providers);
    }

    /**
     * Reads a metric's custom axis dictionary.
     *
     * @param {string} metricId - the metric
     * @returns {object} plain object of axis name to string value
     */
    _readCustomAxes(metricId) {
        const variant = this._settings.get_value(`${metricId}-custom`);
        const axes = {};

        for (let i = 0; i < variant.n_children(); i++) {
            const entry = variant.get_child_value(i);
            axes[entry.get_child_value(0).get_string()[0]] =
                entry.get_child_value(1).get_string()[0];
        }

        return axes;
    }

    /**
     * Starts or stops polling to match the session state.
     *
     * The panel is not visible while the screen is locked, so sampling through
     * a locked session is pure waste. Stopping also clears provider baselines
     * and graph history, which is what stops the first reading after unlock
     * reporting the whole locked period as one enormous spike, and stops the
     * sparkline drawing a straight line across it.
     */
    _syncPolling() {
        if (!this._poller)
            return;

        if (Main.sessionMode.isLocked) {
            this._poller.stop();
            this._indicator?.clearHistory();
        } else {
            this._poller.start();
        }
    }

    /**
     * @param {Map<string, object|null>} readings - provider id to sample
     */
    _onReadings(readings) {
        // One flat options object for every provider. Each reads only the keys
        // it understands and ignores the rest, which keeps this from growing a
        // per-metric branch as more settings arrive.
        //
        // Network and disk each get their own bits flag rather than sharing
        // one. They are separate settings, and collapsing them here would make
        // disk-unit silently do nothing.
        this._indicator?.update(readings, {
            showPercentSign: this._settings.get_boolean('show-percent-sign'),
            tempUnit: this._settings.get_string('temp-unit'),
            netAsBits: this._settings.get_string('net-unit') === 'bits',
            diskAsBits: this._settings.get_string('disk-unit') === 'bits',
        });
    }
}
