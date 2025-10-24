'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, safeStorage } = require('electron');
const { normalizeURL, clampScreenCount, clampZoom } = require('./core');
const { startTorRuntime } = require('./tor-manager');
const { startSocksHttpBridge, startTorHttpBridge } = require('./tor-bridge');
const { startHttpProxyBridge } = require('./http-proxy-bridge');
const { ProxyProfileStore } = require('./proxy-profile-store');
const { testProxyProfile } = require('./proxy-connectivity');
const { DISPLAY_VERSION } = require('./version');
const {
  CONNECTION_MODES,
  PROFILE_TYPES,
  ConnectionFailure,
  normalizeConnectionMode,
  normalizeProfileAssignments,
  routeForPane,
} = require('./connection-providers');
const {
  installSessionAdBlocker,
  setEnabled: setAdBlockEnabled,
  snapshot: adBlockSnapshot,
} = require('./adblocker');

const MAX_PANES = 4;
const TOOLBAR_HEIGHT = 82;
const LABEL_HEIGHT = 24;
const GAP = 2;
const HOME_URL = 'relay://home';
const LEGACY_HOME_URL = 'relay://welcome';
const AUDIO_MODES = new Set(['leader', 'focused', 'all', 'muted']);

let mainWindow = null;
let views = Array(MAX_PANES).fill(null);
let sessions = Array(MAX_PANES).fill(null);
let screenCount = 4;
let zoomFactor = 0.8;
let currentURL = HOME_URL;
let paneURLs = Array(MAX_PANES).fill(HOME_URL);
let paneLabels = Array.from({ length: MAX_PANES }, (_unused, index) => index === 0 ? 'Main' : `Pane ${index + 1}`);
let focusedPane = 0;
let audioMode = 'leader';
let networkMode = 'direct';
let networkBusy = false;
let setupVisible = false;
let panesActivated = false;
let torRuntime = null;
let bridges = Array(MAX_PANES).fill(null);
let proxyAssignments = Array(MAX_PANES).fill(null);
let proxyProfileStore = null;
let routeFailure = null;
let ipResults = Array(MAX_PANES).fill(null);
let statusText = 'Starting';
let lastResetAt = null;
let lastConnectionResetAt = null;
let resizeTimer = null;
let stateTimer = null;
let saveTimer = null;
let identitySequence = 0;
const resettingPanes = new Set();
const recoveringPanes = new Set();
const lastAutomaticRepairAt = new Map();

const homePath = path.join(__dirname, 'renderer', 'welcome-v18.html');
const homeFileURL = pathToFileURL(homePath).href;

function profilesFile() {
  return path.join(app.getPath('userData'), 'proxy-profiles-v31.json');
}

function getProxyProfileStore() {
  if (!proxyProfileStore) {
    proxyProfileStore = new ProxyProfileStore({
      filePath: profilesFile(),
      safeStorage,
    });
  }
  return proxyProfileStore;
}

function publicRouteFailure(error) {
  if (!error) return null;
  if (error instanceof ConnectionFailure) return error.toPublicResult();
  return {
    ok: false,
    code: 'CONNECTION_FAILED',
    paneNumber: null,
    profileId: null,
    error: error?.message || String(error),
    requiresFallbackConfirmation: true,
  };
}

function workspaceFile() {
  return path.join(app.getPath('userData'), 'workspace-v21.json');
}

function isHome(value) {
  return value === HOME_URL || value === LEGACY_HOME_URL || value === homeFileURL;
}

function displayURL(value) {
  return isHome(value) ? HOME_URL : value;
}

function actualURL(value) {
  const normalized = normalizeURL(value);
  return isHome(normalized) ? homeFileURL : normalized;
}

function safeStoredURL(value) {
  const normalized = normalizeURL(value);
  return isHome(normalized) ? HOME_URL : normalized;
}

function readWorkspace() {
  screenCount = 4;
  try {
    const data = JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'));
    zoomFactor = clampZoom(data.zoomFactor || 0.8);
    currentURL = safeStoredURL(data.currentURL || HOME_URL);
    paneURLs = Array.from(
      { length: MAX_PANES },
      (_unused, index) => safeStoredURL(data.paneURLs?.[index] || currentURL),
    );
    paneLabels = Array.from(
      { length: MAX_PANES },
      (_unused, index) => String(
        data.paneLabels?.[index] || (index === 0 ? 'Main' : `Pane ${index + 1}`),
      ).slice(0, 28),
    );
    audioMode = AUDIO_MODES.has(data.audioMode) ? data.audioMode : 'leader';
  } catch {
    zoomFactor = 0.8;
    currentURL = HOME_URL;
    paneURLs = Array(MAX_PANES).fill(HOME_URL);
    paneLabels = Array.from({ length: MAX_PANES }, (_unused, index) => index === 0 ? 'Main' : `Pane ${index + 1}`);
    audioMode = 'leader';
  }
}

function saveWorkspaceSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
      fs.writeFileSync(workspaceFile(), JSON.stringify({
        zoomFactor,
        currentURL: displayURL(currentURL),
        paneURLs: paneURLs.map(displayURL),
        paneLabels,
        audioMode,
      }, null, 2));
    } catch {}
  }, 220);
}

function existingViews() {
  return views.filter(Boolean);
}

function activeViews() {
  return views.slice(0, screenCount).filter(Boolean);
}

function activeSessions() {
  return sessions.slice(0, screenCount).filter(Boolean);
}

function followsLeaderNavigation() {
  const health = globalThis.__conduitCoordinatorV21?.healthSnapshot?.();
  return health?.followingEnabled === true && health?.policy?.navigation === true;
}

