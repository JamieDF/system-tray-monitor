/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Preferences window.
 *
 * This file runs in its own process, not inside gnome-shell. It may import Gtk,
 * Gdk and Adw, and it must never import Clutter, Meta, St or Shell. That is an
 * extensions.gnome.org review rule rather than a style preference, and it is
 * also simply true: those libraries are not loaded here.
 *
 * The only channel back to the running extension is GSettings. There is no
 * shared memory, no direct calls, nothing else. Every control below writes a
 * key and the panel reacts, which is why there is no live preview here: it
 * would mean a second implementation of every glyph in GTK, kept in sync by
 * hand, when the real panel is already visible a few hundred pixels above.
 */

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {createAllProviders} from './src/metrics/registry.js';
import {resolveIcon} from './src/ui/icons.js';
import {
    AXES,
    PRESETS,
    isDegenerate,
    isUnidentifiable,
    normaliseAxes,
} from './src/ui/renderers/presets.js';

/** Preset names in the order they are offered, with custom last. */
const PRESET_NAMES = [...Object.keys(PRESETS), 'custom'];

/** Human readable labels for each preset. */
const PRESET_LABELS = {
    'text': 'Text only',
    'icon-text': 'Icon and value',
    'abbreviated': 'Short label',
    'colour-coded': 'Colour coded',
    'dot': 'Dot',
    'sparkline': 'Sparkline',
    'bars': 'Bar',
    'rings': 'Ring',
    'custom': 'Custom',
};

/**
 * The custom axes, in the order they are presented, with readable labels.
 *
 * Identity axes come first, because "what is this?" is the question a user is
 * answering when they open this section. sep is absent on purpose: a separator
 * sits between two metrics, so it belongs to the group and lives on the
 * Appearance page instead.
 */
const AXIS_ROWS = [
    {axis: 'icon', title: 'Icon', subtitle: 'Symbol identifying the metric'},
    {axis: 'label', title: 'Label', subtitle: 'Text identifying the metric'},
    {axis: 'glyph', title: 'Graph', subtitle: 'How the value is drawn'},
    {axis: 'value', title: 'Value', subtitle: 'The number itself'},
    {axis: 'colour', title: 'Colour', subtitle: 'How the value is tinted'},
];

/** Readable labels for axis values. */
const AXIS_VALUE_LABELS = {
    icon: {true: 'Shown', false: 'Hidden'},
    label: {none: 'None', short: 'Short', full: 'Full'},
    glyph: {none: 'None', dot: 'Dot', vbar: 'Bar', ring: 'Ring', spark: 'Sparkline'},
    value: {true: 'Shown', false: 'Hidden'},
    colour: {theme: 'Theme', heat: 'By load', metric: 'Per metric'},
};

/**
 * Builds a combo row backed by a fixed list of values.
 *
 * @param {object} params - row configuration
 * @param {string} params.title - row title
 * @param {string} [params.subtitle] - row subtitle
 * @param {Array} params.values - the underlying values
 * @param {object} params.labels - value to display string
 * @param {*} params.selected - currently selected value
 * @param {Function} params.onChange - called with the newly selected value
 * @returns {Adw.ComboRow} the configured row
 */
function comboRow({title, subtitle, values, labels, selected, onChange}) {
    const model = new Gtk.StringList();
    for (const value of values)
        model.append(labels[String(value)] ?? String(value));

    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? null,
        model,
        selected: Math.max(0, values.findIndex(v => v === selected)),
    });

    let suppress = false;

    row.connect('notify::selected', () => {
        if (suppress)
            return;

        onChange(values[row.selected]);
    });

    // Lets callers correct a selection without re-entering their own handler.
    row.setValueQuietly = value => {
        const index = values.findIndex(v => v === value);
        if (index < 0 || index === row.selected)
            return;

        suppress = true;
        row.selected = index;
        suppress = false;
    };

    return row;
}

