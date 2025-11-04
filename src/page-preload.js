'use strict';

require('./page-preload-v28');

const { ipcRenderer } = require('electron');

const argument = process.argv.find((value) => value.startsWith('--conduit-pane='))
  || process.argv.find((value) => value.startsWith('--relay-screen='));
const paneNumber = Number(argument?.split('=')[1] || 0);
const isFollower = Number.isInteger(paneNumber) && paneNumber > 1 && paneNumber <= 4;

let currentURL = null;
let targetURL = null;
let reasonText = null;
let lastSuccessText = null;
let resetButton = null;
let retryButton = null;
let manualButton = null;
let statusMessage = null;

function setButtonsDisabled(disabled) {
  for (const button of [retryButton, resetButton, manualButton]) {
    if (button) button.disabled = disabled;
  }
}

function formattedLastSuccess(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'No successful match recorded';
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'Previously matched';
  }
}

function installRecoveryControls() {
  if (!isFollower) return null;
  const overlay = document.querySelector('#conduit-recovery-v27');
  const card = overlay?.querySelector('.conduit-recovery-card');
  if (!overlay || !card) return null;

  if (!document.querySelector('#conduit-recovery-v30-style')) {
    const style = document.createElement('style');
    style.id = 'conduit-recovery-v30-style';
    style.textContent = `
      #conduit-recovery-v27[data-recovery-mode="failed"] {
        inset: 12px 12px auto auto;
        width: min(390px, calc(100vw - 24px));
        height: auto;
        padding: 0;
        background: transparent;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        pointer-events: none;
      }
      #conduit-recovery-v27[data-active="true"][data-recovery-mode="failed"] { display: block; }
      #conduit-recovery-v27[data-recovery-mode="failed"] .conduit-recovery-card {
        width: 100%;
        box-sizing: border-box;
        padding: 16px;
        border: 1px solid rgba(255, 255, 255, .18);
        border-left: 3px solid rgba(127, 181, 255, .78);
        border-radius: 11px;
        background: rgba(67, 75, 89, .97);
        box-shadow: 0 18px 52px rgba(0, 0, 0, .42);
        color: #f4f5f7;
        text-align: left;
        pointer-events: auto;
      }
      #conduit-recovery-v27[data-recovery-mode="failed"] .conduit-recovery-spinner { display: none; }
      #conduit-recovery-v27 .conduit-recovery-v30-details { display: none; margin-top: 12px; }
      #conduit-recovery-v27[data-recovery-mode="failed"] .conduit-recovery-v30-details { display: block; }
      #conduit-recovery-v27 .conduit-recovery-v30-label {
        display: block;
        margin: 10px 0 3px;
        color: rgba(220, 225, 235, .62);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .055em;
        text-transform: uppercase;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-url {
        display: block;
        max-height: 48px;
        overflow: hidden;
        color: rgba(248, 250, 255, .94);
        font: 11px/1.42 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        overflow-wrap: anywhere;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-reason {
        margin: 0;
        color: rgba(238, 242, 249, .84);
        font: 11.5px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-last-success {
        color: rgba(205, 214, 229, .80);
        font-size: 11px;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 7px;
        margin-top: 14px;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-actions button {
        min-height: 35px;
        padding: 7px 8px;
        border: 1px solid rgba(255, 255, 255, .15);
        border-radius: 7px;
        background: rgba(255, 255, 255, .06);
        color: #f4f5f7;
        font: 650 10.5px/1.15 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
        cursor: pointer;
      }
      #conduit-recovery-v27 .conduit-recovery-v30-actions button:hover { background: rgba(255, 255, 255, .12); }
      #conduit-recovery-v27 .conduit-recovery-v30-actions button:disabled { cursor: wait; opacity: .55; }
      #conduit-recovery-v27 .conduit-recovery-v30-actions .retry { background: rgba(79, 149, 245, .20); }
      #conduit-recovery-v27 .conduit-recovery-v30-actions .manual { background: rgba(255, 255, 255, .075); }
      @media (max-width: 430px) {
        #conduit-recovery-v27 .conduit-recovery-v30-actions { grid-template-columns: 1fr; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let details = card.querySelector('.conduit-recovery-v30-details');
  if (!details) {
    details = document.createElement('div');
    details.className = 'conduit-recovery-v30-details';
    details.innerHTML = `
      <span class="conduit-recovery-v30-label">Likely reason</span>
      <p class="conduit-recovery-v30-reason"></p>
      <span class="conduit-recovery-v30-label">Currently showing</span>
      <code class="conduit-recovery-v30-url current"></code>
      <span class="conduit-recovery-v30-label">Screen 1 target</span>
      <code class="conduit-recovery-v30-url target"></code>
      <span class="conduit-recovery-v30-label">Last successful match</span>
      <span class="conduit-recovery-v30-last-success"></span>
      <div class="conduit-recovery-v30-actions">
        <button type="button" class="retry">Try again</button>
        <button type="button" class="reset">Reset screen</button>
        <button type="button" class="manual">Manual control</button>
      </div>
    `;
    card.appendChild(details);
  }

  currentURL = details.querySelector('.current');
  targetURL = details.querySelector('.target');
  reasonText = details.querySelector('.conduit-recovery-v30-reason');
  lastSuccessText = details.querySelector('.conduit-recovery-v30-last-success');
  retryButton = details.querySelector('.retry');
  resetButton = details.querySelector('.reset');
  manualButton = details.querySelector('.manual');
  statusMessage = [...card.children].find((element) => element.tagName === 'SPAN') || null;

  if (!retryButton.dataset.bound) {
    retryButton.dataset.bound = 'true';
    retryButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      setButtonsDisabled(true);
      const title = card.querySelector('strong');
      if (title) title.textContent = 'Trying again';
      if (statusMessage) statusMessage.textContent = 'Starting a fresh synchronization attempt…';

      try {
        const result = await ipcRenderer.invoke('v30-retry-pane-sync', paneNumber);
        if (result?.ok === false) throw new Error(result.error || 'Synchronization could not be retried.');
        overlay.dataset.recoveryMode = 'blocking';
      } catch (error) {
        if (title) title.textContent = 'Retry failed';
        if (statusMessage) statusMessage.textContent = error?.message || String(error);
        setButtonsDisabled(false);
      }
    });
  }

  if (!resetButton.dataset.bound) {
    resetButton.dataset.bound = 'true';
    resetButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      setButtonsDisabled(true);
      const title = card.querySelector('strong');
      if (title) title.textContent = 'Resetting screen';
      if (statusMessage) statusMessage.textContent = 'Clearing this screen and rebuilding its connection…';

      try {
        const result = await ipcRenderer.invoke('v31-request-pane-reset', paneNumber);
        if (result?.ok === false) throw new Error(result.error || 'Reset failed.');
      } catch (error) {
        if (title) title.textContent = 'Reset failed';
        if (statusMessage) statusMessage.textContent = error?.message || String(error);
        setButtonsDisabled(false);
      }
    });
  }

  if (!manualButton.dataset.bound) {
    manualButton.dataset.bound = 'true';
    manualButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      setButtonsDisabled(true);

      try {
        const result = await ipcRenderer.invoke('v18-set-pane-paused', paneNumber, true);
        if (result?.ok === false) throw new Error(result.error || 'Manual control could not be enabled.');
        overlay.dataset.active = 'false';
        overlay.setAttribute('aria-hidden', 'true');
      } catch (error) {
        const title = card.querySelector('strong');
        if (title) title.textContent = 'Could not enable manual control';
        if (statusMessage) statusMessage.textContent = error?.message || String(error);
        setButtonsDisabled(false);
      }
    });
  }

  return overlay;
}

function applyRecoveryMode(value = {}) {
  if (!isFollower) return;
  setTimeout(() => {
    const overlay = installRecoveryControls();
    if (!overlay) return;

    const failed = value.failed === true || value.mode === 'failed';
    overlay.dataset.recoveryMode = failed ? 'failed' : 'blocking';

    if (!failed) {
      setButtonsDisabled(false);
      return;
    }

    const shown = String(value.currentURL || location.href || 'Address unavailable');
    const target = String(value.targetURL || 'Screen 1 address unavailable');
    currentURL.textContent = shown;
    currentURL.title = shown;
    targetURL.textContent = target;
    targetURL.title = target;
    reasonText.textContent = String(value.reason || 'A screen-specific redirect or page state prevented an exact match.');
    lastSuccessText.textContent = formattedLastSuccess(value.lastSuccessfulAt);
    setButtonsDisabled(false);
  }, 0);
}

ipcRenderer.on('v27-recovery', (_event, value) => applyRecoveryMode(value));

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', installRecoveryControls, { once: true });
} else {
  installRecoveryControls();
}
