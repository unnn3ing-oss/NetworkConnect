import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../../../contracts/index.js';
import { createMonitor } from '../../../server/modules/monitor/monitor.js';
import { createFakeClock } from './fake-clock.js';

const v = createValidator();

const mkDevice = (id, ip, over = {}) => ({
  id,
  code: id.toUpperCase(),
  name: id,
  categoryId: 'cat_other',
  floorId: 'flr_1',
  roomId: null,
  groupIds: [],
  ip,
  mac: '',
  hostname: '',
  vendor: '',
  model: '',
  uplink: null,
  monitor: { method: 'icmp', port: null, path: '/', intervalSec: 60, critical: false, ...(over.monitor ?? {}) },
  notes: '',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
});

function fakeEvents() {
  const handlers = new Map();
  const connect = new Set();
  const emitted = [];
  return {
    emitted,
    emit(name, payload) {
      emitted.push({ name, payload });
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    onSseConnect(fn) {
      connect.add(fn);
      return () => connect.delete(fn);
    },
    handlerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) + connect.size,
    /** 模擬一條新的 SSE 連線，回傳它收到的訊息 */
    openSse() {
      const got = [];
      for (const fn of connect) fn((name, payload) => got.push({ name, payload }));
      return got;
    },
    of: (name) => emitted.filter((e) => e.name === name).map((e) => e.payload),
  };
}

function fakeRepo() {
  const docs = new Map();
  return { docs, async list() { return [...docs.values()].map((d) => structuredClone(d)); }, async upsert(d) { docs.set(d.deviceId, structuredClone(d)); return d; }, async remove(id) { return docs.delete(id); } };
}

function fakeProber() {
  const calls = [];
  const mode = new Map(); // host → 'down' | 'error'
  let all = null;
  let hold = null; // 若設定，probe 會卡在這個陣列
  return {
    calls,
    set(host, m) { if (m) mode.set(host, m); else mode.delete(host); },
    setAll(m) { all = m; },
    holdAll() { hold = []; return hold; },
    releaseHold() { const h = hold; hold = null; h.forEach((r) => r()); },
    async probe(req) {
      calls.push({ ...req });
      if (hold) await new Promise((r) => hold.push(r));
      const m = mode.get(req.host) ?? all;
      if (m === 'error') throw new Error('模擬檢查出錯');
      if (m === 'down') return { up: false, rttMs: null };
      return { up: true, rttMs: 2 };
    },
  };
}

function setup({ devices = [], platform = 'linux', ping = { available: true }, settings: s0 = {}, random = () => 0 } = {}) {
  const clock = createFakeClock();
  const events = fakeEvents();
  const prober = fakeProber();
  const repo = fakeRepo();
  const store = { devices: devices.map((d) => structuredClone(d)) };
  const settingsState = { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null, ...s0 };
  const settings = {
    get: () => ({ ...settingsState }),
    async update(patch) { Object.assign(settingsState, patch); return { ...settingsState }; },
  };
  const monitor = createMonitor({
    devices: { async list() { return store.devices.map((d) => structuredClone(d)); } },
    historyRepo: repo,
    events,
    prober,
    settings,
    ping,
    platform,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random,
  });
  return {
    clock, events, prober, repo, store, monitor, settingsState,
    /** 模擬 inventory 的異動事件 */
    async changed(collection, op, id) {
      events.emit('inventory.changed', { collection, op, id });
      await monitor.idle();
    },
  };
}

const three = () => [mkDevice('dev_a', '10.0.0.1'), mkDevice('dev_b', '10.0.0.2'), mkDevice('dev_c', '10.0.0.3')];

