'use strict';

const address = document.querySelector('#address');
const addressForm = document.querySelector('#address-form');
const back = document.querySelector('#back');
const forward = document.querySelector('#forward');
const reload = document.querySelector('#reload');
const restartAll = document.querySelector('#restart-all');
const openSettings = document.querySelector('#open-settings');
const status = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const dnsStatus = document.querySelector('#dns-status');
const labels = document.querySelector('#labels');
const summaryScreens = document.querySelector('#summary-screens');
const summaryZoom = document.querySelector('#summary-zoom');
const summaryNetwork = document.querySelector('#summary-network');
const summarySync = document.querySelector('#summary-sync');
const summaryProtection = document.querySelector('#summary-protection');

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
const progressMeterFill = document.querySelector('#progress-meter-fill');
const progressPercent = document.querySelector('#progress-percent');
const progressCurrent = document.querySelector('#progress-current');
const diagnosticConsole = document.querySelector('#diagnostic-console');
const diagnosticIssueCount = document.querySelector('#diagnostic-issue-count');
const clearDiagnostics = document.querySelector('#clear-diagnostics');
const protectionDetail = document.querySelector('#protection-detail');
const setupScreenCount = document.querySelector('#setup-screen-count');
const setupZoom = document.querySelector('#setup-zoom');
const setupCheckIPs = document.querySelector('#setup-check-ips');
const setupSync = document.querySelector('#setup-sync');
const resetScreenButtons = Array.from(document.querySelectorAll('.screen-reset-button'));
const progressSteps = [0, 1, 2, 3].map((index) => document.querySelector(`#progress-step-${index}`));

const setupControls = [
  setupScreenCount,
  setupZoom,
  setupCheckIPs,
  setupSync,
  ...Array.from(document.querySelectorAll('input[name="setup-network"]')),
  ...resetScreenButtons,
];

const SETTINGS_STEPS = [
  'Workspace layout and zoom',
  'Connection and DNS route',
  'Public-connection verification',
  'Synchronization preference',
];

let latestState = null;
let latestLayout = [];
let setupBusy = false;
let hasOpenedWorkspace = false;
let dialogMode = 'settings';
let pendingRecovery = null;
let diagnosticEntries = [];
let issueCount = 0;
let lastStatusMessage = '';
let lastDnsMessage = '';
let lastBlockedTotal = -1;
let operationName = '';
const stepSignatures = new Map();

function timestamp() {
  return new Date().toLocaleTimeString('en-CA', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function friendlyText(value) {
  return String(value || '')
    .replace(/Tor split/gi, 'Multiple private connections')
    .replace(/Tor connected/gi, 'Private connections active')
    .replace(/Tor route/gi, 'Private route')
    .replace(/Tor was unavailable/gi, 'Private connections were unavailable')
    .replace(/Tor reused an exit IP/gi, 'Private connections share an exit address');
}

function renderDiagnostics() {
  diagnosticConsole.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const entry of diagnosticEntries) {
    const row = document.createElement('div');
    row.className = `diagnostic-entry ${entry.level}`;

    const time = document.createElement('time');
    time.textContent = entry.time;

    const message = document.createElement('span');
    message.textContent = entry.message;

    row.append(time, message);
    fragment.appendChild(row);
  }

  diagnosticConsole.appendChild(fragment);
  diagnosticConsole.scrollTop = diagnosticConsole.scrollHeight;
  diagnosticIssueCount.textContent = issueCount === 0
    ? 'No issues'
    : `${issueCount} issue${issueCount === 1 ? '' : 's'}`;
  diagnosticIssueCount.classList.toggle('has-issues', issueCount > 0);
}

function addDiagnostic(level, message, suppliedTime = '') {
  const normalizedLevel = ['success', 'warn', 'error'].includes(level) ? level : 'info';
  diagnosticEntries.push({
    time: suppliedTime || timestamp(),
    level: normalizedLevel,
    message: friendlyText(message),
  });
  if (diagnosticEntries.length > 300) diagnosticEntries = diagnosticEntries.slice(-300);
  if (normalizedLevel === 'warn' || normalizedLevel === 'error') issueCount += 1;
  renderDiagnostics();
}

function clearDiagnosticLog() {
  diagnosticEntries = [];
  issueCount = 0;
  addDiagnostic('info', 'Diagnostics console cleared.');
}

function setProgress(value, message = '') {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  progressMeterFill.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  if (message) progressCurrent.textContent = friendlyText(message);
  progressMeterFill.classList.toggle('complete', percent === 100);
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
    const ip = result
      ? ` · ${result.ip}${result.isTor === false && latestState.networkMode === 'tor' ? ' · route unverified' : ''}`
      : '';
    label.textContent = `Screen ${item.index + 1}${ip}`;
    labels.appendChild(label);
  });
}

