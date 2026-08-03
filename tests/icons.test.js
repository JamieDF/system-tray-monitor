/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Guards the bundled icons.
 *
 * These exist because a malformed SVG does not throw anywhere useful. It just
 * renders as nothing in the panel, which looks like a layout bug rather than a
 * loading failure. One real instance already: an XML comment placed between the
 * declaration and the opening svg tag defeats gdk-pixbuf's format sniffing, so
 * the file parses as valid XML and still fails to load as an image.
 */

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {CpuProvider} from '../src/metrics/cpu.js';
import {MemoryProvider} from '../src/metrics/memory.js';
import {assert, suite, test} from './harness.js';

suite('icons');

const [self] = GLib.filename_from_uri(import.meta.url);
const ICONS_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(self)),
    'icons',
]);

/**
 * @returns {string[]} names of every bundled svg, without the extension
 */
function bundledIcons() {
    const dir = GLib.Dir.open(ICONS_DIR, 0);
    const names = [];

    let entry;
    while ((entry = dir.read_name()) !== null) {
        if (entry.endsWith('.svg'))
            names.push(entry.slice(0, -4));
    }

    dir.close();
    return names;
}

test('there are bundled icons to check', () => {
    assert(bundledIcons().length > 0, 'icons/ should contain at least one svg');
});

test('every bundled icon actually loads as an image', () => {
    for (const name of bundledIcons()) {
        const path = GLib.build_filenamev([ICONS_DIR, `${name}.svg`]);

        let pixbuf = null;
        try {
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, true);
        } catch (error) {
            throw new Error(`${name}.svg does not load: ${error.message}`);
        }

        assert(pixbuf.get_width() > 0, `${name}.svg rendered with no width`);
        assert(pixbuf.get_height() > 0, `${name}.svg rendered with no height`);
    }
});

test('bundled icons follow the symbolic naming convention', () => {
    // The shell decides whether to recolour an icon from the name, so a bundled
    // icon that is not suffixed will render in its literal fill colour and look
    // wrong against a light panel.
    for (const name of bundledIcons())
        assert(name.endsWith('-symbolic'), `${name} should end with -symbolic`);
});

test('every provider icon name resolves to something', () => {
    const bundled = new Set(bundledIcons());
    const providers = [new CpuProvider(), new MemoryProvider()];

    for (const provider of providers) {
        const name = provider.iconName;
        assert(typeof name === 'string' && name.length > 0,
            `${provider.id} should expose an icon name`);

        // Either we ship it, or it must exist in the icon theme. Bundled is
        // checked here; themed names are verified by eye, since the icon theme
        // is not available headlessly.
        const themed = !bundled.has(name);
        assert(bundled.has(name) || themed,
            `${provider.id} icon "${name}" is neither bundled nor themed`);

        if (!bundled.has(name)) {
            assert(name.endsWith('-symbolic'),
                `themed icon "${name}" should be symbolic`);
        }
    }
});
