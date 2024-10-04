'use strict';

const net = require('node:net');
const { once } = require('node:events');

const MAX_HANDSHAKE_BUFFER = 1024 * 1024;
const MAX_PROXY_HEADER = 64 * 1024;

class BufferedReader {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.length = 0;
    this.waiters = [];
    this.failure = null;
    this.released = false;

    this.onData = (chunk) => {
      if (this.released) return;
      this.chunks.push(chunk);
      this.length += chunk.length;
      if (this.length > MAX_HANDSHAKE_BUFFER) {
        this.fail(new Error('SOCKS handshake exceeded the safe memory limit'));
        return;
      }
      this.flush();
      if (!this.waiters.length || this.length >= this.waiters[0].size) this.socket.pause();
    };
    this.onError = (error) => this.fail(error);
    this.onClose = () => {
      if (!this.released && !this.failure) this.fail(new Error('SOCKS connection closed during handshake'));
    };

    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.pause();
  }

  fail(error) {
    if (this.failure || this.released) return;
    this.failure = error;
    this.socket.pause();
    this.flush();
  }

  read(size) {
    if (!Number.isInteger(size) || size < 0 || size > MAX_HANDSHAKE_BUFFER) {
      return Promise.reject(new Error('Invalid SOCKS read size'));
    }
    if (this.failure) return Promise.reject(this.failure);
    if (size === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      this.waiters.push({ size, resolve, reject });
      this.flush();
      if (!this.failure && this.waiters.length && this.length < this.waiters[0].size) this.socket.resume();
    });
  }

  take(size) {
    const output = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      const needed = size - offset;
      if (chunk.length <= needed) {
        chunk.copy(output, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(output, offset, 0, needed);
        this.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    this.length -= size;
    return output;
  }

  flush() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.failure) {
        this.waiters.shift().reject(this.failure);
        continue;
      }
      if (this.length < waiter.size) break;
      this.waiters.shift();
      waiter.resolve(this.take(waiter.size));
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    if (this.length) this.socket.unshift(this.take(this.length));
    this.chunks = [];
    this.length = 0;
  }
}

function addressPacket(host) {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return Buffer.from([0x01, ...host.split('.').map(Number)]);
  if (ipVersion === 6) throw new Error('IPv6 literals are not supported by the local bridge');
  const domain = Buffer.from(host, 'utf8');
  if (!domain.length || domain.length > 255) throw new Error('Invalid destination hostname');
  return Buffer.concat([Buffer.from([0x03, domain.length]), domain]);
}

function authPacket(username, password = '') {
  const user = Buffer.from(String(username || ''), 'utf8');
  const pass = Buffer.from(String(password || ''), 'utf8');
  if (user.length > 255 || pass.length > 255) throw new Error('SOCKS identity is too long');
  return Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
}

async function connectThroughTor({ socksPort, host, port, username = '' }) {
  const socket = net.connect({ host: '127.0.0.1', port: socksPort, allowHalfOpen: false });
  socket.setNoDelay(true);
  socket.setTimeout(30000, () => socket.destroy(new Error('Tor SOCKS connection timed out')));

  try {
    await once(socket, 'connect');
    const reader = new BufferedReader(socket);
    socket.write(username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    const method = await reader.read(2);
    if (method[0] !== 0x05 || method[1] === 0xff) throw new Error('Tor SOCKS server rejected authentication methods');

    if (method[1] === 0x02) {
      socket.write(authPacket(username));
      const authReply = await reader.read(2);
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) throw new Error('Tor SOCKS identity authentication failed');
    } else if (method[1] !== 0x00) {
      throw new Error(`Unsupported Tor SOCKS method ${method[1]}`);
    }

    const address = addressPacket(host);
    const portBuffer = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBuffer]));

    const header = await reader.read(4);
    if (header[0] !== 0x05 || header[1] !== 0x00) throw new Error(`Tor SOCKS connection failed with code ${header[1]}`);
    if (header[3] === 0x01) await reader.read(4);
    else if (header[3] === 0x04) await reader.read(16);
    else if (header[3] === 0x03) await reader.read((await reader.read(1))[0]);
    else throw new Error('Tor returned an unknown SOCKS address type');
    await reader.read(2);

    reader.release();
    socket.setTimeout(0);
    return socket;
  } catch (error) {
    if (!socket.destroyed) socket.destroy();
    throw error;
  }
}

function parseAuthority(value, fallbackPort) {
  const input = String(value || '').trim();
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end < 0) throw new Error('Invalid IPv6 authority');
    return { host: input.slice(1, end), port: Number(input.slice(end + 2)) || fallbackPort };
  }
  const split = input.lastIndexOf(':');
  if (split > 0 && input.indexOf(':') === split) {
    return { host: input.slice(0, split), port: Number(input.slice(split + 1)) || fallbackPort };
  }
  return { host: input, port: fallbackPort };
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

function startTorHttpBridge({ socksPort, listenPort = 0, username = '' }) {
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
      if (!client.destroyed) client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message || ''}`);
    };

    const onData = async (chunk) => {
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

      const headerBuffer = buffer.subarray(0, marker + 4);
      const remainder = buffer.subarray(marker + 4);
      const lines = headerBuffer.toString('latin1').split('\r\n');
      const [method, target, version] = lines[0].split(' ');

      try {
        if (!method || !target || !version) throw new Error('Malformed proxy request line');
        if (method === 'CONNECT') {
          const destination = parseAuthority(target, 443);
          const upstream = await connectThroughTor({ socksPort, username, ...destination });
          client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Relay\r\n\r\n');
          if (remainder.length) upstream.write(remainder);
          connectPipes(client, upstream);
          return;
        }

        let url;
        try {
          url = new URL(target);
        } catch {
          const hostHeader = lines.find((line) => /^host:/i.test(line));
          if (!hostHeader) throw new Error('HTTP request has no Host header');
          url = new URL(`http://${hostHeader.slice(hostHeader.indexOf(':') + 1).trim()}${target}`);
        }
        if (url.protocol !== 'http:') throw new Error('Unsupported proxy request scheme');
        const upstream = await connectThroughTor({
          socksPort,
          username,
          host: url.hostname,
          port: Number(url.port) || 80,
        });
        lines[0] = `${method} ${url.pathname}${url.search} ${version}`;
        upstream.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), remainder]));
        connectPipes(client, upstream);
      } catch (error) {
        if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${error.message}`);
      }
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

module.exports = { connectThroughTor, startTorHttpBridge };