function renderSummary() {
  if (!latestState) return;
  summaryScreens.textContent = `${latestState.screenCount} screen${latestState.screenCount === 1 ? '' : 's'}`;
  summaryZoom.textContent = `${Math.round(latestState.zoomFactor * 100)}% zoom`;
  summaryNetwork.textContent = latestState.networkMode === 'tor'
    ? 'Multiple private connections'
    : 'Direct connection';
  summarySync.textContent = latestState.syncRequested ? 'Sync on' : 'Sync off';

  resetScreenButtons.forEach((button) => {
    const screenNumber = Number(button.dataset.screen);
    button.disabled = setupBusy || screenNumber > latestState.screenCount;
    button.classList.toggle('unavailable', screenNumber > latestState.screenCount);
  });
}

async function refreshAdBlockStatus({ logChange = false } = {}) {
  try {
    const protection = await window.relay.getAdBlockStatus();
    const total = Number(protection?.totalBlocked) || 0;
    summaryProtection.textContent = `Protection on · ${total} blocked`;
    protectionDetail.textContent = `${total} ad or tracker request${total === 1 ? '' : 's'} blocked across Relay sessions.`;

    if (logChange && total !== lastBlockedTotal) {
      if (lastBlockedTotal < 0) {
        addDiagnostic('success', `Enforced ad and tracker protection is active. ${total} requests blocked so far.`);
      } else if (total > lastBlockedTotal) {
        addDiagnostic('success', `Protection blocked ${total - lastBlockedTotal} additional request${total - lastBlockedTotal === 1 ? '' : 's'} (${total} total).`);
      }
    }
    lastBlockedTotal = total;
  } catch (error) {
    protectionDetail.textContent = 'Protection is enabled, but its counter is unavailable.';
    if (logChange) addDiagnostic('warn', `Could not read protection statistics: ${error.message}`);
  }
}

function selectedSetupNetwork() {
  return document.querySelector('input[name="setup-network"]:checked')?.value || 'direct';
}

function chooseSetupNetwork(value) {
  const input = document.querySelector(`input[name="setup-network"][value="${value}"]`);
  if (input) input.checked = true;
}

function configureProgress(stepLabels, title, eyebrow = 'Operation progress') {
  progressEyebrow.textContent = eyebrow;
  progressTitle.textContent = title;
  stepSignatures.clear();
  progressSteps.forEach((element, index) => {
    element.className = 'progress-step';
    element.querySelector('.step-icon').textContent = String(index + 1);
    element.querySelector('strong').textContent = stepLabels[index] || `Step ${index + 1}`;
    element.querySelector('small').textContent = 'Waiting';
  });
  setProgress(0, 'Waiting for the operation to begin');
}

function setStep(index, state, message) {
  const element = progressSteps[index];
  if (!element) return;

  const cleanMessage = friendlyText(message);
  element.className = `progress-step ${state}`;
  element.querySelector('small').textContent = cleanMessage;
  const icon = element.querySelector('.step-icon');
  if (state === 'done') icon.textContent = '✓';
  else if (state === 'error') icon.textContent = '!';
  else if (state === 'skipped') icon.textContent = '–';
  else icon.textContent = String(index + 1);

  const percent = state === 'done' || state === 'skipped'
    ? (index + 1) * 25
    : state === 'running'
      ? (index * 25) + 10
      : index * 25;
  setProgress(percent, cleanMessage);

  const signature = `${state}:${cleanMessage}`;
  if (stepSignatures.get(index) !== signature) {
    stepSignatures.set(index, signature);
    const level = state === 'error' ? 'error' : state === 'done' ? 'success' : state === 'skipped' ? 'info' : 'info';
    addDiagnostic(level, `${operationName || 'Operation'} · ${element.querySelector('strong').textContent}: ${cleanMessage}`);
  }
}

function clearError() {
  setupError.hidden = true;
  setupError.textContent = '';
  setupBack.hidden = true;
  continueDirect.hidden = true;
  pendingRecovery = null;
}

