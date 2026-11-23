/**
 * Popup: shows the selection made on the page, the clone destination, and the
 * per-repository results streamed from the service worker.
 */
(function () {
  'use strict';

  const elements = {
    hostStatus: document.getElementById('host-status'),
    rootInput: document.getElementById('root-input'),
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

  /** Selected specs reported by the content script. */
  let selected = [];
  /** Whether the active tab is a supported GitHub listing page. */
  let supported = false;
  /** Latest run state from the service worker. */
  let runState = { status: 'idle', total: 0, completed: 0, results: [], summary: null, error: null };

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
      elements.progress.textContent = completed + ' / ' + total;
    } else if (status === 'done' && summary) {
      elements.progress.textContent = total + ' 件完了';
    } else if (status === 'error') {
      elements.progress.textContent = '';
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
        strong(String(summary.success)),
        ' / スキップ ',
        strong(String(summary.skipped)),
        ' / 失敗 ',
        strong(String(summary.failed))
      );
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

  function renderHostStatus(state) {
    elements.hostStatus.className = 'badge';
    if (state.ok) {
      elements.hostStatus.classList.add('badge-ok');
      elements.hostStatus.textContent = '接続 OK';
      elements.hostStatus.title = state.version ? 'ホスト v' + state.version : '接続済み';
    } else {
      elements.hostStatus.classList.add('badge-error');
      elements.hostStatus.textContent = '未接続';
      elements.hostStatus.title = state.message || '';
    }
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
    renderHostStatus(result || { ok: false, message: '状態を取得できません' });
  }

  // --------------------------------------------------------------- actions

  elements.saveRoot.addEventListener('click', async () => {
    const root = elements.rootInput.value.trim();
    const result = await sendToWorker({ type: 'gbc:saveSettings', settings: { root } });
    if (result && result.error) {
      setHint(elements.rootHint, result.error, true);
      return;
    }
    elements.rootInput.value = result.root;
    setHint(elements.rootHint, '保存しました: ' + result.root, false);
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
        total: selected.length,
        completed: 0,
        results: [],
        summary: null,
        error: result.error
      };
      renderRun();
      return;
    }
    if (result) {
      runState = result;
      renderRun();
    }
  });

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
