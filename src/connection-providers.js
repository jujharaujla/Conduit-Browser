'use strict';

const CONNECTION_MODES = Object.freeze({
  DIRECT: 'direct',
  TOR: 'tor',
  PROXY: 'proxy',
});

const PROFILE_TYPES = Object.freeze({
  SOCKS5: 'socks5',
  HTTP: 'http',
});

const VALID_CONNECTION_MODES = new Set(Object.values(CONNECTION_MODES));
const VALID_PROFILE_TYPES = new Set(Object.values(PROFILE_TYPES));

class ConnectionFailure extends Error {
  constructor(message, { code = 'CONNECTION_FAILED', paneNumber = null, profileId = null } = {}) {
    super(message);
    this.name = 'ConnectionFailure';
    this.code = code;
    this.paneNumber = paneNumber;
    this.profileId = profileId;
  }

  toPublicResult() {
    return {
      ok: false,
      code: this.code,
      paneNumber: this.paneNumber,
      profileId: this.profileId,
      error: this.message,
      requiresFallbackConfirmation: true,
    };
  }
}

function normalizeConnectionMode(value) {
  return VALID_CONNECTION_MODES.has(value) ? value : CONNECTION_MODES.DIRECT;
}

function normalizeProfileAssignments(value, maximum = 8) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: maximum }, (_unused, index) => {
    const id = source[index];
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  });
}

function routeForPane({ mode, assignments, paneIndex, profileById }) {
  const normalizedMode = normalizeConnectionMode(mode);
  if (normalizedMode !== CONNECTION_MODES.PROXY) {
    return { mode: normalizedMode, profile: null };
  }

  const profileId = normalizeProfileAssignments(assignments)[paneIndex];
  if (!profileId) {
    throw new ConnectionFailure(`Screen ${paneIndex + 1} does not have a proxy profile.`, {
      code: 'PROFILE_NOT_ASSIGNED',
      paneNumber: paneIndex + 1,
    });
  }

  const profile = profileById(profileId);
  if (!profile) {
    throw new ConnectionFailure(`The proxy assigned to Screen ${paneIndex + 1} no longer exists.`, {
      code: 'PROFILE_NOT_FOUND',
      paneNumber: paneIndex + 1,
      profileId,
    });
  }

  return { mode: normalizedMode, profile };
}

function electronProxyRules(profile, localBridgePort = null) {
  if (!profile || !VALID_PROFILE_TYPES.has(profile.type)) {
    throw new ConnectionFailure('The selected proxy profile is invalid.', {
      code: 'PROFILE_INVALID',
      profileId: profile?.id || null,
    });
  }

  if (profile.type === PROFILE_TYPES.SOCKS5) {
    return localBridgePort
      ? `http://127.0.0.1:${localBridgePort}`
      : `socks5://${profile.host}:${profile.port}`;
  }
  return `http://${profile.host}:${profile.port}`;
}

module.exports = {
  CONNECTION_MODES,
  PROFILE_TYPES,
  ConnectionFailure,
  normalizeConnectionMode,
  normalizeProfileAssignments,
  routeForPane,
  electronProxyRules,
};
