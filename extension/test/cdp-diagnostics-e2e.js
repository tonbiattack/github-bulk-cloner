'use strict';

/**
 * Live check of the host diagnostics and the conflict handling.
 *
 * Covers issue #9 (connection state) and issue #8 (same-name repositories):
 *   - a healthy host reports "ok" plus git/gh capabilities
 *   - the popup renders the ok badge without showing a setup panel
 *   - a folder holding a different repository is reported as a conflict,
 *     not as already cloned
 *   - the layout setting separates the two owners
 *
 * Usage: node extension/test/cdp-diagnostics-e2e.js <extensionId> <scratchDir>
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9360';
const EXTENSION_ID = process.argv[2];
const SCRATCH = process.argv[3];

if (!EXTENSION_ID || !SCRATCH) {
  console.error('usage: node cdp-diagnostics-e2e.js <extensionId> <scratchDir>');
  process.exit(1);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        close() { socket.close(); }
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

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + ' ' +
      JSON.stringify(result.exceptionDetails.exception && result.exceptionDetails.exception.description));
  }
  return result.result.value;
}

/** Creates a repository at dir whose origin points at spec. */
function makeRepo(dir, spec) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/${spec}.git`);
}

/** Sets the saved root and layout, since the worker reads them from storage. */
async function saveSettings(client, root, layout) {
  return evaluate(client, `
    chrome.runtime.sendMessage({type:"gbc:saveSettings",
      settings:{root:${JSON.stringify(root)},layout:${JSON.stringify(layout)}}})
  `);
}

async function runClone(client, root, layout, repositories) {
  await saveSettings(client, root, layout);
  await evaluate(client, `
    chrome.runtime.sendMessage({type:"gbc:startClone",
      repositories:${JSON.stringify(repositories)}})
  `);
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const state = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (state && state.status !== 'running') return state;
  }
  return null;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const root = path.join(SCRATCH, 'clones');
  fs.mkdirSync(root, { recursive: true });

  // ------------------------------------------------------------ diagnostics
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  const response = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(popupUrl)}`,
    { method: 'PUT' }
  );
  const target = await response.json();
  await sleep(2500);

  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  const host = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:checkHost"})');
  check('host reports ok', host && host.state === 'ok', JSON.stringify(host && host.state));
  check('host reports git capability',
    host && host.capabilities && host.capabilities.gitAvailable === true,
    JSON.stringify(host && host.capabilities && host.capabilities.gitAvailable));
  check('host reports its OS', Boolean(host && host.capabilities && host.capabilities.os),
    JSON.stringify(host && host.capabilities && host.capabilities.os));
  check('healthy host has no setup guidance', !host || !host.setup, JSON.stringify(host && host.setup));

  // The popup must show the ok badge and hide the diagnostics panel.
  await evaluate(client, 'location.reload()');
  await sleep(2500);
  const badge = await evaluate(client, 'document.getElementById("host-status").textContent');
  check('popup shows the connected badge', /接続 OK/.test(badge), JSON.stringify(badge));
  const panelHidden = await evaluate(client, 'document.getElementById("host-section").hidden');
  check('popup hides the setup panel when healthy', panelHidden === true, String(panelHidden));

  // --------------------------------------------------------------- conflict
  // ownerA/tool occupies the flat destination for ownerB/tool.
  makeRepo(path.join(root, 'tool'), 'ownerA/tool');

  const conflictState = await runClone(client, root, "flat", ["ownerB/tool"]);
  const conflictResult = conflictState && conflictState.results && conflictState.results[0];
  check('same-name different-owner is a conflict',
    conflictResult && conflictResult.status === 'conflict',
    JSON.stringify(conflictResult && conflictResult.status));
  check('conflict names the existing repository',
    conflictResult && conflictResult.existingRepository === 'ownerA/tool',
    JSON.stringify(conflictResult && conflictResult.existingRepository));
  check('conflict is not counted as skipped',
    conflictState && conflictState.summary && conflictState.summary.skipped === 0 &&
      conflictState.summary.conflict === 1,
    JSON.stringify(conflictState && conflictState.summary));
  check('existing checkout is untouched',
    fs.existsSync(path.join(root, 'tool', '.git')));

  // Matching repository still skips.
  const sameState = await runClone(client, root, "flat", ["ownerA/tool"]);
  const sameResult = sameState && sameState.results && sameState.results[0];
  check('matching repository still skips',
    sameResult && sameResult.status === 'skipped',
    JSON.stringify(sameResult && sameResult.status));

  // ----------------------------------------------------------- owner layout
  const ownerState = await runClone(client, root, "owner", ["ownerA/tool"]);
  const ownerResult = ownerState && ownerState.results && ownerState.results[0];
  check('owner layout targets the nested path',
    ownerResult && String(ownerResult.path).endsWith(path.join('ownerA', 'tool')),
    JSON.stringify(ownerResult && ownerResult.path));
  check('owner layout does not report a conflict',
    ownerResult && ownerResult.status !== 'conflict',
    JSON.stringify(ownerResult && ownerResult.status));

  // The layout setting round-trips through storage.
  const saved = await evaluate(client,
    'chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:"C:\\\\apps",layout:"owner"}})');
  check('layout setting persists', saved && saved.layout === 'owner', JSON.stringify(saved));
  const settings = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:getSettings"})');
  check('layout setting is readable', settings && settings.layout === 'owner', JSON.stringify(settings));
  await evaluate(client,
    'chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:"C:\\\\apps",layout:"flat"}})');

  client.close();

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED: ' + failed.map((c) => c.name).join(', '));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