function showError(message, { allowDirect = false, recovery = null } = {}) {
  const cleanMessage = friendlyText(message || 'The operation could not be completed.');
  setupError.hidden = false;
  setupError.textContent = cleanMessage;
  setupBack.hidden = false;
  continueDirect.hidden = !allowDirect;
  pendingRecovery = recovery;
  addDiagnostic('error', cleanMessage);
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
  renderSummary();
}

function setSettingsMode() {
  dialogMode = 'settings';
  operationName = 'Settings';
  setupDialog.classList.remove('operation-mode');
  setupContent.classList.remove('operation-only');
  setupOptions.hidden = false;
  setupEyebrow.textContent = 'Relay 0.10';
  setupTitle.textContent = 'Workspace settings';
  setupIntro.textContent = 'Every option is shown here. Applying changes locks the browser panes and displays visible progress until the complete configuration is finalized.';
  setupLaunch.hidden = false;
  setupLaunch.textContent = 'Apply settings';
  setupCancel.hidden = !hasOpenedWorkspace;
  clearError();
  configureProgress(SETTINGS_STEPS, 'Ready to apply', 'Diagnostics and progress');
  progressCurrent.textContent = 'Review settings, diagnostics, and protection status';
}

function setOperationMode({ title, intro, progressTitleText, steps, name }) {
  dialogMode = 'operation';
  operationName = name || title;
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
  chooseSetupNetwork(latestState.networkMode);
  renderSummary();
}

async function showBackdrop() {
  setupBackdrop.classList.remove('hidden');
  const result = await window.relay.setSetupVisible(true);
  return result?.ok !== false;
}

async function showSettings(errorMessage = '') {
  if (setupBusy) return;
  copyStateIntoSetup();
  setSettingsMode();
  if (errorMessage) showError(errorMessage);
  await showBackdrop();
  addDiagnostic('info', 'Settings opened. Browser panes are locked while this window is visible.');
  await refreshAdBlockStatus({ logChange: true });
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
  addDiagnostic('success', 'Workspace unlocked.');
  return true;
}

async function beginOperation(config) {
  setOperationMode(config);
  await showBackdrop();
  setSetupBusy(true);
  addDiagnostic('info', `${config.name || config.title} started. Workspace access is locked.`);
}

async function completeOperation() {
  setProgress(100, 'Final checks complete');
  addDiagnostic('success', `${operationName} completed successfully.`);
  await refreshAdBlockStatus({ logChange: true });
  await new Promise((resolve) => setTimeout(resolve, 420));
  setSetupBusy(false);
  await hideSetup();
}

async function failOperation(message, options = {}) {
  setSetupBusy(false);
  showError(message, options);
}

async function runSettings(forceDirect = false) {
  if (setupBusy) return;

  const chosenScreens = Number(setupScreenCount.value);
  const chosenZoom = Number(setupZoom.value);
  const chosenNetwork = forceDirect ? 'direct' : selectedSetupNetwork();
  const shouldCheckIPs = setupCheckIPs.checked;
  const shouldSync = setupSync.checked;

  await beginOperation({
    name: 'Settings update',
    title: 'Applying workspace settings',
    intro: 'Relay has hidden every browser pane. Access returns only after layout, connection, verification, and synchronization settings finish.',
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
      ? 'Connecting each screen to a private routed identity…'
      : 'Applying the Direct connection…');
    const networkResult = await window.relay.setNetwork(chosenNetwork);
    if (!networkResult?.ok) {
      setStep(1, 'error', 'The private connection service was unavailable');
      await failOperation(networkResult?.error || 'Relay could not connect to the local private routing service.', {
        allowDirect: true,
        recovery: 'settings',
      });
      return;
    }
    setStep(1, 'done', chosenNetwork === 'tor'
      ? 'Multiple private connections and remote DNS are ready'
      : 'Direct connection ready');

    if (shouldCheckIPs) {
      setStep(2, 'running', 'Checking every visible screen connection…');
      const ipResult = await window.relay.checkIPs();
      setStep(2, 'done', ipResult?.duplicate
        ? 'Checked · at least two screens share an exit address'
        : ipResult?.ok
          ? 'All visible screen connections verified'
          : 'Finished with one or more unavailable results');
    } else {
      setStep(2, 'skipped', 'Skipped by preference');
    }

    setStep(3, 'running', 'Applying the synchronization preference…');
    await window.relay.setSync(shouldSync);
    setStep(3, 'done', shouldSync ? 'Synchronization enabled' : 'Synchronization disabled');

    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'settings' });
  }
}

