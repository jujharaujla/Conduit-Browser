'use strict';

const address = document.querySelector('#address');
const addressForm = document.querySelector('#address-form');
const back = document.querySelector('#back');
const forward = document.querySelector('#forward');
const reload = document.querySelector('#reload');
const restartAll = document.querySelector('#restart-all');
const openSettings = document.querySelector('#open-settings');
const openConsole = document.querySelector('#open-console');
const status = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const dnsStatus = document.querySelector('#dns-status');
const labels = document.querySelector('#labels');
const summaryScreens = document.querySelector('#summary-screens');
const summaryZoom = document.querySelector('#summary-zoom');
const summaryNetwork = document.querySelector('#summary-network');
const summarySync = document.querySelector('#summary-sync');

const setupBackdrop = document.querySelector('#setup-backdrop');
const setupDialog = document.querySelector('#setup-dialog');
const setupContent = document.querySelector('#setup-content');
const setupOptions = document.querySelector('#setup-options');
const setupCancel = document.querySelector('#setup-cancel');
const setupBack = document.querySelector('#setup-back');
const setupLaunch = document.querySelector('#setup-launch');
const continueDirect = document.querySelector('#continue-direct');
const setupError = document.querySelector('#setup-error');
const setupEyebrow = document.querySelector('#setup-eyebrow');
const setupTitle = document.querySelector('#setup-title');
const setupIntro = document.querySelector('#setup-intro');
const progressEyebrow = document.querySelector('#progress-eyebrow');
const progressTitle = document.querySelector('#progress-title');
const progressBar = document.querySelector('#progress-bar');
const progressPercent = document.querySelector('#progress-percent');
const setupScreenCount = document.querySelector('#setup-screen-count');
const setupZoom = document.querySelector('#setup-zoom');
const setupEnforceRoute = document.querySelector('#setup-enforce-route');
const setupCheckIPs = document.querySelector('#setup-check-ips');
const setupSync = document.querySelector('#setup-sync');
const connectionConsoleSection = document.querySelector('#connection-console-section');
const connectionConsole = document.querySelector('#connection-console');
const clearConsole = document.querySelector('#clear-console');
const resetScreenButtons = Array.from(document.querySelectorAll('.screen-reset-button'));
const progressSteps = [0, 1, 2, 3].map((index) => document.querySelector(`#progress-step-${index}`));

const setupControls = [
  setupScreenCount,
  setupZoom,
  setupEnforceRoute,
  setupCheckIPs,
  setupSync,
  ...Array.from(document.querySelectorAll('input[name="setup-network"]')),
  ...resetScreenButtons,
];

const SETTINGS_STEPS = [
  'Workspace layout and zoom',
  'Connection and DNS route',
  'Public-route verification',
  'Synchronization preference',
];

let latestState = null;
let latestLayout = [];
let setupBusy = false;
let hasOpenedWorkspace = false;
let dialogMode = 'settings';
let pendingRecovery = null;
let enforcePrivateRoute = localStorage.getItem('relay.enforcePrivateRoute') === 'true';
let routeMonitorTimer = null;
let routeCheckInFlight = false;
let routeFailureLocking = false;
let consoleEntries = [];
let lastStateLogKey = '';

