# Relay Browser 0.11

Relay opens one to four isolated Electron browser screens with Screen 1 as the controller, optional ad blocking, concise status diagnostics, guarded synchronization, and optional private routed connections.

## What changed in 0.11

- Screen 1 is now the authoritative controller for clicks, typing, navigation, and scroll position.
- Follower screens automatically catch up when one remains on the previous page or at the wrong scroll position.
- Security-challenge detection remains active for safety, but challenge warnings no longer appear in the toolbar or Settings console.
- A challenged screen is silently skipped instead of freezing synchronization for every screen.
- The Settings console now keeps only a short list of human-readable states such as **Connecting**, **Connected**, **Ready**, and **Connection error**.
- Ad and tracker protection can now be disabled from Settings.
- Turning protection off shows a compatibility warning because some websites may refresh, interrupt the page, or sign the user out.
- Individual screen reset, Restart everything, visible progress, private connections, and the bounded Tor bridge remain included.

## Install on macOS

Extract the archive, open Terminal in the extracted folder, and run:

```bash
npm install --registry=https://registry.npmjs.org/ --no-package-lock
npm run check
npm start
```

You can also double-click `Start Relay.command` after dependencies have been installed.

## Screen 1 control

When **Screen 1 controls followers** is enabled, Relay mirrors supported activity from Screen 1 to Screens 2–4. It also sends an authoritative page URL and proportional scroll position so follower screens can recover after delayed loads or route mismatches.

CAPTCHA and security-challenge interfaces are never mirrored. Password fields, file uploads, payments, purchases, votes, account deletion, and similar sensitive actions are also excluded.

## Ad and tracker protection

Protection starts enabled. Settings shows the blocked-request count and includes a switch to turn protection off for websites that reject blockers. The filter is session-level and applies to new requests immediately.

This is a built-in network filter rather than a browser extension. It blocks many common advertising and tracking requests, but cannot guarantee that every advertisement will be removed.

## Multiple private connections

Relay does not start the private routing service itself. Install and start Tor before applying **Multiple private connections**:

```bash
brew install tor
brew services start tor
```

Alternatively, open Tor Browser and leave it running. Relay checks local SOCKS ports 9050 and 9150. Separate identities do not guarantee different exit IP addresses, so use **Verify public connections** as the source of truth.
