'use strict';

const { app } = require('electron');

// Keep WebRTC on proxy-capable TCP paths and prevent ICE from exposing a
// non-proxied public or local address.
app.commandLine.appendSwitch(
  'force-webrtc-ip-handling-policy',
  'disable_non_proxied_udp',
);

// Gives Windows a stable taskbar and notification identity in packaged builds.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.jujharaujla.conduit');
}

require('./main-entry');
