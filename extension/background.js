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
  kind: 'clone', // clone | pull
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
  const stored = await chrome.storage.local.get({ root: DEFAULT_ROOT });
  const root = typeof stored.root === 'string' && stored.root.trim() !== ''
    ? stored.root
    : DEFAULT_ROOT;
  return { root };
}

async function saveSettings(settings) {
  const root = typeof settings.root === 'string' ? settings.root.trim() : '';
  if (root === '') {
    throw new Error('保存先を入力してください');
  }
  await chrome.storage.local.set({ root });
  return { root };
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
  // A closed popup makes this reject; that is expected.
  chrome.runtime.sendMessage({ type: 'gbc:runUpdate', state: snapshot() }).catch(() => {});
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
  disconnectPort();
  persistRunState();
  broadcast();
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
    case 'nothing_to_pull':
      return '保存先に Git リポジトリが見つかりませんでした。先に clone してください。';
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
 * Starts a native host run.
 *
 * @param {'clone'|'pull'} kind
 * @param {string[]} repositories owner/repo specs. For pull, an empty array
 *   means "every repository under the root".
 */
async function startRun(kind, repositories) {
  if (runState.status === 'running') {
    throw new Error('すでに実行中です');
  }

  const isPull = kind === 'pull';
  const specs = Array.from(new Set(
    (Array.isArray(repositories) ? repositories : [])
      .filter((spec) => typeof spec === 'string' && spec.trim() !== '')
      .map((spec) => spec.trim())
  ));

  if (!isPull && specs.length === 0) {
    throw new Error('リポジトリが選択されていません');
  }
  if (specs.length > MAX_REPOSITORIES) {
    throw new Error('一度に選択できるのは ' + MAX_REPOSITORIES + ' 件までです');
  }

  const { root } = await getSettings();
  resetRun(isPull ? 0 : specs.length, kind);
  await persistRunState();
  broadcast();

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
          existingGitRepo: message.existingGitRepo
        });
        runState.completed = runState.results.length;
        // A pull discovers its own targets, so the total grows as results
        // arrive until the done frame fixes it.
        if (runState.kind === 'pull') runState.total = runState.results.length;
        broadcast();
        break;

      case 'done':
        runState.summary = message.summary || summarize(runState.results, runState.kind);
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
      runState.summary = runState.summary || summarize(runState.results, runState.kind);
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

/** Starts a pull run. An empty list means every repository under the root. */
function startPull(repositories) {
  return startRun('pull', repositories);
}

function summarize(results, kind) {
  if (kind === 'pull') {
    const summary = { updated: 0, upToDate: 0, failed: 0 };
    for (const result of results) {
      if (result.status === 'updated') summary.updated++;
      else if (result.status === 'up-to-date') summary.upToDate++;
      else summary.failed++;
    }
    return summary;
  }

  const summary = { success: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    if (result.status === 'success') summary.success++;
    else if (result.status === 'skipped') summary.skipped++;
    else summary.failed++;
  }
  return summary;
}

/** Checks that the host is installed and answers a ping. */
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
      settle({ ok: false, message: describeConnectError(error) });
      return;
    }

    const timer = setTimeout(() => {
      try { probe.disconnect(); } catch { /* ignore */ }
      settle({ ok: false, message: 'ネイティブホストから応答がありません。' });
    }, 5000);

    probe.onMessage.addListener((message) => {
      if (message && message.type === 'pong') {
        clearTimeout(timer);
        try { probe.disconnect(); } catch { /* ignore */ }
        settle({ ok: true, version: message.version || '' });
      }
    });

    probe.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
      settle({ ok: false, message: describeConnectError(reason || 'host disconnected') });
    });

    try {
      probe.postMessage({ type: 'ping' });
    } catch (error) {
      clearTimeout(timer);
      settle({ ok: false, message: describeConnectError(error) });
    }
  });
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
      startClone(message.repositories)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
      return true;

    case 'gbc:startPull':
      startPull(message.repositories)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
      return true;

    case 'gbc:getRunState':
      restoreRunState()
        .then(() => sendResponse(snapshot()))
        .catch(() => sendResponse(snapshot()));
      return true;

    case 'gbc:checkHost':
      checkHost().then(sendResponse);
      return true;

    case 'gbc:selectionChanged':
      // The popup listens directly; nothing to do here.
      return false;

    default:
      return false;
  }
});
