# Conduit 0.18

Conduit is a one-to-eight-pane Electron browser for repeating ordinary browsing work across isolated sessions. Pane 1 can lead navigation, scrolling, typing, and clicks while followers keep separate cookies, storage, cache, and optional route identities.

## What changed

- Replaced the layered versioned renderer with one HTML file, one stylesheet, and one renderer script.
- Replaced the competing synchronization wrappers with one pane preload and one main-process coordinator.
- Added a live pane map showing registered, aligned, loading, paused, and catching-up panes.
- Added focus mode, per-pane pause/resume, reset, and editable pane names.
- Added selective following controls for navigation, scrolling, typing, and clicks.
- Added saved workspace presets and automatic restoration of pane count, zoom, labels, and previous URLs.
- Added native macOS shortcuts and menus, a right-click pane menu, an About window, system Light/Dark appearance, and a Conduit dock icon.
- Simplified the toolbar and Settings interface around one warm-gray and forest-green identity.
- Removed decorative event hashes, multiple color-theme presets, numbered section tiles, and permanent diagnostic noise.
- Kept the ad filter optional, with a compatibility warning.
- Kept CAPTCHA, password, file-upload, payment, purchase, voting, and account-deletion actions outside synchronization.

## Install on macOS

Extract the archive, open Terminal in the extracted folder, and run:

```bash
npm install --registry=https://registry.npmjs.org/ --no-package-lock
npm run check
npm start
```

After dependencies are installed, `Start Conduit.command` can also be used.

## Keyboard shortcuts

- `⌘,` opens Settings.
- `⌘L` focuses the address bar.
- `⌘R` reloads the focused pane.
- `⌘⇧R` reloads every visible pane.
- `⌘1` through `⌘8` focus a pane.
- `⌘⇧S` saves a workspace preset.

## Pane following

Pane 1 is the leader. Followers can be paused individually without closing their sessions. Settings can independently enable or disable navigation, scrolling, typing, and click following.

Security-challenge pages are skipped. Sensitive fields and actions are not mirrored.

## Isolated routes

The isolated route option connects to a compatible local SOCKS service on port 9050 or 9150. Conduit does not launch that service itself. Route verification reports the public IP address visible to each active pane.
