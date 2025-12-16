'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, ipcMain, shell, protocol, net } = require('electron');

protocol.registerSchemesAsPrivileged([{
  scheme: 'relay',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

app.setName('Conduit');
app.whenReady().then(async () => {
  const homeURL = pathToFileURL(path.join(__dirname, 'renderer', 'welcome-v18.html')).toString();
  await protocol.handle('relay', (request) => {
    const destination = new URL(request.url);
    if (destination.hostname === 'home' || destination.hostname === 'welcome') return net.fetch(homeURL);
    return new Response('Page not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  });
});

ipcMain.handle('v18-open-external', async (_event, value) => {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') throw new Error('Only secure external links are allowed.');
    await shell.openExternal(url.href);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

require('./fresh-start-v23');
require('./main-sync');
require('./main-watchdog');
require('./main-v25-ip-fallback');
require('./main-shell');
