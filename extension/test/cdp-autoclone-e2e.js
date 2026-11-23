'use strict';

/**
 * Live check of "checking a box clones that repository immediately".
 *
 * Loads a real GitHub listing page, checks one box, and verifies that the
 * extension clones exactly that repository into the configured root, creating
 * the root folder when it does not exist.
 *
 * Usage: node extension/test/cdp-autoclone-e2e.js <extensionId> <scratchDir>
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9340';
const EXTENSION_ID = process.argv[2];
const SCRATCH = process.argv[3];

if (!EXTENSION_ID || !SCRATCH) {
  console.error('usage: node cdp-autoclone-e2e.js <extensionId> <scratchDir>');
  process.exit(1);
}

const GITHUB_URL = 'https://github.com/tonbiattack?tab=repositories';
const REPO_NAME = 'github-bulk-cloner';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

async function main() {
  // The root deliberately does not exist, to prove the host creates it.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const root = path.join(SCRATCH, 'nested', 'clone-root');
  check('clone root does not exist yet', !fs.existsSync(root), root);

  // ------------------------------------------------------- extension context
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  const popupResponse = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(popupUrl)}`,
    { method: 'PUT' }
  );
  const popupTarget = await popupResponse.json();
  await sleep(2500);

  const worker = await connect(popupTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  const saved = await evaluate(worker,
    `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(root)}}})`);
  check('clone root saved', saved && saved.root === root, JSON.stringify(saved));

  // Close stale listing tabs so the content script is fresh.
  await evaluate(worker, `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const stale = tabs.filter((t) => t.url && t.url.includes('tab=repositories'));
      await Promise.all(stale.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
      return stale.length;
    })()
  `);

  // ------------------------------------------------------------ GitHub page
  const pageResponse = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(GITHUB_URL)}`,
    { method: 'PUT' }
  );
  const pageTarget = await pageResponse.json();
  await sleep(6000);

  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');

  let boxCount = 0;
  for (let i = 0; i < 30; i++) {
    boxCount = await evaluate(page, 'document.querySelectorAll(".gbc-checkbox").length');
    if (boxCount > 0) break;
    await sleep(1000);
  }
  check('checkboxes present', boxCount > 0, `${boxCount} boxes`);

  // Check the box for the target repository.
  const found = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${REPO_NAME}'));
      if (!match) return null;
      match.click();
      return match.dataset.gbcSpec;
    })()
  `);
  check('found and checked the target repository', Boolean(found), String(found));

  // The row should show a clone status almost immediately.
  await sleep(1500);
  const rowStatus = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${REPO_NAME}'));
      if (!match) return null;
      const badge = match.parentElement.querySelector('.gbc-row-status');
      return badge ? { state: badge.dataset.state, text: badge.textContent } : null;
    })()
  `);
  check('row shows a clone status', Boolean(rowStatus), JSON.stringify(rowStatus));

  // Wait for the run to finish.
  let state = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    state = await evaluate(worker, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (state && state.status !== 'running') break;
  }
  check('clone run finished', state && state.status === 'done', JSON.stringify(state && state.status));
  check('clone targeted the checked repository',
    state && state.results.length === 1 &&
    String(state.results[0].repository).toLowerCase().endsWith('/' + REPO_NAME),
    JSON.stringify(state && state.results.map((r) => r.repository)));

  const result = state && state.results[0];
  check('clone succeeded', result && result.status === 'success',
    JSON.stringify(result && result.status));

  // ------------------------------------------------- verify on-disk effects
  check('clone root was created', fs.existsSync(root), root);

  const target = path.join(root, REPO_NAME);
  check('repository cloned directly under the root', fs.existsSync(path.join(target, '.git')), target);
  check('no owner directory was created',
    !fs.existsSync(path.join(root, 'tonbiattack')),
    path.join(root, 'tonbiattack'));

  if (fs.existsSync(path.join(target, '.git'))) {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: target, encoding: 'utf8'
    }).trim();
    check('remote points at the right repository',
      remote.toLowerCase().includes(REPO_NAME), remote);
  }

  // The row badge should reflect the outcome.
  await sleep(1000);
  const finalBadge = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${REPO_NAME}'));
      if (!match) return null;
      const badge = match.parentElement.querySelector('.gbc-row-status');
      return badge ? { state: badge.dataset.state, text: badge.textContent } : null;
    })()
  `);
  check('row badge shows the clone outcome',
    finalBadge && finalBadge.state === 'success', JSON.stringify(finalBadge));

  // -------------------------------------------------- checking again skips
  await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${REPO_NAME}'));
      if (match) { match.click(); match.click(); }
    })()
  `);

  let second = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    second = await evaluate(worker, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (second && second.status !== 'running' && second.requestId !== state.requestId) break;
  }
  check('re-checking an existing repository skips it',
    second && second.results.length > 0 && second.results[0].status === 'skipped',
    JSON.stringify(second && second.results.map((r) => r.status)));

  page.close();
  worker.close();

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
