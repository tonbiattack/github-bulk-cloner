'use strict';

/**
 * Live end-to-end check of the extension in a real Chrome instance.
 *
 * Verifies, in order:
 *   1. the service worker answers getSettings / checkHost
 *   2. the content script injects checkboxes on a real GitHub listing page
 *   3. select-all / clear work and the popup state matches
 *   4. a real clone runs through native messaging and reports results
 *
 * Usage: node extension/test/cdp-e2e.js <extensionId> [root]
 */

const CDP_PORT = process.env.CDP_PORT || '9334';
const EXTENSION_ID = process.argv[2];
const CLONE_ROOT = process.argv[3] || '';

if (!EXTENSION_ID) {
  console.error('usage: node cdp-e2e.js <extensionId> [cloneRoot]');
  process.exit(1);
}

const GITHUB_URL = 'https://github.com/tonbiattack?tab=repositories';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // ------------------------------------------------------- extension context
  // The service worker is lazy, so drive runtime messages from the popup page,
  // which also exercises the popup itself.
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
  const popupResponse = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(popupUrl)}`,
    { method: 'PUT' }
  );
  const popupTarget = await popupResponse.json();
  await sleep(2500);

  const sw = await connect(popupTarget.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');

  const manifestName = await evaluate(sw, 'chrome.runtime.getManifest().name');
  check('manifest name', manifestName === 'GitHub Bulk Cloner', manifestName);

  const settings = await evaluate(sw, 'chrome.runtime.sendMessage({type:"gbc:getSettings"})');
  check('getSettings returns a root', Boolean(settings && settings.root), JSON.stringify(settings));

  if (CLONE_ROOT) {
    const saved = await evaluate(sw,
      `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(CLONE_ROOT)}}})`);
    check('saveSettings persists the root', saved && saved.root === CLONE_ROOT, JSON.stringify(saved));
  }

  const host = await evaluate(sw, 'chrome.runtime.sendMessage({type:"gbc:checkHost"})');
  check('native host answers ping', Boolean(host && host.ok), JSON.stringify(host));

  // ------------------------------------------------------------ content script
  // Close stale listing tabs from earlier runs so the tab lookup below cannot
  // pick a page whose content script was orphaned by an extension reload.
  await evaluate(sw, `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const stale = tabs.filter((t) => t.url && t.url.includes('tab=repositories'));
      await Promise.all(stale.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
      return stale.length;
    })()
  `);

  const page = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(GITHUB_URL)}`, { method: 'PUT' });
  const pageTarget = await page.json();
  await sleep(6000);

  const tab = await connect(pageTarget.webSocketDebuggerUrl);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');

  const title = await evaluate(tab, 'document.title');
  check('GitHub page loaded', /GitHub/i.test(String(title)), String(title));

  // Content scripts run in an isolated world, so ask the content script itself
  // through the extension messaging channel rather than reading page globals.
  const pageState = await evaluate(sw, `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.url && t.url.includes('tab=repositories'));
      if (!target) return { error: 'listing tab not found', tabs: tabs.map((t) => t.url) };
      return chrome.tabs.sendMessage(target.id, { type: 'gbc:getState' });
    })()
  `);
  check('content script reports a supported page',
    Boolean(pageState && pageState.supported === true),
    JSON.stringify(pageState && pageState.supported));
  check('content script reports candidates',
    Boolean(pageState && Array.isArray(pageState.candidates) && pageState.candidates.length > 0),
    `${pageState && pageState.candidates ? pageState.candidates.length : 0} candidates`);

  const checkboxCount = await evaluate(tab, 'document.querySelectorAll(".gbc-checkbox").length');
  check('checkboxes injected', checkboxCount > 0, `${checkboxCount} checkboxes`);

  // A fork row contains both the repository link and a "Forked from" link.
  // Only the primary link may produce a checkbox.
  const rowsWithDuplicates = await evaluate(tab, `
    (() => {
      const rows = [...document.querySelectorAll('li')].filter((li) => li.querySelector('.gbc-checkbox'));
      return rows.filter((li) => li.querySelectorAll('.gbc-checkbox').length > 1).length;
    })()
  `);
  check('no row has duplicate checkboxes', rowsWithDuplicates === 0, `${rowsWithDuplicates} rows`);

  const forkUpstreamSelected = await evaluate(tab, `
    (() => {
      const specs = [...document.querySelectorAll('.gbc-checkbox')].map((c) => c.dataset.gbcSpec.toLowerCase());
      // The fork's upstream repository must not appear as its own candidate.
      return specs.filter((s) => s === 'saya-ch/dsh-mobile').length;
    })()
  `);
  check('fork upstream link is not a candidate', forkUpstreamSelected === 0, `${forkUpstreamSelected} found`);

  const toolbar = await evaluate(tab, 'Boolean(document.getElementById("gbc-toolbar"))');
  check('toolbar rendered', toolbar === true);

  // Select all, then read the state the popup would see.
  await evaluate(tab, 'document.querySelector(\'[data-gbc-action="select-all"]\').click()');
  await sleep(300);
  const afterSelectAll = await evaluate(tab, 'document.querySelectorAll(".gbc-checkbox:checked").length');
  check('select all checks every box', afterSelectAll === checkboxCount, `${afterSelectAll}/${checkboxCount}`);

  await evaluate(tab, 'document.querySelector(\'[data-gbc-action="clear"]\').click()');
  await sleep(300);
  const afterClear = await evaluate(tab, 'document.querySelectorAll(".gbc-checkbox:checked").length');
  check('clear unchecks every box', afterClear === 0, `${afterClear} checked`);

  // Re-scan must not duplicate checkboxes.
  await evaluate(tab, 'window.dispatchEvent(new Event("popstate"))');
  await sleep(600);
  const afterRescan = await evaluate(tab, 'document.querySelectorAll(".gbc-checkbox").length');
  check('rescan does not duplicate checkboxes', afterRescan === checkboxCount, `${afterRescan} vs ${checkboxCount}`);

  // --------------------------------------------------------------- real clone
  if (CLONE_ROOT) {
    const specs = await evaluate(tab,
      'Array.from(document.querySelectorAll(".gbc-checkbox")).slice(0,2).map(c=>c.dataset.gbcSpec)');
    check('candidate specs are owner/repo', Array.isArray(specs) && specs.every((s) => /^[^/]+\/[^/]+$/.test(s)),
      JSON.stringify(specs));

    if (Array.isArray(specs) && specs.length > 0) {
      const run = await evaluate(sw,
        `chrome.runtime.sendMessage({type:"gbc:startClone",repositories:${JSON.stringify(specs)}})`);
      check('startClone accepted', Boolean(run && run.status), JSON.stringify(run && run.status));

      // Poll until the run finishes.
      let state = null;
      for (let i = 0; i < 120; i++) {
        await sleep(1000);
        state = await evaluate(sw, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
        if (state && state.status !== 'running') break;
      }
      check('clone run finished', state && state.status === 'done', JSON.stringify(state && state.status));
      if (state && state.results) {
        for (const result of state.results) {
          console.log(`      ${result.status.padEnd(8)} ${result.repository} -> ${result.path || ''} ${result.message || ''}`);
        }
        check('every repository reported a status',
          state.results.length === specs.length &&
          state.results.every((r) => ['success', 'skipped', 'failed'].includes(r.status)),
          `${state.results.length}/${specs.length}`);
        check('no secret leaked in results',
          !JSON.stringify(state.results).match(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/),
          'scanned');
      }
    }
  }

  tab.close();
  sw.close();
  finish();
}

function finish() {
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