describe('monitor：基本判定（假時鐘＋假 prober）', () => {
  test('啟動後每台偵測一次；成功 → up，並發出 status.changed（unknown→up）', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.clock.advance(0);
    const items = await t.monitor.listStatus();
    assert.deepEqual(items.map((i) => i.state), ['up', 'up', 'up']);
    for (const i of items) v.assert('api-monitor#StatusItem', i);
    const ch = t.events.of('status.changed');
    assert.equal(ch.length, 3);
    assert.deepEqual([ch[0].from, ch[0].to], ['unknown', 'up']);
    for (const c of ch) v.assert('events#status_changed', c);
    await t.monitor.stop();
  });

  test('連續 3 次失敗才 down；一次成功即 up', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 15 } })] });
    await t.monitor.start();
    await t.clock.advance(0); // up
    t.prober.set('10.0.0.1', 'down');
    await t.clock.advance(15_000);
    assert.equal((await t.monitor.getStatus('dev_a')).state, 'up');
    await t.clock.advance(15_000);
    assert.equal((await t.monitor.getStatus('dev_a')).state, 'up');
    assert.equal((await t.monitor.getStatus('dev_a')).consecutiveFailures, 2);
    await t.clock.advance(15_000);
    const down = await t.monitor.getStatus('dev_a');
    assert.equal(down.state, 'down');
    assert.equal(t.events.of('status.changed').at(-1).to, 'down');
    t.prober.set('10.0.0.1', null);
    await t.clock.advance(15_000);
    assert.equal((await t.monitor.getStatus('dev_a')).state, 'up');
    assert.equal(t.events.of('status.changed').at(-1).from, 'down');
    await t.monitor.stop();
  });

  test('狀態沒變就不發事件', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 15 } })] });
    await t.monitor.start();
    await t.clock.advance(15_000 * 5);
    assert.equal(t.events.of('status.changed').length, 1, '只有第一次 unknown→up');
    await t.monitor.stop();
  });

  test('method=none → disabled，且從不偵測', async () => {
    const t = setup({ devices: [mkDevice('dev_off', '10.0.0.9', { monitor: { method: 'none' } }), mkDevice('dev_a', '10.0.0.1')] });
    await t.monitor.start();
    await t.clock.advance(600_000);
    const off = await t.monitor.getStatus('dev_off');
    assert.equal(off.state, 'disabled');
    assert.equal(t.prober.calls.filter((c) => c.host === '10.0.0.9').length, 0);
    assert.equal((await t.monitor.listStatus()).length, 2, 'GET /api/status 含 disabled');
    await t.monitor.stop();
  });

  test('prober 丟錯（檢查本身出錯）→ unknown＋error，不算失敗次數，也不寫入歷史', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 15 } })] });
    t.prober.set('10.0.0.1', 'error');
    await t.monitor.start();
    await t.clock.advance(60_000);
    const s = await t.monitor.getStatus('dev_a');
    assert.equal(s.state, 'unknown');
    assert.match(s.error, /模擬檢查出錯/);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal((await t.monitor.history('dev_a', 24)).samples.length, 0);
    await t.monitor.stop();
  });

  test('沒有 IP 的設備 → unknown（尚未設定 IP），不呼叫 prober', async () => {
    const t = setup({ devices: [mkDevice('dev_noip', '')] });
    await t.monitor.start();
    await t.clock.advance(0);
    const s = await t.monitor.getStatus('dev_noip');
    assert.equal(s.state, 'unknown');
    assert.match(s.error, /IP/);
    assert.equal(t.prober.calls.length, 0);
    await t.monitor.stop();
  });

  test('prober 收到 method／host／port／path／timeoutMs（取自設定）', async () => {
    const t = setup({
      devices: [mkDevice('dev_h', '10.0.0.5', { monitor: { method: 'http', port: 8080, path: '/ping' } })],
      settings: { timeoutMs: 900 },
    });
    await t.monitor.start();
    await t.clock.advance(0);
    assert.deepEqual(t.prober.calls[0], { method: 'http', host: '10.0.0.5', port: 8080, path: '/ping', timeoutMs: 900 });
    await t.monitor.stop();
  });

  test('每次偵測寫入歷史（up／down 皆記錄）', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 15 } })] });
    await t.monitor.start();
    await t.clock.advance(0);
    t.prober.set('10.0.0.1', 'down');
    await t.clock.advance(15_000);
    const h = await t.monitor.history('dev_a', 24);
    assert.equal(h.deviceId, 'dev_a');
    assert.equal(h.hours, 24);
    assert.deepEqual(h.samples.map((s) => s.up), [true, false]);
    v.assert('api-monitor#HistoryResponse', h);
    await t.monitor.stop();
  });
});

