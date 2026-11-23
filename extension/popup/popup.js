/**
 * Popup: shows the selection made on the page, the clone destination, and the
 * per-repository results streamed from the service worker.
 */
(function () {
  'use strict';

  const elements = {
    hostStatus: document.getElementById('host-status'),
    hostSection: document.getElementById('host-section'),
    hostDetail: document.getElementById('host-detail'),
    hostCapabilities: document.getElementById('host-capabilities'),
    hostSetup: document.getElementById('host-setup'),
    hostRecheck: document.getElementById('host-recheck'),
    rootInput: document.getElementById('root-input'),
    ownerLayout: document.getElementById('owner-layout'),
    saveRoot: document.getElementById('save-root'),
    rootHint: document.getElementById('root-hint'),
    selectionCount: document.getElementById('selection-count'),
    selectionList: document.getElementById('selection-list'),
    selectionEmpty: document.getElementById('selection-empty'),
    refresh: document.getElementById('refresh'),
    clear: document.getElementById('clear'),
    clone: document.getElementById('clone'),
    cloneHint: document.getElementById('clone-hint'),
    progress: document.getElementById('progress'),
    summary: document.getElementById('summary'),
    resultList: document.getElementById('result-list'),
    resultEmpty: document.getElementById('result-empty')
  };

  /** Latest host diagnostic result from the service worker. */
  let hostState = { state: 'unknown', message: '', setup: '' };

  /** Selected specs reported by the content script. */
  let selected = [];
  /** Whether the active tab is a supported GitHub listing page. */
  let supported = false;
  /** Latest run state from the service worker. */
  let runState = {
    status: 'idle',
    kind: 'clone',
    total: 0,
    completed: 0,
    results: [],
    summary: null,
    error: null
  };

  // ------------------------------------------------------------- utilities

  function sendToWorker(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function sendToTab(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message).catch(() => null);
  }

  function setHint(element, text, isError) {
    element.textContent = text || '';
    element.classList.toggle('error', Boolean(isError));
  }

  function statusLabel(status) {
    switch (status) {
      case 'success': return '成功';
      case 'skipped': return 'スキップ';
      case 'conflict': return '衝突';
      case 'failed': return '失敗';
      default: return status;
    }
  }

  // -------------------------------------------------------------- rendering

  function renderSelection() {
    elements.selectionList.replaceChildren();
    elements.selectionCount.textContent = selected.length + ' 件';

    for (const spec of selected) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = spec;
      item.appendChild(name);
      elements.selectionList.appendChild(item);
    }

    const hasSelection = selected.length > 0;
    elements.selectionEmpty.hidden = hasSelection;
    elements.clear.disabled = !hasSelection;
    updateCloneButton();
  }

  function updateCloneButton() {
    const running = runState.status === 'running';
    elements.clone.disabled = running || selected.length === 0 || !supported;

    if (running) {
      setHint(elements.cloneHint, '実行中です…', false);
    } else if (!supported) {
      setHint(elements.cloneHint, 'GitHub のリポジトリ一覧ページを開いてください。', false);
    } else if (selected.length === 0) {
      setHint(elements.cloneHint, 'リポジトリを選択してください。', false);
    } else {
      setHint(elements.cloneHint, selected.length + ' 件を clone します。', false);
    }
  }

  function renderRun() {
    const { status, total, completed, results, summary, error } = runState;

    if (status === 'running') {
      elements.progress.textContent = total > 0
        ? completed + ' / ' + total
        : completed + ' 件処理中';
    } else if (status === 'done' && summary) {
      elements.progress.textContent = results.length + ' 件完了';
    } else {
      elements.progress.textContent = '';
    }

    if (status === 'error' && error) {
      elements.summary.hidden = false;
      elements.summary.replaceChildren();
      const message = document.createElement('div');
      message.textContent = error;
      message.style.color = 'var(--failed)';
      elements.summary.appendChild(message);
    } else if (status === 'done' && summary) {
      elements.summary.hidden = false;
      elements.summary.replaceChildren();
      const line = document.createElement('div');
      line.append(
        '成功 ',
        strong(String(summary.success || 0)),
        ' / スキップ ',
        strong(String(summary.skipped || 0)),
        ' / 失敗 ',
        strong(String(summary.failed || 0))
      );
      if (summary.conflict) {
        line.append(' / 衝突 ', strong(String(summary.conflict)));
      }
      elements.summary.appendChild(line);
    } else {
      elements.summary.hidden = true;
      elements.summary.replaceChildren();
    }

    elements.resultList.replaceChildren();
    for (const result of results) {
      elements.resultList.appendChild(renderResult(result));
    }
    elements.resultEmpty.hidden = results.length > 0;
    updateCloneButton();
  }

  function strong(text) {
    const element = document.createElement('strong');
    element.textContent = text;
    return element;
  }

  function renderResult(result) {
    const item = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'result-head';

    const repo = document.createElement('span');
    repo.className = 'result-repo';
    repo.textContent = result.repository;

    const badge = document.createElement('span');
    badge.className = 'status status-' + result.status;
    badge.textContent = statusLabel(result.status);

    head.append(repo, badge);
    item.appendChild(head);

    if (result.path) {
      const path = document.createElement('div');
      path.className = 'result-path';
      path.textContent = result.path;
      item.appendChild(path);
    }

    if (result.message) {
      const message = document.createElement('div');
      message.className = 'result-message';
      message.textContent = result.message;
      item.appendChild(message);
    }

    return item;
  }

  /** Badge label and tone for each host state. */
  const HOST_BADGES = {
    ok: { label: '接続 OK', tone: 'ok' },
    'not-registered': { label: '未登録', tone: 'error' },
    'git-missing': { label: 'Git なし', tone: 'warn' },
    unresponsive: { label: '応答なし', tone: 'error' },
    error: { label: '接続エラー', tone: 'error' },
    unknown: { label: '未確認', tone: 'unknown' }
  };

  function renderHostStatus(state) {
    hostState = state || { state: 'unknown', message: '', setup: '' };

    const badge = HOST_BADGES[hostState.state] || HOST_BADGES.unknown;
    elements.hostStatus.className = 'badge badge-' + badge.tone;
    elements.hostStatus.textContent = badge.label;
    elements.hostStatus.title = hostState.message || '';

    // The detail panel only appears when something needs attention.
    const needsAttention = hostState.state !== 'ok' && hostState.state !== 'unknown';
    elements.hostSection.hidden = !needsAttention;
    if (!needsAttention) return;

    elements.hostDetail.textContent = hostState.message || '';
    elements.hostDetail.classList.toggle('error', badge.tone === 'error');

    elements.hostSetup.hidden = !hostState.setup;
    elements.hostSetup.textContent = hostState.setup || '';

    renderCapabilities(hostState.capabilities);
  }

  /** Lists what the host reported. Never shows anything it did not report. */
  function renderCapabilities(capabilities) {
    elements.hostCapabilities.replaceChildren();

    if (!capabilities) {
      elements.hostCapabilities.hidden = true;
      return;
    }

    const rows = [];
    if (capabilities.os) {
      rows.push(['OS', capabilities.os + (capabilities.arch ? ' / ' + capabilities.arch : '')]);
    }
    rows.push(['Git', capabilities.gitAvailable ? '利用可能' : '見つかりません']);
    if (capabilities.ghAvailable) {
      rows.push(['gh', capabilities.ghAuthenticated ? '認証済み' : '未認証']);
    } else {
      rows.push(['gh', '未インストール']);
    }

    for (const [label, value] of rows) {
      const item = document.createElement('li');
      const key = document.createElement('span');
      key.className = 'capability-label';
      key.textContent = label;
      const text = document.createElement('span');
      text.textContent = value;
      item.append(key, text);
      elements.hostCapabilities.appendChild(item);
    }

    elements.hostCapabilities.hidden = false;
  }

  // ------------------------------------------------------------------ load

  async function loadSelection() {
    const tab = await activeTab();
    if (!tab || typeof tab.id !== 'number') {
      supported = false;
      selected = [];
      renderSelection();
      return;
    }

    const state = await sendToTab(tab.id, { type: 'gbc:getState' });
    if (!state) {
      // No content script: not a GitHub page, or the extension was just loaded.
      supported = false;
      selected = [];
      renderSelection();
      return;
    }

    supported = Boolean(state.supported);
    selected = Array.isArray(state.selected) ? state.selected : [];
    renderSelection();
  }

  async function loadSettings() {
    const settings = await sendToWorker({ type: 'gbc:getSettings' });
    if (settings && typeof settings.root === 'string') {
      elements.rootInput.value = settings.root;
    }
    if (settings) {
      elements.ownerLayout.checked = settings.layout === 'owner';
      updateLayoutHint();
    }
  }

  /** Keeps the layout hint in step with the checkbox. */
  function updateLayoutHint() {
    if (elements.ownerLayout.checked) {
      setHint(elements.rootHint,
        '各リポジトリは <保存先>\\<owner>\\<repo> に clone されます。同名リポジトリを所有者ごとに分けられます。', false);
    } else {
      setHint(elements.rootHint,
        '各リポジトリは <保存先>\\<repo> に clone されます。フォルダが無ければ自動作成します。', false);
    }
  }

  async function loadRunState() {
    const state = await sendToWorker({ type: 'gbc:getRunState' });
    if (state) {
      runState = state;
      renderRun();
    }
  }

  async function checkHost() {
    const result = await sendToWorker({ type: 'gbc:checkHost' });
    renderHostStatus(result || { state: 'error', message: '状態を取得できません' });
  }

  // --------------------------------------------------------------- actions

  async function saveSettings() {
    const root = elements.rootInput.value.trim();
    const layout = elements.ownerLayout.checked ? 'owner' : 'flat';
    const result = await sendToWorker({ type: 'gbc:saveSettings', settings: { root, layout } });
    if (result && result.error) {
      setHint(elements.rootHint, result.error, true);
      return;
    }
    elements.rootInput.value = result.root;
    elements.ownerLayout.checked = result.layout === 'owner';
    setHint(elements.rootHint, '保存しました: ' + result.root, false);
    updateLayoutHint();
  }

  elements.saveRoot.addEventListener('click', saveSettings);

  elements.ownerLayout.addEventListener('change', () => {
    updateLayoutHint();
    saveSettings();
  });

  elements.hostRecheck.addEventListener('click', () => {
    elements.hostStatus.textContent = '確認中…';
    checkHost();
  });

  elements.rootInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.saveRoot.click();
    }
  });

  elements.refresh.addEventListener('click', async () => {
    await loadSelection();
    await loadRunState();
  });

  elements.clear.addEventListener('click', async () => {
    const tab = await activeTab();
    if (tab && typeof tab.id === 'number') {
      await sendToTab(tab.id, { type: 'gbc:clearSelection' });
    }
    selected = [];
    renderSelection();
  });

  elements.clone.addEventListener('click', async () => {
    if (selected.length === 0) return;

    elements.clone.disabled = true;
    const result = await sendToWorker({ type: 'gbc:startClone', repositories: selected });
    if (result && result.error) {
      runState = {
        status: 'error',
        kind: 'clone',
        total: selected.length,
        completed: 0,
        results: [],
        summary: null,
        error: result.error
      };
      renderRun();
      return;
    }
    // The worker queues the request; the run state arrives via gbc:runUpdate.
  });

  // Clones are also started by the content script when a checkbox is checked,
  // so the popup only displays their progress and results.

  // The service worker pushes progress while the popup is open.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'gbc:runUpdate') return false;
    runState = message.state;
    renderRun();
    return false;
  });

  // ------------------------------------------------------------- bootstrap

  (async function init() {
    renderSelection();
    renderRun();
    await Promise.all([loadSettings(), loadSelection(), loadRunState()]);
    checkHost();
  })();
})();
