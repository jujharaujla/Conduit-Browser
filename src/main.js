'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const {
  MAX_SCREENS,
  DEFAULT_URL,
  normalizeURL,
  clampScreenCount,
  clampZoom,
  layoutCells,
  pageBounds,
  labelBounds,
  pageKey,
  actionLooksSensitive,
} = require('./core');
const { startTorRuntime } = require('./tor-manager');
const { startTorHttpBridge } = require('./tor-bridge');

app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

let mainWindow = null;
let views = [];
let sessions = [];
let screenCount = 4;
let zoomFactor = 1;
let currentURL = DEFAULT_URL;
let networkMode = 'direct';
let networkBusy = false;
let syncRequested = false;
let syncHardLock = '';
let statusText = 'Choose your workspace settings';
let torRuntime = null;
let bridges = [];
let ipResults = Array(MAX_SCREENS).fill(null);
let dnsStatus = 'Direct connection';
let setupVisible = true;
let resizeTimer = null;
let stateTimer = null;
let actionSequence = 0;
let identitySequence = 0;
const pageStates = new Map();
const pendingActions = new Map();

const welcomePath = path.join(__dirname, 'renderer', 'welcome.html');
const welcomeURL = pathToFileURL(welcomePath).href;

function activeViews() {
  return views.slice(0, screenCount);
}

function displayURL(value) {
  return value === welcomeURL || value === DEFAULT_URL ? DEFAULT_URL : value;
}

function actualURL(value) {
  const normalized = normalizeURL(value);
  return normalized === DEFAULT_URL ? welcomeURL : normalized;
}

function operationProgress(operation, step, state, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('operation-progress', {
    operation,
    step,
    state,
    message: String(message || ''),
  });
}

function safetySnapshot() {
  const active = activeViews();
  if (active.length < 2) return { ready: false, reason: 'choose at least two screens' };
  const states = active.map((view) => pageStates.get(view.webContents.id));
  if (states.some((state) => !state)) return { ready: false, reason: 'waiting for page checks' };
  if (states.some((state) => state.loading)) return { ready: false, reason: 'waiting for pages to finish loading' };
  const challenged = states.findIndex((state) => state.challenge);
  if (challenged >= 0) return { ready: false, reason: `security challenge detected on Screen ${challenged + 1}` };
  const keys = states.map((state) => pageKey(state.url));
  if (!keys.every((key) => key === keys[0])) return { ready: false, reason: 'screens are on different pages' };
  return { ready: true, reason: 'screens match' };
}

function statusTextFor(safety) {
  if (networkBusy) return statusText;
  if (setupVisible) return statusText;
  if (syncHardLock) return `${syncHardLock}. Turn synchronization off and on after checking the screens.`;
  if (!syncRequested) return statusText;
  if (!safety.ready) return `Paused: ${safety.reason}`;
  return statusText === 'Ready' || statusText === 'Sync off' ? 'Synchronization ready' : statusText;
}

function sendStateNow() {
  stateTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safety = safetySnapshot();
  mainWindow.webContents.send('browser-state', {
    screenCount,
    zoomFactor,
    currentURL: displayURL(currentURL),
    networkMode,
    networkBusy,
    syncRequested,
    syncReady: syncRequested && !syncHardLock && safety.ready,
    status: statusTextFor(safety),
    ips: ipResults,
    dnsStatus,
    setupVisible,
    canGoBack: views[0]?.webContents.canGoBack() || false,
    canGoForward: views[0]?.webContents.canGoForward() || false,
  });
}

function scheduleState(delay = 40) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(sendStateNow, delay);
}

function updateLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (setupVisible || networkBusy) {
    views.forEach((view) => {
      view.setVisible(false);
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    });
    mainWindow.webContents.send('layout-state', { labels: [] });
    return;
  }

  const [width, height] = mainWindow.getContentSize();
  const cells = layoutCells(screenCount, width, height);
  const labels = [];

  views.forEach((view, index) => {
    if (index < screenCount) {
      const cell = cells[index];
      const next = pageBounds(cell);
      const previous = view.getBounds();
      view.setVisible(true);
      if (previous.x !== next.x || previous.y !== next.y || previous.width !== next.width || previous.height !== next.height) {
        view.setBounds(next);
      }
      labels.push({ index, ...labelBounds(cell) });
    } else {
      view.setVisible(false);
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  });

  mainWindow.webContents.send('layout-state', { labels });
}

function scheduleLayout() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateLayout, 45);
}

function applyZoom() {
  activeViews().forEach((view) => view.webContents.setZoomFactor(zoomFactor));
}

function requestPageStates() {
  activeViews().forEach((view) => view.webContents.send('request-page-state'));
}

function configureSession(ses) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function attachViewEvents(view, index) {
  const wc = view.webContents;
  wc.setAudioMuted(index > 0);
  if (index > 0 && typeof wc.setImageAnimationPolicy === 'function') wc.setImageAnimationPolicy('animateOnce');

  wc.on('did-start-loading', () => {
    const existing = pageStates.get(wc.id) || { url: wc.getURL(), challenge: false };
    pageStates.set(wc.id, { ...existing, loading: true });
    scheduleState();
  });

  wc.on('did-stop-loading', () => {
    const existing = pageStates.get(wc.id) || { url: wc.getURL(), challenge: false };
    pageStates.set(wc.id, { ...existing, loading: false });
    wc.send('request-page-state');
    scheduleState(80);
  });

  wc.on('did-navigate', (_event, url) => {
    if (index === 0) currentURL = url;
    scheduleState();
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    if (index === 0) currentURL = url;
    scheduleState();
  });

  wc.on('render-process-gone', (_event, details) => {
    statusText = `Screen ${index + 1} renderer stopped: ${details.reason}`;
    scheduleState();
  });
}

function createView(index) {
  const partition = `persist:relay-screen-${index + 1}`;
  const ses = session.fromPartition(partition, { cache: true });
  configureSession(ses);
  sessions.push(ses);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'page-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      additionalArguments: [`--relay-screen=${index + 1}`],
    },
  });

  attachViewEvents(view, index);
  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  views.push(view);
  view.webContents.setZoomFactor(zoomFactor);
  setTimeout(() => view.webContents.loadURL(welcomeURL), index * 130);
}

function withTimeout(promise, milliseconds = 1800) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ]);
}

async function closeTorStack() {
  await Promise.allSettled(sessions.map((ses) => ses.closeAllConnections()));
  const oldBridges = bridges;
  bridges = [];
  await Promise.allSettled(oldBridges.filter(Boolean).map((bridge) => withTimeout(bridge.close())));
  if (torRuntime) torRuntime.stop();
  torRuntime = null;
}

async function setSessionDirect(index) {
  const ses = sessions[index];
  await ses.setProxy({ mode: 'direct' });
  await ses.closeAllConnections();
  if (typeof ses.clearHostResolverCache === 'function') await ses.clearHostResolverCache();
}

async function setSessionsDirect() {
  await Promise.all(sessions.map((_ses, index) => setSessionDirect(index)));
}

function nextIdentity(index) {
  identitySequence += 1;
  return `relay-${Date.now()}-${process.pid}-${identitySequence}-screen-${index + 1}`;
}

async function createBridgeForScreen(index) {
  if (!torRuntime) throw new Error('The local Tor service is not connected.');
  const socksPort = torRuntime.socksPorts[index] || torRuntime.port;
  return startTorHttpBridge({
    socksPort,
    username: nextIdentity(index),
    password: `screen-${index + 1}-${identitySequence}`,
  });
}

async function applyTorProxy(index, bridge) {
  const ses = sessions[index];
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: `http://127.0.0.1:${bridge.port}`,
    proxyBypassRules: '<local>',
  });
  await ses.closeAllConnections();
  if (typeof ses.clearHostResolverCache === 'function') await ses.clearHostResolverCache();
}

