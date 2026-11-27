'use strict';

/**
 * Compatibility check with GitHub Repo Sorter.
 *
 * Both extensions run on the same GitHub listing page. Repo Sorter hides
 * GitHub's native list and renders its own `[data-grs-list]`, so this test
 * verifies that checkboxes always land on the list the user can actually see:
 *
 *   1. with a custom sort active, checkboxes are inside `[data-grs-list]`
 *   2. no checkbox is left in the hidden `#user-repositories-list`
 *   3. switching to GitHub's standard view moves them back to the native list
 *   4. switching back re-attaches them without duplicates
 *   5. paging keeps exactly one checkbox per visible row
 *
 * Chrome must already be running with both unpacked extensions loaded, for
 * example:
 *   chrome --user-data-dir=<temp> --remote-debugging-port=9335 \
 *     --disable-extensions-except=<sorter>,<cloner> --load-extension=<sorter>,<cloner>
 *
 * Usage: node extension/test/cdp-sorter-compat.js [githubUrl]
 */

const CDP_PORT = process.env.CDP_PORT || '9334';
const GITHUB_URL = process.argv[2] || 'https://github.com/tonbiattack?tab=repositories';

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
      const message = JSON.parse(String(event.data));
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(JSON.stringify(message.error)));
      else res(message.result);
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
const skips = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/** Snapshot of how the two extensions currently share the page. */
const SNAPSHOT = `(() => {
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const nativeList = document.querySelector('#user-repositories-list');
  const sorterList = document.querySelector('[data-grs-list]');
  const boxes = [...document.querySelectorAll('.gbc-checkbox')];
  return {
    sorterRows: document.querySelectorAll('[data-grs-list] .grs-repo').length,
    nativeHidden: nativeList ? nativeList.getAttribute('data-grs-hidden') === 'true' : false,
    nativeVisible: visible(nativeList),
    sorterVisible: visible(sorterList),
    boxes: boxes.length,
    boxesVisible: boxes.filter(visible).length,
    boxesInNative: nativeList ? nativeList.querySelectorAll('.gbc-checkbox').length : 0,
    boxesInSorter: sorterList ? sorterList.querySelectorAll('.gbc-checkbox').length : 0,
    rowsWithBoxes: [...document.querySelectorAll('.grs-repo, #user-repositories-list li')]
      .filter((row) => row.querySelector('.gbc-checkbox')).length,
    toolbar: document.getElementById('gbc-toolbar')?.textContent ?? null,
    sorterStatus: document.querySelector('[data-grs-status]')?.textContent ?? '',
    sorterError: document.querySelector('[data-grs-status]')?.classList.contains('grs-status--error') ?? false
  };
})()`;