function scheduleAutomaticFollowerRepair(index, reason = 'stopped') {
  if (index < 1 || index >= screenCount || !followsLeaderNavigation()) return;
  const now = Date.now();
  if (now - Number(lastAutomaticRepairAt.get(index) || 0) < 15000) return;
  lastAutomaticRepairAt.set(index, now);

  const health = globalThis.__conduitCoordinatorV21?.healthSnapshot?.();
  const target = health?.rows?.[0]?.url || paneURLs[0] || HOME_URL;
  statusText = `${paneLabels[index]} ${reason}; repairing automatically`;
  scheduleState(10);

  setTimeout(() => {
    void recoverPane(index + 1, target).catch(() => {});
  }, 260);
}

function distribute(total, parts) {
  const usable = Math.max(0, total - (GAP * Math.max(0, parts - 1)));
  const base = Math.floor(usable / parts);
  const extra = usable - (base * parts);
  return Array.from({ length: parts }, (_unused, index) => base + (index < extra ? 1 : 0));
}

function gridShape(count) {
  if (count <= 1) return [1, 1];
  if (count === 2) return [2, 1];
  if (count <= 4) return [2, 2];
  if (count <= 6) return [3, 2];
  return [4, 2];
}

function layoutCells(count, width, height) {
  const [columns, rows] = gridShape(count);
  const widths = distribute(width, columns);
  const heights = distribute(Math.max(0, height - TOOLBAR_HEIGHT), rows);
  const xOffsets = [];
  const yOffsets = [];

  let x = 0;
  let y = TOOLBAR_HEIGHT;
  for (const value of widths) {
    xOffsets.push(x);
    x += value + GAP;
  }
  for (const value of heights) {
    yOffsets.push(y);
    y += value + GAP;
  }

  return Array.from({ length: count }, (_unused, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: xOffsets[column],
      y: yOffsets[row],
      width: widths[column],
      height: heights[row],
    };
  });
}

function sendStateNow() {
  stateTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('workspace-state-v18', {
    screenCount,
    zoomFactor,
    currentURL: displayURL(currentURL),
    paneURLs: paneURLs.map(displayURL),
    paneLabels,
    focusedPane,
    audioMode,
    networkMode,
    networkBusy,
    proxyProfiles: getProxyProfileStore().list(),
    proxyAssignments: [...proxyAssignments],
    routeFailure,
    setupVisible,
    panesActivated,
    status: statusText,
    ips: ipResults,
    lastResetAt,
    lastConnectionResetAt,
    adBlock: adBlockSnapshot(),
    canGoBack: views[0]?.webContents.navigationHistory.canGoBack() || false,
    canGoForward: views[0]?.webContents.navigationHistory.canGoForward() || false,
  });
}

function scheduleState(delay = 55) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(sendStateNow, delay);
}

function operationProgress(operation, percent, message) {
  mainWindow?.webContents.send('operation-progress-v18', { operation, percent, message });
}

function hideAllViews() {
  for (const view of existingViews()) {
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

function updateLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (setupVisible || networkBusy) {
    hideAllViews();
    mainWindow.webContents.send('layout-state-v18', { labels: [] });
    return;
  }

  const [width, height] = mainWindow.getContentSize();
  const labels = [];

  if (focusedPane >= 1 && focusedPane <= screenCount) {
    views.forEach((view, index) => {
      if (!view) return;
      if (index === focusedPane - 1) {
        const cell = {
          x: 0,
          y: TOOLBAR_HEIGHT,
          width,
          height: Math.max(0, height - TOOLBAR_HEIGHT),
        };
        view.setVisible(true);
        view.setBounds({
          x: cell.x,
          y: cell.y + LABEL_HEIGHT,
          width: cell.width,
          height: Math.max(0, cell.height - LABEL_HEIGHT),
        });
        labels.push({ index, x: cell.x, y: cell.y, width: cell.width, height: LABEL_HEIGHT });
      } else {
        view.setVisible(false);
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    });
  } else {
    const cells = layoutCells(screenCount, width, height);
    views.forEach((view, index) => {
      if (!view) return;
      if (index < screenCount) {
        const cell = cells[index];
        view.setVisible(true);
        view.setBounds({
          x: cell.x,
          y: cell.y + LABEL_HEIGHT,
          width: cell.width,
          height: Math.max(0, cell.height - LABEL_HEIGHT),
        });
        labels.push({ index, x: cell.x, y: cell.y, width: cell.width, height: LABEL_HEIGHT });
      } else {
        view.setVisible(false);
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    });
  }

  mainWindow.webContents.send('layout-state-v18', { labels });
}

function scheduleLayout() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateLayout, 40);
}

function applyZoom() {
  for (const view of activeViews()) view.webContents.setZoomFactor(zoomFactor);
}

function audiblePaneIndex() {
  if (audioMode === 'focused') return Math.max(0, (focusedPane || 1) - 1);
  return 0;
}

function applyAudioMode() {
  const selected = audiblePaneIndex();
  views.forEach((view, index) => {
    if (!view) return;
    let audible = false;
    if (index < screenCount) {
      if (audioMode === 'all') audible = true;
      else if (audioMode === 'leader') audible = index === 0;
      else if (audioMode === 'focused') audible = index === selected;
    }
    if (audioMode === 'muted') audible = false;
    view.webContents.setAudioMuted(!audible);
  });
}

function configureSession(ses, index) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  installSessionAdBlocker(ses, `Conduit pane ${index + 1}`);
}