async function setSessionsTor() {
  torRuntime = await startTorRuntime(app.getPath('userData'), MAX_SCREENS);
  bridges = Array(MAX_SCREENS).fill(null);

  for (let index = 0; index < MAX_SCREENS; index += 1) {
    const bridge = await createBridgeForScreen(index);
    bridges[index] = bridge;
    await applyTorProxy(index, bridge);
  }
}

async function renewTorIdentity(index) {
  const ses = sessions[index];
  await ses.closeAllConnections();

  const oldBridge = bridges[index];
  bridges[index] = null;
  if (oldBridge) await withTimeout(oldBridge.close());

  const bridge = await createBridgeForScreen(index);
  bridges[index] = bridge;
  await applyTorProxy(index, bridge);
}

async function clearSessionData(index) {
  const ses = sessions[index];
  await ses.closeAllConnections();
  await Promise.allSettled([
    ses.clearCache(),
    ses.clearStorageData(),
  ]);
  if (typeof ses.clearHostResolverCache === 'function') await ses.clearHostResolverCache();
  pageStates.delete(views[index].webContents.id);
  ipResults[index] = null;
}

async function loadView(index, destination) {
  views[index].webContents.setZoomFactor(zoomFactor);
  await views[index].webContents.loadURL(destination);
}

async function reloadVisibleScreens(destination) {
  await Promise.allSettled(activeViews().map((_view, index) => loadView(index, destination)));
}

async function changeNetwork(mode) {
  if (networkBusy) return { ok: false, mode: networkMode, error: 'Another operation is already in progress.' };

  const requested = mode === 'tor' ? 'tor' : 'direct';
  networkBusy = true;
  setupVisible = true;
  syncRequested = false;
  syncHardLock = '';
  statusText = requested === 'tor' ? 'Connecting to the local Tor service…' : 'Switching to Direct mode…';
  dnsStatus = 'Checking network route…';
  ipResults = Array(MAX_SCREENS).fill(null);
  updateLayout();
  sendStateNow();

  try {
    await setSessionsDirect();
    await closeTorStack();

    if (requested === 'tor') {
      await setSessionsTor();
      networkMode = 'tor';
      dnsStatus = `Tor connected on local SOCKS port ${torRuntime.port}; DNS stays inside Tor`;
      statusText = 'Tor connected';
    } else {
      await setSessionsDirect();
      networkMode = 'direct';
      dnsStatus = 'Direct connection';
      statusText = 'Direct connection';
    }

    await reloadVisibleScreens(actualURL(displayURL(currentURL)));
    return { ok: true, mode: networkMode, dnsStatus };
  } catch (error) {
    const message = error?.message || String(error);
    await closeTorStack();
    await setSessionsDirect();
    networkMode = 'direct';
    dnsStatus = 'Direct connection restored';
    statusText = 'Tor was unavailable; Direct mode is active';
    return { ok: false, mode: 'direct', error: message };
  } finally {
    networkBusy = false;
    updateLayout();
    scheduleState();
  }
}

async function checkIPs() {
  if (networkBusy) return { ok: false, error: 'Another operation is still in progress.' };

  networkBusy = true;
  setupVisible = true;
  statusText = 'Verifying public IPs…';
  updateLayout();
  scheduleState();

  try {
    const results = await Promise.all(activeViews().map(async (_view, index) => {
      const ses = sessions[index];
      try {
        const response = await ses.fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`IP service returned HTTP ${response.status}`);
        const data = await response.json();
        let isTor = null;

        if (networkMode === 'tor') {
          const torCheck = await ses.fetch('https://check.torproject.org/api/ip', { cache: 'no-store' });
          if (torCheck.ok) isTor = Boolean((await torCheck.json()).IsTor);
        }

        return { ip: String(data.ip || 'Unknown'), ok: true, isTor };
      } catch (error) {
        return { ip: 'Unavailable', ok: false, error: error.message, isTor: false };
      }
    }));

    ipResults = Array(MAX_SCREENS).fill(null);
    results.forEach((result, index) => { ipResults[index] = result; });

    const duplicate = results.some((result, index) => (
      result.ok && results.findIndex((other) => other.ok && other.ip === result.ip) !== index
    ));

    if (networkMode === 'tor') {
      const allTor = results.every((result) => result.ok && result.isTor === true);
      dnsStatus = allTor
        ? 'Tor route verified; hostnames are resolved through Tor'
        : 'Tor verification was incomplete; review the screen labels';
      statusText = duplicate ? 'IPs verified; Tor reused an exit IP' : 'IP verification complete';
    } else {
      dnsStatus = 'Direct connection';
      statusText = 'IP verification complete';
    }

    return { ok: results.every((result) => result.ok), results, duplicate };
  } finally {
    networkBusy = false;
    updateLayout();
    scheduleState();
  }
}

