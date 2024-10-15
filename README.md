# Relay Browser 0.10

Relay opens one to four isolated Electron browser screens with guarded synchronization, enforced ad and tracker protection, diagnostics, and optional private routed connections.

## What changed in 0.10

- Added enforced ad and tracker blocking to every Electron browser session.
- The blocker cannot be disabled from the interface.
- Settings now includes a live diagnostics console for connection checks, failures, resets, synchronization warnings, and protection statistics.
- Every setup, restart, and screen-reset workflow now displays a smooth 0–100% progress bar alongside its individual steps.
- Replaced the confusing **Tor split** interface label with **Multiple private connections**.
- The interface still explains that these private routes are powered by a local Tor service and are not separate commercial VPN subscriptions.
- The toolbar shows the current number of blocked requests.
- The locked setup, full restart, individual-screen resets, bounded bridge, and remote-DNS behavior from 0.9 remain included.

## Install on macOS

Extract the archive, open Terminal in the extracted folder, and run:

```bash
npm install --registry=https://registry.npmjs.org/ --no-package-lock
npm run check
npm start
```

You can also double-click `Start Relay.command` after dependencies have been installed.

## Main controls

- **Settings:** opens every Relay option, the progress display, protection status, live diagnostics, and individual-screen resets.
- **Restart everything:** clears and rebuilds all browser sessions and the active connection mode.
- **Reset Screen:** clears one screen's cookies, cache, storage, connections, DNS state, and private-route identity without clearing the other sessions.

Browser panes remain hidden until a settings, reset, or restart operation is finalized.

## Enforced protection

Relay installs a request blocker on every Electron `Session`. It blocks known advertising hosts and common advertising request paths before the request is sent. The Settings console and toolbar show the cumulative blocked-request count.

This is a built-in network filter rather than a browser extension. It should remove many common advertising and tracking requests, but no static block list can guarantee that every advertisement on every website will be removed.

## Multiple private connections

Relay deliberately does not start the private routing service itself. Install and start Tor before applying **Multiple private connections**:

```bash
brew install tor
brew services start tor
```

Alternatively, open Tor Browser and leave it running. Relay checks local SOCKS ports 9050 and 9150.

Separate SOCKS identities create isolated Tor streams, but Tor can still choose the same exit relay for multiple screens. Enable **Verify public connections** in Settings as the source of truth.

## Synchronization safety

Synchronization pauses for CAPTCHAs and security challenges. Password fields, file uploads, payments, purchases, votes, account deletion, and similar sensitive actions are not mirrored.
