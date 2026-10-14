// 前端 core 的純邏輯測試（不需要瀏覽器）；DOM 相關行為見 shell.browser.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, createRouter } from '../../../web/core/router.js';
import { FILTER_KEYS, emptyFilters, filtersFromQuery, filtersToQuery, matchDevice, createFilters } from '../../../web/core/filters.js';
import { createBus, SERVER_EVENTS } from '../../../web/core/bus.js';
import { createApi, ApiError } from '../../../web/core/api.js';
import { loadFrontModules, DEFAULT_MODULES, findBackendProblem } from '../../../web/core/module-loader.js';

/** 假的 location：模擬 hash 與 hashchange */
function fakeLocation(initial = '') {
  let hash = initial;
  const listeners = new Set();
  return {
    getHash: () => hash,
    setHash(h, replace) {
      hash = h;
      if (!replace) for (const l of listeners) l(); // 只有 push 會觸發 hashchange；replaceState 不會
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

describe('router：parseHash / buildHash', () => {
  test('解析路徑與 query', () => {
    assert.deepEqual(parseHash('#/devices?floorId=flr_1&q=%E5%AE%A2%E5%BB%B3'), { path: '/devices', query: { floorId: 'flr_1', q: '客廳' } });
  });
  test('空 hash、只有 # → 路徑 /', () => {
    assert.deepEqual(parseHash(''), { path: '/', query: {} });
    assert.deepEqual(parseHash('#'), { path: '/', query: {} });
    assert.deepEqual(parseHash('#/'), { path: '/', query: {} });
  });
  test('沒有 # 開頭的路徑也能解析', () => {
    assert.equal(parseHash('/topology').path, '/topology');
  });
  test('buildHash 略過空值並編碼；參數順序穩定', () => {
    assert.equal(buildHash('/devices', { q: '客 廳', floorId: 'flr_1', roomId: '', groupId: undefined }), '#/devices?floorId=flr_1&q=%E5%AE%A2%20%E5%BB%B3');
    assert.equal(buildHash('/devices', {}), '#/devices');
  });
  test('parse(build(x)) 往返一致', () => {
    const x = { path: '/floorplan', query: { place: 'dev_a', q: 'a&b=c' } };
    assert.deepEqual(parseHash(buildHash(x.path, x.query)), x);
  });
});

describe('router：createRouter', () => {
  test('start 後 current() 反映目前網址，並通知一次（initial）', () => {
    const loc = fakeLocation('#/devices?q=a');
    const r = createRouter({ loc });
    const seen = [];
    r.on((e) => seen.push(e));
    r.start();
    assert.deepEqual(r.current(), { path: '/devices', query: { q: 'a' } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pathChanged, true);
  });

  test('navigate 改路徑 → pathChanged:true', () => {
    const loc = fakeLocation('#/devices');
    const r = createRouter({ loc });
    const seen = [];
    r.start();
    r.on((e) => seen.push(e));
    r.navigate('#/topology');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/topology');
    assert.equal(seen[0].pathChanged, true);
    assert.equal(loc.getHash(), '#/topology');
  });

  test('只有 query 改變 → pathChanged:false（模組不需要重新掛載）', () => {
    const loc = fakeLocation('#/devices');
    const r = createRouter({ loc });
    r.start();
    const seen = [];
    r.on((e) => seen.push(e));
    r.setQuery({ floorId: 'flr_1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pathChanged, false);
    assert.equal(loc.getHash(), '#/devices?floorId=flr_1');
    r.setQuery({ floorId: '' });
    assert.equal(loc.getHash(), '#/devices');
  });

  test('setQuery 保留其他 query 參數（例如 place）', () => {
    const loc = fakeLocation('#/floorplan?place=dev_a');
    const r = createRouter({ loc });
    r.start();
    r.setQuery({ floorId: 'flr_2' });
    assert.deepEqual(r.current().query, { place: 'dev_a', floorId: 'flr_2' });
  });

  test('瀏覽器 hashchange（外部修改網址）也會通知', () => {
    const loc = fakeLocation('#/devices');
    const r = createRouter({ loc });
    r.start();
    const seen = [];
    r.on((e) => seen.push(e));
    loc.setHash('#/status', false);
    assert.equal(seen.at(-1).path, '/status');
  });

  test('stop 後不再通知；off 取消訂閱', () => {
    const loc = fakeLocation('#/devices');
    const r = createRouter({ loc });
    const seen = [];
    const off = r.on((e) => seen.push(e));
    r.start();
    off();
    r.navigate('#/status');
    assert.equal(seen.length, 1);
    r.stop();
    loc.setHash('#/devices', false);
    assert.equal(r.current().path, '/status');
  });
});

describe('filters', () => {
  test('FILTER_KEYS 與 REST query 參數同名', () => {
    assert.deepEqual(FILTER_KEYS, ['floorId', 'roomId', 'groupId', 'categoryId', 'q']);
  });

  test('filtersFromQuery：存在的鍵覆寫、不存在的鍵保留；忽略未知鍵', () => {
    const base = { ...emptyFilters(), floorId: 'flr_1', q: 'x' };
    assert.deepEqual(filtersFromQuery({ roomId: 'room_a', place: 'dev_a' }, base), { floorId: 'flr_1', roomId: 'room_a', groupId: '', categoryId: '', q: 'x' });
  });

  test('filtersToQuery 只輸出非空欄位', () => {
    assert.deepEqual(filtersToQuery({ ...emptyFilters(), floorId: 'flr_1' }), { floorId: 'flr_1' });
  });

  const dev = {
    id: 'dev_a', code: 'R01', name: '客廳 Mesh 主節點', floorId: 'flr_1', roomId: 'room_living', groupIds: ['grp_family'],
    categoryId: 'cat_mesh', ip: '192.168.1.4', mac: 'AA:BB:CC:00:00:01', hostname: '', vendor: 'Zyxel', model: 'WSQ60', notes: '',
  };

  test('matchDevice：各條件 AND', () => {
    const f = (o) => ({ ...emptyFilters(), ...o });
    assert.equal(matchDevice(dev, f({})), true);
    assert.equal(matchDevice(dev, f({ floorId: 'flr_1', roomId: 'room_living', groupId: 'grp_family', categoryId: 'cat_mesh' })), true);
    assert.equal(matchDevice(dev, f({ floorId: 'flr_2' })), false);
    assert.equal(matchDevice(dev, f({ roomId: 'room_x' })), false);
    assert.equal(matchDevice(dev, f({ groupId: 'grp_iot' })), false);
    assert.equal(matchDevice(dev, f({ categoryId: 'cat_pc' })), false);
  });

  test('matchDevice：關鍵字不分大小寫，比對 code／name／ip／mac／vendor／model', () => {
    const f = (q) => ({ ...emptyFilters(), q });
    for (const q of ['r01', '主節點', '192.168.1.4', 'aa:bb', 'zyxel', 'wsq']) assert.equal(matchDevice(dev, f(q)), true, q);
    assert.equal(matchDevice(dev, f('不存在')), false);
  });

  test('createFilters：由網址 query 初始化，並在 set 時同步網址、emit filters.changed', () => {
    const loc = fakeLocation('#/devices?floorId=flr_1');
    const router = createRouter({ loc });
    const bus = createBus();
    const events = [];
    bus.on('filters.changed', (p) => events.push(p));
    const filters = createFilters({ router, bus });
    router.start();
    assert.equal(filters.get().floorId, 'flr_1');

    filters.set({ roomId: 'room_living' });
    assert.equal(loc.getHash(), '#/devices?floorId=flr_1&roomId=room_living');
    assert.deepEqual(events.at(-1), { floorId: 'flr_1', roomId: 'room_living', groupId: '', categoryId: '', q: '' });

    filters.clear();
    assert.equal(loc.getHash(), '#/devices');
    assert.deepEqual(events.at(-1), emptyFilters());
  });

  test('切換分頁（路徑改變）時，目前的篩選會帶進新網址', () => {
    const loc = fakeLocation('#/devices');
    const router = createRouter({ loc });
    const filters = createFilters({ router, bus: createBus() });
    router.start();
    filters.set({ floorId: 'flr_2', q: 'abc' });
    router.navigate('#/topology');
    assert.equal(loc.getHash(), '#/topology?floorId=flr_2&q=abc');
    assert.equal(filters.get().floorId, 'flr_2');
  });

  test('網址帶有篩選（例如連結 #/devices?floorId=flr_3）時覆寫該欄位並 emit', () => {
    const loc = fakeLocation('#/devices?floorId=flr_1&q=a');
    const router = createRouter({ loc });
    const bus = createBus();
    const events = [];
    bus.on('filters.changed', (p) => events.push(p));
    const filters = createFilters({ router, bus });
    router.start();
    events.length = 0;
    router.navigate('#/floorplan?floorId=flr_3&place=dev_a');
    assert.equal(filters.get().floorId, 'flr_3');
    assert.equal(filters.get().q, 'a');
    assert.equal(events.length, 1);
    assert.equal(router.current().query.place, 'dev_a', '其他參數保留');
  });

  test('set 的值沒變時不 emit', () => {
    const loc = fakeLocation('#/devices');
    const router = createRouter({ loc });
    const bus = createBus();
    let n = 0;
    bus.on('filters.changed', () => n++);
    const filters = createFilters({ router, bus });
    router.start();
    filters.set({ q: 'a' });
    filters.set({ q: 'a' });
    assert.equal(n, 1);
  });
});

describe('bus', () => {
  test('on 回傳取消訂閱；emit 傳 payload；off', () => {
    const bus = createBus();
    const got = [];
    const off = bus.on('x', (p) => got.push(p));
    bus.emit('x', { a: 1 });
    off();
    bus.emit('x', { a: 2 });
    const h = (p) => got.push(p);
    bus.on('y', h);
    bus.off('y', h);
    bus.emit('y', 3);
    assert.deepEqual(got, [{ a: 1 }]);
  });

  test('訂閱者丟錯不會影響其他訂閱者', () => {
    const bus = createBus({ onError() {} });
    const got = [];
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', (p) => got.push(p));
    bus.emit('x', 1);
    assert.deepEqual(got, [1]);
  });

  class FakeES {
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; FakeES.instances.push(this); }
    addEventListener(n, fn) { (this.listeners[n] ??= []).push(fn); }
    close() { this.readyState = 2; this.closed = true; }
    // 測試用
    fire(name, data) { for (const fn of this.listeners[name] ?? []) fn({ data: JSON.stringify(data) }); }
  }

  test('connectSse：把 SERVER_EVENTS 轉發進 bus，並發出 sse.connected', () => {
    FakeES.instances = [];
    const bus = createBus();
    const got = [];
    for (const n of [...SERVER_EVENTS, 'sse.connected']) bus.on(n, (p) => got.push([n, p]));
    bus.connectSse({ EventSourceImpl: FakeES });
    const es = FakeES.instances[0];
    assert.equal(es.url, '/api/events');
    es.onopen();
    es.fire('status.changed', { deviceId: 'dev_a' });
    es.fire('status.snapshot', { items: [] });
    assert.deepEqual(got, [['sse.connected', {}], ['status.changed', { deviceId: 'dev_a' }], ['status.snapshot', { items: [] }]]);
    assert.deepEqual(SERVER_EVENTS, ['inventory.changed', 'status.changed', 'status.snapshot', 'placement.changed', 'plan.changed', 'nvr.changed']);
    bus.close();
  });

  test('連線被關閉（HTTP 錯誤等）時自動重連，退避時間遞增且有上限；成功後重置', () => {
    FakeES.instances = [];
    const timers = [];
    const bus = createBus();
    const disconnected = [];
    bus.on('sse.disconnected', () => disconnected.push(1));
    bus.connectSse({
      EventSourceImpl: FakeES, reconnectBaseMs: 100, reconnectMaxMs: 500,
      setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {},
    });
    const fail = () => { const es = FakeES.instances.at(-1); es.readyState = 2; es.onerror(); };
    fail(); assert.equal(timers.at(-1).ms, 100); timers.at(-1).fn();
    fail(); assert.equal(timers.at(-1).ms, 200); timers.at(-1).fn();
    fail(); assert.equal(timers.at(-1).ms, 400); timers.at(-1).fn();
    fail(); assert.equal(timers.at(-1).ms, 500); timers.at(-1).fn();
    assert.equal(FakeES.instances.length, 5);
    FakeES.instances.at(-1).onopen();
    fail(); assert.equal(timers.at(-1).ms, 100, '連線成功後退避重置');
    assert.equal(disconnected.length, 5);
    bus.close();
  });

  test('瀏覽器自己在重連（readyState=CONNECTING）時不重複建立連線', () => {
    FakeES.instances = [];
    const timers = [];
    const bus = createBus();
    bus.connectSse({ EventSourceImpl: FakeES, setTimeoutImpl: (fn, ms) => { timers.push(ms); return 1; }, clearTimeoutImpl() {} });
    const es = FakeES.instances[0];
    es.readyState = 0;
    es.onerror();
    assert.equal(timers.length, 0);
    assert.equal(FakeES.instances.length, 1);
    bus.close();
  });

  test('close 關閉連線並取消重連', () => {
    FakeES.instances = [];
    const cleared = [];
    const bus = createBus();
    bus.connectSse({ EventSourceImpl: FakeES, setTimeoutImpl: () => 42, clearTimeoutImpl: (t) => cleared.push(t) });
    const es = FakeES.instances[0];
    es.readyState = 2; es.onerror();
    bus.close();
    assert.equal(es.closed, true);
    assert.deepEqual(cleared, [42]);
  });
});

describe('api', () => {
  const jsonRes = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  test('GET 帶 query（略過空值），回傳解析後的 JSON', async () => {
    const calls = [];
    const api = createApi({ fetchImpl: async (url, init) => { calls.push([url, init]); return jsonRes(200, [{ id: 'dev_a' }]); } });
    const r = await api.get('/api/devices', { query: { floorId: 'flr_1', q: '', roomId: undefined } });
    assert.deepEqual(r, [{ id: 'dev_a' }]);
    assert.equal(calls[0][0], '/api/devices?floorId=flr_1');
    assert.equal(calls[0][1].method, 'GET');
  });

  test('POST／PATCH／PUT 送 JSON；DELETE 回 204 → null', async () => {
    const calls = [];
    const api = createApi({
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return init.method === 'DELETE' ? { ok: true, status: 204, headers: { get: () => null }, json: async () => { throw new Error('no body'); } } : jsonRes(200, { ok: true });
      },
    });
    await api.post('/api/floors', { name: '1F' });
    await api.patch('/api/floors/flr_1', { name: 'x' });
    await api.put('/api/monitor/settings', { concurrency: 8 });
    assert.equal(await api.delete('/api/floors/flr_1'), null);
    assert.equal(calls[0][1].headers['content-type'], 'application/json');
    assert.equal(calls[0][1].body, JSON.stringify({ name: '1F' }));
    assert.deepEqual(calls.map((c) => c[1].method), ['POST', 'PATCH', 'PUT', 'DELETE']);
  });

  test('upload 送 FormData，不自己設 content-type', async () => {
    const calls = [];
    const api = createApi({ fetchImpl: async (url, init) => { calls.push(init); return jsonRes(200, {}); } });
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.png');
    await api.upload('/api/plans/flr_1', fd);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].body, fd);
    assert.equal(calls[0].headers?.['content-type'], undefined);
  });

  test('錯誤回應 → ApiError，帶 status／code／message／details', async () => {
    const api = createApi({ fetchImpl: async () => jsonRes(409, { error: { code: 'CONFLICT', message: '樓層仍有房間', details: { rooms: 2 } } }) });
    await assert.rejects(() => api.delete('/api/floors/flr_1'), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'CONFLICT');
      assert.equal(e.message, '樓層仍有房間');
      assert.deepEqual(e.details, { rooms: 2 });
      return true;
    });
  });

  test('非 JSON 的錯誤回應也能轉成 ApiError', async () => {
    const api = createApi({ fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => 'text/html' }, text: async () => '<html>', json: async () => { throw new Error('x'); } }) });
    await assert.rejects(() => api.get('/api/x'), (e) => e instanceof ApiError && e.status === 502 && e.code === 'INTERNAL');
  });

  test('網路失敗 → ApiError code=NETWORK', async () => {
    const api = createApi({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(() => api.get('/api/x'), (e) => e instanceof ApiError && e.code === 'NETWORK' && /連線/.test(e.message));
  });

  test('401 時呼叫 onUnauthorized，然後仍丟出 ApiError', async () => {
    let called = 0;
    const api = createApi({ fetchImpl: async () => jsonRes(401, { error: { code: 'UNAUTHORIZED', message: '需要登入' } }), onUnauthorized: () => called++ });
    await assert.rejects(() => api.get('/api/x'), (e) => e.code === 'UNAUTHORIZED');
    assert.equal(called, 1);
  });

  test('url() 組出含 query 的網址（給 <img src> 使用）', () => {
    const api = createApi({ fetchImpl: async () => {} });
    assert.equal(api.url('/api/plans/flr_1/image', { v: 3 }), '/api/plans/flr_1/image?v=3');
  });
});