function contextMenuForPane(index) {
  return Menu.buildFromTemplate([
    {
      label: focusedPane === index + 1 ? 'Show all panes' : `Focus ${paneLabels[index]}`,
      click: () => setFocusedPane(focusedPane === index + 1 ? 0 : index + 1),
    },
    { label: 'Reload pane', click: () => views[index]?.webContents.reload() },
    {
      label: 'Reset pane…',
      click: () => mainWindow?.webContents.send('menu-command-v18', {
        command: 'reset-pane',
        payload: index + 1,
      }),
    },
    ...(index > 0 ? [{
      label: 'Pause or resume following…',
      click: () => mainWindow?.webContents.send('menu-command-v18', {
        command: 'toggle-pause',
        payload: index + 1,
      }),
    }] : []),
    { type: 'separator' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
  ]);
}

function attachViewEvents(view, index) {
  const wc = view.webContents;
  wc.setAudioMuted(true);
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  wc.on('did-start-loading', () => {
    statusText = `${paneLabels[index]} loading`;
    scheduleState();
  });

  wc.on('did-stop-loading', () => {
    paneURLs[index] = displayURL(wc.getURL());
    if (index === 0) currentURL = paneURLs[0];
    wc.send('request-pane-state-v18');
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.send('request-pane-state-v18');
    }, 420);
    statusText = 'Ready';
    saveWorkspaceSoon();
    applyAudioMode();
    scheduleState(80);
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    statusText = `${paneLabels[index]} could not load: ${errorDescription || errorCode}`;
    paneURLs[index] = displayURL(validatedURL || wc.getURL() || paneURLs[index]);
    scheduleState(20);
  });

  wc.on('did-navigate', (_event, url) => {
    paneURLs[index] = displayURL(url);
    if (index === 0) currentURL = paneURLs[0];
    saveWorkspaceSoon();
    scheduleState();
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    paneURLs[index] = displayURL(url);
    if (index === 0) currentURL = paneURLs[0];
    saveWorkspaceSoon();
    scheduleState();
  });

  wc.on('context-menu', () => contextMenuForPane(index).popup({ window: mainWindow }));

  wc.on('render-process-gone', (_event, details) => {
    statusText = `${paneLabels[index]} stopped: ${details.reason}`;
    globalThis.__conduitCoordinatorV21?.forgetPane(index + 1);
    scheduleState();
    scheduleAutomaticFollowerRepair(index, details.reason || 'stopped');
  });
}

function getOrCreateSession(index) {
  if (sessions[index]) return sessions[index];
  const partition = `persist:conduit-pane-${index + 1}`;
  const ses = session.fromPartition(partition, { cache: true });
  configureSession(ses, index);
  sessions[index] = ses;
  return ses;
}

function buildView(index) {
  const partition = `persist:conduit-pane-${index + 1}`;
  getOrCreateSession(index);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'page-preload-v18.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [`--conduit-pane=${index + 1}`],
    },
  });

  attachViewEvents(view, index);
  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  view.webContents.setZoomFactor(zoomFactor);
  views[index] = view;
  return view;
}

function loadViewWhenReady(index, delay = 0) {
  const view = views[index];
  if (!view || view.webContents.isDestroyed()) return;
  setTimeout(() => {
    if (view.webContents.isDestroyed()) return;
    const destination = actualURL(paneURLs[index]);
    if (view.webContents.getURL() === destination) return;
    view.webContents.loadURL(destination).catch(() => {});
  }, delay);
}

function ensureView(index) {
  if (views[index] && !views[index].webContents.isDestroyed()) return views[index];
  const view = buildView(index);
  if (panesActivated) loadViewWhenReady(index, Math.min(index, 4) * 55);
  return view;
}

function ensureViews(count) {
  for (let index = 0; index < count; index += 1) ensureView(index);
}

async function activatePanes() {
  ensureViews(screenCount);
  panesActivated = true;
  statusText = 'Opening browser screens';
  operationProgress('activate', 88, `Opening ${screenCount} browser screen${screenCount === 1 ? '' : 's'}`);

  await Promise.allSettled(activeViews().map((view, index) => {
    const destination = actualURL(paneURLs[index]);
    if (view.webContents.getURL() === destination) return Promise.resolve();
    return view.webContents.loadURL(destination);
  }));

  applyZoom();
  applyAudioMode();
  statusText = 'Ready';
  updateLayout();
  scheduleState(10);
  return { ok: true, panesActivated, screenCount };
}

function detachAndCloseView(index) {
  const old = views[index];
  if (!old) return;

  globalThis.__conduitCoordinatorV21?.forgetPane(index + 1);
  try { mainWindow?.contentView.removeChildView(old); } catch {}
  views[index] = null;

  if (!old.webContents.isDestroyed()) {
    try { old.webContents.close({ waitForBeforeUnload: false }); } catch {}
  }
}

function paneResetDestination(paneNumber, index) {
  const sync = globalThis.__conduitCoordinatorV21?.healthSnapshot?.();
  if (paneNumber > 1 && sync?.followingEnabled && sync?.policy?.navigation) {
    return paneURLs[0] || HOME_URL;
  }
  return paneURLs[index] || HOME_URL;
}

async function recreateView(index) {
  detachAndCloseView(index);

  const view = buildView(index);
  await view.webContents.loadURL(actualURL(paneURLs[index]));
  view.webContents.setZoomFactor(zoomFactor);
  applyAudioMode();

  for (const delay of [40, 260, 780, 1500]) {
    setTimeout(() => {
      if (!view.webContents.isDestroyed()) view.webContents.send('request-pane-state-v18');
    }, delay);
  }

  return view;
}

async function closeRouteBridges() {
  await Promise.allSettled(activeSessions().map((ses) => ses.closeAllConnections()));
  const old = bridges;
  bridges = Array(MAX_PANES).fill(null);
  await Promise.allSettled(old.filter(Boolean).map((bridge) => bridge.close()));
}

async function closeNetworkStack() {
  await closeRouteBridges();
  torRuntime?.stop();
  torRuntime = null;
}

async function setSessionDirect(index) {
  const ses = getOrCreateSession(index);
  await ses.setProxy({ mode: 'direct' });
  await ses.closeAllConnections();
  await ses.clearHostResolverCache?.();
}

async function setAllDirect() {
  await Promise.all(
    sessions.map((ses, index) => (ses ? setSessionDirect(index) : Promise.resolve())),
  );
}

async function setSessionBlocked(index) {
  const ses = getOrCreateSession(index);
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: 'http://127.0.0.1:9',
    proxyBypassRules: '',
  });
  await ses.closeAllConnections();
  await ses.clearHostResolverCache?.();
}

