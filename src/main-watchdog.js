'use strict';

const { ipcMain } = require('electron');
const sync = require('./main-sync');
const {
  MAX_ATTEMPTS,
  CHALLENGE,
  shouldAutoRecover,
  advanceRecoveryAttempt,
  inferFailureReason,
} = require('./recovery-policy');

const MAX_PANES = 4;
const panes = new Map();
const recovery = new Map();
const lastSuccessfulAt = new Map();
const destroyHooks = new Set();
const automaticRebuilds = new Map();

const live = (contents) => Boolean(contents && !contents.isDestroyed());

function paneNumberFrom(payload) {
  const pane = Number(payload?.paneNumber);
  return Number.isInteger(pane) && pane >= 1 && pane <= MAX_PANES ? pane : 0;
}

function rememberPane(event, payload) {
  const pane = paneNumberFrom(payload);
  if (!pane) return;
  panes.set(pane, event.sender);
  if (destroyHooks.has(event.sender.id)) return;
  destroyHooks.add(event.sender.id);
  event.sender.once('destroyed', () => {
    destroyHooks.delete(event.sender.id);
    if (panes.get(pane)?.id === event.sender.id) panes.delete(pane);
    recovery.delete(pane);
    lastSuccessfulAt.delete(pane);
  });
}

function validTarget(value) {
  const url = sync.normalizedURL(value);
  return /^(https?:|file:|relay:)/i.test(url) ? url : '';
}

function challengeLike(row, contents) {
  if (row?.challenge) return true;
  const text = [row?.title, row?.url, live(contents) ? contents.getURL() : ''].filter(Boolean).join(' ');
  return CHALLENGE.test(text);
}

function sendRecovery(pane, value) {
  const contents = panes.get(pane);
  if (live(contents)) contents.send('v27-recovery', value);
}

function clearRecovery(pane) {
  recovery.delete(pane);
  sendRecovery(pane, { active: false });
}

function clearAllRecovery() {
  for (let pane = 2; pane <= MAX_PANES; pane += 1) clearRecovery(pane);
}

function tryAutomaticRebuild(pane, item, targetURL) {
  const workspace = globalThis.__conduitWorkspaceV21;
  const target = validTarget(targetURL);
  if (!target || typeof workspace?.recoverPane !== 'function') return false;

  const previous = automaticRebuilds.get(pane);
  if (previous?.key === target) return previous.running === true;

  const record = { key: target, running: true, startedAt: Date.now(), ok: null };
  automaticRebuilds.set(pane, record);
  item.rebuilding = true;
  sendRecovery(pane, {
    active: true,
    failed: false,
    mode: 'blocking',
    title: 'Repairing screen',
    message: 'Rebuilding this pane without clearing its cookies or saved session…',
    attempt: item.attempts,
  });

  Promise.resolve(workspace.recoverPane(pane, target)).then((result) => {
    record.running = false;
    record.ok = result?.ok === true;
    record.finishedAt = Date.now();
    recovery.delete(pane);
    if (record.ok) {
      setTimeout(() => {
        try { sync.resyncPane(pane); } catch {}
      }, 260);
    } else {
      sendRecovery(pane, {
        active: true,
        failed: true,
        mode: 'failed',
        title: 'Automatic repair failed',
        message: result?.error || 'The pane could not be rebuilt automatically.',
        attempt: item.attempts,
        currentURL: '',
        targetURL: target,
        reason: result?.error || 'The browser view could not be recreated.',
        lastSuccessfulAt: lastSuccessfulAt.get(pane) || null,
      });
    }
  }).catch((error) => {
    record.running = false;
    record.ok = false;
    record.finishedAt = Date.now();
    sendRecovery(pane, {
      active: true,
      failed: true,
      mode: 'failed',
      title: 'Automatic repair failed',
      message: error?.message || String(error),
      attempt: item.attempts,
      currentURL: '',
      targetURL: target,
      reason: error?.message || String(error),
      lastSuccessfulAt: lastSuccessfulAt.get(pane) || null,
    });
  });

  return true;
}

function recoveryMessage(contents, item, score) {
  if (item.mode === 'domain') return 'Opening the main domain before matching the exact page…';
  if (contents.isLoading()) return 'Waiting for the page to finish loading…';
  if (item.mode === 'state' && Number.isFinite(score)) return `Repairing page state · ${score}% synchronized`;
  if (item.attempts === 0) return 'Checking this screen against Screen 1…';
  return `Reconnecting to Screen 1 · attempt ${item.attempts} of ${MAX_ATTEMPTS}`;
}

function sendFailedState(pane, item, actualURL, targetURL, score) {
  item.exhausted = true;
  sendRecovery(pane, {
    active: true,
    failed: true,
    mode: 'failed',
    title: 'Automatic sync paused',
    message: `${MAX_ATTEMPTS} attempts could not bring this screen up to date.`,
    attempt: item.attempts,
    currentURL: actualURL,
    targetURL,
    reason: inferFailureReason({ mode: item.mode, currentURL: actualURL, targetURL, score }),
    lastSuccessfulAt: lastSuccessfulAt.get(pane) || null,
  });
}