async function restartEverything() {
  if (networkBusy) return { ok: false, error: 'Another operation is already in progress.' };

  const operation = 'restart-all';
  const requestedNetwork = networkMode;
  const restoreSync = syncRequested;
  const destination = actualURL(displayURL(currentURL));

  networkBusy = true;
  setupVisible = true;
  syncRequested = false;
  syncHardLock = '';
  ipResults = Array(MAX_SCREENS).fill(null);
  statusText = 'Restarting Relay…';
  updateLayout();
  sendStateNow();

  try {
    operationProgress(operation, 0, 'running', 'Pausing the workspace and closing active connections…');
    await setSessionsDirect();
    await closeTorStack();
    operationProgress(operation, 0, 'done', 'Workspace paused and connections closed');

    operationProgress(operation, 1, 'running', 'Clearing cookies, cache, storage, and DNS state for every screen…');
    for (let index = 0; index < MAX_SCREENS; index += 1) await clearSessionData(index);
    pageStates.clear();
    pendingActions.clear();
    operationProgress(operation, 1, 'done', 'All four browser sessions were reset');

    operationProgress(operation, 2, 'running', requestedNetwork === 'tor'
      ? 'Reconnecting every screen to the local Tor service…'
      : 'Restoring the Direct network route…');
    if (requestedNetwork === 'tor') {
      await setSessionsTor();
      networkMode = 'tor';
      dnsStatus = `Tor connected on local SOCKS port ${torRuntime.port}; DNS stays inside Tor`;
      operationProgress(operation, 2, 'done', 'Tor route rebuilt with new identities');
    } else {
      await setSessionsDirect();
      networkMode = 'direct';
      dnsStatus = 'Direct connection';
      operationProgress(operation, 2, 'done', 'Direct route restored');
    }

    operationProgress(operation, 3, 'running', 'Reloading every visible screen…');
    await reloadVisibleScreens(destination);
    applyZoom();
    requestPageStates();
    syncRequested = restoreSync;
    statusText = 'Relay restarted';
    operationProgress(operation, 3, 'done', 'All screens reloaded and Relay is ready');
    return { ok: true, mode: networkMode, syncRequested };
  } catch (error) {
    const message = error?.message || String(error);
    operationProgress(operation, 2, 'error', message);

    await closeTorStack();
    await setSessionsDirect();
    networkMode = 'direct';
    dnsStatus = 'Direct connection restored after restart error';
    syncRequested = false;
    await reloadVisibleScreens(destination);
    operationProgress(operation, 3, 'done', 'Screens reloaded in Direct mode');
    statusText = 'Restart completed in Direct mode';
    return { ok: false, mode: 'direct', fallbackReady: true, error: message };
  } finally {
    networkBusy = false;
    updateLayout();
    scheduleState();
  }
}

