'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOLBAR_HEIGHT,
  normalizeURL,
  clampScreenCount,
  clampZoom,
  layoutCells,
  pageKey,
  actionLooksSensitive,
} = require('../src/core');

test('normalizes domains and searches', () => {
  assert.equal(normalizeURL('example.com'), 'https://example.com');
  assert.match(normalizeURL('hello world'), /google\.com\/search/);
});

test('limits screen count and zoom', () => {
  assert.equal(clampScreenCount(0), 1);
  assert.equal(clampScreenCount(9), 4);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(3), 1.5);
});

test('four screens use the full-width workspace below the setup toolbar', () => {
  const cells = layoutCells(4, 1000, 800);
  assert.equal(cells.length, 4);
  assert.equal(cells[0].width + cells[1].width + 2, 1000);
  assert.equal(cells[0].y, TOOLBAR_HEIGHT);
});

test('page key ignores query differences', () => {
  assert.equal(pageKey('https://example.com/a?one=1'), pageKey('https://example.com/a?two=2'));
});

test('blocks sensitive actions', () => {
  assert.equal(actionLooksSensitive({ fieldType: 'password' }), true);
  assert.equal(actionLooksSensitive({ text: 'Place order' }), true);
  assert.equal(actionLooksSensitive({ text: 'Open details' }), false);
});