describe('monitor：並發與設備異動', () => {
  test('並發上限取自設定（concurrency=2 時同時最多 2 個偵測）', async () => {
    const devices = Array.from({ length: 6 }, (_, i) => mkDevice(`dev_${i}`, `10.0.1.${i + 1}`));
    const t = setup({ devices, settings: { concurrency: 2 } });
    const held = t.prober.holdAll();
    await t.monitor.start();
    await t.clock.advance(0);
    assert.equal(t.prober.calls.length, 2);
    t.prober.releaseHold();
    await t.clock.settle();
    assert.equal(t.prober.calls.length, 6, '放行後其餘依序執行（之後 hold 解除）');
    void held;
    await t.monitor.stop();
  });

  test('設備刪除（inventory.changed delete）→ 不再偵測、狀態與歷史清掉、計時器清掉', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.clock.advance(60_000);
    const before = t.prober.calls.filter((c) => c.host === '10.0.0.2').length;
    assert.ok(before >= 2);
    t.store.devices = t.store.devices.filter((d) => d.id !== 'dev_b');
    await t.changed('devices', 'delete', 'dev_b');
    await t.clock.advance(600_000);
    assert.equal(t.prober.calls.filter((c) => c.host === '10.0.0.2').length, before);
    assert.deepEqual((await t.monitor.listStatus()).map((i) => i.deviceId), ['dev_a', 'dev_c']);
    assert.equal(await t.monitor.getStatus('dev_b'), undefined);
    await t.monitor.flush();
    assert.equal(t.repo.docs.has('dev_b'), false, '歷史紀錄也被刪除');
    assert.equal(t.repo.docs.has('dev_a'), true);
    await t.monitor.stop();
  });

  test('新增設備（inventory.changed create）→ 很快開始偵測', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1')] });
    await t.monitor.start();
    await t.clock.advance(0);
    t.store.devices.push(mkDevice('dev_new', '10.0.0.77'));
    await t.changed('devices', 'create', 'dev_new');
    await t.clock.advance(0);
    assert.equal((await t.monitor.getStatus('dev_new')).state, 'up');
    await t.monitor.stop();
  });

  test('修改 IP → 狀態重置並立即重測；改成 method=none → disabled', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1')] });
    await t.monitor.start();
    await t.clock.advance(0);
    t.prober.set('10.0.0.99', 'down');
    t.store.devices[0].ip = '10.0.0.99';
    await t.changed('devices', 'update', 'dev_a');
    assert.equal((await t.monitor.getStatus('dev_a')).state, 'unknown');
    await t.clock.advance(0);
    assert.equal(t.prober.calls.at(-1).host, '10.0.0.99');
    t.store.devices[0].monitor.method = 'none';
    await t.changed('devices', 'update', 'dev_a');
    assert.equal((await t.monitor.getStatus('dev_a')).state, 'disabled');
    assert.equal(t.events.of('status.changed').at(-1).to, 'disabled');
    const calls = t.prober.calls.length;
    await t.clock.advance(300_000);
    assert.equal(t.prober.calls.length, calls);
    await t.monitor.stop();
  });

  test('整批匯入（id:"*"）→ 以新的設備清單全部重建', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.clock.advance(0);
    t.store.devices = [mkDevice('dev_x', '10.0.5.1')];
    await t.changed('devices', 'update', '*');
    assert.deepEqual((await t.monitor.listStatus()).map((i) => i.deviceId), ['dev_x']);
    await t.monitor.flush();
    assert.deepEqual([...t.repo.docs.keys()], ['dev_x'].filter((id) => t.repo.docs.has(id)));
    assert.equal(t.repo.docs.has('dev_a'), false);
    await t.monitor.stop();
  });

  test('其他 collection 的異動不觸發重新排程', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.clock.advance(0);
    const calls = t.prober.calls.length;
    await t.changed('rooms', 'update', 'room_x');
    await t.clock.advance(0);
    assert.equal(t.prober.calls.length, calls);
    await t.monitor.stop();
  });
});

