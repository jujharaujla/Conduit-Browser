'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILE_TYPES } = require('./connection-providers');

const MAX_NAME_LENGTH = 48;
const MAX_USERNAME_LENGTH = 255;
const MAX_PASSWORD_LENGTH = 2048;
const VALID_PROFILE_TYPES = new Set(Object.values(PROFILE_TYPES));

function requiredText(value, label, maximum) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return text;
}

function validateHost(value) {
  const host = requiredText(value, 'Proxy host', 253);
  if (
    host.includes('://')
    || /[/\\@?#\s]/.test(host)
    || host.startsWith('.')
    || host.endsWith('.')
    || host.includes(':')
  ) {
    throw new Error('Proxy host must be a hostname or IPv4 address without a scheme or port.');
  }
  return host.toLowerCase();
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Proxy port must be a whole number from 1 to 65535.');
  }
  return port;
}

function validateCredential(value, label, maximum) {
  const text = String(value || '');
  if (text.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  if (/[\u0000\r\n]/.test(text)) throw new Error(`${label} contains unsupported characters.`);
  return text;
}

function validateProfileInput(input = {}) {
  const type = String(input.type || '').toLowerCase();
  if (!VALID_PROFILE_TYPES.has(type)) {
    throw new Error('Proxy type must be SOCKS5 or HTTP/CONNECT.');
  }

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null,
    name: requiredText(input.name, 'Profile name', MAX_NAME_LENGTH),
    type,
    host: validateHost(input.host),
    port: validatePort(input.port),
    credentialAction: ['keep', 'replace', 'clear'].includes(input.credentialAction)
      ? input.credentialAction
      : 'replace',
    username: validateCredential(input.username, 'Proxy username', MAX_USERNAME_LENGTH),
    password: validateCredential(input.password, 'Proxy password', MAX_PASSWORD_LENGTH),
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: profile.port,
    hasCredentials: Boolean(profile.encryptedCredentials),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

class ProxyProfileStore {
  constructor({ filePath, safeStorage }) {
    if (!filePath) throw new Error('A proxy profile file path is required.');
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.records = [];
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const source = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
      this.records = source.filter((profile) => {
        try {
          return Boolean(
            profile
            && profile.id
            && validateProfileInput({ ...profile, credentialAction: 'keep' })
          );
        } catch {
          return false;
        }
      }).map((profile) => ({
        id: String(profile.id),
        name: String(profile.name),
        type: String(profile.type),
        host: String(profile.host),
        port: Number(profile.port),
        encryptedCredentials: typeof profile.encryptedCredentials === 'string'
          ? profile.encryptedCredentials
          : null,
        createdAt: Number(profile.createdAt) || Date.now(),
        updatedAt: Number(profile.updatedAt) || Date.now(),
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.records = [];
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, profiles: this.records }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.renameSync(temporaryPath, this.filePath);
  }

  list() {
    this.load();
    return this.records.map(publicProfile);
  }

  findRecord(id) {
    this.load();
    return this.records.find((profile) => profile.id === id) || null;
  }

  encryptCredentials(username, password) {
    if (!username && !password) return null;
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Secure credential storage is unavailable on this computer.');
    }
    const plaintext = JSON.stringify({ username, password });
    return this.safeStorage.encryptString(plaintext).toString('base64');
  }

  decryptCredentials(value) {
    if (!value) return { username: '', password: '' };
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('Secure credential storage is unavailable on this computer.');
    }
    const plaintext = this.safeStorage.decryptString(Buffer.from(value, 'base64'));
    const credentials = JSON.parse(plaintext);
    return {
      username: validateCredential(credentials?.username, 'Proxy username', MAX_USERNAME_LENGTH),
      password: validateCredential(credentials?.password, 'Proxy password', MAX_PASSWORD_LENGTH),
    };
  }

  save(input) {
    this.load();
    const validated = validateProfileInput(input);
    const now = Date.now();
    const existing = validated.id ? this.findRecord(validated.id) : null;
    if (validated.id && !existing) throw new Error('The proxy profile no longer exists.');

    let encryptedCredentials = existing?.encryptedCredentials || null;
    if (validated.credentialAction === 'clear') {
      encryptedCredentials = null;
    } else if (validated.credentialAction === 'replace') {
      encryptedCredentials = this.encryptCredentials(validated.username, validated.password);
    }

    const record = {
      id: existing?.id || crypto.randomUUID(),
      name: validated.name,
      type: validated.type,
      host: validated.host,
      port: validated.port,
      encryptedCredentials,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (existing) {
      this.records.splice(this.records.indexOf(existing), 1, record);
    } else {
      this.records.push(record);
    }
    this.records.sort((left, right) => left.name.localeCompare(right.name));
    this.persist();
    return publicProfile(record);
  }

  remove(id) {
    this.load();
    const index = this.records.findIndex((profile) => profile.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    this.persist();
    return true;
  }

  resolve(id) {
    const record = this.findRecord(id);
    if (!record) return null;
    return {
      ...publicProfile(record),
      ...this.decryptCredentials(record.encryptedCredentials),
    };
  }
}

module.exports = {
  ProxyProfileStore,
  publicProfile,
  validateProfileInput,
  validateHost,
  validatePort,
};
