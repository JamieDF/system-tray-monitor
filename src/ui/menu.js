/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * The dropdown shown when the indicator is clicked.
 *
 * The body is a custom actor, not a stack of PopupMenuItems. A grid of
 * metric plots plus a full-width process table cannot be expressed as a
 * single column of menu rows, which is all PopupMenu offers. Settings is
 * still a real menu item, pinned below the scroll, so it stays reachable.
 *
 * Plots are fed on every tick, open or closed. A history that started at
 * each open would be empty every time. The process walk stays gated on
 * the menu being open: that is hundreds of /proc reads, not one push per
 * line.
 *
 * Per-core rows are deliberately absent from this layout. They made the
 * first screen taller than a laptop; the grid is what you open the menu
 * to see.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ProcessTable} from '../metrics/processes.js';
import {MenuGraphArea} from './renderers/glyphs.js';

/** How many metric tiles sit on one row of the grid. */
const GRID_COLUMNS = 2;

/**
 * Sends SIGTERM to a pid.
 *
 * kill(2) is not on GLib, and importing Posix would add a GIR the
 * preferences process does not have. Spawning `kill` keeps this in GLib,
 * and argv (not a shell string) is what stops a pid from being interpreted
 * as anything else.
 *
 * @param {number} pid - process to signal
 */
function endProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 1)
        return;

    try {
        GLib.spawn_async(
            null,
            ['kill', '-TERM', String(pid)],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null);
    } catch (error) {
        logError(error, `system-tray-monitor: could not signal process ${pid}`);
    }
}

/**
 * One metric in the grid: name, current value, and its history plot.
 */
