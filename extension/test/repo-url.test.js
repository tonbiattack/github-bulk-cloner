'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RepoUrl = require('../lib/repo-url.js');

test('parseRepoPath accepts a plain owner/repo path', () => {
  assert.deepEqual(RepoUrl.parseRepoPath('/tonbiattack/zip-scope'), {
    owner: 'tonbiattack',
    repo: 'zip-scope'
  });
});

test('parseRepoPath strips a .git suffix and trailing slash', () => {
  assert.deepEqual(RepoUrl.parseRepoPath('/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(RepoUrl.parseRepoPath('/owner/repo/'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(RepoUrl.parseRepoPath('/owner/repo.git/'), { owner: 'owner', repo: 'repo' });
});

test('parseRepoPath rejects in-repository pages', () => {
  for (const path of [
    '/owner/repo/issues',
    '/owner/repo/issues/1',
    '/owner/repo/tree/main/src',
    '/owner/repo/pulls',
    '/owner/repo/blob/main/README.md',
    '/owner/repo/actions',
    '/owner/repo/settings'
  ]) {
    assert.equal(RepoUrl.parseRepoPath(path), null, path + ' should be rejected');
  }
});

test('parseRepoPath rejects site routes', () => {
  for (const path of [
    '/topics/javascript',
    '/topics/javascript/',
    '/search',
    '/settings/profile',
    '/orgs/foo/repositories',
    '/notifications',
    '/explore',
    '/sponsors/owner',
    '/users/owner',
    '/marketplace'
  ]) {
    assert.equal(RepoUrl.parseRepoPath(path), null, path + ' should be rejected');
  }
});

test('parseRepoPath rejects malformed segments', () => {
  for (const path of [
    '/',
    '/owner',
    '/owner/repo/extra',
    '/owner/..',
    '/owner/.',
    '/owner/-repo',
    '/owner/repo.',
    '/owner/re po',
    '/owner/re:po',
    '/owner/re*po',
    '/owner/re?po',
    '/owner/re%20po',
    '/owner/repo.png',
    '/owner/repo.svg'
  ]) {
    assert.equal(RepoUrl.parseRepoPath(path), null, path + ' should be rejected');
  }
});

test('parseRepoPath enforces GitHub length limits', () => {
  assert.equal(RepoUrl.parseRepoPath('/' + 'a'.repeat(40) + '/repo'), null);
  assert.equal(RepoUrl.parseRepoPath('/owner/' + 'a'.repeat(101)), null);
  assert.notEqual(RepoUrl.parseRepoPath('/' + 'a'.repeat(39) + '/repo'), null);
  assert.notEqual(RepoUrl.parseRepoPath('/owner/' + 'a'.repeat(100)), null);
});

test('normalizeRepoUrl accepts canonical repository URLs', () => {
  assert.deepEqual(RepoUrl.normalizeRepoUrl('https://github.com/tonbiattack/zip-scope'), {
    owner: 'tonbiattack',
    repo: 'zip-scope',
    spec: 'tonbiattack/zip-scope',
    url: 'https://github.com/tonbiattack/zip-scope'
  });
});

test('normalizeRepoUrl normalises .git, trailing slash, and query', () => {
  const expected = 'https://github.com/owner/repo';
  for (const href of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo?tab=readme',
    'https://github.com/owner/repo#readme',
    'https://www.github.com/owner/repo'
  ]) {
    const result = RepoUrl.normalizeRepoUrl(href);
    assert.ok(result, href + ' should be accepted');
    assert.equal(result.url, expected, href);
  }
});

test('normalizeRepoUrl rejects non-GitHub and non-https URLs', () => {
  for (const href of [
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com.evil.example/owner/repo',
    'https://evil.example/github.com/owner/repo',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://github.com/owner/repo',
    'not a url',
    ''
  ]) {
    assert.equal(RepoUrl.normalizeRepoUrl(href), null, href + ' should be rejected');
  }
});

test('normalizeRepoUrl resolves relative hrefs against a base', () => {
  const result = RepoUrl.normalizeRepoUrl('/owner/repo', 'https://github.com/explore');
  assert.ok(result);
  assert.equal(result.spec, 'owner/repo');
});

test('isSupportedPage recognises listing pages', () => {
  for (const href of [
    'https://github.com/tonbiattack?tab=repositories',
    'https://github.com/tonbiattack?tab=repositories&page=2',
    'https://github.com/search?q=cli&type=repositories',
    'https://github.com/topics/chrome-extension',
    'https://github.com/orgs/tonbiattack/repositories',
    'https://github.com/tonbiattack/repositories'
  ]) {
    assert.equal(RepoUrl.isSupportedPage(href), true, href);
  }
});

test('isSupportedPage rejects unrelated pages', () => {
  for (const href of [
    'https://github.com/',
    'https://github.com/tonbiattack',
    'https://github.com/tonbiattack/zip-scope',
    'https://github.com/tonbiattack/zip-scope/issues',
    'https://github.com/search?q=cli',
    'https://github.com/search?q=cli&type=code',
    'https://gitlab.com/tonbiattack?tab=repositories',
    'http://github.com/tonbiattack?tab=repositories',
    'not a url'
  ]) {
    assert.equal(RepoUrl.isSupportedPage(href), false, href);
  }
});

test('collectRepoLinks deduplicates case-insensitively', () => {
  const candidates = RepoUrl.collectRepoLinks([
    { href: 'https://github.com/Owner/Repo' },
    { href: 'https://github.com/owner/repo' },
    { href: 'https://github.com/owner/repo.git' },
    { href: 'https://github.com/owner/other' }
  ]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.spec), ['Owner/Repo', 'owner/other']);
});

test('collectRepoLinks keeps the first spelling of a duplicate', () => {
  const candidates = RepoUrl.collectRepoLinks([
    { href: 'https://github.com/Zed/Alpha' },
    { href: 'https://github.com/zed/alpha' }
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].spec, 'Zed/Alpha');
});

test('collectRepoLinks ignores invalid entries', () => {
  const candidates = RepoUrl.collectRepoLinks([
    null,
    undefined,
    {},
    { href: 42 },
    { href: '' },
    { href: 'https://github.com/owner/repo/issues' },
    { href: 'https://github.com/owner/repo' }
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].spec, 'owner/repo');
});

test('collectRepoLinks tolerates a non-array argument', () => {
  assert.deepEqual(RepoUrl.collectRepoLinks(null), []);
  assert.deepEqual(RepoUrl.collectRepoLinks(undefined), []);
  assert.deepEqual(RepoUrl.collectRepoLinks('nope'), []);
});

test('collectRepoLinks preserves page order', () => {
  const candidates = RepoUrl.collectRepoLinks([
    { href: 'https://github.com/c/three' },
    { href: 'https://github.com/a/one' },
    { href: 'https://github.com/b/two' }
  ]);
  assert.deepEqual(candidates.map((c) => c.spec), ['c/three', 'a/one', 'b/two']);
});
