/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Resolves the logical icon names providers expose into real icons.
 *
 * This lives in the UI layer on purpose. Providers name the icon that
 * represents what they measure, which is a plain string, but they must not
 * import Gio or know anything about where the extension is installed. That
 * keeps src/metrics/ importable under plain gjs with nothing but GLib.
 */

import Gio from 'gi://Gio';

/**
 * Resolves an icon name to a GIcon.
 *
 * Names we ship are loaded from the extension's own icons directory. Anything
 * else falls through to the icon theme, which covers metrics that can reuse a
 * stock Adwaita icon such as network activity.
 *
 * @param {string} extensionPath - absolute path to the installed extension
 * @param {string} name - logical icon name, without extension
 * @returns {Gio.Icon} an icon suitable for St.Icon's gicon property
 */
export function resolveIcon(extensionPath, name) {
    const file = Gio.File.new_for_path(`${extensionPath}/icons/${name}.svg`);

    if (file.query_exists(null))
        return new Gio.FileIcon({file});

    return new Gio.ThemedIcon({name});
}
