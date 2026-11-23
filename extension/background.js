/**
 * Service worker: owns the Native Messaging connection to the Go host and
 * relays progress to the popup.
 *
 * The popup can close at any time, so the clone run is owned here. MV3 workers
 * are also terminated when idle, so the last finished run is mirrored into
 * chrome.storage.session and restored on the next start; the popup then still
 * shows the previous results.
 */

const HOST_NAME = 'com.tonbiattack.github_bulk_cloner';
const DEFAULT_ROOT = 'C:\\apps';
const MAX_REPOSITORIES = 200;
const RUN_STATE_KEY = 'lastRun';

/** In-memory state for the active run. */
let runState = {
  status: 'idle', // idle | running | done | error
  kind: 'clone',
  requestId: null,
  total: 0,
  completed: 0,
  results: [],
  summary: null,
  error: null
};

/** The live port, if a run is in progress. */
let port = null;

/** Set once the persisted state has been read, so it cannot clobber a new run. */
let restored = false;

/**
 * Restores the last finished run. A run that was still marked running when the
 * worker died is reported as interrupted rather than left hanging.
 */
async function restoreRunState() {
  if (restored) return;
  restored = true;

  try {
    const stored = await chrome.storage.session.get(RUN_STATE_KEY);
    const saved = stored[RUN_STATE_KEY];
    if (!saved || typeof saved !== 'object') return;
    // Never overwrite a run that started before the restore finished.
    if (runState.status === 'running') return;

    if (saved.status === 'running') {
      runState = {
        ...saved,
        status: 'error',
        error: '実行中に拡張のバックグラウンドが停止しました。結果を確認して再実行してください。'
      };
    } else {
      runState = saved;
    }
  } catch {
    // storage.session may be unavailable; in-memory state still works.
  }
}

/** Mirrors the current state so it survives a worker restart. */
async function persistRunState() {
  try {
    await chrome.storage.session.set({ [RUN_STATE_KEY]: runState });
  } catch {
    // Persistence is best-effort.
  }
}

// ------------------------------------------------------------------ storage

async function getSettings() {
  const stored = await chrome.storage.local.get({ root: DEFAULT_ROOT, layout: 'flat' });
  const root = typeof stored.root === 'string' && stored.root.trim() !== ''
    ? stored.root
    : DEFAULT_ROOT;
  const layout = stored.layout === 'owner' ? 'owner' : 'flat';
  return { root, layout };
}

async function saveSettings(settings) {
  const root = typeof settings.root === 'string' ? settings.root.trim() : '';
  if (root === '') {
    throw new Error('保存先を入力してください');
  }
  const layout = settings.layout === 'owner' ? 'owner' : 'flat';
  await chrome.storage.local.set({ root, layout });
  return { root, layout };
}

// -------------------------------------------------------------- run helpers

function snapshot() {
  return {
    status: runState.status,
    kind: runState.kind,
    requestId: runState.requestId,
    total: runState.total,
    completed: runState.completed,
    results: runState.results.slice(),
    summary: runState.summary,
    error: runState.error
  };
}

function broadcast() {
  const message = { type: 'gbc:runUpdate', state: snapshot() };

  // A closed popup makes this reject; that is expected.
  chrome.runtime.sendMessage(message).catch(() => {});

  // Content scripts are not reached by runtime.sendMessage, so notify the
  // GitHub tabs separately. This is what updates the per-row clone badges.
  chrome.tabs.query({ url: 'https://github.com/*' }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function resetRun(total, kind) {
  runState = {
    status: 'running',
    kind: kind || 'clone',
    requestId: createRequestId(),
    total,
    completed: 0,
    results: [],
    summary: null,
    error: null
  };
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function finishRun(status, error) {
  runState.status = status;
  if (error) runState.error = error;
  stopWatchdog();
  disconnectPort();
  persistRunState();
  broadcast();
}

/**
 * Watchdog for a run that never reports back.
 *
 * If the host dies without sending `done` and without a disconnect event, the
 * run would stay `running` forever and block the queue. Fail it instead.
 */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
let watchdogTimer = null;

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (runState.status !== 'running') return;
    finishRun('error', 'ネイティブホストから応答がありません。処理を中断しました。');
  }, RUN_TIMEOUT_MS);
}

function stopWatchdog() {
  if (watchdogTimer === null) return;
  clearTimeout(watchdogTimer);
  watchdogTimer = null;
}

function disconnectPort() {
  if (!port) return;
  try {
    port.disconnect();
  } catch {
    // Already gone.
  }
  port = null;
}

