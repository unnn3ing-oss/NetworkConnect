import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { document, reset, click, $, $$ } from './dom.js';
import { createBus } from '../../../web/core/bus.js';
import { emptyFilters } from '../../../web/core/filters.js';
import statusModule from '../../../web/modules/status/index.js';
import { waitFor } from '../../helpers/tmp.js';

beforeEach(reset);

const dev = (id, over = {}) => ({
  id, code: id.toUpperCase(), name: over.name ?? id, categoryId: 'cat_other', floorId: 'flr_1', roomId: null, groupIds: [], ip: '10.0.0.1',
  mac: '', hostname: '', vendor: '', model: '', notes: '', ...over,
  monitor: { method: 'icmp', port: null, path: '/', intervalSec: 60, critical: false, ...(over.monitor ?? {}) },
});
const st = (deviceId, state, over = {}) => ({ deviceId, state, rttMs: state === 'up' ? 3.2 : null, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0, ...over });

function makeCtx({ devices, items, floors, settings = { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null }, history = {}, failOn } = {}) {
  const bus = createBus();
  const calls = [];
  let filters = emptyFilters();
  const data = {
    '/api/devices': devices ?? [],
    '/api/floors': floors ?? [{ id: 'flr_1', name: '1F', order: 1 }, { id: 'flr_2', name: '2F', order: 2 }],
    '/api/status': items ?? [],
    '/api/monitor/settings': settings,
  };
  const api = {
    async get(path) {
      calls.push(['GET', path]);
      if (failOn && failOn.test(path)) throw Object.assign(new Error('伺服器壞了'), { code: 'INTERNAL' });
      const m = /^\/api\/status\/([^/]+)\/history$/.exec(path);
      if (m) return { deviceId: m[1], hours: 24, samples: history[m[1]] ?? [] };
      if (!(path in data)) throw new Error(`未預期的請求 ${path}`);
      return structuredClone(data[path]);
    },
    async put(path, body) {
      calls.push(['PUT', path, body]);
      Object.assign(data['/api/monitor/settings'], body);
      return structuredClone(data['/api/monitor/settings']);
    },
  };
  const ctx = {
    api,
    bus,
    filters: { get: () => ({ ...filters }) },
    ui: { load: (name = 'index') => import(`../../../web/ui/${name}.js`) },
    router: {},
    modules: [],
  };
  return { ctx, bus, calls, data, setFilters: (f) => { filters = { ...emptyFilters(), ...f }; } };
}

async function mount(opts) {
  const t = makeCtx(opts);
  const el = document.createElement('div');
  document.body.append(el);
  await statusModule.mount(el, t.ctx);
  return { ...t, el };
}

const tiles = (el) => $$(el, '.nc-tile');
const ids = (el) => tiles(el).map((t) => t.dataset.deviceId);
const statNum = (el, kind) => Number($(el, `.nc-stat[data-kind="${kind}"] .nc-stat-num`).textContent);