async function setAllBlocked() {
  await Promise.all(
    Array.from({ length: screenCount }, (_unused, index) => setSessionBlocked(index)),
  );
}

function nextIdentity(index) {
  identitySequence += 1;
  return `conduit-${Date.now()}-${process.pid}-${identitySequence}-${index + 1}`;
}

async function createTorBridge(index) {
  if (!torRuntime) {
    throw new Error('Multiple IPs requires a compatible local private-route service.');
  }
  const socksPort = torRuntime.socksPorts[index] || torRuntime.port;
  return startTorHttpBridge({
    socksPort,
    username: nextIdentity(index),
    password: `pane-${index + 1}-${identitySequence}`,
  });
}

async function applyBridge(index, bridge) {
  const ses = getOrCreateSession(index);
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: `http://127.0.0.1:${bridge.port}`,
    proxyBypassRules: '<-loopback>',
  });
  await ses.closeAllConnections();
  await ses.clearHostResolverCache?.();
}

async function setPanePrivate(index) {
  if (bridges[index]) await bridges[index].close();
  bridges[index] = await createTorBridge(index);
  await applyBridge(index, bridges[index]);
}

async function setAllPrivate() {
  torRuntime = await startTorRuntime(app.getPath('userData'), MAX_PANES);
  for (let index = 0; index < screenCount; index += 1) {
    await setPanePrivate(index);
    operationProgress('network', 25 + Math.round(((index + 1) / screenCount) * 55), `Preparing IP ${index + 1} of ${screenCount}`);
  }
}

async function createProfileBridge(profile) {
  if (profile.type === PROFILE_TYPES.SOCKS5) {
    return startSocksHttpBridge({
      socksHost: profile.host,
      socksPort: profile.port,
      username: profile.username,
      password: profile.password,
    });
  }
  if (profile.type === PROFILE_TYPES.HTTP) {
    return startHttpProxyBridge({
      proxyHost: profile.host,
      proxyPort: profile.port,
      username: profile.username,
      password: profile.password,
    });
  }
  throw new ConnectionFailure('The selected proxy type is unsupported.', {
    code: 'PROFILE_INVALID',
    profileId: profile.id,
  });
}

function profileForPane(index, assignments = proxyAssignments) {
  return routeForPane({
    mode: CONNECTION_MODES.PROXY,
    assignments,
    paneIndex: index,
    profileById: (id) => getProxyProfileStore().resolve(id),
  }).profile;
}

async function setPaneProxy(index, assignments = proxyAssignments) {
  const profile = profileForPane(index, assignments);
  if (bridges[index]) await bridges[index].close();
  bridges[index] = await createProfileBridge(profile);
  await applyBridge(index, bridges[index]);
}

async function setAllProxies(assignments = proxyAssignments) {
  for (let index = 0; index < screenCount; index += 1) {
    await setPaneProxy(index, assignments);
    operationProgress(
      'network',
      25 + Math.round(((index + 1) / screenCount) * 55),
      `Preparing proxy for Screen ${index + 1}`,
    );
  }
}

async function changeNetwork(value) {
  if (networkBusy) return { ok: false, error: 'Another operation is running.' };

  const request = value && typeof value === 'object' ? value : { mode: value };
  const requested = normalizeConnectionMode(request.mode);
  const requestedAssignments = normalizeProfileAssignments(
    request.assignments ?? proxyAssignments,
    MAX_PANES,
  );

  if (requested === CONNECTION_MODES.PROXY) {
    try {
      for (let index = 0; index < screenCount; index += 1) {
        profileForPane(index, requestedAssignments);
      }
    } catch (error) {
      routeFailure = publicRouteFailure(error);
      scheduleState(10);
      return routeFailure;
    }
  }

  const previousSetupVisible = setupVisible;
  networkBusy = true;
  setupVisible = true;
  routeFailure = null;
  statusText = requested === CONNECTION_MODES.TOR
    ? 'Connecting Multiple IPs'
    : requested === CONNECTION_MODES.PROXY
      ? 'Connecting proxies'
      : 'Connecting Standard';
  operationProgress('network', 8, 'Closing old connections');
  updateLayout();
  scheduleState(10);

  try {
    await closeNetworkStack();

    if (requested === CONNECTION_MODES.TOR) {
      operationProgress('network', 18, 'Starting private routes');
      await setAllPrivate();
      networkMode = CONNECTION_MODES.TOR;
      statusText = 'Multiple IPs active';
    } else if (requested === CONNECTION_MODES.PROXY) {
      operationProgress('network', 18, 'Starting proxy routes');
      await setAllProxies(requestedAssignments);
      proxyAssignments = requestedAssignments;
      networkMode = CONNECTION_MODES.PROXY;
      statusText = 'Proxy profiles active';
    } else {
      operationProgress('network', 58, 'Restoring the normal route');
      await setAllDirect();
      networkMode = CONNECTION_MODES.DIRECT;
      statusText = 'Standard active';
    }

    operationProgress('network', 88, panesActivated ? 'Reloading screens' : 'Connection prepared');
    if (panesActivated) {
      await Promise.allSettled(
        activeViews().map((view, index) => view.webContents.loadURL(actualURL(paneURLs[index]))),
      );
    }
    operationProgress('network', 100, 'Connection ready');
    return {
      ok: true,
      mode: networkMode,
      assignments: [...proxyAssignments],
    };
  } catch (error) {
    await closeNetworkStack();
    if (requested === CONNECTION_MODES.DIRECT) {
      await setAllDirect();
      networkMode = CONNECTION_MODES.DIRECT;
    } else {
      await setAllBlocked();
      networkMode = requested;
    }
    routeFailure = publicRouteFailure(error);
    statusText = requested === CONNECTION_MODES.DIRECT
      ? 'Standard connection failed'
      : 'Route failed — screens remain blocked';
    return { ...routeFailure, mode: networkMode };
  } finally {
    networkBusy = false;
    setupVisible = previousSetupVisible;
    applyAudioMode();
    updateLayout();
    scheduleState(20);
  }
}

