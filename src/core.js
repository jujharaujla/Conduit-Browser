'use strict';

const TOOLBAR_HEIGHT = 106;
const LABEL_HEIGHT = 26;
const GAP = 2;
const MAX_SCREENS = 8;
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

function distribute(total, parts, gap = GAP) {
  const usable = Math.max(0, total - (gap * Math.max(0, parts - 1)));
  const base = Math.floor(usable / parts);
  const remainder = usable - (base * parts);
  return Array.from({ length: parts }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

function gridShape(count) {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  if (count <= 6) return { columns: 3, rows: 2 };
  return { columns: 4, rows: 2 };
}

function layoutCells(countValue, widthValue, heightValue) {
  const count = clampScreenCount(countValue);
  const width = Math.max(0, Math.floor(widthValue));
  const height = Math.max(0, Math.floor(heightValue));
  const contentHeight = Math.max(0, height - TOOLBAR_HEIGHT);
  const { columns, rows } = gridShape(count);
  const columnWidths = distribute(width, columns);
  const rowHeights = distribute(contentHeight, rows);
  const columnOffsets = [];
  const rowOffsets = [];

  let x = 0;
  for (const columnWidth of columnWidths) {
    columnOffsets.push(x);
    x += columnWidth + GAP;
  }

  let y = TOOLBAR_HEIGHT;
  for (const rowHeight of rowHeights) {
    rowOffsets.push(y);
    y += rowHeight + GAP;
  }

  const cells = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    cells.push({
      x: columnOffsets[column],
      y: rowOffsets[row],
      width: columnWidths[column],
      height: rowHeights[row],
    });
  }
  return cells;
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