/** Maps a host error code to a message the user can act on. */
function describeHostError(code, message) {
  switch (code) {
    case 'invalid_root':
      return '保存先フォルダが使用できません。存在する絶対パスを指定してください。' +
        (message ? ' (' + message + ')' : '');
    case 'git_missing':
      return 'Git が見つかりません。Git for Windows をインストールし、PATH に追加してください。';
    case 'too_many_repositories':
      return '一度に選択できるのは ' + MAX_REPOSITORIES + ' 件までです。';
    case 'invalid_request':
      return 'リクエストが不正です。' + (message ? ' (' + message + ')' : '');
    case 'cancelled':
      return '処理が中断されました。';
    default:
      return message || 'ネイティブホストでエラーが発生しました。';
  }
}

/** Explains why connectNative failed. */
function describeConnectError(error) {
  const text = String(error && error.message ? error.message : error);
  if (/not found|Specified native messaging host/i.test(text)) {
    return 'ネイティブホストが登録されていません。installer の install.ps1 を実行してください。';
  }
  if (/forbidden|Access to the specified native messaging host is forbidden/i.test(text)) {
    return '拡張 ID がネイティブホストの allowed_origins と一致しません。installer を再実行してください。';
  }
  return 'ネイティブホストに接続できません: ' + text;
}

// -------------------------------------------------------------- run start

/**
 * Repositories waiting to be cloned, in the order they were requested.
 *
 * Checking several boxes in quick succession must not fail with "already
 * running", so clone requests are queued and drained one at a time. Each queue
 * entry is one request, so a multi-repository request stays a single run.
 */
const cloneQueue = [];
let drainingQueue = false;

/** Queues a clone request. */
function enqueueClone(repositories) {
  const specs = (Array.isArray(repositories) ? repositories : [])
    .filter((spec) => typeof spec === 'string' && spec.trim() !== '')
    .map((spec) => spec.trim());

  if (specs.length === 0) return;
  cloneQueue.push(specs);
  drainCloneQueue();
}

/** Runs queued clone requests one at a time until the queue is empty. */
async function drainCloneQueue() {
  if (drainingQueue) return;
  drainingQueue = true;

  try {
    while (cloneQueue.length > 0) {
      if (runState.status === 'running') {
        // Wait for the active run to finish before starting the next one.
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      const specs = cloneQueue.shift();
      try {
        await startRun('clone', specs);
      } catch {
        // A failed start is reported through the run state; keep draining.
      }
      // Wait for this run to settle before starting the next.
      while (runState.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } finally {
    drainingQueue = false;
  }
}

/**
 * Starts a native host run.
 *
 * @param {'clone'} kind
 * @param {string[]} repositories owner/repo specs.
 */
async function startRun(kind, repositories) {
  if (runState.status === 'running') {
    throw new Error('すでに実行中です');
  }

  const specs = Array.from(new Set(
    (Array.isArray(repositories) ? repositories : [])
      .filter((spec) => typeof spec === 'string' && spec.trim() !== '')
      .map((spec) => spec.trim())
  ));

  if (specs.length === 0) {
    throw new Error('リポジトリが選択されていません');
  }
  if (specs.length > MAX_REPOSITORIES) {
    throw new Error('一度に選択できるのは ' + MAX_REPOSITORIES + ' 件までです');
  }

  const { root, layout } = await getSettings();
  resetRun(specs.length, kind);
  await persistRunState();
  broadcast();
  startWatchdog();

  let connected;
  try {
    connected = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    finishRun('error', describeConnectError(error));
    return snapshot();
  }

  port = connected;

  connected.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'result':
        runState.results.push({
          repository: message.repository,
          status: message.status,
          path: message.path || '',
          message: message.message || '',
          method: message.method || '',
          existingGitRepo: message.existingGitRepo,
          existingRepository: message.existingRepository
        });
        runState.completed = runState.results.length;
        broadcast();
        break;

      case 'done':
        runState.summary = message.summary || summarize(runState.results);
        runState.total = runState.results.length;
        runState.completed = runState.results.length;
        finishRun('done', null);
        break;

      case 'error':
        finishRun('error', describeHostError(message.code, message.message));
        break;

      default:
        break;
    }
  });

  connected.onDisconnect.addListener((info) => {
    port = null;
    if (runState.status !== 'running') return;

    const reason = chrome.runtime.lastError
      ? chrome.runtime.lastError.message
      : (info && info.error ? info.error.message : '');

    // The host exits after `done`; a disconnect before that is a failure.
    if (runState.completed >= runState.total && runState.total > 0) {
      runState.summary = runState.summary || summarize(runState.results);
      finishRun('done', null);
      return;
    }
    finishRun('error', reason
      ? 'ネイティブホストとの接続が切れました: ' + reason
      : 'ネイティブホストとの接続が切れました。');
  });

  try {
    connected.postMessage({
      type: kind,
      requestId: runState.requestId,
      root,
      layout,
      repositories: specs
    });
  } catch (error) {
    finishRun('error', 'ネイティブホストへ送信できません: ' + String(error && error.message ? error.message : error));
  }

  return snapshot();
}

