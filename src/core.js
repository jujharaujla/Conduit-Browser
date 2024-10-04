'use strict';

const TOOLBAR_HEIGHT = 106;
const LABEL_HEIGHT = 26;
const GAP = 2;
const MAX_SCREENS = 4;
const DEFAULT_URL = 'relay://welcome';

function normalizeURL(value) {
  const input = String(value || '').trim();
  if (!input) return DEFAULT_URL;
  if (input === DEFAULT_URL) return input;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(input)) return input;
  if (/^[\w.-]+\.[a-zA-Z]{2,}(?:[/:?#]|$)/.test(input)) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function clampScreenCount(value) {
  return Math.min(MAX_SCREENS, Math.max(1, Number(value) || 1));
}

function clampZoom(value) {
  return Math.min(1.5, Math.max(0.5, Number(value) || 1));
}

function layoutCells(countValue, widthValue, heightValue) {
  const count = clampScreenCount(countValue);
  const width = Math.max(0, Math.floor(widthValue));
  const height = Math.max(0, Math.floor(heightValue));
  const contentHeight = Math.max(0, height - TOOLBAR_HEIGHT);

  if (count === 1) return [{ x: 0, y: TOOLBAR_HEIGHT, width, height: contentHeight }];
  if (count === 2) {
    const left = Math.floor((width - GAP) / 2);
    return [
      { x: 0, y: TOOLBAR_HEIGHT, width: left, height: contentHeight },
      { x: left + GAP, y: TOOLBAR_HEIGHT, width: width - left - GAP, height: contentHeight },
    ];
  }

  const left = Math.floor((width - GAP) / 2);
  const top = Math.floor((contentHeight - GAP) / 2);
  const right = width - left - GAP;
  const bottom = contentHeight - top - GAP;
  return [
    { x: 0, y: TOOLBAR_HEIGHT, width: left, height: top },
    { x: left + GAP, y: TOOLBAR_HEIGHT, width: right, height: top },
    { x: 0, y: TOOLBAR_HEIGHT + top + GAP, width: left, height: bottom },
    { x: left + GAP, y: TOOLBAR_HEIGHT + top + GAP, width: right, height: bottom },
  ].slice(0, count);
}

function pageBounds(cell) {
  return {
    x: cell.x,
    y: cell.y + LABEL_HEIGHT,
    width: cell.width,
    height: Math.max(0, cell.height - LABEL_HEIGHT),
  };
}

function labelBounds(cell) {
  return { x: cell.x, y: cell.y, width: cell.width, height: LABEL_HEIGHT };
}

function pageKey(value) {
  if (value === DEFAULT_URL) return DEFAULT_URL;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '');
  }
}

const SENSITIVE = /captcha|recaptcha|hcaptcha|turnstile|verify\s*(you|human)|security\s*check|checkout|purchase|buy\s*now|place\s*order|confirm\s*order|payment|credit\s*card|debit\s*card|bank|wire\s*transfer|send\s*money|cast\s*vote|submit\s*vote|delete\s*account|remove\s*account|close\s*account|submit\s*application/i;

function actionLooksSensitive(action) {
  if (!action || typeof action !== 'object') return true;
  if (['password', 'file'].includes(String(action.fieldType || '').toLowerCase())) return true;
  const details = [
    action.text,
    action.ariaLabel,
    action.name,
    action.placeholder,
    action.formText,
    action.formAction,
    action.href,
  ].filter(Boolean).join(' ');
  return SENSITIVE.test(details);
}

module.exports = {
  TOOLBAR_HEIGHT,
  LABEL_HEIGHT,
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
};
