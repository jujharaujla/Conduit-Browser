'use strict';

const net = require('node:net');

const MAX_PROXY_HEADER = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15000;

function removeProxyAuthorization(lines) {
  return lines.filter((line, index) => index === 0 || !/^proxy-authorization:/i.test(line));
}

function authorizationHeader(username, password) {
  if (!username && !password) return null;
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Proxy-Authorization: Basic ${token}`;
}

function authenticatedHeader(headerBuffer, username, password) {
  const lines = removeProxyAuthorization(headerBuffer.toString('latin1').split('\r\n'));
  while (lines.at(-1) === '') lines.pop();
  const authorization = authorizationHeader(username, password);
  if (authorization) lines.push(authorization);
  lines.push('', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

function connectPipes(client, upstream) {
  const close = () => {
    if (!client.destroyed) client.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', () => !upstream.destroyed && upstream.destroy());
  upstream.on('close', () => !client.destroyed && client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
  upstream.resume();
}

function startHttpProxyBridge({
  proxyHost,
  proxyPort,
  username = '',
  password = '',
  listenPort = 0,
}) {
  const server = net.createServer((client) => {
    client.pause();
    client.setNoDelay(true);
    const chunks = [];
    let bufferedLength = 0;
    let finished = false;

    const stopReading = () => {
      client.pause();
      client.off('data', onData);
    };

    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      stopReading();
      if (!client.destroyed) {
        client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
      }
    };

    const onData = (chunk) => {
      if (finished) return;
      chunks.push(chunk);
      bufferedLength += chunk.length;
      if (bufferedLength > MAX_PROXY_HEADER) {
        fail('431 Request Header Fields Too Large', 'Proxy request header exceeded 64 KiB');
        return;
      }

      const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bufferedLength);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      finished = true;
      stopReading();

      const header = authenticatedHeader(buffer.subarray(0, marker + 4), username, password);
      const remainder = buffer.subarray(marker + 4);
      const upstream = net.connect({
        host: proxyHost,
        port: proxyPort,
        allowHalfOpen: false,
      });
      upstream.setNoDelay(true);
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
        upstream.destroy(new Error('HTTP proxy connection timed out'));
      });

      const onConnectError = () => {
        if (!client.destroyed) {
          client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nProxy connection failed');
        }
      };
      upstream.once('error', onConnectError);
      upstream.once('connect', () => {
        upstream.off('error', onConnectError);
        upstream.setTimeout(0);
        upstream.write(header);
        if (remainder.length) upstream.write(remainder);
        connectPipes(client, upstream);
      });
    };

    client.on('data', onData);
    client.on('error', () => {});
    client.resume();
  });

  server.maxConnections = 512;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = {
  authorizationHeader,
  authenticatedHeader,
  startHttpProxyBridge,
};