describe('monitor：stop()', () => {
  test('stop 後沒有殘留計時器，事件訂閱也解除，歷史已落檔', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.clock.advance(90_000);
    assert.ok(t.clock.pending() > 0);
    await t.monitor.stop();
    assert.equal(t.clock.pending(), 0);
    assert.equal(t.events.handlerCount(), 0);
    assert.equal(t.repo.docs.get('dev_a').samples.length >= 2, true);
    const calls = t.prober.calls.length;
    await t.clock.advance(600_000);
    assert.equal(t.prober.calls.length, calls);
  });

  test('暫停中 stop 也不留計時器', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await t.monitor.updateSettings({ pausedUntil: new Date(t.clock.now() + 30 * 60_000).toISOString() });
    await t.monitor.stop();
    assert.equal(t.clock.pending(), 0);
  });
});

describe('monitor：SSE 與手動檢查', () => {
  test('SSE 新連線送 status.snapshot（含所有設備）', async () => {
    const t = setup({ devices: [...three(), mkDevice('dev_off', '10.0.0.9', { monitor: { method: 'none' } })] });
    await t.monitor.start();
    await t.clock.advance(0);
    const got = t.events.openSse();
    assert.equal(got.length, 1);
    assert.equal(got[0].name, 'status.snapshot');
    assert.equal(got[0].payload.items.length, 4);
    v.assert('events#status_snapshot', got[0].payload);
    await t.monitor.stop();
  });

  test('checkNow 立即偵測一次並回傳最新狀態', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 3600 } })] });
    await t.monitor.start();
    await t.clock.advance(0);
    t.prober.set('10.0.0.1', 'down');
    const item = await t.monitor.checkNow('dev_a');
    assert.equal(item.consecutiveFailures, 1);
    assert.equal(t.prober.calls.length, 2);
    await t.monitor.stop();
  });

  test('checkNow：method=none 回目前狀態（disabled）且不偵測；設備不存在 → 丟 NOT_FOUND', async () => {
    const t = setup({ devices: [mkDevice('dev_off', '10.0.0.9', { monitor: { method: 'none' } })] });
    await t.monitor.start();
    const item = await t.monitor.checkNow('dev_off');
    assert.equal(item.state, 'disabled');
    assert.equal(t.prober.calls.length, 0);
    await assert.rejects(t.monitor.checkNow('dev_none'), (e) => e.code === 'NOT_FOUND');
    await t.monitor.stop();
  });

  test('history：設備不存在 → NOT_FOUND', async () => {
    const t = setup({ devices: three() });
    await t.monitor.start();
    await assert.rejects(t.monitor.history('dev_none', 24), (e) => e.code === 'NOT_FOUND');
    await t.monitor.stop();
  });
});

