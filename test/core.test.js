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

test('limits pane count and zoom', () => {
  assert.equal(clampScreenCount(0), 1);
  assert.equal(clampScreenCount(9), 8);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(3), 1.5);
});

test('four panes use the full-width workspace below the toolbar', () => {
  const cells = layoutCells(4, 1000, 800);
  assert.equal(cells.length, 4);
  assert.equal(cells[0].width + cells[1].width + 2, 1000);
  assert.equal(cells[0].y, TOOLBAR_HEIGHT);
});

test('eight panes form a balanced four-by-two matrix', () => {
  const cells = layoutCells(8, 1200, 900);
  assert.equal(cells.length, 8);
  assert.equal(cells[0].width + cells[1].width + cells[2].width + cells[3].width + 6, 1200);
  assert.equal(cells[0].y, TOOLBAR_HEIGHT);
  assert.equal(cells[4].y, cells[0].y + cells[0].height + 2);
});

test('page key ignores query differences', () => {
  assert.equal(pageKey('https://example.com/a?one=1'), pageKey('https://example.com/a?two=2'));
});

test('blocks sensitive actions', () => {
  assert.equal(actionLooksSensitive({ fieldType: 'password' }), true);
  assert.equal(actionLooksSensitive({ text: 'Place order' }), true);
  assert.equal(actionLooksSensitive({ text: 'Open details' }), false);
});