async function resetScreen(screenNumberValue) {
  if (networkBusy) return { ok: false, error: 'Another operation is already in progress.' };

  const screenNumber = Number(screenNumberValue);
  const index = screenNumber - 1;
  if (!Number.isInteger(index) || index < 0 || index >= screenCount) {
    return { ok: false, error: 'Choose a visible screen to reset.' };
  }

  const operation = 'reset-screen';
  const restoreSync = syncRequested;
  const destination = views[index].webContents.getURL() || actualURL(displayURL(currentURL));

  networkBusy = true;
  setupVisible = true;
  syncRequested = false;
  syncHardLock = '';
  statusText = `Resetting Screen ${screenNumber}…`;
  updateLayout();
  sendStateNow();

  try {
    operationProgress(operation, 0, 'running', `Isolating Screen ${screenNumber} and closing its connections…`);
    await sessions[index].closeAllConnections();
    operationProgress(operation, 0, 'done', `Screen ${screenNumber} is isolated`);

    operationProgress(operation, 1, 'running', 'Clearing cookies, cache, storage, and DNS state…');
    await clearSessionData(index);
    operationProgress(operation, 1, 'done', `Screen ${screenNumber} browser data was cleared`);

    operationProgress(operation, 2, 'running', networkMode === 'tor'
      ? 'Requesting a fresh Tor identity for this screen…'
      : 'Restoring the Direct route for this screen…');
    if (networkMode === 'tor') {
      await renewTorIdentity(index);
      operationProgress(operation, 2, 'done', 'Fresh Tor SOCKS identity created');
    } else {
      await setSessionDirect(index);
      operationProgress(operation, 2, 'done', 'Direct route restored');
    }

    operationProgress(operation, 3, 'running', `Reloading Screen ${screenNumber}…`);
    await loadView(index, destination);
    views[index].webContents.send('request-page-state');
    syncRequested = restoreSync;
    statusText = `Screen ${screenNumber} reset`;
    operationProgress(operation, 3, 'done', `Screen ${screenNumber} is clean and ready`);
    return { ok: true, screenNumber, mode: networkMode };
  } catch (error) {
    const message = error?.message || String(error);
    operationProgress(operation, 2, 'error', message);

    await closeTorStack();
    await setSessionsDirect();
    networkMode = 'direct';
    dnsStatus = 'Direct connection restored after screen reset error';
    syncRequested = false;
    await loadView(index, destination).catch(() => {});
    statusText = `Screen ${screenNumber} reset finished in Direct mode`;
    return { ok: false, mode: 'direct', fallbackReady: true, error: message };
  } finally {
    networkBusy = false;
    updateLayout();
    scheduleState();
  }
}

function finalizePending(actionId) {
  const pending = pendingActions.get(actionId);
  if (!pending) return;
  pendingActions.delete(actionId);

  const successful = pending.results.filter((result) => result.ok).length;
  const firstFailure = pending.results.find((result) => !result.ok);
  statusText = successful === pending.expected
    ? `Synced ${pending.kind} to ${successful}/${pending.expected}`
    : `Synced ${pending.kind} to ${successful}/${pending.expected}${firstFailure?.reason ? ` · ${firstFailure.reason}` : ''}`;
  scheduleState(100);
}

function queueReplay(action) {
  const targets = activeViews().slice(1);
  if (!targets.length) return;
  const actionId = ++actionSequence;
  pendingActions.set(actionId, { kind: action.kind, expected: targets.length, results: [] });
  targets.forEach((view) => view.webContents.send('replay-action', { actionId, action }));
  setTimeout(() => finalizePending(actionId), 1400);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 650,
    show: false,
    title: 'Relay',
    backgroundColor: '#d7d7d2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  for (let index = 0; index < MAX_SCREENS; index += 1) createView(index);
  await setSessionsDirect();
  updateLayout();
  sendStateNow();

  mainWindow.on('resize', scheduleLayout);
  mainWindow.on('closed', () => {
    mainWindow = null;
    views = [];
    sessions = [];
    pageStates.clear();
  });
}

