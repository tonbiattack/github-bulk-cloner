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
    // GitHub Repo Sorter replaces GitHub's list with its own while keeping the
    // native one in the DOM but hidden, so this container must be considered
    // too (see the visibility checks in candidateAnchors).
    '[data-grs-list]',
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
  /** Set once the extension has been reloaded or removed under this page. */
  let contextInvalidated = false;

  // ------------------------------------------------------- context validity

  /**
   * Reports whether this content script can still talk to the extension.
   *
   * Reloading or removing the extension orphans the content scripts already
   * running in open tabs. Their chrome.runtime calls then throw
   * "Extension context invalidated", so every call is guarded by this check.
   */
  function isContextValid() {
    if (contextInvalidated) return false;
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /**
   * Stops all work and removes the injected UI once the extension is gone.
   *
   * Without this the page keeps a dead observer and dead checkboxes that can
   * never report anything.
   */
  function handleInvalidatedContext() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    teardown();
  }

  /**
   * Sends a message to the extension, tolerating an invalidated context.
   *
   * chrome.runtime.sendMessage throws synchronously when the context is gone,
   * so a promise .catch() alone is not enough.
   */
  function sendMessageSafely(message) {
    if (!isContextValid()) {
      handleInvalidatedContext();
      return Promise.resolve(null);
    }
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      handleInvalidatedContext();
      return Promise.resolve(null);
    }
  }

  // ---------------------------------------------------------------- scanning

  /**
   * Reports whether an element is currently rendered.
   *
   * GitHub (and extensions such as GitHub Repo Sorter) hide lists with
   * `display: none` instead of removing them. Checkboxes added to a hidden row
   * can never be clicked, so hidden candidates must be skipped and the next
   * visible container used instead.
   */
  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (typeof element.getClientRects !== 'function') return false;
    return element.getClientRects().length > 0;
  }

  /** Returns the anchors to consider, preferring known visible listing containers. */
  function candidateAnchors() {
    for (const selector of LIST_CONTAINERS) {
      const anchors = [];
      for (const container of document.querySelectorAll(selector)) {
        if (!isVisible(container)) continue;
        for (const anchor of container.querySelectorAll('a[href]')) {
          if (isVisible(anchor)) anchors.push(anchor);
        }
      }
      if (anchors.length > 0) return anchors;
    }

    const fallback = document.querySelector(FALLBACK_CONTAINER);
    if (!fallback || !isVisible(fallback)) return [];
    return Array.from(fallback.querySelectorAll('a[href]')).filter(isVisible);
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

      // Checking a box clones that repository straight away. Unchecking only
      // clears the selection; it never touches the working tree.
      if (checkbox.checked) {
        requestClone(candidate);
      }
    });

    wrapper.appendChild(checkbox);
    return { wrapper, checkbox };
  }

  /** Inserts the checkbox at the start of the row that contains the anchor. */
  /**
   * Inserts the checkbox next to the repository name.
   *
   * GitHub's rows are flex containers (`d-flex justify-content-between`) whose
   * main column is a fixed-width `col-10`; adding the checkbox as a flex
   * sibling pushes that column to the far right and leaves a large gap. Putting
   * it immediately before the name link keeps the checkbox and the title
   * together and leaves the row layout untouched.
   */
  function insertCheckbox(anchor, wrapper) {
    const row = rowFor(anchor);
    const parent = anchor.parentNode;

    if (parent && parent.nodeType === 1 && parent !== row) {
      parent.insertBefore(wrapper, anchor);
      return row || parent;
    }
    if (row) {
      row.insertBefore(wrapper, anchor);
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

  // ------------------------------------------------------------ auto clone

  /** Rows currently waiting on a clone, keyed by lowercased spec. */
  const pendingClones = new Map();

  /**
   * Clones one repository as soon as its checkbox is checked.
   *
   * The service worker owns the native messaging port, so this only sends a
   * request and reflects the outcome on the row.
   */
  function requestClone(candidate) {
    const key = candidate.spec.toLowerCase();
    if (pendingClones.has(key)) return;

    setRowStatus(candidate.spec, 'working', 'clone 中…');
    pendingClones.set(key, true);

    sendMessageSafely({
      type: 'gbc:startClone',
      repositories: [candidate.spec]
    }).then((result) => {
      pendingClones.delete(key);
      if (!result) {
        // A null result means the extension context is gone; the row is
        // already cleaned up by handleInvalidatedContext.
        if (!contextInvalidated) {
          setRowStatus(candidate.spec, 'failed', 'clone できませんでした');
        }
        return;
      }
      if (result.error) {
        setRowStatus(candidate.spec, 'failed', result.error);
      }
      // The run is asynchronous; the worker reports the outcome separately.
    }).catch((error) => {
      pendingClones.delete(key);
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

  /** Applies a clone result reported by the service worker. */
  function applyCloneResult(result) {
    if (!result || typeof result.repository !== 'string') return;

    switch (result.status) {
      case 'success':
        setRowStatus(result.repository, 'success', 'clone 済み');
        break;
      case 'skipped':
        setRowStatus(result.repository, 'skipped', '既にあります');
        break;
      case 'conflict':
        // Another repository already occupies the destination; do not claim
        // this one is present.
        setRowStatus(result.repository, 'conflict',
          result.existingRepository
            ? '別リポジトリあり (' + result.existingRepository + ')'
            : '別リポジトリあり');
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

    // Stop for good once the extension has been reloaded or removed.
    if (!isContextValid()) {
      handleInvalidatedContext();
      return;
    }

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
      if (existing) {
        // Keep a live, visible checkbox; replace one that is hidden or gone
        // (for example when GitHub Repo Sorter swaps the list it renders).
        if (existing.checkbox.isConnected && isVisible(existing.checkbox)) return;
        existing.wrapper.remove();
        entries.delete(key);
      }

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

    // Drop entries whose checkbox is gone or no longer visible and that did
    // not reappear in this scan.
    for (const [key, entry] of entries) {
      if (seenThisScan.has(key)) continue;
      if (!entry.checkbox.isConnected || !isVisible(entry.checkbox)) {
        entry.wrapper.remove();
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
    sendMessageSafely({
      type: 'gbc:selectionChanged',
      selected: selectedCandidates().map((candidate) => candidate.spec)
    });
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
    if (!isContextValid()) {
      handleInvalidatedContext();
      return;
    }

    scan();

    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });

    // GitHub navigates without a full page load, so re-check on history change.
    window.addEventListener('popstate', scheduleScan);
    document.addEventListener('turbo:load', scheduleScan);
    document.addEventListener('pjax:end', scheduleScan);
  }

  // --------------------------------------------------------------- messaging

  // Registering a listener on an invalidated context throws, so guard it.
  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;

      switch (message.type) {
        case 'gbc:runUpdate': {
          // Reflect clone outcomes on the rows as they arrive.
          const state = message.state;
          if (state && state.kind === 'clone' && Array.isArray(state.results)) {
            for (const result of state.results) applyCloneResult(result);
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
