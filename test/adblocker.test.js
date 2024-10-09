'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldBlock } = require('../src/adblocker');

function request(url, resourceType = 'script') {
  return { url, resourceType };
}

test('blocks known advertising hosts', () => {
  assert.equal(shouldBlock(request('https://securepubads.g.doubleclick.net/tag/js/gpt.js')), true);
  assert.equal(shouldBlock(request('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')), true);
});

test('blocks common ad request paths', () => {
  assert.equal(shouldBlock(request('https://example.com/gampad/ads?slot=10', 'xhr')), true);
  assert.equal(shouldBlock(request('https://example.com/video/vast.xml', 'media')), true);
});

test('does not block ordinary navigation or assets', () => {
  assert.equal(shouldBlock(request('https://example.com/', 'mainFrame')), false);
  assert.equal(shouldBlock(request('https://example.com/assets/application.js')), false);
});