function checkFollowers() {
  const health = sync.healthSnapshot();
  const leader = health?.rows?.[0];
  const followingEnabled = health?.followingEnabled === true;
  const navigationEnabled = followingEnabled && health?.policy?.navigation === true;
  const leaderContents = panes.get(1);

  if (!followingEnabled || challengeLike(leader, leaderContents)) {
    clearAllRecovery();
    return;
  }

  const targetURL = navigationEnabled ? validTarget(leader?.url) : '';
  const targetSite = targetURL ? sync.siteKey(targetURL) : '';
  const domainURL = targetURL ? sync.mainDomainURL(targetURL) : '';
  const now = Date.now();
  const navigationJobs = [];
  let requestStateRepair = false;

  for (let pane = 2; pane <= Number(health.visiblePaneCount || 1); pane += 1) {
    const row = health.rows?.find((item) => item.paneNumber === pane);
    const contents = panes.get(pane);

    const followerChallenge = challengeLike(row, contents);
    if (!shouldAutoRecover({
      followingEnabled,
      registered: row?.registered === true,
      paused: row?.paused === true,
      challenge: followerChallenge,
      live: live(contents),
    })) {
      clearRecovery(pane);
      continue;
    }

    const actualURL = sync.normalizedURL(contents.getURL());
    const actualSite = sync.siteKey(actualURL);
    const score = Number(row.syncScore);
    const stateBehind = Number.isFinite(score) && score < 65;
    const domainBehind = Boolean(targetSite) && actualSite !== targetSite;
    const urlBehind = Boolean(targetURL) && !domainBehind && actualURL !== targetURL;

    if (!domainBehind && !urlBehind && !stateBehind) {
      lastSuccessfulAt.set(pane, now);
      automaticRebuilds.delete(pane);
      clearRecovery(pane);
      continue;
    }

    const mode = domainBehind ? 'domain' : urlBehind ? 'url' : 'state';
    const desiredURL = mode === 'domain' ? domainURL : mode === 'url' ? targetURL : '';
    const key = `${mode}:${desiredURL || actualURL}`;
    let item = recovery.get(pane);

    if (!item || item.key !== key) {
      item = {
        key,
        mode,
        desiredURL,
        since: now,
        attempts: 0,
        lastAttemptAt: 0,
        nextAttemptAt: now + (mode === 'state' ? 1000 : 650),
        settleUntil: 0,
        exhausted: false,
      };
      recovery.set(pane, item);
    }

    if (item.exhausted) {
      if ((mode === 'domain' || mode === 'url') && tryAutomaticRebuild(pane, item, targetURL)) continue;
      sendFailedState(pane, item, actualURL, targetURL, score);
      continue;
    }

    if (item.attempts >= MAX_ATTEMPTS && now >= item.settleUntil) {
      if ((mode === 'domain' || mode === 'url') && tryAutomaticRebuild(pane, item, targetURL)) continue;
      sendFailedState(pane, item, actualURL, targetURL, score);
      continue;
    }

    const elapsed = now - item.since;
    const displayDelay = mode === 'state' ? 850 : 450;
    if (elapsed >= displayDelay) {
      sendRecovery(pane, {
        active: true,
        failed: false,
        mode: 'blocking',
        title: mode === 'domain' ? 'Opening site' : mode === 'url' ? 'Catching up' : 'Synchronizing',
        message: recoveryMessage(contents, item, score),
        attempt: item.attempts,
      });
    }

    if (elapsed < displayDelay || now < item.nextAttemptAt || item.attempts >= MAX_ATTEMPTS) continue;
    if (contents.isLoading() && item.attempts > 0 && now - item.lastAttemptAt < 2400) continue;

    const advanced = advanceRecoveryAttempt(item, now, desiredURL ? 2200 : 1200);
    Object.assign(item, advanced);
    if (!advanced.attempted) {
      sendFailedState(pane, item, actualURL, targetURL, score);
      continue;
    }

    if (desiredURL) {
      sendRecovery(pane, {
        active: true,
        failed: false,
        mode: 'blocking',
        title: mode === 'domain' ? 'Opening site' : 'Synchronizing',
        message: mode === 'domain'
          ? `Opening the main domain · attempt ${item.attempts} of ${MAX_ATTEMPTS}`
          : `Opening the Screen 1 address · attempt ${item.attempts} of ${MAX_ATTEMPTS}`,
        attempt: item.attempts,
      });
      navigationJobs.push({ pane, contents, url: desiredURL });
    } else {
      requestStateRepair = true;
      sendRecovery(pane, {
        active: true,
        failed: false,
        mode: 'blocking',
        title: 'Synchronizing',
        message: `Reapplying Screen 1 state · attempt ${item.attempts} of ${MAX_ATTEMPTS}`,
        attempt: item.attempts,
      });
    }
  }

  if (navigationJobs.length) {
    setTimeout(() => {
      for (const { pane, contents, url } of navigationJobs) {
        const row = sync.healthSnapshot().rows?.find((item) => item.paneNumber === pane);
        if (!live(contents) || challengeLike(row, contents)) continue;
        try { sync.navigatePane(pane, url, true); } catch {}
        setTimeout(() => {
          try { sync.resyncPane(pane); } catch {}
        }, 360);
      }
    }, 18);
  }

  if (requestStateRepair) {
    setTimeout(() => {
      try { sync.fullResync(); } catch {}
    }, 190);
  }
}

ipcMain.handle('v30-retry-pane-sync', (_event, paneValue) => {
  const pane = Number(paneValue);
  if (!Number.isInteger(pane) || pane < 2 || pane > MAX_PANES) {
    return { ok: false, error: 'Choose a follower screen.' };
  }

  recovery.delete(pane);
  sendRecovery(pane, {
    active: true,
    failed: false,
    mode: 'blocking',
    title: 'Trying again',
    message: 'Starting a fresh synchronization attempt…',
    attempt: 0,
  });

  try { sync.resyncPane(pane); } catch {}
  return { ok: true, paneNumber: pane };
});

ipcMain.on('v26-register', rememberPane);
ipcMain.on('v26-state', rememberPane);

const watchdog = setInterval(checkFollowers, 450);
watchdog.unref?.();

module.exports = { checkFollowers, challengeLike, MAX_ATTEMPTS, inferFailureReason };
