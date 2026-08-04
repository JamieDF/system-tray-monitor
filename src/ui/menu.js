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
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {resolveIcon} from './icons.js';

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
            style_class: 'system-monitor-menu-heading',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._value = new St.Label({
            text: '',
            style_class: 'system-monitor-menu-total',
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
            style_class: 'system-monitor-menu-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._value = new St.Label({
            text: '',
            style_class: 'system-monitor-menu-value',
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
 * Builds and maintains the contents of the indicator's menu.
 */
export class MetricMenu {
    /**
     * @param {PopupMenu.PopupMenu} menu - the indicator's menu
     * @param {object[]} providers - active providers, in panel order
     * @param {string} extensionPath - for resolving bundled icons
     * @param {Function} onOpenPreferences - invoked by the settings item
     * @param {Function} [onOpened] - invoked when the menu becomes visible
     */
    constructor(menu, providers, extensionPath, onOpenPreferences, onOpened = () => {}) {
        this._menu = menu;
        this._providers = providers;
        this._sections = new Map();
        this._isOpen = false;

        providers.forEach((provider, index) => {
            if (index > 0)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const header = new HeaderItem(provider, extensionPath);
            menu.addMenuItem(header);

            // Detail rows are created lazily, because how many there are is not
            // known until the metric is asked. Core count is the obvious case.
            this._sections.set(provider.id, {header, rows: [], provider});
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
     * Returns immediately when closed, which is what keeps per-core parsing off
     * the normal path.
     *
     * @param {Map<string, object|null>} readings - provider id to sample
     * @param {object} options - formatting options drawn from settings
     */
    update(readings, options) {
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
     * Syncs a section's detail rows to the data, creating or hiding rows as the
     * count changes.
     *
     * @param {object} section - the section being updated
     * @param {Array<{label: string, text: string}>} rows - current detail
     */
    _updateRows(section, rows) {
        while (section.rows.length < rows.length) {
            const item = new DetailItem();

            // Inserted directly after the heading and any rows already there,
            // so a section's rows stay together rather than landing at the end
            // of the whole menu.
            const position = this._menu._getMenuItems().indexOf(section.header) +
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
