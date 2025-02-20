'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  navigate: (value) => ipcRenderer.invoke('navigate', value),
  back: () => ipcRenderer.invoke('go-back'),
  forward: () => ipcRenderer.invoke('go-forward'),
  reload: () => ipcRenderer.invoke('reload'),
  setScreenCount: (value) => ipcRenderer.invoke('set-screen-count', value),
  setZoom: (value) => ipcRenderer.invoke('set-zoom', value),
  setNetwork: (value) => ipcRenderer.invoke('set-network', value),
  checkIPs: () => ipcRenderer.invoke('check-ips'),
  setSync: (enabled) => ipcRenderer.invoke('set-sync', enabled),
  restartEverything: () => ipcRenderer.invoke('restart-everything'),
  resetScreen: (screenNumber) => ipcRenderer.invoke('reset-screen', screenNumber),
  setSetupVisible: (visible) => ipcRenderer.invoke('set-setup-visible', visible),
  onState: (callback) => ipcRenderer.on('browser-state', (_event, state) => callback(state)),
  onLayout: (callback) => ipcRenderer.on('layout-state', (_event, state) => callback(state)),
  onOperationProgress: (callback) => ipcRenderer.on('operation-progress', (_event, progress) => callback(progress)),
});
