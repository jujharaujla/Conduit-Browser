# Relay Browser 0.9

Relay opens one to four isolated Electron browser screens with guarded synchronization and optional local Tor routing.

## What changed in 0.9

- Added **Restart everything** beside the address bar.
- Added a single **Settings** window containing every editable Relay option.
- Removed inline workspace settings from the toolbar so changes cannot apply partially.
- Applying settings hides every browser pane and shows four progress stages until the operation finishes.
- Restart everything clears cookies, cache, site storage, DNS state, open connections, and Tor identities for all screens before rebuilding the current route.
- Settings includes separate **Reset Screen 1–4** controls.
- An individual reset clears only that screen and requests a new Tor identity when Tor split is active.
- Reset and restart operations cannot be dismissed while they are running.
- Failed Tor reconstruction leaves Relay locked in the operation window so the user can return to Settings and finalize a Direct route.
- The bounded Tor bridge and remote-DNS protections from 0.8 remain included.

## Install on macOS

Extract the archive, open Terminal in the extracted folder, and run:

```bash
npm install --registry=https://registry.npmjs.org/ --no-package-lock
npm run check
npm start
```

You can also double-click `Start Relay.command` after dependencies have been installed.

## Main controls

- **Settings:** opens screen count, zoom, network route, IP verification, synchronization, and individual-screen reset controls.
- **Restart everything:** rebuilds all browser sessions and the active network route.
- **Reset Screen:** clears one screen's cookies, cache, storage, connections, DNS state, and Tor identity without clearing the other sessions.

Every settings, restart, and reset workflow uses a blocking progress screen. Browser panes remain hidden until the operation is finalized.

## Using Tor split

Relay deliberately does not start Tor itself. Install and start the Homebrew service before applying Tor mode:

```bash
brew install tor
brew services start tor
```

Alternatively, open Tor Browser and leave it running. Relay checks local SOCKS ports 9050 and 9150.

To stop the Homebrew Tor service later:

```bash
brew services stop tor
```

Separate SOCKS identities create isolated Tor streams, but Tor can still choose the same exit relay for multiple screens. Enable **Verify public IPs** in Settings as the source of truth.

## Synchronization safety

Synchronization pauses for CAPTCHAs and security challenges. Password fields, file uploads, payments, purchases, votes, account deletion, and similar sensitive actions are not mirrored.
