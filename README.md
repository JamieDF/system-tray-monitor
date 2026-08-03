# System Monitor

A GNOME Shell extension showing CPU, memory, temperature, network and disk
activity in the top bar, beside the existing status icons.

Every metric can be turned on or off independently, and each one picks its own
display style: plain text, an icon with a value, a sparkline, a ring gauge, and
several others. Anything the presets do not cover can be built from the
underlying axes in a custom mode.

## Status

Early development. Not yet released, not yet on extensions.gnome.org.

## Requirements

- GNOME Shell 48, 49 or 50
- Ubuntu GNOME. Fedora is likely to work, since the metrics come from `/proc`
  which is a kernel interface, but it is untested and not claimed as supported.

There is no libgtop dependency. Everything is read directly from `/proc` and
`/sys`, which removes a package requirement and a common source of breakage
across shell versions.

## Installing for development

```bash
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/system-monitor@jamiedf.github.io
glib-compile-schemas schemas/
```

Then enable it inside a nested shell session rather than your live desktop:

```bash
dbus-run-session -- gnome-shell --wayland --wayland-display=wayland-99
```

GNOME 50 is Wayland only, so the shell cannot be restarted in place. The nested
session is how you iterate.

## Documentation

- `docs/architecture.md` for how the metrics layer, poller and renderer fit
  together, and why they are separated the way they are
- `docs/st-widgets.md` for the St property reference used by the panel code
- `CONTRIBUTING.md` for the development loop and code standards

## Licence

GPL-2.0-or-later. See `LICENSE`.