function timestamp() {
  return new Date().toLocaleTimeString('en-CA', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function appendLog(level, message) {
  const clean = String(message || '').trim();
  if (!clean) return;
  consoleEntries.push({ time: timestamp(), level: level || 'info', message: clean });
  if (consoleEntries.length > 300) consoleEntries = consoleEntries.slice(-300);

  const row = document.createElement('div');
  row.className = `console-line ${level || 'info'}`;
  const time = document.createElement('time');
  time.textContent = consoleEntries.at(-1).time;
  const text = document.createElement('span');
  text.textContent = clean;
  row.append(time, text);
  connectionConsole.appendChild(row);

  while (connectionConsole.children.length > 300) connectionConsole.firstElementChild?.remove();
  connectionConsole.scrollTop = connectionConsole.scrollHeight;
}

function friendlyStatus(value) {
  return String(value || '')
    .replace(/Tor split/gi, 'Multiple private routes')
    .replace(/Tor connected/gi, 'Private routes connected')
    .replace(/Tor was unavailable/gi, 'Private routes unavailable')
    .replace(/Tor reused an exit IP/gi, 'Private routes reused an exit');
}

function renderLabels() {
  labels.replaceChildren();
  latestLayout.forEach((item) => {
    const label = document.createElement('div');
    label.className = 'screen-label';
    label.style.left = `${item.x}px`;
    label.style.top = `${item.y}px`;
    label.style.width = `${item.width}px`;
    label.style.height = `${item.height}px`;

    const result = latestState?.ips?.[item.index];
    const routeText = result
      ? ` · ${result.ip}${result.isTor === false && latestState.networkMode === 'tor' ? ' · route unverified' : ''}`
      : '';
    label.textContent = `Screen ${item.index + 1}${routeText}`;
    labels.appendChild(label);
  });
}

function renderSummary() {
  if (!latestState) return;
  summaryScreens.textContent = `${latestState.screenCount} screen${latestState.screenCount === 1 ? '' : 's'}`;
  summaryZoom.textContent = `${Math.round(latestState.zoomFactor * 100)}% zoom`;
  summaryNetwork.textContent = latestState.networkMode === 'tor'
    ? (enforcePrivateRoute ? 'Private routes required' : 'Multiple private routes')
    : 'Direct';
  summarySync.textContent = latestState.syncRequested ? 'Sync on' : 'Sync off';

  resetScreenButtons.forEach((button) => {
    const screenNumber = Number(button.dataset.screen);
    button.disabled = setupBusy || screenNumber > latestState.screenCount;
    button.classList.toggle('unavailable', screenNumber > latestState.screenCount);
  });
}

function selectedSetupNetwork() {
  return document.querySelector('input[name="setup-network"]:checked')?.value || 'direct';
}

function chooseSetupNetwork(value) {
  const input = document.querySelector(`input[name="setup-network"][value="${value}"]`);
  if (input) input.checked = true;
}

function updateProgressMeter() {
  let units = 0;
  let hasError = false;
  progressSteps.forEach((element) => {
    if (element.classList.contains('done') || element.classList.contains('skipped')) units += 1;
    else if (element.classList.contains('running')) units += 0.45;
    else if (element.classList.contains('error')) {
      units += 0.75;
      hasError = true;
    }
  });
  const percent = Math.max(0, Math.min(100, Math.round((units / progressSteps.length) * 100)));
  progressBar.style.width = `${percent}%`;
  progressBar.classList.toggle('error', hasError);
  progressPercent.textContent = `${percent}%`;
}

function configureProgress(stepLabels, title, eyebrow = 'Operation progress') {
  progressEyebrow.textContent = eyebrow;
  progressTitle.textContent = title;
  progressSteps.forEach((element, index) => {
    element.className = 'progress-step';
    element.querySelector('.step-icon').textContent = String(index + 1);
    element.querySelector('strong').textContent = stepLabels[index] || `Step ${index + 1}`;
    element.querySelector('small').textContent = 'Waiting';
  });
  updateProgressMeter();
}

function setStep(index, state, message, { log = true } = {}) {
  const element = progressSteps[index];
  if (!element) return;
  element.className = `progress-step ${state}`;
  element.querySelector('small').textContent = message;
  const icon = element.querySelector('.step-icon');
  if (state === 'done') icon.textContent = '✓';
  else if (state === 'error') icon.textContent = '!';
  else if (state === 'skipped') icon.textContent = '–';
  else icon.textContent = String(index + 1);
  updateProgressMeter();

  if (log && ['running', 'done', 'error'].includes(state)) {
    const label = element.querySelector('strong').textContent;
    appendLog(state === 'error' ? 'error' : state === 'done' ? 'success' : 'info', `${label}: ${message}`);
  }
}

function finishProgress() {
  progressSteps.forEach((element, index) => {
    if (!element.classList.contains('done') && !element.classList.contains('skipped')) {
      setStep(index, 'done', 'Complete', { log: false });
    }
  });
  progressBar.style.width = '100%';
  progressPercent.textContent = '100%';
}

function clearError() {
  setupError.hidden = true;
  setupError.textContent = '';
  setupBack.hidden = true;
  continueDirect.hidden = true;
  pendingRecovery = null;
}

function showError(message, { allowDirect = false, recovery = null } = {}) {
  const clean = String(message || 'The operation could not be completed.');
  setupError.hidden = false;
  setupError.textContent = clean;
  setupBack.hidden = false;
  continueDirect.hidden = !allowDirect || enforcePrivateRoute;
  pendingRecovery = recovery;
  appendLog('error', clean);
}

function setSetupBusy(busy) {
  setupBusy = busy;
  setupControls.forEach((control) => { control.disabled = busy; });
  setupLaunch.disabled = busy;
  setupCancel.disabled = busy;
  setupBack.disabled = busy;
  continueDirect.disabled = busy;
  restartAll.disabled = busy;
  openSettings.disabled = busy;
  openConsole.disabled = busy;
  renderSummary();
}

function setSettingsMode() {
  dialogMode = 'settings';
  setupDialog.classList.remove('operation-mode');
  setupContent.classList.remove('operation-only');
  setupOptions.hidden = false;
  setupEyebrow.textContent = 'Relay 1.0';
  setupTitle.textContent = 'Workspace settings';
  setupIntro.textContent = 'All Relay settings and diagnostics are shown here. Applying changes locks the workspace until every step is finalized.';
  setupLaunch.hidden = false;
  setupLaunch.textContent = 'Apply settings';
  setupCancel.hidden = !hasOpenedWorkspace;
  clearError();
  configureProgress(SETTINGS_STEPS, 'Waiting to apply', 'Setup progress');
}

function setOperationMode({ title, intro, progressTitleText, steps }) {
  dialogMode = 'operation';
  setupDialog.classList.add('operation-mode');
  setupContent.classList.add('operation-only');
  setupOptions.hidden = true;
  setupEyebrow.textContent = 'Relay operation';
  setupTitle.textContent = title;
  setupIntro.textContent = intro;
  setupLaunch.hidden = true;
  setupCancel.hidden = true;
  clearError();
  configureProgress(steps, progressTitleText);
}

function copyStateIntoSetup() {
  if (!latestState) return;
  setupScreenCount.value = String(latestState.screenCount);
  setupZoom.value = String(latestState.zoomFactor);
  setupSync.checked = Boolean(latestState.syncRequested);
  setupEnforceRoute.checked = enforcePrivateRoute;
  chooseSetupNetwork(enforcePrivateRoute ? 'tor' : latestState.networkMode);
  renderSummary();
}

async function showBackdrop() {
  setupBackdrop.classList.remove('hidden');
  const result = await window.relay.setSetupVisible(true);
  return result?.ok !== false;
}

async function showSettings(errorMessage = '', focusConsole = false) {
  if (setupBusy) return;
  copyStateIntoSetup();
  setSettingsMode();
  if (errorMessage) showError(errorMessage);
  await showBackdrop();
  if (focusConsole) {
    requestAnimationFrame(() => {
      connectionConsoleSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      connectionConsoleSection.classList.add('console-highlight');
      setTimeout(() => connectionConsoleSection.classList.remove('console-highlight'), 1200);
    });
  }
}

async function hideSetup() {
  if (setupBusy) return false;
  const result = await window.relay.setSetupVisible(false);
  if (!result?.ok) {
    showError(result?.error || 'Relay is still finalizing the operation.');
    return false;
  }
  setupBackdrop.classList.add('hidden');
  hasOpenedWorkspace = true;
  return true;
}

async function beginOperation(config) {
  setOperationMode(config);
  await showBackdrop();
  setSetupBusy(true);
  appendLog('info', config.title);
}

async function completeOperation() {
  finishProgress();
  appendLog('success', 'Operation finalized. Workspace access restored.');
  await new Promise((resolve) => setTimeout(resolve, 420));
  setSetupBusy(false);
  await hideSetup();
}

async function failOperation(message, options = {}) {
  setSetupBusy(false);
  showError(message, options);
}

function privateRouteVerified(result) {
  const expected = latestState?.screenCount || 1;
  return Boolean(
    result?.ok &&
    Array.isArray(result.results) &&
    result.results.length >= expected &&
    result.results.slice(0, expected).every((entry) => entry?.ok && entry?.isTor === true)
  );
}

async function runSettings(forceDirect = false) {
  if (setupBusy) return;

  const chosenScreens = Number(setupScreenCount.value);
  const chosenZoom = Number(setupZoom.value);
  const requirePrivate = Boolean(setupEnforceRoute.checked);
  const chosenNetwork = requirePrivate ? 'tor' : (forceDirect ? 'direct' : selectedSetupNetwork());
  const shouldCheckRoutes = setupCheckIPs.checked || requirePrivate;
  const shouldSync = setupSync.checked;

  await beginOperation({
    title: 'Applying workspace settings',
    intro: 'Relay has hidden every browser pane. Access returns only after layout, connection routing, route verification, and synchronization settings finish.',
    progressTitleText: 'Finalizing settings',
    steps: SETTINGS_STEPS,
  });

  try {
    setStep(0, 'running', 'Applying pane count and shared zoom…');
    await Promise.all([
      window.relay.setScreenCount(chosenScreens),
      window.relay.setZoom(chosenZoom),
    ]);
    setStep(0, 'done', `${chosenScreens} screen${chosenScreens === 1 ? '' : 's'} · ${Math.round(chosenZoom * 100)}%`);

    setStep(1, 'running', chosenNetwork === 'tor'
      ? 'Connecting every screen to the local private-route provider…'
      : 'Applying the Direct connection…');
    const networkResult = await window.relay.setNetwork(chosenNetwork);
    if (!networkResult?.ok) {
      setStep(1, 'error', 'The requested private-route provider was unavailable');
      await failOperation(networkResult?.error || 'Relay could not connect to the local private-route provider.', {
        allowDirect: !requirePrivate,
        recovery: 'settings',
      });
      return;
    }
    setStep(1, 'done', chosenNetwork === 'tor'
      ? 'Multiple private routes and remote DNS are ready'
      : 'Direct connection ready');

    if (shouldCheckRoutes) {
      setStep(2, 'running', 'Verifying the public route for every visible screen…');
      const routeResult = await window.relay.checkIPs();
      if (requirePrivate && !privateRouteVerified(routeResult)) {
        setStep(2, 'error', 'At least one screen could not verify its private route');
        await failOperation('Private-route enforcement is enabled, so Relay will remain locked until every visible screen verifies the private provider.', {
          recovery: 'settings',
        });
        return;
      }
      setStep(2, 'done', routeResult?.duplicate
        ? 'Verified · the provider reused one public exit'
        : routeResult?.ok
          ? 'All visible screens verified'
          : 'Finished with one or more unavailable results');
    } else {
      setStep(2, 'skipped', 'Skipped');
    }

    setStep(3, 'running', 'Applying the synchronization preference…');
    await window.relay.setSync(shouldSync);
    setStep(3, 'done', shouldSync ? 'Synchronization enabled' : 'Synchronization disabled');

    enforcePrivateRoute = requirePrivate;
    localStorage.setItem('relay.enforcePrivateRoute', String(enforcePrivateRoute));
    appendLog('success', enforcePrivateRoute
      ? 'Private-route kill switch enabled. Direct fallback is not allowed.'
      : 'Private-route enforcement disabled.');
    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'settings' });
  }
}

