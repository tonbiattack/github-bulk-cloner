/**
 * Content script: detects repository links on GitHub listing pages, adds a
 * checkbox to each candidate, and keeps the selection in sync with the popup.
 *
 * The page is a single-page app that re-renders constantly, so every DOM write
 * is idempotent: a candidate is only ever given one checkbox, and a checkbox
 * that GitHub removed is re-created on the next scan.
 */
(function () {
  'use strict';

  const RepoUrl = globalThis.GBCRepoUrl;
  if (!RepoUrl) {
    console.warn('[GBC] repo-url.js was not loaded; content script disabled');
    return;
  }

  /** Containers that hold repository listings, most specific first. */
  const LIST_CONTAINERS = [
    '[data-testid="results-list"]',
    '#user-repositories-list',
    '#org-repositories-list',
    'div[data-testid="topic-repositories"]',
    'ul.repo-list',
    'div.repo-list',
    '[data-testid="repository-list"]'
  ];

  /** Fallback container when GitHub changes its markup. */
  const FALLBACK_CONTAINER = 'main';

  const CHECKBOX_CLASS = 'gbc-checkbox';
  const WRAPPER_CLASS = 'gbc-checkbox-wrapper';
  const SELECTED_CLASS = 'gbc-selected';
  const TOOLBAR_ID = 'gbc-toolbar';

  /** spec (lowercased) -> {candidate, checkbox, wrapper, anchor} */
  const entries = new Map();
  /** Lowercased specs the user has selected. */
  const selected = new Set();

  let scanScheduled = false;
  let observer = null;

  // ---------------------------------------------------------------- scanning

  /** Returns the anchors to consider, preferring known listing containers. */
  function candidateAnchors() {
    for (const selector of LIST_CONTAINERS) {
      const containers = document.querySelectorAll(selector);
      if (containers.length === 0) continue;

      const anchors = [];
      for (const container of containers) {
        anchors.push(...container.querySelectorAll('a[href]'));
      }
      if (anchors.length > 0) return anchors;
    }

    const fallback = document.querySelector(FALLBACK_CONTAINER);
    return fallback ? Array.from(fallback.querySelectorAll('a[href]')) : [];
  }

  /** Returns the row element that represents one repository entry. */
  function rowFor(anchor) {
    return anchor.closest('li, [role="listitem"], article, div.Box-row');
  }

  /**
   * Picks the primary repository link for a row.
   *
   * A row can contain more than one repository link: a fork shows
   * "Forked from <owner>/<repo>", which would otherwise become a second
   * candidate for the same row. The primary link is the one whose text is the
   * bare repository name; failing that, the first link in the row.
   */
  function primaryAnchor(anchors) {
    if (anchors.length <= 1) return anchors[0] || null;

    for (const anchor of anchors) {
      const candidate = RepoUrl.normalizeRepoUrl(anchor.getAttribute('href'), location.href);
      if (!candidate) continue;
      const text = (anchor.textContent || '').trim();
      if (text.toLowerCase() === candidate.repo.toLowerCase()) return anchor;
    }
    return anchors[0];
  }

  /** Builds the checkbox element for one candidate. */
  function createCheckbox(candidate) {
    const wrapper = document.createElement('span');
    wrapper.className = WRAPPER_CLASS;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = CHECKBOX_CLASS;
    checkbox.checked = selected.has(candidate.spec.toLowerCase());
    checkbox.setAttribute('aria-label', candidate.spec + ' を選択');
    checkbox.dataset.gbcSpec = candidate.spec;

    checkbox.addEventListener('change', () => {
      const key = candidate.spec.toLowerCase();
      if (checkbox.checked) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
      applySelectedStyle(candidate.spec, checkbox.checked);
      updateToolbar();
      notifySelectionChanged();

      // Checking a box pulls that repository straight away. Unchecking only
      // clears the selection; it never touches the working tree.
      if (checkbox.checked) {
        requestPull(candidate);
      }
    });

    wrapper.appendChild(checkbox);
    return { wrapper, checkbox };
  }

  /** Inserts the checkbox at the start of the row that contains the anchor. */
  function insertCheckbox(anchor, wrapper) {
    const row = anchor.closest('li, [role="listitem"], article, div.Box-row');
    if (row) {
      row.insertBefore(wrapper, row.firstChild);
      return row;
    }
    anchor.parentNode.insertBefore(wrapper, anchor);
    return anchor.parentNode;
  }

  function applySelectedStyle(spec, isSelected) {
    const entry = entries.get(spec.toLowerCase());
    if (!entry || !entry.row) return;
    entry.row.classList.toggle(SELECTED_CLASS, isSelected);
  }

  // ------------------------------------------------------------- auto pull

  /** Rows currently waiting on a pull, keyed by lowercased spec. */
  const pendingPulls = new Map();

  /**
   * Pulls one repository as soon as its checkbox is checked.
   *
   * The service worker owns the native messaging port, so this only sends a
   * request and reflects the outcome on the row.
   */
  function requestPull(candidate) {
    const key = candidate.spec.toLowerCase();
    if (pendingPulls.has(key)) return;

    setRowStatus(candidate.spec, 'pulling', 'pull 中…');
    pendingPulls.set(key, true);

    chrome.runtime.sendMessage({
      type: 'gbc:startPull',
      repositories: [candidate.spec]
    }).then((result) => {
      pendingPulls.delete(key);
      if (!result) {
        setRowStatus(candidate.spec, 'failed', 'pull できませんでした');
        return;
      }
      if (result.error) {
        setRowStatus(candidate.spec, 'failed', result.error);
        return;
      }
      // The run is asynchronous; the worker reports the outcome separately.
      setRowStatus(candidate.spec, 'pulling', 'pull 中…');
    }).catch((error) => {
      pendingPulls.delete(key);
      setRowStatus(candidate.spec, 'failed', String(error && error.message ? error.message : error));
    });
  }

  /** Shows a short status next to a row's checkbox. */
  function setRowStatus(spec, state, text) {
    const entry = entries.get(spec.toLowerCase());
    if (!entry) return;

    let badge = entry.wrapper.querySelector('.gbc-row-status');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gbc-row-status';
      entry.wrapper.appendChild(badge);
    }
    badge.dataset.state = state;
    badge.textContent = text || '';
    badge.title = text || '';
  }

  /** Applies a pull result reported by the service worker. */
  function applyPullResult(result) {
    if (!result || typeof result.repository !== 'string') return;

    switch (result.status) {
      case 'updated':
        setRowStatus(result.repository, 'updated', '更新');
        break;
      case 'up-to-date':
        setRowStatus(result.repository, 'up-to-date', '最新');
        break;
      case 'failed':
        setRowStatus(result.repository, 'failed', result.message || '失敗');
        break;
      default:
        break;
    }
  }

  /** Adds checkboxes for any newly seen candidates. */
  function scan() {
    scanScheduled = false;

    if (!RepoUrl.isSupportedPage(location.href)) {
      teardown();
      return;
    }

    // Group repository links by their row so a row yields at most one
    // candidate, even when it contains a "Forked from" link.
    const byRow = new Map();
    const looseAnchors = [];

    for (const anchor of candidateAnchors()) {
      if (!RepoUrl.normalizeRepoUrl(anchor.getAttribute('href'), location.href)) continue;

      const row = rowFor(anchor);
      if (!row) {
        looseAnchors.push(anchor);
        continue;
      }
      const group = byRow.get(row);
      if (group) group.push(anchor);
      else byRow.set(row, [anchor]);
    }

    const seenThisScan = new Set();

    const register = (anchor, row) => {
      const candidate = RepoUrl.normalizeRepoUrl(anchor.getAttribute('href'), location.href);
      if (!candidate) return;

      const key = candidate.spec.toLowerCase();
      if (seenThisScan.has(key)) return;
      seenThisScan.add(key);

      const existing = entries.get(key);
      if (existing && existing.checkbox.isConnected) return;

      const { wrapper, checkbox } = createCheckbox(candidate);
      const insertedRow = insertCheckbox(anchor, wrapper);
      entries.set(key, {
        candidate,
        checkbox,
        wrapper,
        anchor,
        row: row || insertedRow
      });
      applySelectedStyle(candidate.spec, checkbox.checked);
    };

    for (const [row, anchors] of byRow) {
      const anchor = primaryAnchor(anchors);
      if (anchor) register(anchor, row);
    }
    for (const anchor of looseAnchors) {
      register(anchor, null);
    }

    // Drop entries whose checkbox GitHub removed and that no longer appear.
    for (const [key, entry] of entries) {
      if (!entry.checkbox.isConnected && !seenThisScan.has(key)) {
        entries.delete(key);
      }
    }

    updateToolbar();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // Coalesce the burst of mutations a GitHub re-render produces.
    requestAnimationFrame(() => setTimeout(scan, 100));
  }

  // ----------------------------------------------------------------- toolbar

  function updateToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    const count = entries.size;
    if (count === 0) {
      if (toolbar) toolbar.remove();
      return;
    }

    const element = toolbar || buildToolbar();
    const countLabel = element.querySelector('.gbc-toolbar-count');
    if (countLabel) {
      countLabel.textContent = selected.size + ' / ' + count + ' 件選択';
    }
    const selectAll = element.querySelector('[data-gbc-action="select-all"]');
    if (selectAll) selectAll.disabled = selected.size === count;
    const clear = element.querySelector('[data-gbc-action="clear"]');
    if (clear) clear.disabled = selected.size === 0;
  }

  function buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'gbc-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'GitHub Bulk Cloner');

    const countLabel = document.createElement('span');
    countLabel.className = 'gbc-toolbar-count';

    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.dataset.gbcAction = 'select-all';
    selectAll.textContent = '全選択';
    selectAll.addEventListener('click', selectAllRepositories);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.dataset.gbcAction = 'clear';
    clear.textContent = '全解除';
    clear.addEventListener('click', clearSelection);

    toolbar.append(countLabel, selectAll, clear);
    document.body.appendChild(toolbar);
    return toolbar;
  }

  // --------------------------------------------------------------- selection

  function setSelected(specs) {
    const wanted = new Set(specs.map((spec) => String(spec).toLowerCase()));
    selected.clear();
    for (const key of wanted) {
      if (entries.has(key)) selected.add(key);
    }
    for (const [key, entry] of entries) {
      entry.checkbox.checked = selected.has(key);
      applySelectedStyle(entry.candidate.spec, entry.checkbox.checked);
    }
    updateToolbar();
  }

  function selectAllRepositories() {
    for (const [key, entry] of entries) {
      selected.add(key);
      entry.checkbox.checked = true;
      applySelectedStyle(entry.candidate.spec, true);
    }
    updateToolbar();
    notifySelectionChanged();
  }

  function clearSelection() {
    selected.clear();
    for (const entry of entries.values()) {
      entry.checkbox.checked = false;
      applySelectedStyle(entry.candidate.spec, false);
    }
    updateToolbar();
    notifySelectionChanged();
  }

  /** Returns the selected candidates in page order. */
  function selectedCandidates() {
    const result = [];
    for (const [key, entry] of entries) {
      if (selected.has(key)) result.push(entry.candidate);
    }
    return result;
  }

  function notifySelectionChanged() {
    // The popup may be closed; a failed send is expected and harmless.
    chrome.runtime.sendMessage({
      type: 'gbc:selectionChanged',
      selected: selectedCandidates().map((candidate) => candidate.spec)
    }).catch(() => {});
  }

  // -------------------------------------------------------------- lifecycle

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const entry of entries.values()) {
      entry.wrapper.remove();
    }
    entries.clear();
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (toolbar) toolbar.remove();
  }

  function start() {
    scan();

    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });

    // GitHub navigates without a full page load, so re-check on history change.
    window.addEventListener('popstate', scheduleScan);
    document.addEventListener('turbo:load', scheduleScan);
    document.addEventListener('pjax:end', scheduleScan);
  }

  // --------------------------------------------------------------- messaging

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'gbc:runUpdate': {
        // Reflect pull outcomes on the rows as they arrive.
        const state = message.state;
        if (state && state.kind === 'pull' && Array.isArray(state.results)) {
          for (const result of state.results) applyPullResult(result);
        }
        return false;
      }

      case 'gbc:getState':
        sendResponse({
          supported: RepoUrl.isSupportedPage(location.href),
          candidates: Array.from(entries.values()).map((entry) => ({
            spec: entry.candidate.spec,
            url: entry.candidate.url
          })),
          selected: selectedCandidates().map((candidate) => candidate.spec)
        });
        return false;

      case 'gbc:setSelection':
        setSelected(Array.isArray(message.selected) ? message.selected : []);
        sendResponse({ ok: true });
        return false;

      case 'gbc:selectAll':
        selectAllRepositories();
        sendResponse({ ok: true });
        return false;

      case 'gbc:clearSelection':
        clearSelection();
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
