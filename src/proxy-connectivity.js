'use strict';

const net = require('node:net');
const { once } = require('node:events');
const { PROFILE_TYPES } = require('./connection-providers');
const { startSocksHttpBridge } = require('./tor-bridge');
const { startHttpProxyBridge } = require('./http-proxy-bridge');

const MAX_RESPONSE_HEADER = 64 * 1024;

function createBridge(profile) {
  if (profile.type === PROFILE_TYPES.SOCKS5) {
    return startSocksHttpBridge({
      socksHost: profile.host,
      socksPort: profile.port,
      username: profile.username,
      password: profile.password,
    });
  }
  return startHttpProxyBridge({
    proxyHost: profile.host,
    proxyPort: profile.port,
    username: profile.username,
    password: profile.password,
  });
}

function readResponseHeader(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('The proxy test timed out.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = () => {
      cleanup();
      reject(new Error('The proxy connection failed.'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The proxy closed the test connection.'));
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
      if (buffered.length > MAX_RESPONSE_HEADER) {
        cleanup();
        reject(new Error('The proxy returned an oversized response.'));
        return;
      }
      const marker = buffered.indexOf('\r\n\r\n');
      if (marker < 0) return;
      cleanup();
      resolve(buffered.subarray(0, marker + 4).toString('latin1'));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function testProxyProfile(profile, {
  targetHost = 'example.com',
  targetPort = 443,
  timeoutMs = 12000,
} = {}) {
  const startedAt = Date.now();
  let bridge = null;
  let client = null;
  try {
    bridge = await createBridge(profile);
    client = net.connect({ host: '127.0.0.1', port: bridge.port });
    client.setTimeout(timeoutMs, () => client.destroy(new Error('The proxy test timed out.')));
    await once(client, 'connect');
    client.setTimeout(0);
    client.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`);
    const header = await readResponseHeader(client, timeoutMs);
    const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/i.exec(header)?.[1]);
    if (status === 407) throw new Error('The proxy rejected the saved credentials.');
    if (status < 200 || status >= 300) throw new Error('The proxy could not reach the test destination.');
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'The proxy test failed.',
      checkedAt: Date.now(),
    };
  } finally {
    if (client && !client.destroyed) client.destroy();
    await bridge?.close?.().catch(() => {});
  }
}

module.exports = { testProxyProfile };
