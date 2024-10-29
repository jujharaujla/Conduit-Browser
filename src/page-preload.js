'use strict';

const { ipcRenderer } = require('electron');

const screenArgument = process.argv.find((value) => value.startsWith('--relay-screen='));
const screenNumber = Number(screenArgument?.split('=')[1] || 0);
const isController = screenNumber === 1;
const inputTimers = new WeakMap();
let pageStateTimer = null;
let scrollTimer = null;
let controllerStateTimer = null;
let lastControllerSignature = '';

const SENSITIVE = /captcha|recaptcha|hcaptcha|turnstile|verify\s*(you|human)|security\s*check|checkout|purchase|buy\s*now|place\s*order|confirm\s*order|payment|credit\s*card|debit\s*card|bank|wire\s*transfer|send\s*money|cast\s*vote|submit\s*vote|delete\s*account|remove\s*account|close\s*account|submit\s*application/i;

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
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function selectorFor(element) {
  if (!(element instanceof Element)) return '';
  if (element.id) return `#${escapeCSS(element.id)}`;

  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder']) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const tag = element.tagName.toLowerCase();
    return `${tag}[${attribute}="${escapeAttribute(value)}"]`;
  }

  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 7) {
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
  const form = element.closest?.('form');
  return {
    tag: String(element.tagName || '').toLowerCase(),
    fieldType: String(element.type || '').toLowerCase(),
    name: element.getAttribute?.('name') || '',
    ariaLabel: element.getAttribute?.('aria-label') || '',
    placeholder: element.getAttribute?.('placeholder') || '',
    text: String(element.innerText || element.value || '').trim().replace(/\s+/g, ' ').slice(0, 180),
    href: element.href || '',
    formText: String(form?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 220),
    formAction: form?.action || '',
  };
}

function metadataFor(element) {
  return { selector: selectorFor(element), ...fingerprintFor(element) };
}

function sensitiveElement(element) {
  if (!(element instanceof Element)) return true;
  const meta = fingerprintFor(element);
  if (meta.fieldType === 'password' || meta.fieldType === 'file') return true;
  return SENSITIVE.test([
    meta.text,
    meta.ariaLabel,
    meta.name,
    meta.placeholder,
    meta.href,
    meta.formText,
    meta.formAction,
  ].join(' '));
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
    '[data-sitekey][class*="captcha" i]',
    '[data-sitekey][class*="turnstile" i]',
  ];
  if (selectors.some((selector) => document.querySelector(selector))) return true;
  return /challenges\.cloudflare\.com|google\.com\/recaptcha|hcaptcha\.com\/1\/api/i.test(location.href);
}

function sendPageState() {
  clearTimeout(pageStateTimer);
  const challenge = challengeDetected();
  ipcRenderer.send('challenge-state-v11', { screenNumber, challenge });
  ipcRenderer.send('page-state', {
    screenNumber,
    url: location.href,
    challenge: false,
    challengePresent: challenge,
    title: document.title,
  });
}

function schedulePageState(delay = 180) {
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
  };
}

function sendControllerState(force = false) {
  if (!isController || challengeDetected()) return;
  const state = windowScrollState();
  const signature = `${state.url}|${state.scrollXRatio.toFixed(4)}|${state.scrollYRatio.toFixed(4)}`;
  if (!force && signature === lastControllerSignature) return;
  lastControllerSignature = signature;
  ipcRenderer.send('controller-state-v11', state);
}

function scheduleControllerState(delay = 70, force = false) {
  if (!isController) return;
  clearTimeout(controllerStateTimer);
  controllerStateTimer = setTimeout(() => sendControllerState(force), delay);
}