describe('前端 module-loader（loadFrontModules）', () => {
  const okMod = (id, extra = {}) => ({ default: { id, title: id, icon: id, route: `#/${id}`, order: 10, async mount() {}, unmount() {}, ...extra } });

  test('預設模組清單與規格 §9 一致', () => {
    assert.deepEqual([...DEFAULT_MODULES].sort(), ['cameras', 'dashboard', 'devices', 'floorplan', 'onboarding', 'settings', 'status', 'topology']);
  });

  test('載入成功的模組依 order 排序，並帶出 meta', async () => {
    const orders = { a: 30, b: 10, c: 20 };
    const entries = await loadFrontModules({ ids: ['a', 'b', 'c'], importer: async (id) => okMod(id, { order: orders[id] }) });
    assert.deepEqual(entries.map((e) => e.id), ['b', 'c', 'a']);
    assert.ok(entries.every((e) => e.error === null && typeof e.mod.mount === 'function'));
  });

  test('import 失敗 → 只有該模組帶 error，其他不受影響', async () => {
    const entries = await loadFrontModules({
      ids: ['devices', 'status'],
      importer: async (id) => { if (id === 'devices') throw new SyntaxError('Unexpected token'); return okMod(id); },
    });
    const devices = entries.find((e) => e.id === 'devices');
    assert.match(devices.error.message, /Unexpected token/);
    assert.equal(devices.mod, null);
    assert.equal(devices.title, '設備', '失敗時仍有可顯示的標題與路由');
    assert.equal(devices.route, '#/devices');
    assert.equal(entries.find((e) => e.id === 'status').error, null);
  });

  test('模組形狀不合（沒有 mount、id 不符、route 格式錯）→ error', async () => {
    const bad = {
      noMount: { default: { id: 'noMount', title: 't', route: '#/noMount', order: 1 } },
      wrongId: okMod('other'),
      badRoute: { default: { ...okMod('badRoute').default, route: '/badRoute' } },
      noDefault: {},
    };
    const entries = await loadFrontModules({ ids: Object.keys(bad), importer: async (id) => bad[id] });
    for (const e of entries) assert.ok(e.error, `${e.id} 應該有 error`);
  });

  test('requires：後端模組 failed／disabled 時回報原因', () => {
    const backend = [{ name: 'nvr', state: 'failed', error: 'go2rtc 不存在' }, { name: 'monitor', state: 'disabled' }, { name: 'inventory', state: 'ok' }];
    assert.match(findBackendProblem(['inventory', 'nvr'], backend), /nvr.*go2rtc 不存在/);
    assert.match(findBackendProblem(['monitor'], backend), /monitor.*停用/);
    assert.equal(findBackendProblem(['inventory'], backend), null);
    assert.equal(findBackendProblem([], backend), null);
    assert.equal(findBackendProblem(['nvr'], []), null, '拿不到後端狀態時不擋');
  });
});
