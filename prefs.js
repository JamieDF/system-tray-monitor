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
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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

export default class SystemTrayMonitorPreferences extends ExtensionPreferences {
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

        // Ordering and configuring are separate jobs, so they get separate
        // sections. Putting reorder buttons on each metric row meant every row
        // carried four controls doing three unrelated things, and the down
        // arrow was the same chevron as the expander's own drawer arrow.
        //
        // Splitting them also makes the order visible in one place. Arrows on
        // rows only ever told you "this can move", never where it currently sat.
        const orderGroup = new Adw.PreferencesGroup({
            title: 'Panel order',
            description: 'Left to right, as they appear in the top bar. ' +
                'Drag to reorder, or focus a metric and press Ctrl with an arrow key.',
        });
        page.add(orderGroup);

        const group = new Adw.PreferencesGroup({
            title: 'Metrics',
            description: 'A metric that is switched off is never sampled.',
        });
        page.add(group);

        // Rebuilding both sections on a change is simpler than surgically
        // moving things, and at five metrics the cost is irrelevant.
        //
        // Rows are tracked explicitly rather than walked from the group, because
        // a PreferencesGroup's real children are its internal box and header,
        // not the rows added to it.
        let shown = [];
        let orderRow = null;

        const rebuild = () => {
            if (orderRow !== null)
                orderGroup.remove(orderRow);

            orderRow = this._orderStrip(settings, providers, rebuild);
            orderGroup.add(orderRow);

            // Remember which row was expanded so it can be restored after the
            // rebuild. Without this, changing a metric's style recreates the row
            // from scratch and it snaps shut — frustrating when you are mid-edit
            // and the axis rows you were about to tweak just disappeared. Tracked
            // by provider id because the row object itself is destroyed below.
            const expandedIds = new Set(shown
                .filter(row => row.expanded)
                .map(row => row.providerId));

            for (const row of shown)
                group.remove(row);

            shown = this._orderedProviders(settings, providers)
                .map(provider => {
                    const row = this._metricRow(settings, provider, rebuild);
                    if (expandedIds.has(provider.id))
                        row.expanded = true;
                    return row;
                });

            for (const row of shown)
                group.add(row);
        };

        rebuild();