function sendControllerAction(action) {
  if (!isController || challengeDetected()) return;
  ipcRenderer.send('controller-action-v11', action);
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
  if (action.tag && candidate.tagName.toLowerCase() === action.tag) score += 4;
  if (action.fieldType && String(candidate.type || '').toLowerCase() === action.fieldType) score += 3;
  if (action.name && candidate.getAttribute('name') === action.name) score += 8;
  if (action.ariaLabel && candidate.getAttribute('aria-label') === action.ariaLabel) score += 8;
  if (action.placeholder && candidate.getAttribute('placeholder') === action.placeholder) score += 7;
  if (action.href && candidate.href === action.href) score += 7;

  const text = String(candidate.innerText || candidate.value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (action.text && text === action.text) score += 9;
  else if (action.text && text && (text.includes(action.text) || action.text.includes(text))) score += 4;
  return score;
}

function findTarget(action) {
  if (action.selector) {
    try {
      const exact = document.querySelector(action.selector);
      if (exact && visible(exact)) return { element: exact, strategy: 'selector' };
    } catch {}
  }

  const selector = action.tag || 'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]';
  let candidates = [];
  try {
    candidates = [...document.querySelectorAll(selector)].filter(visible);
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

  return bestScore >= 5
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

function dispatchFieldEvents(element, includeChange = true) {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  if (includeChange) element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function applyWindowPosition(state) {
  if (challengeDetected()) return;
  const root = document.scrollingElement || document.documentElement;
  const maxX = Math.max(0, root.scrollWidth - innerWidth);
  const maxY = Math.max(0, root.scrollHeight - innerHeight);
  scrollTo(
    Math.max(0, Math.min(1, Number(state.scrollXRatio) || 0)) * maxX,
    Math.max(0, Math.min(1, Number(state.scrollYRatio) || 0)) * maxY,
  );
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

  if (!element) return { ok: false, reason: 'target element not found' };
  if (sensitiveElement(element)) return { ok: true, skipped: true, reason: 'protected target skipped' };

  if (action.kind === 'input' || action.kind === 'change') {
    const type = String(element.type || '').toLowerCase();
    if (type === 'password' || type === 'file') return { ok: true, skipped: true };
    if (type === 'checkbox' || type === 'radio') nativeSetChecked(element, Boolean(action.checked));
    else nativeSetValue(element, String(action.value ?? ''));
    element.focus?.({ preventScroll: true });
    dispatchFieldEvents(element, true);
    return { ok: true, strategy: found.strategy };
  }

  if (action.kind === 'key') {
    element.focus?.({ preventScroll: true });
    if (action.key === 'Enter' && element.closest?.('form')) {
      const form = element.closest('form');
      if (sensitiveElement(form)) return { ok: true, skipped: true };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { ok: true, strategy: 'form-submit' };
    }
    const options = { key: action.key, code: action.code, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', options));
    element.dispatchEvent(new KeyboardEvent('keyup', options));
    return { ok: true, strategy: found.strategy };
  }

  if (action.kind === 'click') {
    const clickable = element.closest?.('button, a, label, [role="button"], input, select, textarea') || element;
    if (sensitiveElement(clickable)) return { ok: true, skipped: true };
    clickable.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    clickable.click();
    return { ok: true, strategy: found.strategy };
  }

  return { ok: false, reason: 'unsupported action' };
}

if (isController) {
  window.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || sensitiveElement(target)) return;
    const interactiveField = target.closest('input, textarea, select, option, [contenteditable="true"]');
    if (interactiveField && !target.closest('button, a, label, [role="button"]')) return;

    sendControllerAction({
      kind: 'click',
      ...metadataFor(target),
      xRatio: event.clientX / Math.max(1, innerWidth),
      yRatio: event.clientY / Math.max(1, innerHeight),
      button: event.button,
    });
  }, true);

  window.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable)) return;
    if (sensitiveElement(target)) return;

    clearTimeout(inputTimers.get(target));
    inputTimers.set(target, setTimeout(() => sendControllerAction(valuePayload(target, 'input')), 55));
  }, true);

  window.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (sensitiveElement(target)) return;
    sendControllerAction(valuePayload(target, 'change'));
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.repeat || !['Enter', 'Escape'].includes(event.key)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || sensitiveElement(target)) return;
    sendControllerAction({ kind: 'key', ...metadataFor(target), key: event.key, code: event.code });
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
    }, 45);
  }, true);

  window.addEventListener('popstate', () => scheduleControllerState(30, true));
  window.addEventListener('hashchange', () => scheduleControllerState(30, true));
}

ipcRenderer.on('replay-action', (_event, payload) => {
  let result;
  try {
    result = replayAction(payload.action);
  } catch (error) {
    result = { ok: false, reason: error.message };
  }
  ipcRenderer.send('replay-result', { actionId: payload.actionId, screenNumber, ...result });
  schedulePageState(120);
});

ipcRenderer.on('controller-state-v11', (_event, state) => {
  if (isController || challengeDetected()) return;
  requestAnimationFrame(() => applyWindowPosition(state));
  setTimeout(() => applyWindowPosition(state), 220);
  setTimeout(() => applyWindowPosition(state), 720);
});

ipcRenderer.on('request-page-state', () => schedulePageState(0));
window.addEventListener('DOMContentLoaded', () => {
  schedulePageState(20);
  scheduleControllerState(40, true);
});
window.addEventListener('load', () => {
  schedulePageState(60);
  scheduleControllerState(80, true);
});

const installObserver = () => {
  if (!document.documentElement) return;
  new MutationObserver(() => schedulePageState(280)).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

if (document.documentElement) installObserver();
else window.addEventListener('DOMContentLoaded', installObserver, { once: true });

setInterval(sendPageState, 2400);
if (isController) setInterval(() => sendControllerState(false), 650);