describe('status 頁：版面', () => {
  test('模組資訊維持不變：id／route／order', () => {
    assert.equal(statusModule.id, 'status');
    assert.equal(statusModule.route, '#/status');
    assert.equal(statusModule.order, 60);
  });

  test('上方四個統計；下方依樓層分組；離線的關鍵設備置頂', async () => {
    const devices = [dev('a'), dev('b', { monitor: { critical: true } }), dev('c', { floorId: 'flr_2' }), dev('d', { monitor: { method: 'none' } }), dev('e')];
    const items = [st('a', 'up'), st('b', 'down'), st('c', 'unknown'), st('e', 'down')];
    const { el } = await mount({ devices, items });
    assert.equal(statNum(el, 'up'), 1);
    assert.equal(statNum(el, 'down'), 2);
    assert.equal(statNum(el, 'unknown'), 1);
    assert.equal(statNum(el, 'disabled'), 1);
    assert.deepEqual($$(el, '.nc-stat').map((s) => $(s, '.nc-stat-label').textContent), ['上線', '離線', '未知', '未偵測']);
    const groups = $$(el, '.nc-status-group');
    assert.deepEqual(groups.map((g) => $(g, '.nc-status-group-title').textContent.replace(/\s+/g, '')), ['1F4台', '2F1台'].map((s) => s.replace(/\s+/g, '')));
    assert.deepEqual($$(groups[0], '.nc-tile').map((t) => t.dataset.deviceId), ['b', 'e', 'a', 'd']);
  });

  test('燈號：關鍵設備離線 → 紅色警示；非關鍵離線 → 灰色離線', async () => {
    const devices = [dev('crit', { monitor: { critical: true } }), dev('norm')];
    const { el } = await mount({ devices, items: [st('crit', 'down'), st('norm', 'down')] });
    const stateOf = (id) => $(el, `.nc-tile[data-device-id="${id}"] .nc-status`).dataset.state;
    assert.equal(stateOf('crit'), 'down');
    assert.equal(stateOf('norm'), 'offline');
  });

  test('磚塊顯示名稱、IP 與延遲', async () => {
    const { el } = await mount({ devices: [dev('a', { name: '客廳 AP', ip: '192.168.1.5' })], items: [st('a', 'up', { rttMs: 4.5 })] });
    const t = $(el, '.nc-tile');
    assert.match(t.textContent, /客廳 AP/);
    assert.match(t.textContent, /192\.168\.1\.5/);
    assert.match(t.textContent, /4\.5 ms/);
  });

  test('設備名稱當純文字顯示（不會被當成 HTML），也沒有行內樣式（CSP）', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { el } = await mount({ devices: [dev('a', { name: evil })], items: [st('a', 'up')] });
    assert.equal($(el, '.nc-tile img'), null);
    assert.ok($(el, '.nc-tile').textContent.includes(evil));
    assert.equal($$(el, '[style]').length, 0);
  });

  test('載入自己的樣式表 /modules/status/status.css（只載入一次）', async () => {
    await mount({ devices: [dev('a')] });
    await mount({ devices: [dev('a')] });
    assert.equal($$(document.head, 'link[href="/modules/status/status.css"]').length, 1);
  });

  test('沒有任何設備 → 空狀態；篩選後沒有符合的 → 另一種空狀態', async () => {
    const a = await mount({ devices: [] });
    assert.ok($(a.el, '.nc-empty'));
    assert.equal(tiles(a.el).length, 0);
    reset();
    const b = await mount({ devices: [dev('a')] });
    b.setFilters({ q: '不存在' });
    b.bus.emit('filters.changed', {});
    assert.match($(b.el, '.nc-empty').textContent, /沒有符合/);
  });

  test('API 失敗 → 顯示錯誤並可重試，不丟例外', async () => {
    const { el, calls } = await mount({ devices: [dev('a')], failOn: /\/api\/devices$/ });
    assert.match(el.textContent, /無法載入/);
    const retry = $$(el, 'button').find((b) => /重試/.test(b.textContent));
    assert.ok(retry);
    const before = calls.length;
    click(retry);
    await waitFor(() => calls.length > before);
  });
});

describe('status 頁：互動', () => {
  test('點設備 → 發出 device.open', async () => {
    const { el, bus } = await mount({ devices: [dev('a'), dev('b')], items: [st('a', 'up'), st('b', 'up')] });
    const got = [];
    bus.on('device.open', (p) => got.push(p));
    click($(el, '.nc-tile[data-device-id="b"]'));
    assert.deepEqual(got, [{ id: 'b' }]);
  });

  test('磚塊是可聚焦的按鈕（鍵盤可操作）', async () => {
    const { el } = await mount({ devices: [dev('a')], items: [st('a', 'up')] });
    assert.equal($(el, '.nc-tile').tagName, 'BUTTON');
    assert.equal($(el, '.nc-tile').type, 'button');
  });

  test('status.changed 即時更新燈號與統計，並重新排序', async () => {
    const { el, bus } = await mount({ devices: [dev('a'), dev('b', { monitor: { critical: true } })], items: [st('a', 'up'), st('b', 'up')] });
    assert.deepEqual(ids(el), ['a', 'b'].sort());
    bus.emit('status.changed', { deviceId: 'b', from: 'up', to: 'down', rttMs: null, at: '2026-10-14T08:30:00.000Z' });
    assert.equal(statNum(el, 'up'), 1);
    assert.equal(statNum(el, 'down'), 1);
    assert.equal(ids(el)[0], 'b', '離線的關鍵設備置頂');
    assert.equal($(el, '.nc-tile[data-device-id="b"] .nc-status').dataset.state, 'down');
  });

  test('status.snapshot 取代全部狀態（SSE 重連後）', async () => {
    const { el, bus } = await mount({ devices: [dev('a'), dev('b')], items: [st('a', 'up'), st('b', 'up')] });
    bus.emit('status.snapshot', { items: [st('a', 'down'), st('b', 'unknown')] });
    assert.equal(statNum(el, 'up'), 0);
    assert.equal(statNum(el, 'down'), 1);
    assert.equal(statNum(el, 'unknown'), 1);
  });

  test('全站篩選改變 → 只顯示符合的設備，統計也跟著變', async () => {
    const devices = [dev('a'), dev('b', { floorId: 'flr_2' })];
    const { el, bus, setFilters } = await mount({ devices, items: [st('a', 'up'), st('b', 'down')] });
    setFilters({ floorId: 'flr_2' });
    bus.emit('filters.changed', { floorId: 'flr_2' });
    assert.deepEqual(ids(el), ['b']);
    assert.equal(statNum(el, 'up'), 0);
    assert.equal(statNum(el, 'down'), 1);
  });

  test('inventory.changed → 重新載入設備清單與狀態', async () => {
    const { el, bus, data, calls } = await mount({ devices: [dev('a')], items: [st('a', 'up')] });
    data['/api/devices'] = [dev('a'), dev('new')];
    data['/api/status'] = [st('a', 'up'), st('new', 'up')];
    const before = calls.length;
    bus.emit('inventory.changed', { collection: 'devices', op: 'create', id: 'new' });
    await waitFor(() => ids(el).includes('new'));
    assert.ok(calls.length > before);
  });
});

