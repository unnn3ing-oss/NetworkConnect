import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOverview, createOverviewClient, looksLikeLocalNetworkDenied } from '../../../desktop/lib/overview.js';

const dev = (id, critical, name = id) => ({ id, name, monitor: { critical } });
const st = (deviceId, state) => ({ deviceId, state });

test('summarizeOverview：有關鍵設備 down 才算警示', () => {
  const devices = [dev('a', true), dev('b', false), dev('c', true)];
  const r = summarizeOverview({ devices, statuses: [st('a', 'down'), st('b', 'down'), st('c', 'up')] });
  assert.equal(r.criticalDown, 1);
  assert.deepEqual(r.criticalDownIds, ['a']);
  assert.equal(r.alert, true);
});

test('summarizeOverview：只有非關鍵設備離線＝正常', () => {
  const r = summarizeOverview({ devices: [dev('b', false)], statuses: [st('b', 'down')] });
  assert.equal(r.alert, false);
});

test('summarizeOverview：unknown／disabled／無狀態的關鍵設備不算離線', () => {
  const devices = [dev('a', true), dev('b', true), dev('c', true)];
  const r = summarizeOverview({ devices, statuses: [st('a', 'unknown'), st('b', 'disabled')] });
  assert.equal(r.alert, false);
});

test('summarizeOverview：狀態中有未知設備時忽略', () => {
  assert.equal(summarizeOverview({ devices: [], statuses: [st('zzz', 'down')] }).alert, false);
});

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('createOverviewClient.getDevice：呼叫 /api/devices/:id', async () => {
  const calls = [];
  const client = createOverviewClient({ getBaseUrl: () => 'http://127.0.0.1:8780', fetch: async (u) => { calls.push(u); return jsonRes({ id: 'dev_a', name: 'R', monitor: { critical: true } }); } });
  const d = await client.getDevice('dev_a');
  assert.deepEqual(d, { name: 'R', critical: true });
  assert.deepEqual(calls, ['http://127.0.0.1:8780/api/devices/dev_a']);
});

test('createOverviewClient.getDevice：設備 id 會被編碼；HTTP 錯誤或網路失敗回 null', async () => {
  const calls = [];
  const c1 = createOverviewClient({ getBaseUrl: () => 'http://x', fetch: async (u) => { calls.push(u); return jsonRes({}, 401); } });
  assert.equal(await c1.getDevice('a/b'), null);
  assert.equal(calls[0], 'http://x/api/devices/a%2Fb');
  const c2 = createOverviewClient({ getBaseUrl: () => 'http://x', fetch: async () => { throw new Error('boom'); } });
  assert.equal(await c2.getDevice('a'), null);
  const c3 = createOverviewClient({ getBaseUrl: () => null, fetch: async () => { throw new Error('should not be called'); } });
  assert.equal(await c3.getDevice('a'), null);
});

test('createOverviewClient.getSummary：同時取得設備與狀態；任一失敗回 null', async () => {
  const fetch = async (u) => (u.endsWith('/api/devices') ? jsonRes([dev('a', true)]) : jsonRes([st('a', 'down')]));
  const client = createOverviewClient({ getBaseUrl: () => 'http://x', fetch });
  assert.equal((await client.getSummary()).alert, true);
  const bad = createOverviewClient({ getBaseUrl: () => 'http://x', fetch: async (u) => (u.endsWith('/api/status') ? jsonRes({}, 401) : jsonRes([])) });
  assert.equal(await bad.getSummary(), null);
});

test('summarizeOverview：統計監控中設備的 up／down 數（排除 disabled 與未知設備）', () => {
  const devices = [dev('a', false), dev('b', false), dev('c', false), dev('d', false)];
  const r = summarizeOverview({ devices, statuses: [st('a', 'up'), st('b', 'down'), st('c', 'disabled'), st('d', 'unknown'), st('zzz', 'down')] });
  assert.equal(r.monitored, 3);
  assert.equal(r.up, 1);
  assert.equal(r.down, 1);
});

test('looksLikeLocalNetworkDenied：macOS 上多台設備全部離線才判定', () => {
  assert.equal(looksLikeLocalNetworkDenied({ monitored: 5, up: 0, down: 5 }, 'darwin'), true);
  assert.equal(looksLikeLocalNetworkDenied({ monitored: 5, up: 1, down: 4 }, 'darwin'), false);
  assert.equal(looksLikeLocalNetworkDenied({ monitored: 2, up: 0, down: 2 }, 'darwin'), false, '設備太少，可能只是剛好都關機');
  assert.equal(looksLikeLocalNetworkDenied({ monitored: 5, up: 0, down: 5 }, 'win32'), false);
  assert.equal(looksLikeLocalNetworkDenied(null, 'darwin'), false);
});

test('getPausedUntil／setPausedUntil：讀寫 /api/monitor/settings', async () => {
  const calls = [];
  const fetch = async (u, init) => {
    calls.push([u, init?.method ?? 'GET', init?.body]);
    return jsonRes({ defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: '2026-10-14T09:00:00.000Z' });
  };
  const client = createOverviewClient({ getBaseUrl: () => 'http://x', fetch });
  assert.equal(await client.getPausedUntil(), Date.parse('2026-10-14T09:00:00.000Z'));
  assert.equal(await client.setPausedUntil('2026-10-14T10:00:00.000Z'), true);
  assert.deepEqual(calls[1], ['http://x/api/monitor/settings', 'PUT', JSON.stringify({ pausedUntil: '2026-10-14T10:00:00.000Z' })]);
  await client.setPausedUntil(null);
  assert.equal(calls[2][2], JSON.stringify({ pausedUntil: null }));
});

test('getPausedUntil：未暫停回 null；失敗回 null；setPausedUntil 失敗回 false', async () => {
  const none = createOverviewClient({ getBaseUrl: () => 'http://x', fetch: async () => jsonRes({ pausedUntil: null }) });
  assert.equal(await none.getPausedUntil(), null);
  const bad = createOverviewClient({ getBaseUrl: () => 'http://x', fetch: async () => jsonRes({}, 401) });
  assert.equal(await bad.getPausedUntil(), null);
  assert.equal(await bad.setPausedUntil(null), false);
});
