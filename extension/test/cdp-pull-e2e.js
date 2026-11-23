'use strict';

/**
 * Live end-to-end check of the bulk pull feature in a real Chrome instance.
 *
 * Sets up a clone root containing two real repositories, then drives the
 * extension's pull path through native messaging and verifies:
 *   - "pull all" discovers repositories under the root
 *   - an up-to-date repository reports up-to-date
 *   - a repository with a new upstream commit reports updated and gets it
 *   - a diverged repository fails without rewriting local history
 *
 * Usage: node extension/test/cdp-pull-e2e.js <extensionId> <scratchDir>
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9339';
const EXTENSION_ID = process.argv[2];
const SCRATCH = process.argv[3];

if (!EXTENSION_ID || !SCRATCH) {
  console.error('usage: node cdp-pull-e2e.js <extensionId> <scratchDir>');
  process.exit(1);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  }).trim();
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

/** Builds a bare upstream plus a working clone, returning both paths. */
function makeRepo(base, owner, repo) {
  const bare = path.join(base, 'upstreams', `${owner}-${repo}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(base, 'init', '--bare', '-b', 'main', bare);

  const seed = path.join(base, 'seeds', `${owner}-${repo}`);
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  git(base, 'clone', bare, seed);
  git(seed, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'file.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'first');
  git(seed, 'push', '-u', 'origin', 'main');

  return { bare, seed };
}

function cloneInto(bare, root, repo) {
  // The flat layout is what the host creates: <root>/<repo>.
  const target = path.join(root, repo);
  fs.mkdirSync(target, { recursive: true });
  git(root, 'clone', bare, target);
  return target;
}

function pushTo(seed, content) {
  fs.writeFileSync(path.join(seed, 'file.txt'), content);
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'update ' + content);
  git(seed, 'push', 'origin', 'main');
}

async function main() {
  // ------------------------------------------------------------ fixtures
  const root = path.join(SCRATCH, 'clones');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const alpha = makeRepo(SCRATCH, 'alpha', 'one');
  const beta = makeRepo(SCRATCH, 'beta', 'two');
  const gamma = makeRepo(SCRATCH, 'gamma', 'three');

  cloneInto(alpha.bare, root, 'one');
  const betaPath = cloneInto(beta.bare, root, 'two');
  const gammaPath = cloneInto(gamma.bare, root, 'three');

  // beta gets a new upstream commit; gamma diverges locally.
  pushTo(beta.seed, 'two\n');
  fs.writeFileSync(path.join(gammaPath, 'local.txt'), 'local\n');
  git(gammaPath, 'add', '.');
  git(gammaPath, 'commit', '-m', 'local work');
  const gammaHead = git(gammaPath, 'rev-parse', 'HEAD');
  pushTo(gamma.seed, 'upstream\n');

  check('fixtures created', fs.existsSync(path.join(root, 'one', '.git')));

  // ------------------------------------------------------- extension context
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  const response = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(popupUrl)}`,
    { method: 'PUT' }
  );
  const target = await response.json();
  await sleep(2500);

  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');

  const saved = await evaluate(client,
    `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(root)}}})`);
  check('clone root saved', saved && saved.root === root, JSON.stringify(saved));

  // ------------------------------------------------------------- pull all
  const started = await evaluate(client,
    'chrome.runtime.sendMessage({type:"gbc:startPull",repositories:[]})');
  check('pull all accepted', Boolean(started && started.status), JSON.stringify(started && started.status));

  let state = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    state = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (state && state.status !== 'running') break;
  }

  check('pull run finished', state && state.status === 'done', JSON.stringify(state && state.status));
  check('pull discovered every repository', state && state.results.length === 3,
    `${state && state.results ? state.results.length : 0} results`);

  const byRepo = {};
  for (const result of state.results) byRepo[result.repository] = result;

  check('up-to-date repository reported as such',
    byRepo['one'] && byRepo['one'].status === 'up-to-date',
    JSON.stringify(byRepo['one'] && byRepo['one'].status));

  check('repository with new commits reported updated',
    byRepo['two'] && byRepo['two'].status === 'updated',
    JSON.stringify(byRepo['two'] && byRepo['two'].status));

  check('diverged repository reported failed',
    byRepo['three'] && byRepo['three'].status === 'failed',
    JSON.stringify(byRepo['three'] && byRepo['three'].status));

  // ------------------------------------------------- verify on-disk effects
  const betaContent = fs.readFileSync(path.join(betaPath, 'file.txt'), 'utf8').replace(/\r\n/g, '\n');
  check('updated repository actually received the commit', betaContent === 'two\n', JSON.stringify(betaContent));

  const gammaHeadAfter = git(gammaPath, 'rev-parse', 'HEAD');
  check('diverged repository kept its local history', gammaHeadAfter === gammaHead,
    `${gammaHead.slice(0, 7)} -> ${gammaHeadAfter.slice(0, 7)}`);
  check('diverged repository kept its local file',
    fs.existsSync(path.join(gammaPath, 'local.txt')));

  // --------------------------------------------------- named pull subset
  const named = await evaluate(client,
    'chrome.runtime.sendMessage({type:"gbc:startPull",repositories:["one"]})');
  check('named pull accepted', Boolean(named && named.status));

  let namedState = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    namedState = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (namedState && namedState.status !== 'running') break;
  }
  check('named pull only touched the named repository',
    namedState && namedState.results.length === 1 &&
    namedState.results[0].repository === 'one',
    JSON.stringify(namedState && namedState.results.map((r) => r.repository)));

  // ------------------------------------------------------ nothing to pull
  const emptyRoot = path.join(SCRATCH, 'empty');
  fs.mkdirSync(emptyRoot, { recursive: true });
  await evaluate(client,
    `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(emptyRoot)}}})`);
  await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:startPull",repositories:[]})');

  // The host error arrives asynchronously through the run state.
  let emptyState = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    emptyState = await evaluate(client, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (emptyState && emptyState.status !== 'running') break;
  }
  check('empty root reports an actionable error',
    Boolean(emptyState && emptyState.status === 'error' &&
      /Git リポジトリが見つかりません/.test(emptyState.error || '')),
    JSON.stringify(emptyState && emptyState.error));

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
