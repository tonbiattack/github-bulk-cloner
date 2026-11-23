/**
 * Pure repository-URL logic for GitHub Bulk Cloner.
 *
 * This file has no DOM dependency so it can be unit tested in Node and reused
 * by the content script. It is loaded as a classic script in the extension and
 * as a CommonJS module in tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GBCRepoUrl = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * First path segments that are GitHub site routes rather than users or
   * organisations. A link whose owner is one of these is never a repository.
   */
  const RESERVED_OWNERS = new Set([
    'about', 'account', 'apps', 'blog', 'business', 'careers', 'cody', 'codespaces',
    'collections', 'contact', 'customer-stories', 'dashboard', 'discussions', 'edu',
    'enterprise', 'events', 'explore', 'features', 'gist', 'git-guides', 'home',
    'issues', 'join', 'login', 'logout', 'marketplace', 'mobile', 'new', 'non-profit',
    'notifications', 'organizations', 'orgs', 'personal', 'premium-support', 'pricing',
    'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site',
    'sponsors', 'stars', 'team', 'topics', 'trending', 'users', 'watching'
  ]);

  /** Paths that are files or assets, never repositories. */
  const RESERVED_SUFFIXES = ['.png', '.svg', '.ico', '.txt', '.xml', '.json', '.css', '.js'];

  /** GitHub login rules: alphanumerics and hyphens, no leading/trailing hyphen. */
  const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
  /** GitHub repository names: alphanumerics, dot, underscore, hyphen. */
  const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

  const MAX_OWNER_LEN = 39;
  const MAX_REPO_LEN = 100;

  /**
   * Parses a pathname into {owner, repo} when it is exactly /<owner>/<repo>.
   * Extra segments (issues, tree, pulls, ...) are rejected, which is what keeps
   * in-repository links from becoming candidates.
   */
  function parseRepoPath(pathname) {
    if (typeof pathname !== 'string' || pathname === '') return null;

    const segments = pathname.split('/').filter((segment) => segment !== '');
    if (segments.length !== 2) return null;

    let [owner, repo] = segments;

    // Normalise the optional .git suffix and a trailing slash.
    if (repo.toLowerCase().endsWith('.git')) {
      repo = repo.slice(0, -4);
    }
    if (repo === '') return null;

    if (owner.length > MAX_OWNER_LEN || repo.length > MAX_REPO_LEN) return null;
    if (!OWNER_PATTERN.test(owner)) return null;
    if (!REPO_PATTERN.test(repo)) return null;
    if (repo === '.' || repo === '..') return null;
    if (repo.startsWith('-')) return null;
    if (repo.endsWith('.') || repo.endsWith(' ')) return null;

    const lowerOwner = owner.toLowerCase();
    if (RESERVED_OWNERS.has(lowerOwner)) return null;

    const lowerRepo = repo.toLowerCase();
    if (RESERVED_SUFFIXES.some((suffix) => lowerRepo.endsWith(suffix))) return null;

    return { owner, repo };
  }

  /**
   * Normalises an href into a repository candidate, or returns null.
   * Only https://github.com/<owner>/<repo> is accepted; query strings, hashes,
   * other hosts, and non-https schemes are rejected.
   */
  function normalizeRepoUrl(href, base) {
    if (typeof href !== 'string' || href.trim() === '') return null;

    let url;
    try {
      url = base ? new URL(href, base) : new URL(href);
    } catch {
      return null;
    }

    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;

    const parsed = parseRepoPath(url.pathname);
    if (!parsed) return null;

    return {
      owner: parsed.owner,
      repo: parsed.repo,
      spec: parsed.owner + '/' + parsed.repo,
      url: 'https://github.com/' + parsed.owner + '/' + parsed.repo
    };
  }

  /**
   * Reports whether the extension should offer selection on this page.
   * These are the listing pages named in the MVP spec.
   */
  function isSupportedPage(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return false;

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;

    // Profile or organisation repositories tab.
    if (params.get('tab') === 'repositories') return true;

    // Repository search results.
    if (path === '/search' && params.get('type') === 'repositories') return true;

    // Topic listing pages.
    if (/^\/topics\/[^/]+$/.test(path)) return true;

    // Organisation repositories page.
    if (/^\/orgs\/[^/]+\/repositories$/.test(path)) return true;

    // A user's own repositories page.
    if (/^\/[^/]+\/repositories$/.test(path)) return true;

    return false;
  }

  /**
   * Turns raw link entries into deduplicated candidates.
   *
   * @param {Array<{href: string, base?: string}>} entries
   * @returns {Array<{owner: string, repo: string, spec: string, url: string}>}
   */
  function collectRepoLinks(entries) {
    if (!Array.isArray(entries)) return [];

    const seen = new Set();
    const candidates = [];

    for (const entry of entries) {
      if (!entry || typeof entry.href !== 'string') continue;
      const candidate = normalizeRepoUrl(entry.href, entry.base);
      if (!candidate) continue;

      // GitHub treats owner and repository names case-insensitively.
      const key = candidate.spec.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }

    return candidates;
  }

  return {
    RESERVED_OWNERS,
    parseRepoPath,
    normalizeRepoUrl,
    isSupportedPage,
    collectRepoLinks
  };
});
