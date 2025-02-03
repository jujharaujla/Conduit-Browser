'use strict';

const { ipcRenderer } = require('electron');

const screenArgument = process.argv.find((value) => value.startsWith('--relay-screen='));
const screenNumber = Number(screenArgument?.split('=')[1] || 0);
const isController = screenNumber === 1;

const inputTimers = new WeakMap();
let pageStateTimer = null;
let controllerStateTimer = null;
let scrollTimer = null;
let stateSequence = 0;
let lastControllerSignature = '';

const PROTECTED_TERMS = /captcha|recaptcha|hcaptcha|turnstile|verify\s*(you|human)|security\s*check|checkout|purchase|buy\s*now|place\s*order|confirm\s*order|payment|credit\s*card|debit\s*card|wire\s*transfer|send\s*money|cast\s*vote|submit\s*vote|delete\s*account|close\s*account/i;

function registerScreen() {
  if (Number.isInteger(screenNumber) && screenNumber >= 1 && screenNumber <= 4) {
    ipcRenderer.send('register-screen-v12', { screenNumber });
  }
}

function escapeAttribute(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeCSS(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
}

function visible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.pointerEvents !== 'none'
    && rect.width > 0
    && rect.height > 0;
}

function selectorFor(element) {
  if (!(element instanceof Element)) return '';
  if (element.id) return `#${escapeCSS(element.id)}`;

  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder']) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    return `${element.tagName.toLowerCase()}[${attribute}="${escapeAttribute(value)}"]`;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 8) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
      : [];
    const position = Math.max(1, siblings.indexOf(current) + 1);
    parts.unshift(`${tag}:nth-of-type(${position})`);
    current = current.parentElement;
  }
  return `html > ${parts.join(' > ')}`;
}

function fingerprintFor(element) {
  return {
    tag: String(element?.tagName || '').toLowerCase(),
    fieldType: String(element?.type || '').toLowerCase(),
    name: element?.getAttribute?.('name') || '',
    ariaLabel: element?.getAttribute?.('aria-label') || '',
    placeholder: element?.getAttribute?.('placeholder') || '',
    text: String(element?.innerText || element?.value || '').trim().replace(/\s+/g, ' ').slice(0, 160),
    href: element?.href || '',
    role: element?.getAttribute?.('role') || '',
  };
}

function metadataFor(element) {
  return {
    selector: selectorFor(element),
    ...fingerprintFor(element),
  };
}

function challengeDetected() {
  const selectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '#challenge-running',
    '#challenge-form',
  ];

  if (selectors.some((selector) => document.querySelector(selector))) return true;
  return /challenges\.cloudflare\.com|google\.com\/recaptcha|hcaptcha\.com\/1\/api/i.test(location.href);
}

function protectedElement(element) {
  if (!(element instanceof Element)) return true;

  const type = String(element.type || '').toLowerCase();
  if (type === 'password' || type === 'file') return true;

  const clickable = element.closest?.('button, a, input, label, [role="button"]') || element;
  const text = [
    clickable.innerText,
    clickable.value,
    clickable.getAttribute?.('aria-label'),
    clickable.getAttribute?.('name'),
    clickable.getAttribute?.('href'),
  ].filter(Boolean).join(' ');

  return PROTECTED_TERMS.test(text);
}

function sendPageState() {
  clearTimeout(pageStateTimer);
  const challenge = challengeDetected();

  ipcRenderer.send('challenge-state-v12', { screenNumber, challenge });
  ipcRenderer.send('page-state', {
    screenNumber,
    url: location.href,
    challenge: false,
    challengePresent: challenge,
    title: document.title,
  });
}

function schedulePageState(delay = 160) {
  clearTimeout(pageStateTimer);
  pageStateTimer = setTimeout(sendPageState, delay);
}

function windowScrollState() {
  const root = document.scrollingElement || document.documentElement;
  const maxX = Math.max(1, root.scrollWidth - innerWidth);
  const maxY = Math.max(1, root.scrollHeight - innerHeight);

  return {
    url: location.href,
    scrollXRatio: Math.max(0, Math.min(1, scrollX / maxX)),
    scrollYRatio: Math.max(0, Math.min(1, scrollY / maxY)),
    sequence: ++stateSequence,
  };
}

function sendControllerState(force = false) {
  if (!isController || challengeDetected()) return;

  const state = windowScrollState();
  const signature = `${state.url}|${state.scrollXRatio.toFixed(4)}|${state.scrollYRatio.toFixed(4)}`;
  if (!force && signature === lastControllerSignature) return;

  lastControllerSignature = signature;
  ipcRenderer.send('controller-state-v12', state);
}

function scheduleControllerState(delay = 60, force = false) {
  if (!isController) return;
  clearTimeout(controllerStateTimer);
  controllerStateTimer = setTimeout(() => sendControllerState(force), delay);
}

function sendControllerAction(action) {
  if (!isController || challengeDetected()) return;
  ipcRenderer.send('controller-action-v12', action);
}

