'use strict';

const BLOCKED_HOSTS = [
  '2mdn.net',
  'adform.net',
  'adnxs.com',
  'adroll.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'casalemedia.com',
  'contextweb.com',
  'criteo.com',
  'criteo.net',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'googletagservices.com',
  'lijit.com',
  'media.net',
  'moatads.com',
  'openx.net',
  'outbrain.com',
  'pubmatic.com',
  'revcontent.com',
  'rubiconproject.com',
  'sharethrough.com',
  'smartadserver.com',
  'taboola.com',
  'teads.tv',
  'yieldmo.com',
];

const BLOCKED_URL_PATTERNS = [
  /\/ads?(?:erver|ervice|ystem)?[\/_?=-]/i,
  /\/adslot[\/_?=-]/i,
  /\/adview[\/_?=-]/i,
  /\/gampad\//i,
  /\/pagead\//i,
  /\/prebid(?:\.|\/|\?)/i,
  /\/vast(?:\.|\/|\?)/i,
  /\/vpaid(?:\.|\/|\?)/i,
  /[?&](?:ad|ads|adunit|adslot)=/i,
];

const BLOCKED_RESOURCE_TYPES = new Set([
  'subFrame',
  'script',
  'image',
  'stylesheet',
  'font',
  'object',
  'xhr',
  'ping',
  'media',
  'webSocket',
  'other',
]);

const installedSessions = new WeakSet();
const statistics = new Map();

function hostnameMatches(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return BLOCKED_HOSTS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function shouldBlock(details) {
  if (!details || !BLOCKED_RESOURCE_TYPES.has(details.resourceType)) return false;

  let parsed;
  try {
    parsed = new URL(details.url);
  } catch {
    return false;
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
  if (hostnameMatches(parsed.hostname)) return true;

  const searchable = `${parsed.pathname}${parsed.search}`;
  return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(searchable));
}

function snapshot() {
  const sessions = Array.from(statistics.values()).map((entry) => ({ ...entry }));
  return {
    enforced: true,
    totalBlocked: sessions.reduce((sum, entry) => sum + entry.blocked, 0),
    sessions,
  };
}

function installSessionAdBlocker(ses, label = 'browser', onDiagnostic = () => {}) {
  if (!ses || installedSessions.has(ses)) return;
  installedSessions.add(ses);

  const entry = {
    label,
    blocked: 0,
    lastBlockedHost: '',
  };
  statistics.set(label, entry);

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const blocked = shouldBlock(details);

    if (blocked) {
      entry.blocked += 1;
      try {
        entry.lastBlockedHost = new URL(details.url).hostname;
      } catch {
        entry.lastBlockedHost = 'unknown';
      }

      if (entry.blocked === 1 || entry.blocked % 50 === 0) {
        onDiagnostic({
          level: 'success',
          message: `${label}: blocked ${entry.blocked} ad or tracker request${entry.blocked === 1 ? '' : 's'}`,
        });
      }
    }

    callback({ cancel: blocked });
  });

  onDiagnostic({
    level: 'success',
    message: `${label}: enforced ad and tracker protection enabled`,
  });
}

module.exports = {
  installSessionAdBlocker,
  shouldBlock,
  snapshot,
};