describe('status 頁：提示與暫停', () => {
  test('settings 帶 hint 時顯示提示（macOS 區域網路權限）', async () => {
    const hint = '可能未允許「區域網路」權限';
    const { el } = await mount({ devices: [dev('a')], items: [st('a', 'down')], settings: { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null, hint } });
    assert.match($(el, '.nc-status-banner[data-kind="hint"]').textContent, /區域網路/);
  });

  test('沒有 hint 時不顯示提示', async () => {
    const { el } = await mount({ devices: [dev('a')] });
    assert.equal($(el, '.nc-status-banner[data-kind="hint"]'), null);
  });

  test('偵測暫停中 → 顯示橫幅與「恢復偵測」，按下後 PUT pausedUntil:null', async () => {
    const until = new Date(Date.now() + 20 * 60_000).toISOString();
    const { el, calls } = await mount({ devices: [dev('a')], settings: { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: until } });
    const banner = $(el, '.nc-status-banner[data-kind="paused"]');
    assert.ok(banner);
    click($(banner, 'button'));
    await waitFor(() => calls.some((c) => c[0] === 'PUT'));
    assert.deepEqual(calls.find((c) => c[0] === 'PUT').slice(1), ['/api/monitor/settings', { pausedUntil: null }]);
    await waitFor(() => $(el, '.nc-status-banner[data-kind="paused"]') === null);
  });
});

describe('status 頁：24 小時可用率迷你條', () => {
  test('每台載入歷史並畫出 24 格＋百分比（純 SVG）', async () => {
    const now = Date.now();
    const samples = [
      { at: new Date(now - 10 * 60_000).toISOString(), up: true, rttMs: 1 },
      { at: new Date(now - 20 * 60_000).toISOString(), up: false, rttMs: null },
    ];
    const { el, calls } = await mount({ devices: [dev('a'), dev('off', { monitor: { method: 'none' } })], items: [st('a', 'up')], history: { a: samples } });
    await waitFor(() => $(el, '.nc-tile[data-device-id="a"] .nc-uptime-pct')?.textContent.includes('50'));
    const svg = $(el, '.nc-tile[data-device-id="a"] svg.nc-uptime');
    assert.equal($$(svg, 'rect').length, 24);
    assert.match(svg.getAttribute('aria-label'), /50/);
    assert.equal(calls.filter((c) => c[1] === '/api/status/off/history').length, 0, '未偵測的設備不查歷史');
  });

  test('沒有資料時顯示「—」', async () => {
    const { el } = await mount({ devices: [dev('a')], items: [st('a', 'up')] });
    await waitFor(() => $(el, '.nc-uptime-pct'));
    assert.equal($(el, '.nc-uptime-pct').textContent.trim(), '—');
  });
});

describe('status 頁：unmount', () => {
  test('解除所有 bus 訂閱、清掉計時器，之後事件不再影響畫面', async () => {
    const timers = new Set();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const realSetT = globalThis.setTimeout;
    const realClearT = globalThis.clearTimeout;
    const outstanding = new Set();
    globalThis.setInterval = (...a) => { const h = realSet(...a); outstanding.add(h); timers.add(h); return h; };
    globalThis.clearInterval = (h) => { outstanding.delete(h); realClear(h); };
    globalThis.setTimeout = (...a) => { const h = realSetT(...a); outstanding.add(h); return h; };
    globalThis.clearTimeout = (h) => { outstanding.delete(h); realClearT(h); };
    try {
      const { el, bus } = await mount({ devices: [dev('a')], items: [st('a', 'up')] });
      assert.ok(timers.size >= 1, '有週期性更新的計時器');
      statusModule.unmount();
      await new Promise((r) => realSetT(r, 20));
      const html = el.innerHTML;
      bus.emit('status.changed', { deviceId: 'a', from: 'up', to: 'down', rttMs: null, at: '2026-10-14T08:30:00.000Z' });
      bus.emit('status.snapshot', { items: [] });
      assert.equal(el.innerHTML, html);
      // 只允許測試自己的 setTimeout（等待用）以外沒有殘留的 setInterval
      for (const h of timers) assert.equal(outstanding.has(h), false, '週期計時器已清除');
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      globalThis.setTimeout = realSetT;
      globalThis.clearTimeout = realClearT;
    }
  });

  test('在載入途中 unmount 不會丟例外或寫入已卸載的畫面', async () => {
    const t = makeCtx({ devices: [dev('a')], items: [st('a', 'up')] });
    const el = document.createElement('div');
    document.body.append(el);
    const p = statusModule.mount(el, t.ctx);
    statusModule.unmount();
    await p;
    assert.equal(tiles(el).length, 0);
  });
});
