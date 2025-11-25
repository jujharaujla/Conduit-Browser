'use strict';

const MAX_ATTEMPTS = 3;
const CHALLENGE = /captcha|recaptcha|hcaptcha|turnstile|challenge-platform|challenges\.cloudflare|just a moment|verify (you are|that you are) human|security check|checking your browser|access denied|\/challenge(?:\/|\?|$)|\/captcha(?:\/|\?|$)/i;

function shouldAutoRecover({ followingEnabled, registered, paused, challenge, live }) {
  return followingEnabled === true
    && registered === true
    && paused !== true
    && challenge !== true
    && live === true;
}

function shouldPropagateNavigation({
  followingEnabled,
  navigationEnabled,
  registered,
  paused,
  leaderChallenge,
  followerChallenge,
  live,
}) {
  return shouldAutoRecover({
    followingEnabled,
    registered,
    paused,
    challenge: followerChallenge,
    live,
  }) && navigationEnabled === true && leaderChallenge !== true;
}

function advanceRecoveryAttempt(item, now, settleMilliseconds) {
  const attempts = Number(item?.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    return { ...item, attempts, exhausted: true, attempted: false };
  }

  const settleUntil = now + Math.max(0, Number(settleMilliseconds) || 0);
  return {
    ...item,
    attempts: attempts + 1,
    lastAttemptAt: now,
    settleUntil,
    nextAttemptAt: settleUntil,
    exhausted: false,
    attempted: true,
  };
}

function inferFailureReason({ mode, currentURL, targetURL, score }) {
  const current = String(currentURL || '').toLowerCase();
  const target = String(targetURL || '').toLowerCase();

  if (/\b(login|log-in|signin|sign-in|auth|account)\b/.test(current)
      && !/\b(login|log-in|signin|sign-in|auth|account)\b/.test(target)) {
    return 'This screen was redirected to a sign-in or account page.';
  }

  if (/\b(error|blocked|denied|unavailable|offline)\b/.test(current)) {
    return 'The site appears to have returned an error or access block on this screen.';
  }

  if (mode === 'domain') {
    return 'This screen ended up on a different site or redirect than Screen 1.';
  }

  if (mode === 'url') {
    return 'A redirect or page-specific session state kept this screen on a different address.';
  }

  if (mode === 'state' || (Number.isFinite(Number(score)) && Number(score) < 65)) {
    return 'The address matched, but the page content, controls, or scroll position stayed out of sync.';
  }

  return 'A site redirect or screen-specific session state prevented an exact match.';
}

module.exports = {
  MAX_ATTEMPTS,
  CHALLENGE,
  shouldAutoRecover,
  shouldPropagateNavigation,
  advanceRecoveryAttempt,
  inferFailureReason,
};