ipcMain.handle('navigate', async (_event, value) => {
  if (setupVisible || networkBusy) return { ok: false, error: 'Relay is finishing an operation.' };
  const destination = actualURL(value);
  currentURL = destination;
  syncHardLock = '';
  statusText = 'Loading…';
  await Promise.allSettled(activeViews().map((view) => view.webContents.loadURL(destination)));
  scheduleState();
  return { ok: true };
});

ipcMain.handle('go-back', () => {
  if (setupVisible || networkBusy) return { ok: false };
  activeViews().forEach((view) => view.webContents.canGoBack() && view.webContents.goBack());
  return { ok: true };
});

ipcMain.handle('go-forward', () => {
  if (setupVisible || networkBusy) return { ok: false };
  activeViews().forEach((view) => view.webContents.canGoForward() && view.webContents.goForward());
  return { ok: true };
});

ipcMain.handle('reload', () => {
  if (setupVisible || networkBusy) return { ok: false };
  activeViews().forEach((view) => view.webContents.reload());
  return { ok: true };
});

ipcMain.handle('set-screen-count', (_event, value) => {
  screenCount = clampScreenCount(value);
  syncHardLock = '';
  ipResults = Array(MAX_SCREENS).fill(null);
  updateLayout();
  applyZoom();
  requestPageStates();
  scheduleState();
  return { ok: true, screenCount };
});

ipcMain.handle('set-zoom', (_event, value) => {
  zoomFactor = clampZoom(value);
  applyZoom();
  scheduleState();
  return { ok: true, zoomFactor };
});

ipcMain.handle('set-network', (_event, value) => changeNetwork(value));
ipcMain.handle('check-ips', checkIPs);
ipcMain.handle('restart-everything', restartEverything);
ipcMain.handle('reset-screen', (_event, screenNumber) => resetScreen(screenNumber));

ipcMain.handle('set-sync', (_event, enabled) => {
  syncRequested = Boolean(enabled);
  syncHardLock = '';
  statusText = syncRequested ? 'Checking screens…' : 'Sync off';
  requestPageStates();
  setTimeout(() => scheduleState(), 120);
  return { ok: true, enabled: syncRequested };
});

ipcMain.handle('set-setup-visible', (_event, visible) => {
  if (!visible && networkBusy) {
    return { ok: false, visible: true, error: 'Relay is still finishing the current operation.' };
  }
  setupVisible = Boolean(visible);
  statusText = setupVisible ? 'Workspace controls are locked' : (networkMode === 'tor' ? 'Tor connected' : 'Ready');
  updateLayout();
  scheduleState();
  return { ok: true, visible: setupVisible };
});

ipcMain.on('page-state', (event, state) => {
  const viewIndex = views.findIndex((view) => view.webContents.id === event.sender.id);
  if (viewIndex < 0) return;
  const previous = pageStates.get(event.sender.id) || {};
  pageStates.set(event.sender.id, { ...previous, ...state, loading: false, screenNumber: viewIndex + 1 });

  if (syncRequested && state.challenge) {
    syncHardLock = `Security challenge detected on Screen ${viewIndex + 1}`;
  }
  scheduleState(80);
});

ipcMain.on('page-action', (event, action) => {
  const sourceIndex = views.findIndex((view) => view.webContents.id === event.sender.id);
  if (sourceIndex !== 0 || !syncRequested || syncHardLock || setupVisible || networkBusy) return;

  const safety = safetySnapshot();
  if (!safety.ready) {
    statusText = `Not synced: ${safety.reason}`;
    scheduleState(100);
    return;
  }

  if (actionLooksSensitive(action)) {
    syncHardLock = 'Sensitive action was not mirrored';
    scheduleState();
    return;
  }

  queueReplay(action);
});

ipcMain.on('replay-result', (_event, result) => {
  const pending = pendingActions.get(result.actionId);
  if (!pending) return;
  pending.results.push(result);
  if (pending.results.length >= pending.expected) finalizePending(result.actionId);
});

app.whenReady().then(createWindow);
app.on('before-quit', () => {
  if (torRuntime) torRuntime.stop();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
