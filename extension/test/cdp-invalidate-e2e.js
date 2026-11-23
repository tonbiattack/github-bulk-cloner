'use strict';

/**
 * Reproduces the "Extension context invalidated" error.
 *
 * Opens a GitHub listing page, then reloads the extension so the content
 * script already running in that page is orphaned. Any chrome.runtime call
 * from the orphaned script used to throw. This checks that the page stays
 * clean and that the injected UI is removed instead.
 *
 * Usage: node extension/test/cdp-invalidate-e2e.js <extensionId>
 */

const CDP_PORT = process.env.CDP_PORT || '9344';
const EXTENSION_ID = process.argv[2];

if (!EXTENSION_ID) {
  console.error('usage: node cdp-invalidate-e2e.js <extensionId>');
  process.exit(1);
}

const GITHUB_URL = 'https://github.com/tonbiattack?tab=repositories';

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
    const events = [];
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
        events,
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
        return;
      }
      events.push(message);
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
  // ------------------------------------------------------------ GitHub page
  const pageResponse = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(GITHUB_URL)}`,
    { method: 'PUT' }
  );
  const pageTarget = await pageResponse.json();
  await sleep(6000);

  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  let boxCount = 0;
  for (let i = 0; i < 30; i++) {
    boxCount = await evaluate(page, 'document.querySelectorAll(".gbc-checkbox").length');
    if (boxCount > 0) break;
    await sleep(1000);
  }
  check('checkboxes injected before reload', boxCount > 0, `${boxCount} boxes`);

  // ------------------------------------------------- reload the extension
  // Loading the unpacked extension again replaces it, orphaning the content
  // script that is already running in the page above.
  const loadResponse = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const version = await loadResponse.json();
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser.send('Extensions.loadUnpacked', { path: process.cwd() + '/extension' });
  browser.close();
  await sleep(2000);

  // ------------------------------------------- interact with the orphaned UI
  // Checking a box is what used to throw: the change handler calls
  // notifySelectionChanged(), which calls chrome.runtime.sendMessage on a
  // context that no longer exists.
  await evaluate(page, `
    (() => {
      const box = document.querySelector('.gbc-checkbox');
      if (!box) return 'no box';
      box.click();
      return 'clicked';
    })()
  `);
  await sleep(2000);

  // Unchecking exercises the same path.
  await evaluate(page, `
    (() => {
      const box = document.querySelector('.gbc-checkbox');
      if (box) box.click();
    })()
  `);
  await sleep(1500);

  // Trigger a rescan too, which also used to call into the dead context.
  await evaluate(page, 'window.dispatchEvent(new Event("popstate"))');
  await sleep(2000);

  // ------------------------------------------------------- inspect the page
  const errors = page.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => {
      const d = e.params.exceptionDetails;
      return (d.exception && d.exception.description) || d.text || '';
    })
    .filter((text) => /Extension context invalidated/i.test(text));

  check('no "Extension context invalidated" exception', errors.length === 0,
    errors.length > 0 ? errors[0].split('\n')[0] : 'none');

  const logErrors = page.events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => e.params.entry.text || '')
    .filter((text) => /Extension context invalidated/i.test(text));

  check('no "Extension context invalidated" console error', logErrors.length === 0,
    logErrors.length > 0 ? logErrors[0] : 'none');

  // The orphaned UI should be gone rather than left dead on the page.
  const remaining = await evaluate(page, 'document.querySelectorAll(".gbc-checkbox").length');
  check('orphaned checkboxes were removed', remaining === 0, `${remaining} left`);

  const toolbar = await evaluate(page, 'Boolean(document.getElementById("gbc-toolbar"))');
  check('orphaned toolbar was removed', toolbar === false);

  page.close();

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
