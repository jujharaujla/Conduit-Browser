# Relay Browser 1.0

Relay opens one to four isolated Electron browser screens with guarded synchronization, optional private routing, locked settings workflows, and per-screen reset controls.

## What changed in 1.0

- Replaced the user-facing **Tor split** label with **Multiple private routes**.
- Kept the provider name visible in diagnostics: the current provider is a local Tor SOCKS service, not a conventional VPN.
- Added **Require private routes**, an in-app kill switch that refuses to unlock the workspace until every visible screen verifies the private route.
- Private-route enforcement automatically requires public-route verification.
- When enforcement is active, Direct fallback is not allowed.
- Added a background route health check. If verification fails, Relay hides every pane and opens the locked recovery screen.
- Added **Open console** beside the top-right status information.
- Added a live connection console for provider checks, route failures, status changes, resets, and restart progress.
- Added a real progress bar driven by the four current operation stages.
- Improved settings terminology for connections, routes, verification, and identity renewal.
- Kept **Restart everything**, individual screen resets, the bounded SOCKS bridge, and remote-DNS routing.

## What the kill switch covers

The enforcement setting applies inside Relay. When Multiple private routes is active, each Electron session uses a fixed local proxy bridge and does not intentionally fall back to Direct mode. Relay also performs periodic verification and locks the interface when verification fails.

This is not a system-wide macOS VPN kill switch and does not control traffic from other applications.

## Install on macOS

Extract the archive, open Terminal in the extracted folder, and run:

```bash
npm install --registry=https://registry.npmjs.org/ --no-package-lock
npm run check
npm start
```

You can also double-click `Start Relay.command` after dependencies have been installed.

## Main controls

- **Settings:** opens screen count, zoom, routing, route enforcement, verification, synchronization, diagnostics, and individual-screen reset controls.
- **Open console:** opens Settings and scrolls directly to live connection diagnostics.
- **Restart everything:** rebuilds all browser sessions and the active connection route.
- **Reset Screen:** clears one screen's cookies, cache, storage, connections, DNS state, and private-route identity without clearing other sessions.

Every settings, restart, and reset workflow uses a blocking progress screen. Browser panes remain hidden until the operation is finalized.

## Multiple private routes

Relay deliberately does not start its private-route provider. Install and start the Homebrew Tor service before applying Multiple private routes:

```bash
brew install tor
brew services start tor
```

Alternatively, open Tor Browser and leave it running. Relay checks local SOCKS ports 9050 and 9150.

To stop the Homebrew service later:

```bash
brew services stop tor
```

Separate SOCKS identities create isolated Tor streams, but the provider can still choose the same public exit for multiple screens. The verification results shown in Relay are the source of truth.

## Synchronization safety

Synchronization pauses for CAPTCHAs and security challenges. Password fields, file uploads, payments, purchases, votes, account deletion, and similar sensitive actions are not mirrored.