async function runRestartEverything() {
  if (setupBusy) return;

  await beginOperation({
    title: 'Restarting everything',
    intro: 'Relay is clearing every isolated browser session, rebuilding the current connection route, and reloading all visible screens.',
    progressTitleText: 'Restarting Relay',
    steps: [
      'Pause workspace',
      'Reset browser sessions',
      'Rebuild connection routes',
      'Reload every screen',
    ],
  });

  try {
    const result = await window.relay.restartEverything();
    if (!result?.ok) {
      await failOperation(result?.error || 'Relay restarted with a connection fallback.', {
        recovery: 'restart',
        allowDirect: !enforcePrivateRoute,
      });
      return;
    }

    if (enforcePrivateRoute) {
      setStep(3, 'running', 'Verifying enforced private routes after restart…');
      const routeResult = await window.relay.checkIPs();
      if (!privateRouteVerified(routeResult)) {
        setStep(3, 'error', 'Private-route verification failed after restart');
        await failOperation('Relay remains locked because the required private routes could not be verified after restart.', {
          recovery: 'settings',
        });
        return;
      }
    }
    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'restart' });
  }
}

async function runScreenReset(screenNumber) {
  if (setupBusy) return;

  await beginOperation({
    title: `Resetting Screen ${screenNumber}`,
    intro: `Only Screen ${screenNumber} is being cleared. Other screen sessions remain unchanged, but the entire workspace stays locked until the reset is finalized.`,
    progressTitleText: `Reset Screen ${screenNumber}`,
    steps: [
      `Isolate Screen ${screenNumber}`,
      'Clear browser data',
      'Renew private-route identity',
      `Reload Screen ${screenNumber}`,
    ],
  });

  try {
    const result = await window.relay.resetScreen(screenNumber);
    if (!result?.ok) {
      await failOperation(result?.error || `Screen ${screenNumber} could not be fully reset.`, { recovery: 'screen' });
      return;
    }

    if (enforcePrivateRoute) {
      setStep(3, 'running', `Verifying Screen ${screenNumber} and all enforced routes…`);
      const routeResult = await window.relay.checkIPs();
      if (!privateRouteVerified(routeResult)) {
        setStep(3, 'error', 'Private-route verification failed after screen reset');
        await failOperation('Relay remains locked because one or more required private routes could not be verified after the screen reset.', {
          recovery: 'settings',
        });
        return;
      }
    }
    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'screen' });
  }
}