describe('monitor：睡眠恢復', () => {
  test('醒來時清除失敗計數並立即全部重測，不會把網路尚未恢復的設備誤報離線', async () => {
    const devices = Array.from({ length: 12 }, (_, i) => mkDevice(`dev_${i}`, `10.0.2.${i + 1}`, { monitor: { intervalSec: 60 } }));
    const t = setup({ devices });
    await t.monitor.start();
    await t.clock.advance(0);
    assert.ok((await t.monitor.listStatus()).every((i) => i.state === 'up'));
    // 睡眠前網路剛好不穩：連續兩次失敗
    t.prober.setAll('down');
    await t.clock.advance(60_000);
    await t.clock.advance(60_000);
    assert.ok((await t.monitor.listStatus()).every((i) => i.consecutiveFailures === 2 && i.state === 'up'));
    // 睡 2 小時；醒來時 Wi-Fi 還沒連上（仍然失敗）
    t.clock.jump(2 * 3600_000);
    const before = t.prober.calls.length;
    await t.clock.tick();
    assert.equal(t.prober.calls.length - before, 12, '全部立即重測一次');
    const after = await t.monitor.listStatus();
    assert.ok(after.every((i) => i.state === 'up' && i.consecutiveFailures === 1), '失敗計數已清除後重算，沒有誤報 down');
    assert.equal(t.events.of('status.changed').filter((c) => c.to === 'down').length, 0);
    await t.monitor.stop();
  });
});

describe('monitor：暫停偵測（pausedUntil）', () => {
  test('暫停期間不偵測、不發 status.changed；到期後立即重測', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 15 } })] });
    await t.monitor.start();
    await t.clock.advance(0);
    const until = new Date(t.clock.now() + 30 * 60_000).toISOString();
    const s = await t.monitor.updateSettings({ pausedUntil: until });
    assert.equal(s.pausedUntil, until);
    t.prober.setAll('down');
    const calls = t.prober.calls.length;
    const events = t.events.of('status.changed').length;
    await t.clock.advance(29 * 60_000);
    assert.equal(t.prober.calls.length, calls);
    assert.equal(t.events.of('status.changed').length, events);
    await t.clock.advance(60_000);
    assert.equal(t.prober.calls.length, calls + 1, '到期立即重測');
    await t.monitor.stop();
  });

  test('暫停中手動 check 不偵測，回目前狀態', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1')] });
    await t.monitor.start();
    await t.clock.advance(0);
    await t.monitor.updateSettings({ pausedUntil: new Date(t.clock.now() + 60_000).toISOString() });
    const calls = t.prober.calls.length;
    const item = await t.monitor.checkNow('dev_a');
    assert.equal(item.state, 'up');
    assert.equal(t.prober.calls.length, calls);
    await t.monitor.stop();
  });

  test('pausedUntil: null → 立即恢復；過去的時間 → 等同 null', async () => {
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1', { monitor: { intervalSec: 3600 } })] });
    await t.monitor.start();
    await t.clock.advance(0);
    await t.monitor.updateSettings({ pausedUntil: new Date(t.clock.now() + 3600_000).toISOString() });
    const calls = t.prober.calls.length;
    const s = await t.monitor.updateSettings({ pausedUntil: null });
    await t.clock.advance(0);
    assert.equal(s.pausedUntil, null);
    assert.equal(t.prober.calls.length, calls + 1);
    const past = await t.monitor.updateSettings({ pausedUntil: new Date(t.clock.now() - 1000).toISOString() });
    assert.equal(past.pausedUntil, null);
    await t.monitor.stop();
  });

  test('啟動時已存的 pausedUntil（未來）會被遵守', async () => {
    const future = new Date(Date.parse('2026-10-14T08:00:00.000Z') + 10 * 60_000).toISOString();
    const t = setup({ devices: [mkDevice('dev_a', '10.0.0.1')], settings: { pausedUntil: future } });
    await t.monitor.start();
    await t.clock.advance(5 * 60_000);
    assert.equal(t.prober.calls.length, 0);
    await t.clock.advance(5 * 60_000);
    assert.equal(t.prober.calls.length, 1);
    await t.monitor.stop();
  });
});

