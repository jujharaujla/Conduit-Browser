'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  navigate: (value) => ipcRenderer.invoke('navigate', value),
  back: () => ipcRenderer.invoke('go-back'),
  forward: () => ipcRenderer.invoke('go-forward'),
  reload: () => ipcRenderer.invoke('reload'),

  setScreenCount: async (value) => {
    const [workspace, controller] = await Promise.all([
      ipcRenderer.invoke('set-screen-count', value),
      ipcRenderer.invoke('v12-set-screen-count', value),
    ]);
    return { ...(workspace || {}), controller };
  },

  setZoom: (value) => ipcRenderer.invoke('set-zoom', value),
  setNetwork: (value) => ipcRenderer.invoke('set-network', value),
  checkIPs: () => ipcRenderer.invoke('check-ips'),

  setSync: async (enabled) => {
    const [workspace, controller] = await Promise.all([
      ipcRenderer.invoke('set-sync', enabled),
      ipcRenderer.invoke('v12-set-sync', enabled),
    ]);
    return { ...(workspace || {}), controller };
  },

  restartEverything: () => ipcRenderer.invoke('restart-everything'),
  resetScreen: (screenNumber) => ipcRenderer.invoke('reset-screen', screenNumber),
  setSetupVisible: (visible) => ipcRenderer.invoke('set-setup-visible', visible),
  getAdBlockStatus: () => ipcRenderer.invoke('get-adblock-status'),
  setAdBlockEnabled: (enabled) => ipcRenderer.invoke('set-adblock-enabled', enabled),

  onState: (callback) => ipcRenderer.on('browser-state', (_event, state) => {
    if (!state?.syncRequested || state.networkBusy || state.setupVisible) {
      callback(state);
      return;
    }

    callback({
      ...state,
      syncReady: true,
      status: 'Screen 1 control active',
    });
  }),
  onLayout: (callback) => ipcRenderer.on('layout-state', (_event, state) => callback(state)),
  onOperationProgress: (callback) => ipcRenderer.on('operation-progress', (_event, progress) => callback(progress)),
  onDiagnostic: (callback) => ipcRenderer.on('diagnostic-log', (_event, entry) => callback(entry)),
});