async function lockForRouteFailure(message) {
  if (routeFailureLocking || setupBusy || !hasOpenedWorkspace) return;
  routeFailureLocking = true;
  try {
    await beginOperation({
      title: 'Private route interrupted',
      intro: 'The kill switch detected that one or more screens no longer verified the required private connection. Browser access is blocked until the route is restored.',
      progressTitleText: 'Connection protection active',
      steps: [
        'Detect route interruption',
        'Block workspace access',
        'Verify private-route provider',
        'Await reconnection',
      ],
    });
    setStep(0, 'done', 'A private-route health check failed');
    setStep(1, 'done', 'All browser panes are hidden and inaccessible');
    setStep(2, 'error', message || 'The private-route provider could not be verified');
    setStep(3, 'skipped', 'Open Settings and reconnect the provider');
    await failOperation(message || 'Private-route enforcement blocked Relay because the required connection could not be verified.', {
      recovery: 'settings',
    });
  } finally {
    routeFailureLocking = false;
  }
}

async function runRouteHealthCheck() {
  if (!enforcePrivateRoute || routeCheckInFlight || setupBusy || !hasOpenedWorkspace) return;
  if (!setupBackdrop.classList.contains('hidden')) return;
  if (!latestState || latestState.networkMode !== 'tor') {
    await lockForRouteFailure('Relay entered Direct mode while private-route enforcement was enabled.');
    return;
  }

  routeCheckInFlight = true;
  try {
    const result = await window.relay.checkIPs();
    if (!privateRouteVerified(result)) {
      await lockForRouteFailure('One or more screens failed the private-route verification check.');
    }
  } catch (error) {
    await lockForRouteFailure(error?.message || 'The background private-route health check failed.');
  } finally {
    routeCheckInFlight = false;
  }
}

