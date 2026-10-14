import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, summarize, groupByFloor, uptimeSummary, rankOf, UPTIME_BUCKETS } from '../../../web/modules/status/model.js';

const dev = (id, over = {}) => ({
  id, code: id.toUpperCase(), name: id, categoryId: 'cat_other', floorId: 'flr_1', roomId: null, groupIds: [], ip: '10.0.0.1',
  mac: '', hostname: '', vendor: '', model: '', notes: '', ...over,
  monitor: { method: 'icmp', port: null, path: '/', intervalSec: 60, critical: false, ...(over.monitor ?? {}) },
});
const st = (deviceId, state, over = {}) => ({ deviceId, state, rttMs: state === 'up' ? 3 : null, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0, ...over });
const floors = [{ id: 'flr_1', name: '1F', order: 1 }, { id: 'flr_2', name: '2F', order: 2 }];
const empty = { floorId: '', roomId: '', groupId: '', categoryId: '', q: '' };

describe('buildRows / summarize', () => {
  test('每台設備配對狀態；沒有狀態項目者視為 unknown；method=none 視為 disabled', () => {
    const rows = buildRows([dev('a'), dev('b'), dev('c', { monitor: { method: 'none' } })], [st('a', 'up')], empty);
    assert.deepEqual(rows.map((r) => [r.device.id, r.state]), [['a', 'up'], ['b', 'unknown'], ['c', 'disabled']]);
  });

  test('遵守全站篩選（樓層、關鍵字）', () => {
    const devices = [dev('a'), dev('b', { floorId: 'flr_2' }), dev('c', { name: '客廳電視' })];
    assert.deepEqual(buildRows(devices, [], { ...empty, floorId: 'flr_2' }).map((r) => r.device.id), ['b']);
    assert.deepEqual(buildRows(devices, [], { ...empty, q: '客廳' }).map((r) => r.device.id), ['c']);
  });

  test('統計：上線／離線／未知／未偵測，另外算出離線的關鍵設備數', () => {
    const devices = [
      dev('a'), dev('b'), dev('c', { monitor: { critical: true } }), dev('d'), dev('e', { monitor: { method: 'none' } }), dev('f'),
    ];
    const rows = buildRows(devices, [st('a', 'up'), st('b', 'down'), st('c', 'down'), st('d', 'unknown')], empty);
    assert.deepEqual(summarize(rows), { up: 1, down: 2, unknown: 2, disabled: 1, criticalDown: 1, total: 6 });
  });
});

describe('groupByFloor：依樓層分組，離線的關鍵設備置頂', () => {
  test('依樓層 order 排列；沒有樓層或樓層不存在者歸「未指定樓層」排最後', () => {
    const devices = [dev('a', { floorId: 'flr_2' }), dev('b'), dev('c', { floorId: null }), dev('d', { floorId: 'flr_gone' })];
    const groups = groupByFloor(buildRows(devices, [], empty), floors);
    assert.deepEqual(groups.map((g) => g.name), ['1F', '2F', '未指定樓層']);
    assert.deepEqual(groups[2].rows.map((r) => r.device.id).sort(), ['c', 'd']);
  });

  test('空的樓層不出現', () => {
    const groups = groupByFloor(buildRows([dev('a')], [], empty), floors);
    assert.deepEqual(groups.map((g) => g.name), ['1F']);
  });

  test('組內排序：離線的關鍵設備 → 其他離線 → 未知 → 上線 → 未偵測；同級依編號', () => {
    const devices = [
      dev('up1'), dev('off'), dev('crit', { monitor: { critical: true } }), dev('unk'), dev('dis', { monitor: { method: 'none' } }), dev('up0'),
      dev('critUp', { monitor: { critical: true } }),
    ];
    const items = [st('up1', 'up'), st('off', 'down'), st('crit', 'down'), st('unk', 'unknown'), st('up0', 'up'), st('critUp', 'up')];
    const [g] = groupByFloor(buildRows(devices, items, empty), floors);
    assert.deepEqual(g.rows.map((r) => r.device.id), ['crit', 'off', 'unk', 'critUp', 'up0', 'up1', 'dis']);
  });

  test('每組帶統計（離線數、關鍵離線數）', () => {
    const devices = [dev('a', { monitor: { critical: true } }), dev('b')];
    const [g] = groupByFloor(buildRows(devices, [st('a', 'down'), st('b', 'up')], empty), floors);
    assert.equal(g.summary.down, 1);
    assert.equal(g.summary.criticalDown, 1);
  });

  test('rankOf', () => {
    assert.ok(rankOf({ state: 'down', device: dev('x', { monitor: { critical: true } }) }) < rankOf({ state: 'down', device: dev('x') }));
    assert.ok(rankOf({ state: 'down', device: dev('x') }) < rankOf({ state: 'unknown', device: dev('x') }));
    assert.ok(rankOf({ state: 'up', device: dev('x') }) < rankOf({ state: 'disabled', device: dev('x') }));
  });
});

describe('uptimeSummary：24 小時可用率迷你條', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

  test('24 個小時桶，由舊到新；最後一桶是「現在往前一小時」', () => {
    assert.equal(UPTIME_BUCKETS, 24);
    const r = uptimeSummary([{ at: at(10), up: true, rttMs: 1 }], now);
    assert.equal(r.buckets.length, 24);
    assert.equal(r.buckets[23].state, 'up');
    assert.equal(r.buckets[0].state, 'none');
  });

  test('可用率 = 成功次數 / 全部次數，一位小數；沒有資料為 null', () => {
    const s = [];
    for (let i = 0; i < 999; i++) s.push({ at: at(i % 600), up: true, rttMs: 1 });
    s.push({ at: at(5), up: false, rttMs: null });
    assert.equal(uptimeSummary(s, now).pct, 99.9);
    assert.equal(uptimeSummary([], now).pct, null);
  });

  test('桶的狀態：全成功 up、全失敗 down、部分 partial、無資料 none', () => {
    const s = [
      { at: at(5), up: true, rttMs: 1 }, { at: at(6), up: true, rttMs: 1 }, // 最後一桶：全成功
      { at: at(65), up: false, rttMs: null }, { at: at(66), up: false, rttMs: null }, // 倒數第二桶：全失敗
      { at: at(125), up: true, rttMs: 1 }, { at: at(126), up: false, rttMs: null }, // 倒數第三桶：部分
    ];
    const { buckets } = uptimeSummary(s, now);
    assert.deepEqual([buckets[23].state, buckets[22].state, buckets[21].state, buckets[20].state], ['up', 'down', 'partial', 'none']);
  });

  test('超過 24 小時前的資料與未來的資料被忽略', () => {
    const r = uptimeSummary([{ at: at(60 * 25), up: false, rttMs: null }, { at: new Date(now + 3600_000).toISOString(), up: false, rttMs: null }], now);
    assert.equal(r.pct, null);
  });
});