const MetricTile = GObject.registerClass(
class MetricTile extends St.BoxLayout {
    /**
     * @param {object} params
     * @param {object} params.provider - the metric
     * @param {object|null} params.graphs - plot config, or null to hide the plot
     */
    _init({provider, graphs}) {
        super._init({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'system-tray-monitor-menu-tile',
        });

        this._provider = provider;

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'system-tray-monitor-menu-tile-header',
        });

        header.add_child(new St.Label({
            text: provider.name,
            style_class: 'system-tray-monitor-menu-tile-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._value = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-tile-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._value);
        this.add_child(header);

        this._area = null;

        if (graphs) {
            this._area = new MenuGraphArea({
                metricId: provider.id,
                seriesCount: provider.series ? provider.series(null).length : 1,
                historyLength: graphs.historyLength,
                height: graphs.height,
            });
            this.add_child(this._area);
        }
    }

    /**
     * @param {object|null} sample - reading from sample()
     * @param {object} options - formatting options
     */
    update(sample, options) {
        const text = this._provider.format(sample, options);
        if (this._value.text !== text)
            this._value.text = text;
    }

    /**
     * @param {Array<number|null>} values - one sample per plot line
     */
    setValues(values) {
        this._area?.setValues(values);
    }

    /**
     * @param {number} length - samples to retain per line
     */
    setHistoryLength(length) {
        this._area?.setHistoryLength(length);
    }

    clearHistory() {
        this._area?.clearHistory();
    }
});

/**
 * One process row: name, CPU share, RSS. Clickable when ending is allowed.
 */
const ProcessRow = GObject.registerClass(
class ProcessRow extends St.BoxLayout {
    _init() {
        super._init({
            x_expand: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
            style_class: 'popup-menu-item system-tray-monitor-menu-process',
        });

        this._pid = 0;

        this._name = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-process-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._name);

        this._cpu = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-col-cpu',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._cpu);

        this._memory = new St.Label({
            text: '',
            style_class: 'system-tray-monitor-menu-col-mem',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._memory);

        this.connect('button-release-event', () => {
            if (this._pid > 1)
                endProcess(this._pid);

            return Clutter.EVENT_STOP;
        });
    }

    /**
     * @param {{pid: number, label: string, text: string, memory: string, endable: boolean}} row
     */
    setRow(row) {
        this._pid = row.endable ? row.pid : 0;
        this.reactive = row.endable;
        this.can_focus = row.endable;
        this.track_hover = row.endable;

        if (this._name.text !== row.label)
            this._name.text = row.label;

        if (this._cpu.text !== row.text)
            this._cpu.text = row.text;

        if (this._memory.text !== row.memory)
            this._memory.text = row.memory;
    }
});

/**
 * Builds and maintains the contents of the indicator's menu.
 */
export class MetricMenu {
    /**
     * @param {PopupMenu.PopupMenu} menu - the indicator's menu
     * @param {object[]} providers - active providers, in panel order
     * @param {string} extensionPath - kept for the caller; tiles label by name
     * @param {Function} onOpenPreferences - invoked by the settings item
     * @param {Function} [onOpened] - invoked when the menu becomes visible
     * @param {object} [graphs] - plot configuration drawn from settings
     * @param {Set<string>} [graphs.enabled] - provider ids that get a plot
     * @param {number} [graphs.historyLength] - samples retained per line
     * @param {number} [graphs.height] - plot height in logical pixels
     * @param {object} [processes] - compact process list configuration
     * @param {boolean} [processes.enabled] - whether the section is shown
     * @param {number} [processes.limit] - how many pids to keep
     */
    constructor(menu, providers, extensionPath, onOpenPreferences,
        onOpened = () => {}, graphs = null, processes = null) {
        this._menu = menu;
        this._providers = providers;
        this._tiles = new Map();
        this._processTable = null;
        this._processRows = [];
        this._processBox = null;
        this._isOpen = false;

        // The shell's .popup-menu is 15em. That is why this read as a
        // receipt. The class is on the boxpointer so it beats that rule.
        menu.actor.add_style_class_name('system-tray-monitor-menu');

        this._body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'system-tray-monitor-menu-body',
        });

        const scroll = new St.ScrollView({
            style_class: 'system-tray-monitor-menu-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            child: this._body,
        });
        scroll.clip_to_allocation = true;
        menu.box.add_child(scroll);
        this._scroll = scroll;

        this._buildGrid(providers, graphs);

        if (processes?.enabled)
            this._buildProcessTable(processes.limit ?? 8);

        if (providers.length > 0 || processes?.enabled)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settings = new PopupMenu.PopupImageMenuItem(
            'Settings', 'preferences-system-symbolic');
        settings.connect('activate', () => onOpenPreferences());
        menu.addMenuItem(settings);

        this._openStateId = menu.connect('open-state-changed', (_menu, open) => {
            this._isOpen = open;

            if (open) {
                this._fitToWorkArea();
                onOpened();
                return;
            }

            for (const provider of this._providers)
                provider.resetDetail?.();

            this._processTable?.reset();
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            if (this._isOpen)
                this._fitToWorkArea();
        });
    }

    /** @returns {boolean} whether the menu is currently visible */
    get isOpen() {
        return this._isOpen;
    }

    /**
     * Applies a tick's readings.
     *
     * Plots record first, on every tick. The process walk returns immediately
     * when closed.
     *
     * @param {Map<string, object|null>} readings - provider id to sample
     * @param {object} options - formatting options drawn from settings
     */
    update(readings, options) {
        for (const provider of this._providers) {
            const tile = this._tiles.get(provider.id);
            if (!tile || !readings.has(provider.id))
                continue;

            tile.setValues(this._lineValues(provider, readings.get(provider.id)));
        }

        if (!this._isOpen)
            return;

        for (const provider of this._providers) {
            const tile = this._tiles.get(provider.id);
            if (tile && readings.has(provider.id))
                tile.update(readings.get(provider.id), options);
        }

        if (this._processTable)
            this._syncProcessRows(this._processTable.top(options));
    }

    /**
     * @param {number} length - samples to retain per plot line
     */
    setHistoryLength(length) {
        for (const tile of this._tiles.values())
            tile.setHistoryLength(length);
    }

    /**
     * Discards plot history alongside the panel's.
     */
    clearHistory() {
        for (const tile of this._tiles.values())
            tile.clearHistory();

        this._processTable?.reset();
    }

    /**
     * @param {number} limit - rows to keep in the process list
     */
    setProcessLimit(limit) {
        this._processTable?.setLimit(limit);
    }

    /**
     * Lays out one tile per enabled metric, left to right then down.
     *
     * @param {object[]} providers - active metrics in panel order
     * @param {object|null} graphs - plot configuration
     */
    _buildGrid(providers, graphs) {
        if (providers.length === 0)
            return;

        const plotted = graphs?.enabled ?? new Set();
        const layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
            column_homogeneous: true,
            column_spacing: 8,
            row_spacing: 8,
        });
        const grid = new St.Widget({
            layout_manager: layout,
            x_expand: true,
            style_class: 'system-tray-monitor-menu-grid',
        });

        providers.forEach((provider, index) => {
            const tile = new MetricTile({
                provider,
                graphs: plotted.has(provider.id) ? graphs : null,
            });
            layout.attach(tile, index % GRID_COLUMNS, Math.floor(index / GRID_COLUMNS), 1, 1);
            this._tiles.set(provider.id, tile);
        });

        this._body.add_child(grid);
    }

    /**
     * @param {number} limit - how many pids to keep
     */
    _buildProcessTable(limit) {
        this._processTable = new ProcessTable();
        this._processTable.setLimit(limit);

        const heading = new St.Label({
            text: 'Processes',
            style_class: 'system-tray-monitor-menu-heading',
        });
        this._body.add_child(heading);

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'system-tray-monitor-menu-process-header',
        });
        header.add_child(new St.Label({
            text: 'Process',
            style_class: 'system-tray-monitor-menu-process-name',
            x_expand: true,
        }));
        header.add_child(new St.Label({
            text: 'CPU',
            style_class: 'system-tray-monitor-menu-col-cpu',
        }));
        header.add_child(new St.Label({
            text: 'Memory',
            style_class: 'system-tray-monitor-menu-col-mem',
        }));
        this._body.add_child(header);

        this._processBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'system-tray-monitor-menu-process-list',
        });
        this._body.add_child(this._processBox);
    }

    /**
     * Caps the scroll pane to whatever monitor the indicator is on.
     *
     * There is no window size to set. The shell sizes panel menus from the
     * work area, and this does the same for the inner pane, measuring the
     * Settings row rather than guessing a margin. CSS max-height is in
     * logical pixels, the work area is not, so the scale factor has to
     * come along.
     */
    _fitToWorkArea() {
        if (!this._scroll || !this._menu?.sourceActor)
            return;

        const index = Main.layoutManager.findIndexForActor(this._menu.sourceActor);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            index >= 0 ? index : Main.layoutManager.primaryIndex);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        const available = workArea.height
            - this._menu.actor.margin_top
            - this._menu.actor.margin_bottom
            - this._themeVertical(this._menu.actor)
            - this._footerHeight();

        const maxHeight = Math.max(120, Math.round(available / scale));
        this._scroll.style = `max-height: ${maxHeight}px;`;
    }

    /**
     * Height of every sibling below the scroll pane, in physical pixels.
     *
     * @returns {number} Settings row, separator, and any future chrome
     */
    _footerHeight() {
        let height = 0;

        for (const child of this._menu.box.get_children()) {
            if (child === this._scroll || !child.visible)
                continue;

            const [, natural] = child.get_preferred_height(-1);
            height += natural;
        }

        return height;
    }

    /**
     * Padding and border from the theme, in physical pixels.
     *
     * @param {Clutter.Actor} actor - typically the boxpointer
     * @returns {number} vertical chrome
     */
    _themeVertical(actor) {
        try {
            const node = actor.get_theme_node();
            return node.get_padding(St.Side.TOP)
                + node.get_padding(St.Side.BOTTOM)
                + node.get_border_width(St.Side.TOP)
                + node.get_border_width(St.Side.BOTTOM);
        } catch {
            return 0;
        }
    }

    /**
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
     * @param {Array<{pid: number, label: string, text: string, memory: string, endable: boolean}>} rows
     */
    _syncProcessRows(rows) {
        if (!this._processBox)
            return;

        while (this._processRows.length < rows.length) {
            const item = new ProcessRow();
            this._processBox.add_child(item);
            this._processRows.push(item);
        }

        this._processRows.forEach((item, index) => {
            if (index < rows.length) {
                item.setRow(rows[index]);
                item.visible = true;
            } else {
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

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        this._tiles.clear();
        this._processRows = [];
        this._processBox = null;
        this._processTable = null;
        this._body = null;
        this._scroll = null;
        this._menu = null;
        this._providers = [];
    }
}
