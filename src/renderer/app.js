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
  'Network and DNS route',
  'Public-IP verification',
  'Synchronization preference',
];

let latestState = null;
let latestLayout = [];
let setupBusy = false;
let hasOpenedWorkspace = false;
let dialogMode = 'settings';
let pendingRecovery = null;

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
      ? ` · ${result.ip}${result.isTor === false && latestState.networkMode === 'tor' ? ' · not Tor' : ''}`
      : '';
    label.textContent = `Screen ${item.index + 1}${ip}`;
    labels.appendChild(label);
  });
}

function renderSummary() {
  if (!latestState) return;
  summaryScreens.textContent = `${latestState.screenCount} screen${latestState.screenCount === 1 ? '' : 's'}`;
  summaryZoom.textContent = `${Math.round(latestState.zoomFactor * 100)}% zoom`;
  summaryNetwork.textContent = latestState.networkMode === 'tor' ? 'Tor split' : 'Direct';
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

function configureProgress(stepLabels, title, eyebrow = 'Operation progress') {
  progressEyebrow.textContent = eyebrow;
  progressTitle.textContent = title;
  progressSteps.forEach((element, index) => {
    element.className = 'progress-step';
    element.querySelector('.step-icon').textContent = String(index + 1);
    element.querySelector('strong').textContent = stepLabels[index] || `Step ${index + 1}`;
    element.querySelector('small').textContent = 'Waiting';
  });
}

function setStep(index, state, message) {
  const element = progressSteps[index];
  if (!element) return;
  element.className = `progress-step ${state}`;
  element.querySelector('small').textContent = message;
  const icon = element.querySelector('.step-icon');
  if (state === 'done') icon.textContent = '✓';
  else if (state === 'error') icon.textContent = '!';
  else if (state === 'skipped') icon.textContent = '–';
  else icon.textContent = String(index + 1);
}

function clearError() {
  setupError.hidden = true;
  setupError.textContent = '';
  setupBack.hidden = true;
  continueDirect.hidden = true;
  pendingRecovery = null;
}

function showError(message, { allowDirect = false, recovery = null } = {}) {
  setupError.hidden = false;
  setupError.textContent = String(message || 'The operation could not be completed.');
  setupBack.hidden = false;
  continueDirect.hidden = !allowDirect;
  pendingRecovery = recovery;
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
  setupDialog.classList.remove('operation-mode');
  setupContent.classList.remove('operation-only');
  setupOptions.hidden = false;
  setupEyebrow.textContent = 'Relay 0.9';
  setupTitle.textContent = 'Workspace settings';
  setupIntro.textContent = 'All Relay settings are shown here. Applying them locks the workspace and displays progress until every step is finalized.';
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
}

async function completeOperation() {
  await new Promise((resolve) => setTimeout(resolve, 320));
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
    title: 'Applying workspace settings',
    intro: 'Relay has hidden every browser pane. Access returns only after layout, network, IP verification, and synchronization settings finish.',
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
      ? 'Connecting to local Tor on ports 9050 or 9150…'
      : 'Applying the Direct network route…');
    const networkResult = await window.relay.setNetwork(chosenNetwork);
    if (!networkResult?.ok) {
      setStep(1, 'error', 'The requested Tor route was unavailable');
      await failOperation(networkResult?.error || 'Relay could not connect to a local Tor service.', {
        allowDirect: true,
        recovery: 'settings',
      });
      return;
    }
    setStep(1, 'done', chosenNetwork === 'tor' ? 'Tor and remote DNS are ready' : 'Direct connection ready');

    if (shouldCheckIPs) {
      setStep(2, 'running', 'Checking every visible screen…');
      const ipResult = await window.relay.checkIPs();
      setStep(2, 'done', ipResult?.duplicate
        ? 'Checked · duplicate Tor exit detected'
        : ipResult?.ok
          ? 'All visible screens verified'
          : 'Finished with one or more unavailable results');
    } else {
      setStep(2, 'skipped', 'Skipped');
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
    title: 'Restarting everything',
    intro: 'Relay is clearing every isolated browser session, rebuilding the current network route, and reloading all visible screens.',
    progressTitleText: 'Restarting Relay',
    steps: [
      'Pause workspace',
      'Reset browser sessions',
      'Rebuild network route',
      'Reload every screen',
    ],
  });

  try {
    const result = await window.relay.restartEverything();
    if (!result?.ok) {
      await failOperation(result?.error || 'Relay restarted with a network fallback.', { recovery: 'restart' });
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
    title: `Resetting Screen ${screenNumber}`,
    intro: `Only Screen ${screenNumber} is being cleared. Other screen sessions remain unchanged, but the entire workspace stays locked until the reset is finalized.`,
    progressTitleText: `Reset Screen ${screenNumber}`,
    steps: [
      `Isolate Screen ${screenNumber}`,
      'Clear browser data',
      'Renew network identity',
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
  status.textContent = state.status;
  dnsStatus.textContent = state.dnsStatus;

  statusDot.className = 'status-dot';
  if (state.networkBusy || setupBusy) statusDot.classList.add('busy');
  else if (state.syncRequested && !state.syncReady) statusDot.classList.add('warning');
  else if (state.networkMode === 'tor') statusDot.classList.add('secure');

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

setSettingsMode();
window.relay.setSetupVisible(true);