function startRouteMonitor() {
  if (routeMonitorTimer) clearInterval(routeMonitorTimer);
  routeMonitorTimer = setInterval(runRouteHealthCheck, 20000);
}

addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.relay.navigate(address.value);
});
back.addEventListener('click', () => window.relay.back());
forward.addEventListener('click', () => window.relay.forward());
reload.addEventListener('click', () => window.relay.reload());
restartAll.addEventListener('click', runRestartEverything);
openSettings.addEventListener('click', () => showSettings());
openConsole.addEventListener('click', () => showSettings('', true));

setupCancel.addEventListener('click', () => {
  if (hasOpenedWorkspace && !setupBusy && dialogMode === 'settings') hideSetup();
});
setupBack.addEventListener('click', () => showSettings());
setupLaunch.addEventListener('click', () => runSettings(false));
continueDirect.addEventListener('click', () => {
  if (pendingRecovery === 'settings' && !enforcePrivateRoute && !setupEnforceRoute.checked) {
    chooseSetupNetwork('direct');
    runSettings(true);
  }
});
clearConsole.addEventListener('click', () => {
  consoleEntries = [];
  connectionConsole.replaceChildren();
});

setupEnforceRoute.addEventListener('change', () => {
  if (setupEnforceRoute.checked) {
    chooseSetupNetwork('tor');
    setupCheckIPs.checked = true;
    appendLog('info', 'Private-route enforcement selected. Route verification is now required.');
  }
});