async function fetchJSONWithTimeout(ses, url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await ses.fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRoute(data, source) {
  const ip = data?.ip || data?.query;
  if (!ip) return null;

  const city = data.city || '';
  const region = data.region_code || data.region || data.regionName || '';
  const country = data.country_code || data.country_code_iso3 || data.countryCode || data.country || '';
  let location = [city, region, country].filter(Boolean).join(', ');

  if (!location && data.country_name) location = data.country_name;
  if (!location && data.country) location = data.country;

  return {
    ok: true,
    ip: String(ip),
    location: location || 'Location unavailable',
    city: String(city || ''),
    region: String(region || ''),
    country: String(data.country_name || data.country || ''),
    countryCode: String(data.country_code || data.countryCode || ''),
    source,
  };
}

async function fetchRouteDetails(ses) {
  let lastError = null;

  const providers = [
    {
      url: 'https://ipwho.is/',
      source: 'ipwho.is',
      map: (data) => {
        if (data?.success === false) throw new Error(data.message || 'Location lookup failed');
        return normalizeRoute(data, 'ipwho.is');
      },
    },
    {
      url: 'https://ipapi.co/json/',
      source: 'ipapi.co',
      map: (data) => normalizeRoute(data, 'ipapi.co'),
    },
  ];

  for (const provider of providers) {
    try {
      const data = await fetchJSONWithTimeout(ses, provider.url, 10000);
      const route = provider.map(data);
      if (route && route.location !== 'Location unavailable') return route;
      if (route) {
        lastError = new Error('Provider returned no location');
        continue;
      }
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const data = await fetchJSONWithTimeout(ses, 'https://api.ipify.org?format=json', 7000);
    if (!data?.ip) throw new Error('IP lookup failed');
    return {
      ok: true,
      ip: String(data.ip),
      location: 'Location unavailable',
      source: 'api.ipify.org',
    };
  } catch (error) {
    return {
      ok: false,
      ip: 'Unavailable',
      location: '',
      error: error?.message || lastError?.message || String(error),
    };
  }
}

async function checkIPs() {
  if (networkBusy) return { ok: false, error: 'Another operation is running.' };

  const previousSetupVisible = setupVisible;
  networkBusy = true;
  setupVisible = true;
  statusText = 'Checking IP addresses and locations';
  operationProgress('verify', 8, 'Starting route checks');
  updateLayout();
  scheduleState(10);

  try {
    let completed = 0;
    const results = await Promise.all(
      Array.from({ length: screenCount }, async (_unused, index) => {
        const result = await fetchRouteDetails(getOrCreateSession(index));
        ipResults[index] = result;
        completed += 1;
        operationProgress(
          'verify',
          10 + Math.round((completed / screenCount) * 88),
          `Checked ${completed} of ${screenCount} panes`,
        );
        scheduleState(5);
        return result;
      }),
    );

    for (let index = screenCount; index < MAX_PANES; index += 1) ipResults[index] = null;
    statusText = `${results.filter((item) => item.ok).length}/${results.length} locations checked`;
    return { ok: results.every((item) => item.ok), results };
  } finally {
    networkBusy = false;
    setupVisible = previousSetupVisible;
    operationProgress('verify', 100, 'Route check complete');
    updateLayout();
    scheduleState(20);
  }
}

async function clearPane(index) {
  const ses = getOrCreateSession(index);
  await ses.closeAllConnections();
  await Promise.allSettled([ses.clearCache(), ses.clearStorageData()]);
  await ses.clearHostResolverCache?.();
  ipResults[index] = null;
}

async function recoverPane(paneNumberValue, destinationValue) {
  const paneNumber = Number(paneNumberValue);
  const index = paneNumber - 1;
  if (!Number.isInteger(index) || index < 1 || index >= screenCount) {
    return { ok: false, error: 'Choose a visible follower screen.' };
  }
  if (networkBusy || resettingPanes.has(index) || recoveringPanes.has(index)) {
    return { ok: false, error: 'This screen is already being repaired.' };
  }

  const destination = displayURL(destinationValue || paneResetDestination(paneNumber, index));
  recoveringPanes.add(index);
  statusText = `Repairing ${paneLabels[index]}`;
  operationProgress('recover', 20, `Rebuilding ${paneLabels[index]} without clearing its session`);

  try {
    // A soft rebuild replaces only the failed WebContentsView. Cookies, local
    // storage, proxy settings, and the other panes remain untouched.
    detachAndCloseView(index);
    paneURLs[index] = destination;
    updateLayout();
    scheduleState(5);
    await new Promise((resolve) => setTimeout(resolve, 55));

    await recreateView(index);
    updateLayout();
    operationProgress('recover', 85, `Rejoining ${paneLabels[index]} to Screen 1`);

    for (const delay of [80, 320, 900]) {
      setTimeout(() => globalThis.__conduitCoordinatorV21?.resyncPane?.(paneNumber), delay);
    }

    statusText = `${paneLabels[index]} repaired`;
    operationProgress('recover', 100, 'Screen repaired');
    return { ok: true, paneNumber, url: destination, preservedSession: true };
  } catch (error) {
    statusText = `${paneLabels[index]} repair failed`;
    return { ok: false, error: error?.message || String(error) };
  } finally {
    recoveringPanes.delete(index);
    applyAudioMode();
    updateLayout();
    scheduleState(20);
  }
}

async function resetPane(paneNumberValue) {
  const paneNumber = Number(paneNumberValue);
  const index = paneNumber - 1;
  if (!Number.isInteger(index) || index < 0 || index >= screenCount) {
    return { ok: false, error: 'Choose a visible pane.' };
  }
  if (networkBusy) return { ok: false, error: 'Another workspace operation is running.' };
  if (resettingPanes.has(index)) return { ok: false, error: 'This screen is already resetting.' };

  const returnURL = paneResetDestination(paneNumber, index);
  resettingPanes.add(index);
  operationProgress('reset', 8, `Disconnecting ${paneLabels[index]}`);

  try {
    // Destroy the old page before clearing its partition so it cannot immediately
    // recreate cookies or local storage while the reset is running.
    detachAndCloseView(index);
    updateLayout();
    scheduleState(5);
    await new Promise((resolve) => setTimeout(resolve, 45));

    await clearPane(index);
    paneURLs[index] = displayURL(returnURL);
    operationProgress('reset', 42, 'This screen was cleared');

    if (networkMode === CONNECTION_MODES.TOR) {
      await setPanePrivate(index);
    } else if (networkMode === CONNECTION_MODES.PROXY) {
      await setPaneProxy(index);
    } else {
      await setSessionDirect(index);
    }

    operationProgress('reset', 70, 'Rebuilding this screen');
    await recreateView(index);
    updateLayout();
    operationProgress('reset', 92, 'Rejoining this screen');
    globalThis.__conduitCoordinatorV21?.resyncPane?.(paneNumber);

    lastResetAt = Date.now();
    statusText = `${paneLabels[index]} reset`;
    operationProgress('reset', 100, 'Screen reset complete');
    return { ok: true, paneNumber, url: displayURL(returnURL) };
  } catch (error) {
    // Keep the workspace usable even when rebuilding the selected screen fails.
    if (!views[index] || views[index].webContents.isDestroyed()) {
      paneURLs[index] = HOME_URL;
      try { await recreateView(index); } catch {}
    }
    return { ok: false, error: error?.message || String(error) };
  } finally {
    resettingPanes.delete(index);
    applyAudioMode();
    updateLayout();
    scheduleState(20);
  }
}

async function resetAllConnections() {
  if (networkBusy) return { ok: false, error: 'Another operation is running.' };
  if (!panesActivated) return { ok: false, error: 'Open the browser screens before resetting connections.' };

  const requestedNetwork = networkMode;
  const previousSetupVisible = setupVisible;
  networkBusy = true;
  setupVisible = true;
  statusText = 'Resetting all connections';
  updateLayout();
  scheduleState(10);
  operationProgress('connections', 8, 'Closing live connections');

  try {
    await Promise.allSettled(activeSessions().map(async (ses) => {
      await ses.closeAllConnections();
      await ses.clearHostResolverCache?.();
    }));
    ipResults = Array(MAX_PANES).fill(null);

    operationProgress(
      'connections',
      32,
      requestedNetwork === CONNECTION_MODES.TOR
        ? 'Renewing private-route identities'
        : requestedNetwork === CONNECTION_MODES.PROXY
          ? 'Reconnecting proxy profiles'
          : 'Refreshing the standard route',
    );

    if (requestedNetwork === CONNECTION_MODES.TOR) {
      if (!torRuntime) torRuntime = await startTorRuntime(app.getPath('userData'), MAX_PANES);

      const oldBridges = bridges;
      bridges = Array(MAX_PANES).fill(null);
      await Promise.allSettled(oldBridges.filter(Boolean).map((bridge) => bridge.close()));

      for (let index = 0; index < screenCount; index += 1) {
        await setPanePrivate(index);
        operationProgress(
          'connections',
          36 + Math.round(((index + 1) / screenCount) * 34),
          `Renewing connection ${index + 1} of ${screenCount}`,
        );
      }
      networkMode = CONNECTION_MODES.TOR;
    } else if (requestedNetwork === CONNECTION_MODES.PROXY) {
      await closeRouteBridges();
      await setAllProxies(proxyAssignments);
      networkMode = CONNECTION_MODES.PROXY;
    } else {
      await closeNetworkStack();
      await Promise.all(
        Array.from({ length: screenCount }, (_unused, index) => setSessionDirect(index)),
      );
      networkMode = CONNECTION_MODES.DIRECT;
    }

    operationProgress('connections', 76, 'Reconnecting current pages');
    const coordinator = globalThis.__conduitCoordinatorV21;
    const health = coordinator?.healthSnapshot?.();
    const reconnects = [];

    for (let index = 0; index < screenCount; index += 1) {
      const view = views[index];
      if (!view || view.webContents.isDestroyed()) continue;
      const paneNumber = index + 1;
      const destination = displayURL(paneURLs[index] || HOME_URL);
      const row = health?.rows?.find((item) => item.paneNumber === paneNumber);

      if (paneNumber > 1 && !row?.paused && coordinator?.navigatePane) {
        const result = coordinator.navigatePane(paneNumber, destination);
        if (result?.ok !== false) continue;
      }

      reconnects.push(view.webContents.loadURL(actualURL(destination)));
    }

    await Promise.allSettled(reconnects);
    for (let paneNumber = 2; paneNumber <= screenCount; paneNumber += 1) {
      setTimeout(() => coordinator?.resyncPane?.(paneNumber), 280 + (paneNumber * 70));
    }

    lastConnectionResetAt = Date.now();
    statusText = requestedNetwork === CONNECTION_MODES.TOR
      ? 'All private connections renewed'
      : requestedNetwork === CONNECTION_MODES.PROXY
        ? 'All proxy connections renewed'
        : 'All standard connections renewed';
    operationProgress('connections', 100, 'All connections reset');
    return {
      ok: true,
      mode: networkMode,
      preservedSessionData: true,
      resetAt: lastConnectionResetAt,
    };
  } catch (error) {
    statusText = 'Connection reset failed';
    if (requestedNetwork !== CONNECTION_MODES.DIRECT) {
      await closeNetworkStack();
      await setAllBlocked();
      routeFailure = publicRouteFailure(error);
    }
    return {
      ...(routeFailure || publicRouteFailure(error)),
      mode: networkMode,
    };
  } finally {
    networkBusy = false;
    setupVisible = previousSetupVisible;
    applyAudioMode();
    updateLayout();
    scheduleState(20);
  }
}

async function restartAll() {
  if (networkBusy) return { ok: false, error: 'Another operation is running.' };

  const requestedNetwork = networkMode;
  const previousSetupVisible = setupVisible;
  networkBusy = true;
  setupVisible = true;
  updateLayout();
  operationProgress('restart', 8, 'Closing connections');

  try {
    await closeNetworkStack();

    operationProgress('restart', 30, 'Clearing pane data');
    for (let index = 0; index < screenCount; index += 1) {
      await clearPane(index);
      globalThis.__conduitCoordinatorV21?.forgetPane(index + 1);
    }

    operationProgress('restart', 52, 'Rebuilding connection');
    if (requestedNetwork === CONNECTION_MODES.TOR) {
      await setAllPrivate();
      networkMode = CONNECTION_MODES.TOR;
    } else if (requestedNetwork === CONNECTION_MODES.PROXY) {
      await setAllProxies(proxyAssignments);
      networkMode = CONNECTION_MODES.PROXY;
    } else {
      await setAllDirect();
      networkMode = CONNECTION_MODES.DIRECT;
    }

    operationProgress('restart', 72, 'Rebuilding panes');
    for (let index = 0; index < screenCount; index += 1) {
      await recreateView(index);
    }

    lastResetAt = Date.now();
    statusText = 'Workspace restarted';
    operationProgress('restart', 100, 'Workspace ready');
    return { ok: true };
  } catch (error) {
    await closeNetworkStack();
    if (requestedNetwork === CONNECTION_MODES.DIRECT) {
      networkMode = CONNECTION_MODES.DIRECT;
      await setAllDirect();
    } else {
      networkMode = requestedNetwork;
      await setAllBlocked();
    }
    routeFailure = publicRouteFailure(error);
    return { ...routeFailure, mode: networkMode };
  } finally {
    networkBusy = false;
    setupVisible = previousSetupVisible;
    applyAudioMode();
    updateLayout();
    scheduleState(20);
  }
}

function setFocusedPane(value) {
  const paneNumber = Number(value);
  focusedPane = Number.isInteger(paneNumber) && paneNumber >= 1 && paneNumber <= screenCount
    ? paneNumber
    : 0;
  applyAudioMode();
  updateLayout();
  scheduleState();
  return { ok: true, focusedPane };
}

function setAudioMode(value) {
  audioMode = AUDIO_MODES.has(value) ? value : 'leader';
  applyAudioMode();
  saveWorkspaceSoon();
  scheduleState();
  return { ok: true, audioMode };
}

async function setPaneCount(value) {
  if (networkBusy) return { ok: false, error: 'Another operation is running.' };
  const next = clampScreenCount(value);
  const previous = screenCount;
  const routedGrowth = (
    (networkMode === CONNECTION_MODES.TOR || networkMode === CONNECTION_MODES.PROXY)
    && next > previous
  );
  const previousSetupVisible = setupVisible;
  const panesWereActivated = panesActivated;

  if (routedGrowth) {
    networkBusy = true;
    setupVisible = true;
    panesActivated = false;
    updateLayout();
  }

  try {
    ensureViews(next);
    panesActivated = panesWereActivated;
    screenCount = next;

    if (focusedPane > screenCount) focusedPane = 0;
    ipResults = Array(MAX_PANES).fill(null);

    if (routedGrowth) {
      for (let index = previous; index < next; index += 1) {
        if (networkMode === CONNECTION_MODES.TOR) {
          await setPanePrivate(index);
        } else {
          proxyAssignments[index] ||= proxyAssignments[0];
          await setPaneProxy(index);
        }
      }
      if (panesWereActivated) {
        for (let index = previous; index < next; index += 1) loadViewWhenReady(index);
      }
    } else if (
      (networkMode === CONNECTION_MODES.TOR || networkMode === CONNECTION_MODES.PROXY)
      && next < previous
    ) {
      for (let index = next; index < previous; index += 1) {
        if (bridges[index]) {
          await bridges[index].close().catch(() => {});
          bridges[index] = null;
        }
        if (sessions[index]) await setSessionDirect(index).catch(() => {});
      }
    }

    return { ok: true, screenCount };
  } catch (error) {
    if (routedGrowth) {
      await Promise.allSettled(
        Array.from(
          { length: next - previous },
          (_unused, offset) => setSessionBlocked(previous + offset),
        ),
      );
      routeFailure = publicRouteFailure(error);
    }
    return { ...publicRouteFailure(error), screenCount };
  } finally {
    panesActivated = panesWereActivated;
    if (routedGrowth) {
      networkBusy = false;
      setupVisible = previousSetupVisible;
    }
    applyZoom();
    applyAudioMode();
    updateLayout();
    scheduleState();
  }
}

async function createWindow() {
  readWorkspace();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: DISPLAY_VERSION,
    backgroundColor: '#25272d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  setupVisible = true;
  panesActivated = false;
  statusText = 'Waiting for workspace settings';

  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index-v18.html'));

  updateLayout();
  sendStateNow();

  mainWindow.on('resize', scheduleLayout);
  mainWindow.on('closed', () => {
    mainWindow = null;
    views = Array(MAX_PANES).fill(null);
    sessions = Array(MAX_PANES).fill(null);
  });
}

ipcMain.handle('v18-navigate', async (_event, value) => {
  if (setupVisible || networkBusy) return { ok: false, error: 'Conduit is applying changes.' };

  const destination = actualURL(value);
  currentURL = displayURL(destination);
  const leaderOnly = followsLeaderNavigation();
  const targets = leaderOnly ? [views[0]].filter(Boolean) : activeViews();

  await Promise.allSettled(targets.map((view, targetIndex) => {
    const index = leaderOnly ? 0 : targetIndex;
    paneURLs[index] = currentURL;
    return view.webContents.loadURL(destination);
  }));

  // When Navigation following is active, Screen 1 is the only navigation owner.
  // Followers receive the settled address through the coordinator, avoiding two
  // overlapping loadURL calls for the same pane.
  if (leaderOnly) {
    for (const delay of [30, 160, 420]) {
      setTimeout(() => globalThis.__conduitCoordinatorV21?.requestPane?.(1), delay);
    }
  }

  saveWorkspaceSoon();
  scheduleState();
  return { ok: true, leaderOnly };
});

ipcMain.handle('v18-back', () => {
  const targets = followsLeaderNavigation() ? [views[0]].filter(Boolean) : activeViews();
  targets.forEach((view) => {
    const history = view.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
  });
  return { ok: true };
});

ipcMain.handle('v18-forward', () => {
  const targets = followsLeaderNavigation() ? [views[0]].filter(Boolean) : activeViews();
  targets.forEach((view) => {
    const history = view.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
  });
  return { ok: true };
});

ipcMain.handle('v18-reload-all', () => {
  activeViews().forEach((view) => view.webContents.reload());
  return { ok: true };
});

ipcMain.handle('v18-reload-active', () => {
  views[(focusedPane || 1) - 1]?.webContents.reload();
  return { ok: true };
});

ipcMain.handle('v18-set-pane-count-workspace', (_event, value) => setPaneCount(value));

ipcMain.handle('v18-set-zoom', (_event, value) => {
  zoomFactor = clampZoom(value);
  applyZoom();
  saveWorkspaceSoon();
  scheduleState();
  return { ok: true, zoomFactor };
});

ipcMain.handle('v18-set-audio-mode', (_event, value) => setAudioMode(value));
ipcMain.handle('v18-set-network', (_event, value) => changeNetwork(value));
ipcMain.handle('v31-list-proxy-profiles', () => ({
  ok: true,
  profiles: getProxyProfileStore().list(),
}));
ipcMain.handle('v31-save-proxy-profile', (_event, value) => {
  try {
    const profile = getProxyProfileStore().save(value);
    scheduleState(10);
    return { ok: true, profile };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle('v31-delete-proxy-profile', (_event, value) => {
  const id = String(value || '');
  if (networkMode === CONNECTION_MODES.PROXY && proxyAssignments.includes(id)) {
    return {
      ok: false,
      error: 'Switch away from this proxy profile before deleting it.',
    };
  }
  const removed = getProxyProfileStore().remove(id);
  if (removed) {
    proxyAssignments = proxyAssignments.map((assigned) => assigned === id ? null : assigned);
    scheduleState(10);
  }
  return { ok: removed };
});
ipcMain.handle('v31-test-proxy-profile', async (_event, value) => {
  try {
    const profile = getProxyProfileStore().resolve(String(value || ''));
    if (!profile) return { ok: false, error: 'The proxy profile no longer exists.' };
    return await testProxyProfile(profile);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});
ipcMain.handle('v18-check-ips', checkIPs);
ipcMain.handle('v18-reset-pane', (_event, value) => resetPane(value));
ipcMain.handle('v31-request-pane-reset', (_event, value) => {
  const paneNumber = Number(value);
  const index = paneNumber - 1;
  if (!Number.isInteger(index) || index < 0 || index >= screenCount) {
    return { ok: false, error: 'Choose a visible pane.' };
  }
  if (networkBusy || resettingPanes.has(index)) {
    return { ok: false, error: 'This screen cannot be reset right now.' };
  }

  // Start immediately but acknowledge before the requesting pane is destroyed.
  void resetPane(paneNumber).catch(() => {});
  return { ok: true, accepted: true, paneNumber };
});
ipcMain.handle('v34-reset-all-connections', resetAllConnections);
ipcMain.handle('v18-restart-all', restartAll);
ipcMain.handle('v18-focus-pane', (_event, value) => setFocusedPane(value));

ipcMain.handle('v18-set-pane-label', (_event, paneNumberValue, labelValue) => {
  const index = Number(paneNumberValue) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PANES) return { ok: false };
  paneLabels[index] = String(labelValue || `Pane ${index + 1}`).trim().slice(0, 28)
    || `Pane ${index + 1}`;
  saveWorkspaceSoon();
  updateLayout();
  scheduleState();
  return { ok: true, paneLabels };
});

ipcMain.handle('v18-set-settings-visible', (_event, visible) => {
  if (!visible && networkBusy) return { ok: false, error: 'An operation is still running.' };
  if (!visible && !panesActivated) {
    return { ok: false, error: 'Apply settings before opening the workspace.' };
  }
  setupVisible = Boolean(visible);
  updateLayout();
  scheduleState();
  return { ok: true, visible: setupVisible };
});

ipcMain.handle('v30-activate-panes', activatePanes);

ipcMain.handle('v18-get-workspace', () => ({
  screenCount,
  zoomFactor,
  currentURL: displayURL(currentURL),
  paneURLs: paneURLs.map(displayURL),
  paneLabels,
  focusedPane,
  audioMode,
  networkMode,
  proxyProfiles: getProxyProfileStore().list(),
  proxyAssignments: [...proxyAssignments],
  routeFailure,
  setupVisible,
  panesActivated,
  ips: ipResults,
  lastResetAt,
  lastConnectionResetAt,
  adBlock: adBlockSnapshot(),
}));

ipcMain.handle('v18-get-adblock', () => adBlockSnapshot());
ipcMain.handle('v18-set-adblock', (_event, enabled) => {
  const result = setAdBlockEnabled(enabled);
  scheduleState();
  return result;
});

globalThis.__conduitWorkspaceV21 = {
  recoverPane(value, destination) {
    return recoverPane(value, destination);
  },
};

app.whenReady().then(createWindow);
app.on('before-quit', () => {
  saveWorkspaceSoon();
  void closeRouteBridges();
  torRuntime?.stop();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
