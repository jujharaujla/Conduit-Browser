'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('conduit', {
  navigate: (value) => ipcRenderer.invoke('v18-navigate', value),
  back: () => ipcRenderer.invoke('v18-back'),
  forward: () => ipcRenderer.invoke('v18-forward'),
  reloadAll: () => ipcRenderer.invoke('v18-reload-all'),
  reloadActive: () => ipcRenderer.invoke('v18-reload-active'),

  setPaneCount: async (value) => {
    const [workspace, sync] = await Promise.all([
      ipcRenderer.invoke('v18-set-pane-count-workspace', value),
      ipcRenderer.invoke('v18-set-pane-count', value),
    ]);
    return { ...(workspace || {}), sync };
  },
  syncPaneCount: (value) => ipcRenderer.invoke('v18-set-pane-count', value),
  setZoom: (value) => ipcRenderer.invoke('v18-set-zoom', value),
  setAudioMode: (value) => ipcRenderer.invoke('v18-set-audio-mode', value),
  setNetwork: (value) => ipcRenderer.invoke('v18-set-network', value),
  listProxyProfiles: () => ipcRenderer.invoke('v31-list-proxy-profiles'),
  saveProxyProfile: (value) => ipcRenderer.invoke('v31-save-proxy-profile', value),
  deleteProxyProfile: (id) => ipcRenderer.invoke('v31-delete-proxy-profile', id),
  testProxyProfile: (id) => ipcRenderer.invoke('v31-test-proxy-profile', id),
  checkIPs: () => ipcRenderer.invoke('v18-check-ips'),
  checkIPFallbacksV25: (panes) => ipcRenderer.invoke('v25-check-ip-fallbacks', panes),
  resetPane: (pane) => ipcRenderer.invoke('v18-reset-pane', pane),
  resetAllConnections: () => ipcRenderer.invoke('v34-reset-all-connections'),
  restartAll: () => ipcRenderer.invoke('v18-restart-all'),
  focusPane: (pane) => ipcRenderer.invoke('v18-focus-pane', pane),
  setPaneLabel: (pane, label) => ipcRenderer.invoke('v18-set-pane-label', pane, label),
  setSettingsVisible: (visible) => ipcRenderer.invoke('v18-set-settings-visible', visible),
  activatePanes: () => ipcRenderer.invoke('v30-activate-panes'),
  getWorkspace: () => ipcRenderer.invoke('v18-get-workspace'),

  setFollowing: (enabled) => ipcRenderer.invoke('v18-set-following', enabled),
  setPolicy: (policy) => ipcRenderer.invoke('v18-set-policy', policy),
  pausePane: (pane, paused) => ipcRenderer.invoke('v18-set-pane-paused', pane, paused),
  getHealth: () => ipcRenderer.invoke('v18-get-health'),
  resyncV26: () => ipcRenderer.invoke('v26-resync-all'),

  getAdBlock: () => ipcRenderer.invoke('v18-get-adblock'),
  setAdBlock: (enabled) => ipcRenderer.invoke('v18-set-adblock', enabled),
  openExternal: (url) => ipcRenderer.invoke('v18-open-external', url),

  onState: (callback) => ipcRenderer.on('workspace-state-v18', (_event, state) => callback(state)),
  onLayout: (callback) => ipcRenderer.on('layout-state-v18', (_event, state) => callback(state)),
  onProgress: (callback) => ipcRenderer.on('operation-progress-v18', (_event, progress) => callback(progress)),
  onHealth: (callback) => ipcRenderer.on('pane-health-v18', (_event, health) => callback(health)),
  onMenuCommand: (callback) => ipcRenderer.on('menu-command-v18', (_event, command) => callback(command)),
});