describe('monitor：沒有 ping 指令', () => {
  const noPing = { available: false, reason: '找不到 ping 指令，無法使用 ICMP 偵測' };

  test('模組仍運作：icmp 設備標 unknown 並說明原因，tcp 設備照常偵測', async () => {
    const t = setup({
      ping: noPing,
      devices: [mkDevice('dev_i', '10.0.0.1'), mkDevice('dev_t', '10.0.0.2', { monitor: { method: 'tcp', port: 80 } })],
    });
    await t.monitor.start();
    await t.clock.advance(0);
    const i = await t.monitor.getStatus('dev_i');
    assert.equal(i.state, 'unknown');
    assert.match(i.error, /ping/);
    assert.equal((await t.monitor.getStatus('dev_t')).state, 'up');
    assert.deepEqual(t.prober.calls.map((c) => c.method), ['tcp'], '不嘗試呼叫 icmp');
    await t.monitor.stop();
  });
});

describe('monitor：macOS 區域網路權限提示', () => {
  const icmpDevices = () => Array.from({ length: 4 }, (_, i) => mkDevice(`dev_${i}`, `10.0.3.${i + 1}`));

  test('macOS：所有 icmp 設備（≥3 台）同時失敗、但 127.0.0.1 可通 → settings 帶 hint', async () => {
    const t = setup({ platform: 'darwin', devices: icmpDevices() });
    t.prober.setAll('down');
    t.prober.set('127.0.0.1', 'up');
    await t.monitor.start();
    await t.clock.advance(0);
    const s = await t.monitor.getSettings();
    assert.equal(typeof s.hint, 'string');
    assert.match(s.hint, /區域網路/);
    assert.ok(t.prober.calls.some((c) => c.host === '127.0.0.1' && c.method === 'icmp'));
    await t.monitor.stop();
  });

  test('只要有一台 icmp 設備是通的 → 沒有 hint（且 hint 欄位不出現）', async () => {
    const t = setup({ platform: 'darwin', devices: icmpDevices() });
    t.prober.setAll('down');
    t.prober.set('10.0.3.1', 'up');
    await t.monitor.start();
    await t.clock.advance(0);
    const s = await t.monitor.getSettings();
    assert.equal('hint' in s, false);
    v.assert('api-monitor#MonitorSettings', s);
    await t.monitor.stop();
  });

  test('icmp 設備少於 3 台 → 沒有 hint', async () => {
    const t = setup({ platform: 'darwin', devices: icmpDevices().slice(0, 2) });
    t.prober.setAll('down');
    t.prober.set('127.0.0.1', 'up');
    await t.monitor.start();
    await t.clock.advance(0);
    assert.equal('hint' in (await t.monitor.getSettings()), false);
    await t.monitor.stop();
  });

  test('127.0.0.1 也不通（整個網路都壞）→ 沒有 hint', async () => {
    const t = setup({ platform: 'darwin', devices: icmpDevices() });
    t.prober.setAll('down');
    await t.monitor.start();
    await t.clock.advance(0);
    assert.equal('hint' in (await t.monitor.getSettings()), false);
    await t.monitor.stop();
  });

  test('非 macOS 平台不提示（也不多做 127.0.0.1 偵測）', async () => {
    for (const platform of ['win32', 'linux']) {
      const t = setup({ platform, devices: icmpDevices() });
      t.prober.setAll('down');
      await t.monitor.start();
      await t.clock.advance(0);
      assert.equal('hint' in (await t.monitor.getSettings()), false, platform);
      assert.equal(t.prober.calls.some((c) => c.host === '127.0.0.1'), false, platform);
      await t.monitor.stop();
    }
  });

  test('恢復通了之後 hint 消失', async () => {
    const t = setup({ platform: 'darwin', devices: icmpDevices().map((d) => ({ ...d, monitor: { ...d.monitor, intervalSec: 15 } })) });
    t.prober.setAll('down');
    t.prober.set('127.0.0.1', 'up');
    await t.monitor.start();
    await t.clock.advance(0);
    assert.equal(typeof (await t.monitor.getSettings()).hint, 'string');
    t.prober.setAll(null);
    await t.clock.advance(15_000);
    t.clock.jump(60_000); // 讓 hint 的快取過期
    assert.equal('hint' in (await t.monitor.getSettings()), false);
    await t.monitor.stop();
  });
});