function valuePayload(element, kind) {
  return {
    kind,
    ...metadataFor(element),
    value: element.isContentEditable ? element.textContent : String(element.value ?? '').slice(0, 20000),
    checked: Boolean(element.checked),
  };
}

function scoreCandidate(candidate, action) {
  let score = 0;

  if (action.tag && candidate.tagName.toLowerCase() === action.tag) score += 5;
  if (action.fieldType && String(candidate.type || '').toLowerCase() === action.fieldType) score += 4;
  if (action.name && candidate.getAttribute('name') === action.name) score += 10;
  if (action.ariaLabel && candidate.getAttribute('aria-label') === action.ariaLabel) score += 10;
  if (action.placeholder && candidate.getAttribute('placeholder') === action.placeholder) score += 8;
  if (action.role && candidate.getAttribute('role') === action.role) score += 4;
  if (action.href && candidate.href === action.href) score += 9;

  const text = String(candidate.innerText || candidate.value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (action.text && text === action.text) score += 11;
  else if (action.text && text && (text.includes(action.text) || action.text.includes(text))) score += 5;

  return score;
}

function findTarget(action) {
  if (action.selector) {
    try {
      const exact = document.querySelector(action.selector);
      if (exact && visible(exact)) return { element: exact, strategy: 'selector' };
    } catch {}
  }

  const query = action.tag || 'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]';
  let candidates = [];

  try {
    candidates = [...document.querySelectorAll(query)].filter(visible);
  } catch {}

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, action);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= 6
    ? { element: best, strategy: 'fingerprint' }
    : { element: null, strategy: 'none' };
}

function nativeSetValue(element, value) {
  if (element.isContentEditable) {
    element.textContent = value;
    return;
  }

  let prototype;
  if (element instanceof HTMLTextAreaElement) prototype = HTMLTextAreaElement.prototype;
  else if (element instanceof HTMLInputElement) prototype = HTMLInputElement.prototype;
  else if (element instanceof HTMLSelectElement) prototype = HTMLSelectElement.prototype;

  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function nativeSetChecked(element, checked) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  if (setter) setter.call(element, checked);
  else element.checked = checked;
}

function dispatchFieldEvents(element) {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function applyWindowPosition(state) {
  if (challengeDetected()) return;

  const root = document.scrollingElement || document.documentElement;
  const maxX = Math.max(0, root.scrollWidth - innerWidth);
  const maxY = Math.max(0, root.scrollHeight - innerHeight);

  scrollTo(
    Math.max(0, Math.min(1, Number(state?.scrollXRatio) || 0)) * maxX,
    Math.max(0, Math.min(1, Number(state?.scrollYRatio) || 0)) * maxY,
  );
}

function dispatchClickSequence(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + (rect.width / 2);
  const clientY = rect.top + (rect.height / 2);
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
  };

  if (globalThis.PointerEvent) {
    element.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent('mousedown', common));

  if (globalThis.PointerEvent) {
    element.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent('mouseup', common));
  element.click();
}

