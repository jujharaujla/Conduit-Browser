'use strict';

const net = require('node:net');

function configuredPorts() {
  const requested = Number(process.env.RELAY_TOR_PORT);
  const ports = [];
  if (Number.isInteger(requested) && requested > 0 && requested <= 65535) ports.push(requested);
  for (const port of [9050, 9150]) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function probeSocks5(port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once('data', (chunk) => finish(chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] !== 0xff));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function findExistingTorPort(onStatus = () => {}) {
  for (const port of configuredPorts()) {
    onStatus(`Checking local Tor on 127.0.0.1:${port}`);
    if (await probeSocks5(port)) return port;
  }
  return null;
}

async function startTorRuntime(_userDataPath, screenCount = 4, onStatus = () => {}) {
  const port = await findExistingTorPort(onStatus);
  if (!port) {
    throw new Error(
      'No running Tor service was found on port 9050 or 9150. ' +
      'Install Tor with “brew install tor”, then start it with “brew services start tor”, ' +
      'or open Tor Browser before retrying.'
    );
  }

  onStatus(`Connected to local Tor SOCKS service on 127.0.0.1:${port}`);
  return {
    socksPorts: Array(screenCount).fill(port),
    managed: false,
    port,
    logs: [`Local Tor service detected on port ${port}`],
    getUnsafeDnsAttempts: () => 0,
    stop: () => {},
  };
}

module.exports = {
  configuredPorts,
  probeSocks5,
  findExistingTorPort,
  startTorRuntime,
};
