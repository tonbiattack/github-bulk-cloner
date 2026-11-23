'use strict';

/**
 * Live check of "checking a box pulls that repository immediately".
 *
 * Loads a real GitHub listing page, checks one box, and verifies that the
 * extension starts a pull for exactly that repository and shows the outcome
 * on the row.
 *
 * Usage: node extension/test/cdp-autopull-e2e.js <extensionId> <cloneRoot>
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9340';
const EXTENSION_ID = process.argv[2];
const CLONE_ROOT = process.argv[3];

if (!EXTENSION_ID || !CLONE_ROOT) {
  console.error('usage: node cdp-autopull-e2e.js <extensionId> <cloneRoot>');
  process.exit(1);
}

const GITHUB_URL = 'https://github.com/tonbiattack?tab=repositories';

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

async function main() {
  // A real clone of one of the user's repositories, so the pull has a target.
  fs.rmSync(CLONE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CLONE_ROOT, { recursive: true });
  const repoName = 'github-bulk-cloner';
  const target = path.join(CLONE_ROOT, repoName);
  execFileSync('git', ['clone', '--depth', '1',
    'https://github.com/tonbiattack/github-bulk-cloner.git', target], { encoding: 'utf8' });
  check('fixture repository cloned', fs.existsSync(path.join(target, '.git')));

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
    `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(CLONE_ROOT)}}})`);
  check('clone root saved', saved && saved.root === CLONE_ROOT, JSON.stringify(saved));

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

  // The content script injects after the page settles, so poll for the boxes.
  let boxCount = 0;
  for (let i = 0; i < 30; i++) {
    boxCount = await evaluate(page, 'document.querySelectorAll(".gbc-checkbox").length');
    if (boxCount > 0) break;
    await sleep(1000);
  }
  check('checkboxes present', boxCount > 0, `${boxCount} boxes`);

  // Find the checkbox for the repository we cloned.
  const found = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${repoName}'));
      if (!match) return null;
      match.click();
      return match.dataset.gbcSpec;
    })()
  `);
  check('found and checked the target repository', Boolean(found), String(found));

  // The row should show a pull status almost immediately.
  await sleep(1500);
  const rowStatus = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${repoName}'));
      if (!match) return null;
      const badge = match.parentElement.querySelector('.gbc-row-status');
      return badge ? { state: badge.dataset.state, text: badge.textContent } : null;
    })()
  `);
  check('row shows a pull status', Boolean(rowStatus), JSON.stringify(rowStatus));

  // Wait for the run to finish and confirm it targeted this repository.
  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    state = await evaluate(worker, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (state && state.status !== 'running' && state.kind === 'pull') break;
  }
  check('a pull run ran', state && state.kind === 'pull', JSON.stringify(state && state.kind));
  check('pull targeted the checked repository',
    state && state.results.length === 1 &&
    String(state.results[0].repository).toLowerCase().endsWith('/' + repoName),
    JSON.stringify(state && state.results.map((r) => r.repository)));

  const finalStatus = state && state.results[0] ? state.results[0].status : null;
  check('pull reported a pull status',
    ['updated', 'up-to-date', 'failed'].includes(finalStatus), String(finalStatus));

  // The row badge should reflect the final outcome.
  await sleep(1000);
  const finalBadge = await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${repoName}'));
      if (!match) return null;
      const badge = match.parentElement.querySelector('.gbc-row-status');
      return badge ? { state: badge.dataset.state, text: badge.textContent } : null;
    })()
  `);
  check('row badge reflects the outcome',
    finalBadge && ['updated', 'up-to-date', 'failed'].includes(finalBadge.state),
    JSON.stringify(finalBadge));

  // Unchecking must not start another pull.
  const before = await evaluate(worker, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
  await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      const match = boxes.find((b) => (b.dataset.gbcSpec || '').toLowerCase().endsWith('/${repoName}'));
      if (match) match.click();
    })()
  `);
  await sleep(2000);
  const after = await evaluate(worker, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
  check('unchecking does not start a pull',
    before.requestId === after.requestId,
    `${before.requestId} -> ${after.requestId}`);

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
