'use strict';

const { app, BrowserWindow, Menu, dialog } = require('electron');
const { DISPLAY_VERSION, PACKAGE_VERSION } = require('./version');

const windowForUI = () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) || null;

function command(name, payload = null) {
  windowForUI()?.webContents.send('menu-command-v18', { command: name, payload });
}

function showAbout() {
  return dialog.showMessageBox({
    type: 'info',
    title: `About ${DISPLAY_VERSION}`,
    message: DISPLAY_VERSION,
    detail: `Package ${PACKAGE_VERSION}\nA linked multi-screen browser made by Jujhar.`,
  });
}

app.whenReady().then(() => {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Conduit',
      submenu: [
        {
          label: 'About Conduit',
          click: showAbout,
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => command('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Focus Address', accelerator: 'CommandOrControl+L', click: () => command('focus-address') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Active Screen', accelerator: 'CommandOrControl+R', click: () => command('reload-active') },
        { label: 'Reload Every Screen', accelerator: 'CommandOrControl+Shift+R', click: () => command('reload-all') },
        { type: 'separator' },
        ...Array.from({ length: 4 }, (_unused, index) => ({
          label: `Focus Screen ${index + 1}`,
          accelerator: `CommandOrControl+${index + 1}`,
          click: () => command('focus-pane', index + 1),
        })),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    ...(!isMac ? [{
      role: 'help',
      submenu: [{ label: 'About Conduit', click: showAbout }],
    }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

require('./workspace');