/** Starts a clone run. */
function startClone(repositories) {
  return startRun('clone', repositories);
}

function summarize(results) {
  const summary = { success: 0, skipped: 0, failed: 0, conflict: 0 };
  for (const result of results) {
    if (result.status === 'success') summary.success++;
    else if (result.status === 'skipped') summary.skipped++;
    else if (result.status === 'conflict') summary.conflict++;
    else summary.failed++;
  }
  return summary;
}

/**
 * Checks that the host is installed, reachable, and usable.
 *
 * Returns a structured state rather than a bare ok flag, so the popup can tell
 * "not registered" from "installed but git is missing" from "no response".
 * Only facts the host actually reports are included; nothing about Windows or
 * Git is guessed in the browser.
 *
 * @returns {Promise<{state: string, message: string, version?: string,
 *   capabilities?: object}>}
 */
async function checkHost() {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let probe;
    try {
      probe = chrome.runtime.connectNative(HOST_NAME);
    } catch (error) {
      settle(classifyConnectError(error));
      return;
    }

    const timer = setTimeout(() => {
      try { probe.disconnect(); } catch { /* ignore */ }
      settle({
        state: 'unresponsive',
        message: 'ネイティブホストから応答がありません。ホストの実行に失敗している可能性があります。'
      });
    }, 5000);

    probe.onMessage.addListener((message) => {
      if (!message || message.type !== 'pong') return;

      clearTimeout(timer);
      try { probe.disconnect(); } catch { /* ignore */ }

      const version = message.version || '';
      const capabilities = message.capabilities || {
        gitAvailable: false, ghAvailable: false, ghAuthenticated: false, os: '', arch: ''
      };

      if (!capabilities.gitAvailable) {
        settle({
          state: 'git-missing',
          message: 'ネイティブホストは動いていますが、Git が見つかりません。',
          version,
          capabilities
        });
        return;
      }

      settle({ state: 'ok', message: '接続 OK', version, capabilities });
    });

    probe.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      settle(classifyConnectError(reason || 'host disconnected'));
    });

    try {
      probe.postMessage({ type: 'ping' });
    } catch (error) {
      clearTimeout(timer);
      settle(classifyConnectError(error));
    }
  });
}

/** Turns a connectNative failure into a diagnostic state. */
function classifyConnectError(error) {
  const text = String(error && error.message ? error.message : error);

  // Chrome reports the same "host not found" error both when nothing is
  // registered and when the registration does not allow this extension ID.
  // Do not pretend to tell them apart.
  if (/not found|Specified native messaging host/i.test(text)) {
    return {
      state: 'not-registered',
      message: 'ネイティブホストが登録されていないか、この拡張 ID 用に登録されていません。'
    };
  }
  if (/forbidden|Access to the specified native messaging host is forbidden/i.test(text)) {
    return {
      state: 'not-registered',
      message: 'ネイティブホストがこの拡張 ID 用に登録されていません。'
    };
  }
  return {
    state: 'error',
    message: 'ネイティブホストに接続できません: ' + text
  };
}

/** The setup steps shown when the host is not usable. */
function setupGuidance(state) {
  switch (state) {
    case 'not-registered':
      return 'セットアップしてください。ストア版は installer\\setup.ps1、開発版は ' +
        'installer\\install.ps1 -ExtensionId <拡張ID> を実行します。手順は docs/setup.md にあります。';
    case 'git-missing':
      return 'Git for Windows をインストールし、PATH に追加してから拡張を再確認してください。';
    case 'unresponsive':
      return 'ホストの実行ファイルが壊れている可能性があります。installer\\setup.ps1 -Repair で再インストールしてください。';
    default:
      return '';
  }
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'gbc:getSettings':
      getSettings().then(sendResponse).catch((error) => sendResponse({ error: String(error) }));
      return true;

    case 'gbc:saveSettings':
      saveSettings(message.settings || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
      return true;

    case 'gbc:startClone':
      // Queue the request so rapid checkbox clicks are serialised rather than
      // rejected with "already running".
      enqueueClone(message.repositories);
      sendResponse({ status: 'queued', kind: 'clone' });
      return false;

    case 'gbc:getRunState':
      restoreRunState()
        .then(() => sendResponse(snapshot()))
        .catch(() => sendResponse(snapshot()));
      return true;

    case 'gbc:checkHost':
      checkHost().then((result) => {
        // Attach the setup steps the popup should show for this state.
        sendResponse({ ...result, setup: setupGuidance(result.state) });
      });
      return true;

    case 'gbc:selectionChanged':
      // The popup listens directly; nothing to do here.
      return false;

    default:
      return false;
  }
});