async function waitFor(tab, expression, description, tries = 60) {
  let value = null;
  for (let i = 0; i < tries; i++) {
    value = await evaluate(tab, expression);
    if (value) return value;
    await sleep(500);
  }
  throw new Error('timed out waiting for ' + description);
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target; start Chrome with a page first');

  const tab = await connect(page.webSocketDebuggerUrl);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url: GITHUB_URL });

  // Wait until Repo Sorter has replaced the list and Bulk Cloner has scanned it.
  await waitFor(tab, `(() => {
    const rows = document.querySelectorAll('[data-grs-list] .grs-repo').length;
    const boxes = document.querySelectorAll('[data-grs-list] .gbc-checkbox').length;
    return rows > 0 && boxes > 0;
  })()`, 'sorter list with checkboxes');

  let state = await evaluate(tab, SNAPSHOT);
  check('sorter list is visible', state.sorterRows > 0 && state.sorterVisible, `${state.sorterRows} rows`);
  check('native list is hidden while sorting', state.nativeHidden && !state.nativeVisible);
  check('checkboxes are attached to the visible sorter list', state.boxesInSorter > 0,
    `${state.boxesInSorter}/${state.boxes}`);
  check('no checkbox is left in the hidden native list', state.boxesInNative === 0,
    `${state.boxesInNative} in native`);
  check('every checkbox is visible', state.boxesVisible === state.boxes,
    `${state.boxesVisible}/${state.boxes}`);
  check('checkbox count matches the visible rows', state.boxes === state.sorterRows,
    `${state.boxes} vs ${state.sorterRows}`);
  check('exactly one checkbox per visible row', state.rowsWithBoxes === state.sorterRows,
    `${state.rowsWithBoxes} rows with a checkbox`);
  const toolbarCount = Number((/\/\s*(\d+)\s*件選択/.exec(String(state.toolbar)) || [])[1]);
  check('toolbar counts the visible candidates', toolbarCount === state.boxes, String(state.toolbar));

  // Checking a box must work: it marks the row and requests a clone.
  await evaluate(tab, `document.querySelector('[data-grs-list] .gbc-checkbox').click()`);
  await sleep(400);
  const afterClick = await evaluate(tab, `(() => ({
    checked: document.querySelectorAll('[data-grs-list] .gbc-checkbox:checked').length,
    selectedRows: document.querySelectorAll('[data-grs-list] .gbc-selected').length
  }))()`);
  check('clicking a checkbox selects the row', afterClick.checked >= 1 && afterClick.selectedRows >= 1,
    JSON.stringify(afterClick));

  // Paging: the next page must also get one checkbox per row.
  await evaluate(tab, `document.querySelector('[data-grs-page="next"]')?.scrollIntoView({block:'center'})`);
  await sleep(300);
  await evaluate(tab, `document.querySelector('[data-grs-page="next"]')?.click()`);
  await sleep(1500);
  state = await evaluate(tab, SNAPSHOT);
  check('paging keeps one checkbox per visible row', state.boxes === state.sorterRows && state.sorterRows > 0,
    `${state.boxes} boxes for ${state.sorterRows} rows`);

  // Standard view: Bulk Cloner must move to GitHub's own list.
  await evaluate(tab, `document.querySelector('[data-grs-action="standard"]')?.click()`);
  await sleep(1200);
  state = await evaluate(tab, SNAPSHOT);
  check('standard view shows the native list', state.nativeVisible && !state.nativeHidden);
  check('checkboxes move to the native list in standard view', state.boxesInNative > 0,
    `${state.boxesInNative} in native, ${state.boxesInSorter} in sorter`);
  check('no checkbox stays in the removed sorter list', state.boxesInSorter === 0);
  check('every checkbox is visible in standard view', state.boxesVisible === state.boxes,
    `${state.boxesVisible}/${state.boxes}`);

  // Back to a custom sort: checkboxes must follow and not duplicate.
  // Repo Sorter clears its data when returning to the standard view, so this
  // step refetches from GitHub. Skip the assertions if the API is unavailable
  // (for example the unauthenticated rate limit) rather than blaming the fix.
  await evaluate(tab, `(() => {
    const summary = document.querySelector('#sort-options summary');
    if (summary) summary.click();
    document.querySelector('[data-grs-sort="pushed"]')?.click();
  })()`);
  let restored = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    restored = await evaluate(tab, SNAPSHOT);
    if (restored.sorterRows > 0 || restored.sorterError) break;
  }
  if (restored && restored.sorterError) {
    skip('switching back to a custom sort',
      'GitHub API unavailable: ' + restored.sorterStatus.slice(0, 100));
  } else {
    state = restored;
    check('custom sort is active again', state.sorterRows > 0 && state.sorterVisible);
    check('checkboxes return to the sorter list', state.boxesInSorter > 0 && state.boxesInNative === 0,
      `${state.boxesInSorter} in sorter, ${state.boxesInNative} in native`);
    check('switching lists does not duplicate checkboxes', state.boxes === state.sorterRows,
      `${state.boxes} boxes for ${state.sorterRows} rows`);
  }

  tab.close();
  finish();
}

function skip(name, reason) {
  skips.push(name);
  console.log(`SKIP  ${name} — ${reason}`);
}

function finish() {
  const failed = checks.filter((item) => !item.ok);
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} checks passed` +
    (skips.length > 0 ? `, ${skips.length} skipped` : ''));
  if (failed.length > 0) {
    console.log('FAILED: ' + failed.map((item) => item.name).join(', '));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
