# Contributing to System Tray Monitor

Thanks for taking the time to contribute! Every bug report, suggestion, and pull request helps.

## Before You Start

- **Search first.** Check [open and closed issues](../../issues) before filing a new one; your question or bug may already be covered.
- **Comment before coding.** For anything beyond a small bug fix, open an issue first to discuss the approach. This avoids wasted effort if the direction doesn't fit the project.

## How to Contribute

### Reporting Bugs

Open an issue and include:
- What you did, what you expected, and what happened instead
- Your GNOME Shell version (`gnome-shell --version`), distribution, and whether you're on light or dark
- Steps to reproduce (the more specific the better)

Shell errors go to the journal, not to a console:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

### Suggesting Features

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

### Submitting Code

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes
3. Run the test suite; all tests must pass:
   ```bash
   gjs -m tests/run.js
   ```
4. Write tests for any new functionality
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`
6. Open a pull request against `main` with a clear description of what and why

## Running It Locally

There is no build step. Symlink the repo and compile the settings schema:

```bash
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/system-tray-monitor@jamiedf.github.io
glib-compile-schemas schemas/
gnome-extensions enable system-tray-monitor@jamiedf.github.io
```

### The Reload Trap

**GNOME Shell caches extension code for the life of your session.** Editing a file under `src/` or `extension.js` and re-enabling the extension does nothing: the shell already has the old module in memory. There is no error and the extension still reports `ACTIVE`, so it looks like your change simply had no effect.

Two ways round it:

- **Log out and back in.** Reliable, disruptive.
- **Use a nested shell.** Starts a second GNOME session in a window with your current code, leaving your real session alone:
  ```bash
  dbus-run-session -- gnome-shell --wayland --wayland-display=wayland-99
  ```

`prefs.js` is exempt. It runs in its own short-lived process, so closing and reopening the preferences window is enough to pick up changes. Anything shared between the two, like `src/ui/renderers/presets.js`, will look updated in preferences and stale in the panel until you restart the shell.

The stylesheet is also exempt: it is reloaded when the extension is re-enabled.

## Code Standards

- **Plain JavaScript**: no build step, no bundler, no `node_modules` in the shipped extension. Keep it that way.
- **`src/metrics/` imports only `gi://GLib`**: never `St`, `Clutter`, or anything under `resource:///org/gnome/shell/`. This is what lets the metrics layer be tested without a display server, and extensions.gnome.org enforces the same separation.
- **`prefs.js` never imports `St`, `Clutter`, `Meta` or `Shell`**, and the panel code never imports `Gtk`, `Gdk` or `Adw`. They run in different processes; those libraries genuinely aren't loaded.
- **Tests required**: new features need tests; bug fixes ideally include a regression test.
- **Presets are data**: adding a display style should mean an entry in `src/ui/renderers/presets.js` and nothing else. If it needs a new branch in the renderer, something has drifted.
- **Comments explain why, not what.** The code already says what it does.
- **One thing per PR**: keep pull requests focused on a single change.
- **No em dashes** in code, comments, commit messages, or user-facing strings.

### Colours

There is one stylesheet, deliberately. The shell picks `stylesheet-light.css` based on a settings value that does not reliably match what the panel is actually painted, so a per-variant palette can end up drawing dark on dark.

- Muted text sets **no colour**; it inherits the panel foreground and dims with `opacity`.
- Colours that must be specific are mid-tones clearing a 3:1 contrast ratio against both `#000000` and `#fafafb`. `tests/stylesheet.test.js` measures this and fails the build otherwise.

## What We're Looking For

This is intentionally a small, self-contained panel indicator: no daemon, no dependencies beyond GNOME itself, no network access. It reads `/proc` and `/sys` directly rather than pulling in libgtop.

It also has to be cheap. A tool that measures resource use has no business consuming much, so one shared timer drives every metric, disabled metrics are never sampled, and per-core parsing only happens while the dropdown is open. Contributions that add background work, extra timers, or per-tick allocation need a good reason.

## Response Time

This is a small project maintained in spare time. I'll aim to respond to issues and PRs within a week, but it may take longer.

## Code of Conduct

Be respectful. Constructive feedback is welcome; personal attacks are not. Issues or PRs that are abusive will be closed.