document.querySelectorAll('input[name="setup-network"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked && input.value === 'direct' && setupEnforceRoute.checked) {
      setupEnforceRoute.checked = false;
      appendLog('warn', 'Private-route enforcement was disabled because Direct connection was selected.');
    }
  });
});

resetScreenButtons.forEach((button) => {
  button.addEventListener('click', () => runScreenReset(Number(button.dataset.screen)));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && hasOpenedWorkspace && !setupBusy && dialogMode === 'settings' && !setupBackdrop.classList.contains('hidden')) {
    hideSetup();
  }
});

window.relay.onState((state) => {
  latestState = state;
  if (document.activeElement !== address) address.value = state.currentURL;
  back.disabled = setupBusy || !state.canGoBack;
  forward.disabled = setupBusy || !state.canGoForward;
  reload.disabled = setupBusy;
  status.textContent = friendlyStatus(state.status);
  dnsStatus.textContent = friendlyStatus(state.dnsStatus);

  statusDot.className = 'status-dot';
  if (state.networkBusy || setupBusy) statusDot.classList.add('busy');
  else if (enforcePrivateRoute && state.networkMode !== 'tor') statusDot.classList.add('warning');
  else if (state.syncRequested && !state.syncReady) statusDot.classList.add('warning');
  else if (state.networkMode === 'tor') statusDot.classList.add('secure');

  const stateLogKey = `${state.status}|${state.dnsStatus}|${state.networkMode}`;
  if (stateLogKey !== lastStateLogKey) {
    lastStateLogKey = stateLogKey;
    appendLog(state.networkMode === 'tor' ? 'success' : 'info', `${state.status} · ${state.dnsStatus}`);
  }

  renderSummary();
  renderLabels();

  if (enforcePrivateRoute && hasOpenedWorkspace && !setupBusy && setupBackdrop.classList.contains('hidden') && state.networkMode !== 'tor') {
    lockForRouteFailure('Relay entered Direct mode while private-route enforcement was enabled.');
  }
});

window.relay.onLayout(({ labels: layout }) => {
  latestLayout = layout;
  renderLabels();
});

window.relay.onOperationProgress((progress) => {
  const step = Number(progress.step);
  const state = progress.state || 'running';
  const message = progress.message || 'Working…';
  appendLog(state === 'error' ? 'error' : state === 'done' ? 'success' : 'info', message);
  if (dialogMode === 'operation') setStep(step, state, message, { log: false });
});

appendLog('info', 'Relay diagnostic console initialized.');
appendLog('info', 'Private routes use a local Tor SOCKS provider; the interface will report provider-specific failures here.');
setSettingsMode();
setupEnforceRoute.checked = enforcePrivateRoute;
if (enforcePrivateRoute) {
  chooseSetupNetwork('tor');
  setupCheckIPs.checked = true;
}
window.relay.setSetupVisible(true);
startRouteMonitor();
