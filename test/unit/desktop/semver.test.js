import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, isNewerVersion, checkForUpdate } from '../../../desktop/lib/semver.js';

test('parseVersion：接受 v 前綴、預發行、build metadata', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('1.2.3-beta.1+abc'), { major: 1, minor: 2, patch: 3, pre: ['beta', 1] });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion('1.2.3.4'), null);
  assert.equal(parseVersion('01.2.3'), null);
});

test('compareVersions：數值比較而非字串比較', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('compareVersions：預發行版小於正式版，預發行之間依 semver 規則', () => {
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('compareVersions：build metadata 不影響比較', () => {
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
});

test('compareVersions：無法解析時丟錯', () => {
  assert.throws(() => compareVersions('abc', '1.0.0'), /版本/);
});

test('isNewerVersion：無法解析的版本一律視為沒有新版', () => {
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('v0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('v0.0.9', '0.1.0'), false);
  assert.equal(isNewerVersion('nightly', '0.1.0'), false);
});

const release = (over = {}) => ({ tag_name: 'v0.2.0', html_url: 'https://example.test/releases/tag/v0.2.0', draft: false, prerelease: false, ...over });
const fakeFetch = (body, { ok = true, status = 200 } = {}) => async (url, init) => {
  fakeFetch.calls.push({ url, init });
  return { ok, status, json: async () => body };
};
fakeFetch.calls = [];

test('checkForUpdate：有新版時回 available 與下載頁', async () => {
  const r = await checkForUpdate({ currentVersion: '0.1.0', repo: 'owner/repo', fetch: fakeFetch(release()) });
  assert.equal(r.status, 'available');
  assert.equal(r.latest, '0.2.0');
  assert.equal(r.url, 'https://example.test/releases/tag/v0.2.0');
  assert.match(fakeFetch.calls.at(-1).url, /api\.github\.com\/repos\/owner\/repo\/releases\/latest$/);
});

test('checkForUpdate：已是最新', async () => {
  const r = await checkForUpdate({ currentVersion: '0.2.0', repo: 'owner/repo', fetch: fakeFetch(release()) });
  assert.equal(r.status, 'up-to-date');
});

test('checkForUpdate：HTTP 404（尚無任何發行版）視為已是最新', async () => {
  const r = await checkForUpdate({ currentVersion: '0.1.0', repo: 'owner/repo', fetch: fakeFetch({}, { ok: false, status: 404 }) });
  assert.equal(r.status, 'up-to-date');
});

test('checkForUpdate：其他錯誤與網路失敗回 error，不丟例外', async () => {
  const bad = await checkForUpdate({ currentVersion: '0.1.0', repo: 'o/r', fetch: fakeFetch({}, { ok: false, status: 500 }) });
  assert.equal(bad.status, 'error');
  const net = await checkForUpdate({ currentVersion: '0.1.0', repo: 'o/r', fetch: async () => { throw new Error('offline'); } });
  assert.equal(net.status, 'error');
  assert.match(net.message, /offline/);
});

test('checkForUpdate：下載頁網址不是 https 時退回預設的 releases 頁', async () => {
  const r = await checkForUpdate({ currentVersion: '0.1.0', repo: 'owner/repo', fetch: fakeFetch(release({ html_url: 'javascript:alert(1)' })) });
  assert.equal(r.url, 'https://github.com/owner/repo/releases');
});