async function runRestartEverything() {
  if (setupBusy) return;

  await beginOperation({
    name: 'Restart everything',
    title: 'Restarting everything',
    intro: 'Relay is clearing every isolated browser session, rebuilding the current connection mode, and reloading all visible screens.',
    progressTitleText: 'Restarting Relay',
    steps: [
      'Pause workspace',
      'Reset browser sessions',
      'Rebuild connection mode',
      'Reload every screen',
    ],
  });

  try {
    const result = await window.relay.restartEverything();
    if (!result?.ok) {
      await failOperation(result?.error || 'Relay restarted with a Direct-connection fallback.', { recovery: 'restart' });
      return;
    }
    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'restart' });
  }
}

async function runScreenReset(screenNumber) {
  if (setupBusy) return;

  await beginOperation({
    name: `Reset Screen ${screenNumber}`,
    title: `Resetting Screen ${screenNumber}`,
    intro: `Only Screen ${screenNumber} is being cleared. Other sessions remain unchanged, but the whole workspace stays locked until the reset is finalized.`,
    progressTitleText: `Reset Screen ${screenNumber}`,
    steps: [
      `Isolate Screen ${screenNumber}`,
      'Clear browser data',
      'Renew connection identity',
      `Reload Screen ${screenNumber}`,
    ],
  });

  try {
    const result = await window.relay.resetScreen(screenNumber);
    if (!result?.ok) {
      await failOperation(result?.error || `Screen ${screenNumber} could not be fully reset.`, { recovery: 'screen' });
      return;
    }
    await completeOperation();
  } catch (error) {
    await failOperation(error?.message || String(error), { recovery: 'screen' });
  }
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
clearDiagnostics.addEventListener('click', clearDiagnosticLog);

setupCancel.addEventListener('click', () => {
  if (hasOpenedWorkspace && !setupBusy && dialogMode === 'settings') hideSetup();
});
setupBack.addEventListener('click', () => showSettings());
setupLaunch.addEventListener('click', () => runSettings(false));
continueDirect.addEventListener('click', () => {
  if (pendingRecovery === 'settings') {
    chooseSetupNetwork('direct');
    runSettings(true);
  }
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
  status.textContent = friendlyText(state.status);
  dnsStatus.textContent = friendlyText(state.dnsStatus);

  statusDot.className = 'status-dot';
  if (state.networkBusy || setupBusy) statusDot.classList.add('busy');
  else if (state.syncRequested && !state.syncReady) statusDot.classList.add('warning');
  else if (state.networkMode === 'tor') statusDot.classList.add('secure');

  const nextStatus = friendlyText(state.status);
  const nextDns = friendlyText(state.dnsStatus);
  if (lastStatusMessage && nextStatus !== lastStatusMessage) {
    const level = /failed|unavailable|error|paused|stopped/i.test(nextStatus) ? 'warn' : 'info';
    addDiagnostic(level, nextStatus);
  }
  if (lastDnsMessage && nextDns !== lastDnsMessage) {
    const level = /failed|incomplete|unavailable|restored after/i.test(nextDns) ? 'warn' : 'info';
    addDiagnostic(level, nextDns);
  }
  lastStatusMessage = nextStatus;
  lastDnsMessage = nextDns;

  renderSummary();
  renderLabels();
});

window.relay.onLayout(({ labels: layout }) => {
  latestLayout = layout;
  renderLabels();
});

window.relay.onOperationProgress((progress) => {
  if (dialogMode !== 'operation') return;
  setStep(Number(progress.step), progress.state || 'running', progress.message || 'Working…');
});

window.relay.onDiagnostic((entry) => {
  addDiagnostic(entry?.level || 'info', entry?.message || '', entry?.time || '');
  refreshAdBlockStatus();
});

setInterval(() => refreshAdBlockStatus({ logChange: false }), 4000);

setSettingsMode();
addDiagnostic('info', 'Relay diagnostics console initialized.');
addDiagnostic('success', 'Workspace locking is enabled for settings, reset, and restart operations.');
refreshAdBlockStatus({ logChange: true });
window.relay.setSetupVisible(true);