function replayAction(action) {
  if (challengeDetected()) return { ok: true, skipped: true, reason: 'challenge skipped' };

  const found = findTarget(action);
  let element = found.element;

  if (action.kind === 'click' && !element) {
    const x = Math.max(0, Math.min(innerWidth - 1, Math.round(Number(action.xRatio || 0) * innerWidth)));
    const y = Math.max(0, Math.min(innerHeight - 1, Math.round(Number(action.yRatio || 0) * innerHeight)));
    element = document.elementFromPoint(x, y);
    if (element) found.strategy = 'coordinates';
  }

  if (action.kind === 'scroll') {
    if (action.selector === '__window__') {
      applyWindowPosition(action);
      return { ok: true, strategy: 'window-scroll' };
    }

    if (!element) return { ok: false, reason: 'scroll target not found' };
    const maxX = Math.max(0, element.scrollWidth - element.clientWidth);
    const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo(
      Math.max(0, Math.min(1, Number(action.xRatio) || 0)) * maxX,
      Math.max(0, Math.min(1, Number(action.yRatio) || 0)) * maxY,
    );
    return { ok: true, strategy: found.strategy };
  }

  if (!element) return { ok: false, reason: 'target not found' };
  if (protectedElement(element)) return { ok: true, skipped: true, reason: 'protected target skipped' };

  if (action.kind === 'input' || action.kind === 'change') {
    const type = String(element.type || '').toLowerCase();
    if (type === 'password' || type === 'file') return { ok: true, skipped: true };

    if (type === 'checkbox' || type === 'radio') nativeSetChecked(element, Boolean(action.checked));
    else nativeSetValue(element, String(action.value ?? ''));

    element.focus?.({ preventScroll: true });
    dispatchFieldEvents(element);
    return { ok: true, strategy: found.strategy };
  }

  if (action.kind === 'key') {
    element.focus?.({ preventScroll: true });

    if (action.key === 'Enter' && element.closest?.('form')) {
      const form = element.closest('form');
      if (protectedElement(element)) return { ok: true, skipped: true };

      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();

      return { ok: true, strategy: 'form-submit' };
    }

    const options = {
      key: action.key,
      code: action.code,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', options));
    element.dispatchEvent(new KeyboardEvent('keyup', options));
    return { ok: true, strategy: found.strategy };
  }

  if (action.kind === 'click') {
    const clickable = element.closest?.('button, a, label, [role="button"], input, select, textarea') || element;
    if (protectedElement(clickable)) return { ok: true, skipped: true };

    clickable.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    dispatchClickSequence(clickable);
    return { ok: true, strategy: found.strategy };
  }

  return { ok: false, reason: 'unsupported action' };
}

function installHistoryHooks() {
  for (const methodName of ['pushState', 'replaceState']) {
    const original = history[methodName];
    if (typeof original !== 'function') continue;

    history[methodName] = function relayHistoryHook(...args) {
      const result = original.apply(this, args);
      scheduleControllerState(20, true);
      schedulePageState(30);
      return result;
    };
  }
}

if (isController) {
  window.addEventListener('click', (event) => {
    const rawTarget = event.target instanceof Element ? event.target : null;
    if (!rawTarget) return;

    const target = rawTarget.closest('button, a, label, [role="button"], input, select, textarea') || rawTarget;
    if (protectedElement(target)) return;

    const interactiveField = target.closest('input, textarea, select, [contenteditable="true"]');
    if (interactiveField && !target.matches('button, a, label, [role="button"]')) return;

    sendControllerAction({
      kind: 'click',
      ...metadataFor(target),
      xRatio: event.clientX / Math.max(1, innerWidth),
      yRatio: event.clientY / Math.max(1, innerHeight),
      button: event.button,
    });
    scheduleControllerState(100, true);
  }, true);

  window.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable)) return;
    if (protectedElement(target)) return;

    clearTimeout(inputTimers.get(target));
    inputTimers.set(target, setTimeout(() => {
      sendControllerAction(valuePayload(target, 'input'));
      scheduleControllerState(30, true);
    }, 45));
  }, true);

  window.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (protectedElement(target)) return;

    sendControllerAction(valuePayload(target, 'change'));
    scheduleControllerState(30, true);
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.repeat || !['Enter', 'Escape'].includes(event.key)) return;

    const target = event.target instanceof Element ? event.target : null;
    if (!target || protectedElement(target)) return;

    sendControllerAction({
      kind: 'key',
      ...metadataFor(target),
      key: event.key,
      code: event.code,
    });
    scheduleControllerState(100, true);
  }, true);

  window.addEventListener('scroll', (event) => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const target = event.target;

      if (target === document || target === document.documentElement || target === document.body) {
        const state = windowScrollState();
        sendControllerAction({ kind: 'scroll', selector: '__window__', ...state });
        sendControllerState(true);
        return;
      }

      if (!(target instanceof Element)) return;
      const maxX = Math.max(1, target.scrollWidth - target.clientWidth);
      const maxY = Math.max(1, target.scrollHeight - target.clientHeight);
      sendControllerAction({
        kind: 'scroll',
        ...metadataFor(target),
        xRatio: target.scrollLeft / maxX,
        yRatio: target.scrollTop / maxY,
      });
      sendControllerState(true);
    }, 35);
  }, true);

  window.addEventListener('popstate', () => scheduleControllerState(20, true));
  window.addEventListener('hashchange', () => scheduleControllerState(20, true));
  installHistoryHooks();
}

ipcRenderer.on('replay-action-v12', (_event, payload) => {
  let result;

  try {
    result = replayAction(payload.action);
  } catch (error) {
    result = { ok: false, reason: error.message };
  }

  ipcRenderer.send('replay-result-v12', {
    actionId: payload.actionId,
    screenNumber,
    ...result,
  });

  schedulePageState(100);
});

ipcRenderer.on('controller-state-v12', (_event, state) => {
  if (isController || challengeDetected()) return;

  requestAnimationFrame(() => applyWindowPosition(state));
  setTimeout(() => applyWindowPosition(state), 160);
  setTimeout(() => applyWindowPosition(state), 520);
  setTimeout(() => applyWindowPosition(state), 1100);
});

ipcRenderer.on('request-controller-state-v12', () => sendControllerState(true));
ipcRenderer.on('request-page-state', () => schedulePageState(0));

registerScreen();

window.addEventListener('DOMContentLoaded', () => {
  registerScreen();
  schedulePageState(15);
  scheduleControllerState(30, true);
});

window.addEventListener('load', () => {
  registerScreen();
  schedulePageState(50);
  scheduleControllerState(70, true);
});

const installObserver = () => {
  if (!document.documentElement) return;
  new MutationObserver(() => schedulePageState(260)).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

if (document.documentElement) installObserver();
else window.addEventListener('DOMContentLoaded', installObserver, { once: true });

setInterval(registerScreen, 3000);
setInterval(sendPageState, 2400);
if (isController) setInterval(() => sendControllerState(false), 500);