export default class SystemMonitorPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window - the window to populate
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Constructed here rather than hardcoded, so the list of metrics has a
        // single source of truth shared with the panel. Providers import only
        // GLib, which is why they are usable from this process at all.
        const providers = createAllProviders();

        window.add(this._metricsPage(settings, providers));
        window.add(this._appearancePage(settings));
        window.add(this._unitsPage(settings));

        window.set_default_size(620, 720);
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object[]} providers - every known provider
     * @returns {Adw.PreferencesPage} the metrics page
     */
    _metricsPage(settings, providers) {
        const page = new Adw.PreferencesPage({
            title: 'Metrics',
            icon_name: 'view-list-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Panel metrics',
            description: 'Shown left to right in the order below. ' +
                'A metric that is switched off is never sampled.',
        });
        page.add(group);

        // Rebuilding the whole group on a change is simpler than surgically
        // moving rows, and at five metrics the cost is irrelevant.
        //
        // The added rows are tracked explicitly rather than walked from the
        // group, because a PreferencesGroup's real children are its internal
        // box and header, not the rows added to it.
        let shown = [];

        const rebuild = () => {
            for (const row of shown)
                group.remove(row);

            shown = this._orderedProviders(settings, providers)
                .map(provider => this._metricRow(settings, provider, rebuild));

            for (const row of shown)
                group.add(row);
        };

        rebuild();

        return page;
    }

    /**
     * Orders providers for display: enabled ones in their configured order,
     * then the rest.
     *
     * enabled-metrics carries both membership and order, so a disabled metric
     * has no position of its own. Listing the disabled ones afterwards is
     * simpler than adding a second ordering key that would then need keeping in
     * sync with the first.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {object[]} providers - every known provider
     * @returns {object[]} providers in display order
     */
    _orderedProviders(settings, providers) {
        const enabled = settings.get_strv('enabled-metrics');
        const byId = new Map(providers.map(p => [p.id, p]));

        const ordered = enabled
            .map(id => byId.get(id))
            .filter(p => p !== undefined);

        const seen = new Set(ordered.map(p => p.id));

        return [...ordered, ...providers.filter(p => !seen.has(p.id))];
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object} provider - the metric
     * @param {Function} rebuild - re-renders the whole list
     * @returns {Adw.ExpanderRow} the row for this metric
     */
    _metricRow(settings, provider, rebuild) {
        const styleKey = `${provider.id}-style`;
        const style = settings.get_string(styleKey);
        const enabled = settings.get_strv('enabled-metrics');
        const isEnabled = enabled.includes(provider.id);
        const available = provider.isAvailable();

        const row = new Adw.ExpanderRow({
            title: provider.name,
            subtitle: this._rowSubtitle(provider, style, isEnabled, available),
            sensitive: available,
        });

        row.add_prefix(new Gtk.Image({gicon: resolveIcon(this.path, provider.iconName)}));

        // Reordering only means anything for metrics that are in the list.
        const index = enabled.indexOf(provider.id);
        const up = new Gtk.Button({
            icon_name: 'go-up-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: isEnabled && index > 0,
            tooltip_text: 'Move left in the panel',
        });
        const down = new Gtk.Button({
            icon_name: 'go-down-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: isEnabled && index >= 0 && index < enabled.length - 1,
            tooltip_text: 'Move right in the panel',
        });

        up.connect('clicked', () => {
            this._move(settings, provider.id, -1);
            rebuild();
        });
        down.connect('clicked', () => {
            this._move(settings, provider.id, 1);
            rebuild();
        });

        row.add_suffix(up);
        row.add_suffix(down);

        const toggle = new Gtk.Switch({
            active: isEnabled,
            valign: Gtk.Align.CENTER,
        });
        toggle.connect('notify::active', () => {
            this._setEnabled(settings, provider.id, toggle.active);
            rebuild();
        });
        row.add_suffix(toggle);

        this._addStyleRows(settings, provider, row, rebuild);

        return row;
    }

    /**
     * @param {object} provider - the metric
     * @param {string} style - current preset name
     * @param {boolean} isEnabled - whether it appears in the panel
     * @param {boolean} available - whether its data source can be read
     * @returns {string} subtitle text
     */
    _rowSubtitle(provider, style, isEnabled, available) {
        if (!available)
            return 'No sensor found on this machine';

        if (!isEnabled)
            return 'Not shown in the panel';

        return PRESET_LABELS[style] ?? style;
    }

    /**
     * Adds the style combo and, when custom is selected, the axis rows.
     *
     * The axes are only created when they apply. Building them always and
     * greying them out would leave six dead controls sitting under every metric
     * that uses a preset.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {object} provider - the metric
     * @param {Adw.ExpanderRow} row - the row to add to
     * @param {Function} rebuild - re-renders the whole list
     */
    _addStyleRows(settings, provider, row, rebuild) {
        const styleKey = `${provider.id}-style`;

        const styleRow = comboRow({
            title: 'Style',
            values: PRESET_NAMES,
            labels: PRESET_LABELS,
            selected: settings.get_string(styleKey),
            onChange: value => {
                settings.set_string(styleKey, value);
                rebuild();
            },
        });
        row.add_row(styleRow);

        if (settings.get_string(styleKey) !== 'custom')
            return;

        const warning = new Adw.ActionRow({visible: false});
        warning.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));

        const axisRows = new Map();

        const current = () => normaliseAxes(this._readCustom(settings, provider.id));

        const apply = (axis, value) => {
            const axes = current();
            axes[axis] = value;

            // Blocked rather than allowed, because an invisible metric reads as
            // a crash. The control that caused it is put back and the reason is
            // spelled out, which is friendlier than silently ignoring the click.
            if (isDegenerate(axes)) {
                axisRows.get(axis)?.setValueQuietly(current()[axis]);
                warning.title = 'That would hide this metric completely';
                warning.subtitle = 'Keep at least one of icon, label, graph or value.';
                warning.visible = true;
                return;
            }

            this._writeCustom(settings, provider.id, axes);
            this._syncWarning(warning, axes);
        };

        for (const {axis, title, subtitle} of AXIS_ROWS) {
            const axisRow = comboRow({
                title,
                subtitle,
                values: AXES[axis].values,
                labels: AXIS_VALUE_LABELS[axis],
                selected: current()[axis],
                onChange: value => apply(axis, value),
            });

            axisRows.set(axis, axisRow);
            row.add_row(axisRow);
        }

        row.add_row(warning);
        this._syncWarning(warning, current());
    }

    /**
     * Shows an advisory when a combination is legal but hard to read.
     *
     * Unlike the degenerate case this is allowed. Someone who has learned the
     * positions may genuinely want a bare sparkline, and it is their panel. It
     * is only ever wrong as a shipped default.
     *
     * @param {Adw.ActionRow} warning - the warning row
     * @param {object} axes - the current axis set
     */
    _syncWarning(warning, axes) {
        if (isUnidentifiable(axes)) {
            warning.title = 'Nothing identifies this metric';
            warning.subtitle =
                'With no icon and no label, you will have to remember its position.';
            warning.visible = true;
            return;
        }

        warning.visible = false;
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - the metric
     * @returns {object} the stored custom axes as a plain object
     */
    _readCustom(settings, metricId) {
        const variant = settings.get_value(`${metricId}-custom`);
        const axes = {};

        for (let i = 0; i < variant.n_children(); i++) {
            const entry = variant.get_child_value(i);
            axes[entry.get_child_value(0).get_string()[0]] =
                entry.get_child_value(1).get_string()[0];
        }

        return axes;
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - the metric
     * @param {object} axes - axis values to store
     */
    _writeCustom(settings, metricId, axes) {
        // The schema type is a{ss}, so every value is stored as its spelling.
        // presets.js coerces "true" and "false" back to booleans on the way in.
        const dict = {};
        for (const [key, value] of Object.entries(axes))
            dict[key] = String(value);

        settings.set_value(`${metricId}-custom`, new GLib.Variant('a{ss}', dict));
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - the metric
     * @param {boolean} enabled - whether it should appear
     */
    _setEnabled(settings, metricId, enabled) {
        const current = settings.get_strv('enabled-metrics');

        if (enabled && !current.includes(metricId))
            settings.set_strv('enabled-metrics', [...current, metricId]);
        else if (!enabled)
            settings.set_strv('enabled-metrics', current.filter(id => id !== metricId));
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - the metric
     * @param {number} delta - -1 to move earlier, 1 to move later
     */
    _move(settings, metricId, delta) {
        const order = settings.get_strv('enabled-metrics');
        const index = order.indexOf(metricId);
        const target = index + delta;

        if (index < 0 || target < 0 || target >= order.length)
            return;

        [order[index], order[target]] = [order[target], order[index]];
        settings.set_strv('enabled-metrics', order);
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @returns {Adw.PreferencesPage} the appearance page
     */
    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'applications-graphics-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(group);

        group.add(comboRow({
            title: 'Separator',
            subtitle: 'Drawn between metrics',
            values: ['space', 'dot', 'pipe'],
            labels: {space: 'Space', dot: 'Middot', pipe: 'Pipe'},
            selected: settings.get_string('separator'),
            onChange: value => settings.set_string('separator', value),
        }));

        const percent = new Adw.SwitchRow({
            title: 'Percent sign',
            subtitle: 'Turning this off saves a little width',
            active: settings.get_boolean('show-percent-sign'),
        });
        percent.connect('notify::active',
            () => settings.set_boolean('show-percent-sign', percent.active));
        group.add(percent);

        const graphs = new Adw.PreferencesGroup({
            title: 'Graphs',
            description: 'Applies to sparklines only.',
        });
        page.add(graphs);

        graphs.add(this._spinRow(settings, {
            key: 'graph-width',
            title: 'Width',
            subtitle: 'Logical pixels, before display scaling',
            min: 16,
            max: 120,
        }));

        graphs.add(this._spinRow(settings, {
            key: 'history-length',
            title: 'History',
            subtitle: 'Samples kept per graph',
            min: 8,
            max: 120,
        }));

        return page;
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @returns {Adw.PreferencesPage} the units page
     */
    _unitsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Units',
            icon_name: 'preferences-other-symbolic',
        });

        const sampling = new Adw.PreferencesGroup({
            title: 'Sampling',
            description: 'One timer drives every metric, so this is the whole cost.',
        });
        page.add(sampling);

        sampling.add(this._spinRow(settings, {
            key: 'refresh-interval',
            title: 'Interval',
            subtitle: 'Seconds between readings',
            min: 1,
            max: 60,
        }));

        const units = new Adw.PreferencesGroup({title: 'Units'});
        page.add(units);

        units.add(comboRow({
            title: 'Temperature',
            values: ['celsius', 'fahrenheit'],
            labels: {celsius: 'Celsius', fahrenheit: 'Fahrenheit'},
            selected: settings.get_string('temp-unit'),
            onChange: value => settings.set_string('temp-unit', value),
        }));

        units.add(comboRow({
            title: 'Network',
            subtitle: 'Bits matches how links and ISPs are rated',
            values: ['bytes', 'bits'],
            labels: {bytes: 'Bytes', bits: 'Bits'},
            selected: settings.get_string('net-unit'),
            onChange: value => settings.set_string('net-unit', value),
        }));

        units.add(comboRow({
            title: 'Disk',
            values: ['bytes', 'bits'],
            labels: {bytes: 'Bytes', bits: 'Bits'},
            selected: settings.get_string('disk-unit'),
            onChange: value => settings.set_string('disk-unit', value),
        }));

        return page;
    }

    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {object} params - row configuration
     * @param {string} params.key - settings key
     * @param {string} params.title - row title
     * @param {string} [params.subtitle] - row subtitle
     * @param {number} params.min - lowest value
     * @param {number} params.max - highest value
     * @returns {Adw.SpinRow} the configured row
     */
    _spinRow(settings, {key, title, subtitle, min, max}) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle ?? null,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1,
                value: settings.get_int(key),
            }),
        });

        row.connect('notify::value', () => settings.set_int(key, row.get_value()));

        return row;
    }
}