        return page;
    }

    /**
     * The reorder strip: one chip per shown metric, in panel order.
     *
     * Horizontal rather than a vertical list, because the thing being ordered is
     * horizontal. An up arrow meaning "left" was a translation the user had to
     * perform on every use.
     *
     * Two ways to move a chip, and both are needed. Dragging is the obvious
     * gesture but is mouse only, so it cannot be the only one: an extension that
     * removes the sole keyboard path fails the accessibility expectations
     * extensions.gnome.org reviews against. Ctrl with the arrow keys moves the
     * focused chip and covers that.
     *
     * Added straight to the group rather than wrapped in an ActionRow. That
     * row's prefix slot is sized for a small icon, so a full width strip put
     * there gets squashed to nothing.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {object[]} providers - every known provider
     * @param {Function} rebuild - re-renders both sections
     * @returns {Gtk.Widget} the strip
     */
    _orderStrip(settings, providers, rebuild) {
        const byId = new Map(providers.map(p => [p.id, p]));
        const order = settings.get_strv('enabled-metrics').filter(id => byId.has(id));

        if (order.length === 0) {
            return new Gtk.Label({
                label: 'No metrics are shown in the panel.',
                css_classes: ['dim-label'],
                halign: Gtk.Align.START,
                margin_top: 6,
            });
        }

        const strip = new Gtk.Box({
            spacing: 8,
            css_classes: ['card'],
            margin_top: 4,
        });
        strip.set_margin_start(0);

        const inner = new Gtk.Box({
            spacing: 8,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 12,
            margin_end: 12,
        });
        strip.append(inner);

        for (const id of order)
            inner.append(this._orderChip(settings, byId.get(id), order, rebuild));

        return strip;
    }

    /**
     * One draggable chip.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {object} provider - the metric this chip represents
     * @param {string[]} order - current panel order
     * @param {Function} rebuild - re-renders both sections
     * @returns {Gtk.Button} the chip
     */
    _orderChip(settings, provider, order, rebuild) {
        const content = new Gtk.Box({spacing: 6});
        content.append(new Gtk.Image({
            gicon: resolveIcon(this.path, provider.iconName),
        }));
        content.append(new Gtk.Label({label: provider.name}));

        const chip = new Gtk.Button({
            child: content,
            tooltip_text: 'Drag to reorder, or focus and press Ctrl with an arrow key',
        });

        // Focus is the selection. Tracking a separate "selected" chip would be
        // a second thing to keep in sync for no gain, since Ctrl with an arrow
        // key already acts on whatever is focused.
        chip.connect('map', () => {
            if (this._focusMetric === provider.id)
                chip.grab_focus();
        });

        this._makeDraggable(chip, provider.id);
        this._makeDropTarget(chip, settings, provider.id, rebuild);
        this._addKeyboardReorder(chip, settings, provider.id, order, rebuild);

        return chip;
    }

    /**
     * @param {Gtk.Widget} chip - the chip to drag
     * @param {string} metricId - what this chip represents
     */
    _makeDraggable(chip, metricId) {
        const source = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});

        source.connect('prepare', () => {
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(metricId);

            return Gdk.ContentProvider.new_for_value(value);
        });

        // Without an explicit icon the pointer carries nothing and the drag
        // looks broken even though it works.
        source.connect('drag-begin', () => {
            const paintable = new Gtk.WidgetPaintable({widget: chip});
            source.set_icon(paintable, 0, 0);
        });

        chip.add_controller(source);
    }

    /**
     * @param {Gtk.Widget} chip - the chip being dropped onto
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - what this chip represents
     * @param {Function} rebuild - re-renders both sections
     */
    _makeDropTarget(chip, settings, metricId, rebuild) {
        const target = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING),
        });

        // Highlighting the chip under the pointer is what tells the user where
        // the thing will land. Without it a drag is a guess.
        target.connect('enter', () => {
            chip.add_css_class('suggested-action');
            return Gdk.DragAction.MOVE;
        });
        target.connect('leave', () => chip.remove_css_class('suggested-action'));

        target.connect('drop', (_target, value) => {
            chip.remove_css_class('suggested-action');

            // GJS unwraps the GValue into a plain JS string before passing it
            // here, so value is already the metric id. Calling .get_string() on
            // it returns undefined (strings have no such method), the falsy
            // guard bails out, and the drop silently does nothing — which is
            // exactly the symptom of "drag works but release doesn't reorder".
            const dragged = typeof value === 'string' ? value : value?.get_string?.();
            if (!dragged || dragged === metricId)
                return false;

            const order = settings.get_strv('enabled-metrics');
            this._reorder(settings, dragged, order.indexOf(metricId));

            this._focusMetric = dragged;
            rebuild();

            return true;
        });

        chip.add_controller(target);
    }

    /**
     * @param {Gtk.Widget} chip - the chip to attach to
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - what this chip represents
     * @param {string[]} order - current panel order
     * @param {Function} rebuild - re-renders both sections
     */
    _addKeyboardReorder(chip, settings, metricId, order, rebuild) {
        const keys = new Gtk.EventControllerKey();

        keys.connect('key-pressed', (_controller, keyval, _code, state) => {
            if (!(state & Gdk.ModifierType.CONTROL_MASK))
                return false;

            // Left and right rather than up and down, matching both the strip's
            // orientation and the panel's.
            const delta = keyval === Gdk.KEY_Left
                ? -1
                : keyval === Gdk.KEY_Right ? 1 : 0;

            if (delta === 0)
                return false;

            const index = order.indexOf(metricId);
            if (index < 0 || index + delta < 0 || index + delta >= order.length)
                return true;

            this._reorder(settings, metricId, index + delta);
            this._focusMetric = metricId;
            rebuild();

            return true;
        });

        chip.add_controller(keys);
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
     * Moves a metric to an absolute position in the panel order.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {string} metricId - the metric to move
     * @param {number} target - index to move it to
     */
    _reorder(settings, metricId, target) {
        const order = settings.get_strv('enabled-metrics');
        const from = order.indexOf(metricId);

        if (from < 0 || target < 0 || target >= order.length || from === target)
            return;

        order.splice(from, 1);
        order.splice(target, 0, metricId);

        settings.set_strv('enabled-metrics', order);
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
        const isEnabled = settings.get_strv('enabled-metrics').includes(provider.id);
        const available = provider.isAvailable();

        const row = new Adw.ExpanderRow({
            title: provider.name,
            subtitle: this._rowSubtitle(provider, style, isEnabled, available),
            sensitive: available,
        });

        // Tagged so rebuild() can remember which row was expanded and restore
        // it after recreating the list. Without this identifier there is no way
        // to match an old (about-to-be-destroyed) row to its replacement.
        row.providerId = provider.id;

        row.add_prefix(new Gtk.Image({gicon: resolveIcon(this.path, provider.iconName)}));

        // No reorder buttons here. Ordering lives in its own section above, so
        // this row carries only the two things that belong to the metric
        // itself: whether it is shown, and how it is drawn.
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

        // A row inside the drawer rather than another suffix, because the
        // suffix slot is the panel's on/off and these configure different
        // surfaces: the toggle says whether the metric exists in the panel at
        // all, this says whether its dropdown section opens onto a plot.
        const dropdownGraph = new Adw.SwitchRow({
            title: 'Dropdown graph',
            subtitle: 'A history plot in the dropdown for this metric',
            active: settings.get_boolean(`${provider.id}-menu-graph`),
        });
        dropdownGraph.connect('notify::active', () =>
            settings.set_boolean(`${provider.id}-menu-graph`, dropdownGraph.active));
        row.add_row(dropdownGraph);

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

        const menuGraphs = new Adw.PreferencesGroup({
            title: 'Dropdown graphs',
            description: 'History plots shown in the dropdown.',
        });
        page.add(menuGraphs);

        menuGraphs.add(this._spinRow(settings, {
            key: 'menu-graph-height',
            title: 'Height',
            subtitle: 'Logical pixels, before display scaling',
            min: 24,
            max: 96,
        }));

        menuGraphs.add(this._spinRow(settings, {
            key: 'menu-history-length',
            title: 'History',
            subtitle: 'Samples kept per plot line',
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
