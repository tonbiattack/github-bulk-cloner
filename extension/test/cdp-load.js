'use strict';

/**
 * Loads the unpacked extension into a running Chrome via the CDP Extensions
 * domain (Chrome 130+), then reports the assigned extension ID.
 *
 * Usage: node extension/test/cdp-load.js <path-to-extension>
 */

const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9334';

async function browserWebSocketUrl() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const info = await response.json();
  return info.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(JSON.stringify(message.error)));
        else res(message.result);
      }
    });

    socket.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

async function main() {
  const extensionPath = path.resolve(process.argv[2] || 'extension');
  const client = await connect(await browserWebSocketUrl());

  try {
    const result = await client.send('Extensions.loadUnpacked', { path: extensionPath });
    console.log('extensionId=' + result.id);
  } catch (error) {
    console.error('loadUnpacked failed: ' + error.message);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
