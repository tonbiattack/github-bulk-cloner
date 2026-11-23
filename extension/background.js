/**
 * Service worker: owns the Native Messaging connection to the Go host and
 * relays progress to the popup.
 *
 * The popup can close at any time, so the clone run is owned here and its state
 * is kept in memory plus chrome.storage.session. The popup re-subscribes on
 * open and receives the current snapshot.
 */

const HOST_NAME = 'com.tonbiattack.github_bulk_cloner';
const DEFAULT_ROOT = 'C:\\apps';
const MAX_REPOSITORIES = 200;

/** In-memory state for the active run. */
let runState = {
  status: 'idle', // idle | running | done | error
  requestId: null,
  total: 0,
  completed: 0,
  results: [],
  summary: null,
  error: null
};

/** The live port, if a run is in progress. */
let port = null;

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

function resetRun(total) {
  runState = {
    status: 'running',
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

// -------------------------------------------------------------- clone start

async function startClone(repositories) {
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

  const { root } = await getSettings();
  resetRun(specs.length);
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
        broadcast();
        break;

      case 'done':
        runState.summary = message.summary || summarize(runState.results);
        runState.completed = runState.total;
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
      type: 'clone',
      requestId: runState.requestId,
      root,
      repositories: specs
    });
  } catch (error) {
    finishRun('error', 'ネイティブホストへ送信できません: ' + String(error && error.message ? error.message : error));
  }

  return snapshot();
}

function summarize(results) {
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

    case 'gbc:getRunState':
      sendResponse(snapshot());
      return false;

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
