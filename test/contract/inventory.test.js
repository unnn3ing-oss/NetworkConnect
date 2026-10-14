// inventory 契約測試：以真實 startServer（空資料夾）驗證 contracts/api.md §3 的行為與回應 schema。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { createValidator, readSeed } from '../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../helpers/tmp.js';

const validator = createValidator();
const conforms = (ref, data) => {
  const r = validator.validate(ref, data);
  assert.equal(r.valid, true, `${ref} 不符：${JSON.stringify(r.errors)}`);
};

let server;
let events;
const call = async (method, url, body) => {
  const res = await server.app.inject({ method, url, payload: body, headers: body !== undefined ? { 'content-type': 'application/json' } : {} });
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, headers: res.headers };
};
const get = (url) => call('GET', url);
const post = (url, body) => call('POST', url, body);
const patch = (url, body) => call('PATCH', url, body);
const del = (url) => call('DELETE', url);

before(async () => {
  server = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {} });
  server.events.on('inventory.changed', (p) => events.push(p));
});
after(async () => {
  await server.stop();
  cleanupAllTmpDirs();
});
beforeEach(() => {
  events = [];
});

async function reset() {
  for (const d of (await get('/api/devices')).json) await del(`/api/devices/${d.id}`);
  for (const r of (await get('/api/rooms')).json) await del(`/api/rooms/${r.id}`);
  for (const f of (await get('/api/floors')).json) await del(`/api/floors/${f.id}`);
  for (const g of (await get('/api/groups')).json) await del(`/api/groups/${g.id}`);
  for (const c of (await get('/api/categories')).json.filter((x) => !x.builtin)) await del(`/api/categories/${c.id}`);
  events = [];
}

const mkFloor = async (name = '1F', extra = {}) => (await post('/api/floors', { name, ...extra })).json;
const mkRoom = async (floorId, name = '客廳') => (await post('/api/rooms', { floorId, name })).json;
const mkDev = async (name, extra = {}) => {
  const r = await post('/api/devices', { name, categoryId: 'cat_router', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};

describe('內建類別', () => {
  test('首次啟動寫入 15 個內建類別（id 與種子一致），順序依種子', async () => {
    const r = await get('/api/categories');
    assert.equal(r.status, 200);
    conforms('api-inventory#CategoryList', r.json);
    const seed = readSeed('categories.json');
    assert.deepEqual(r.json, seed);
    assert.equal(r.json.length, 15);
  });

  test('內建類別不可刪（409）；只能改 defaultMonitor', async () => {
    const d = await del('/api/categories/cat_router');
    assert.equal(d.status, 409);
    assert.equal(d.json.error.code, 'CONFLICT');

    const bad = await patch('/api/categories/cat_router', { name: '改名' });
    assert.equal(bad.status, 409);

    const ok = await patch('/api/categories/cat_mobile', { defaultMonitor: 'icmp' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.defaultMonitor, 'icmp');
    await patch('/api/categories/cat_mobile', { defaultMonitor: 'none' });
  });

  test('自訂類別 CRUD；被設備使用時不可刪（409）', async () => {
    await reset();
    const c = await post('/api/categories', { name: '門鈴', tier: 'endpoint' });
    assert.equal(c.status, 201);
    conforms('category', c.json);
    assert.deepEqual({ builtin: c.json.builtin, icon: c.json.icon, defaultMonitor: c.json.defaultMonitor }, { builtin: false, icon: 'other', defaultMonitor: 'icmp' });
    assert.deepEqual(events, [{ collection: 'categories', op: 'create', id: c.json.id }]);

    const p = await patch(`/api/categories/${c.json.id}`, { name: '智慧門鈴', icon: 'camera' });
    assert.equal(p.status, 200);
    assert.equal(p.json.name, '智慧門鈴');

    const list = (await get('/api/categories')).json;
    assert.equal(list.at(-1).id, c.json.id, '自訂類別排在內建之後');

    const dev = await mkDev('前門門鈴', { categoryId: c.json.id });
    const blocked = await del(`/api/categories/${c.json.id}`);
    assert.equal(blocked.status, 409);
    await del(`/api/devices/${dev.id}`);
    assert.equal((await del(`/api/categories/${c.json.id}`)).status, 204);
    assert.equal((await get('/api/categories')).json.length, 15);
  });

  test('tier 不合法 → 400 VALIDATION；不存在 → 404', async () => {
    const r = await post('/api/categories', { name: 'x', tier: 'nope' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.equal((await patch('/api/categories/cat_nope', { icon: 'x' })).status, 404);
    assert.equal((await del('/api/categories/cat_nope')).status, 404);
  });
});

describe('樓層', () => {
  test('建立：order 省略時排在最後；列表依 order、name', async () => {
    await reset();
    const a = await post('/api/floors', { name: '1F' });
    assert.equal(a.status, 201);
    conforms('floor', a.json);
    const b = await post('/api/floors', { name: '2F' });
    assert.ok(b.json.order > a.json.order);
    const c = await post('/api/floors', { name: 'B1', order: 0 });
    const list = (await get('/api/floors')).json;
    conforms('api-inventory#FloorList', list);
    assert.deepEqual(list.map((f) => f.name), ['B1', '1F', '2F']);
    assert.deepEqual(events.map((e) => e.op), ['create', 'create', 'create']);
    assert.equal(events[0].collection, 'floors');
    assert.equal(c.status, 201);
  });

  test('PATCH：改名、改 order、updatedAt 更新；未知欄位 400', async () => {
    await reset();
    const f = await mkFloor('1F');
    await new Promise((r) => setTimeout(r, 5));
    const p = await patch(`/api/floors/${f.id}`, { name: '一樓', order: 9 });
    assert.equal(p.status, 200);
    assert.equal(p.json.name, '一樓');
    assert.equal(p.json.order, 9);
    assert.ok(p.json.updatedAt > f.updatedAt);
    assert.equal(p.json.createdAt, f.createdAt);
    assert.equal((await patch(`/api/floors/${f.id}`, { id: 'flr_x' })).status, 400);
    assert.equal((await patch('/api/floors/flr_missing', { name: 'x' })).status, 404);
  });

  test('刪除仍有房間或設備 → 409 並附數量；清空後可刪', async () => {
    await reset();
    const f = await mkFloor('1F');
    const room = await mkRoom(f.id);
    const blocked = await del(`/api/floors/${f.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'CONFLICT');
    assert.deepEqual(blocked.json.error.details, { rooms: 1, devices: 0 });

    await del(`/api/rooms/${room.id}`);
    const dev = await mkDev('路由器', { floorId: f.id });
    const blocked2 = await del(`/api/floors/${f.id}`);
    assert.equal(blocked2.status, 409);
    assert.deepEqual(blocked2.json.error.details, { rooms: 0, devices: 1 });

    await del(`/api/devices/${dev.id}`);
    events = [];
    assert.equal((await del(`/api/floors/${f.id}`)).status, 204);
    assert.deepEqual(events, [{ collection: 'floors', op: 'delete', id: f.id }]);
    assert.equal((await del(`/api/floors/${f.id}`)).status, 404);
  });
});

describe('房間', () => {
  test('建立需要樓層存在（400）；GET 可依 floorId 篩選並排序', async () => {
    await reset();
    const f1 = await mkFloor('1F');
    const f2 = await mkFloor('2F');
    const bad = await post('/api/rooms', { floorId: 'flr_missing', name: '客廳' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION');

    const r2 = (await post('/api/rooms', { floorId: f2.id, name: '主臥', order: 1 })).json;
    const r1b = (await post('/api/rooms', { floorId: f1.id, name: '廚房', order: 2 })).json;
    const r1a = (await post('/api/rooms', { floorId: f1.id, name: '客廳', order: 1 })).json;
    conforms('room', r1a);
    const all = (await get('/api/rooms')).json;
    conforms('api-inventory#RoomList', all);
    assert.deepEqual(all.map((r) => r.id), [r1a.id, r1b.id, r2.id]);
    assert.deepEqual((await get(`/api/rooms?floorId=${f2.id}`)).json.map((r) => r.id), [r2.id]);
    assert.equal((await get('/api/rooms?floorId=bad')).status, 400);
  });

  test('改房間的樓層：房間內設備的 floorId 一併更新並發事件', async () => {
    await reset();
    const f1 = await mkFloor('1F');
    const f2 = await mkFloor('2F');
    const room = await mkRoom(f1.id);
    const dev = await mkDev('AP', { floorId: f1.id, roomId: room.id });
    events = [];
    const p = await patch(`/api/rooms/${room.id}`, { floorId: f2.id });
    assert.equal(p.status, 200);
    assert.equal(p.json.floorId, f2.id);
    assert.equal((await get(`/api/devices/${dev.id}`)).json.floorId, f2.id);
    assert.ok(events.some((e) => e.collection === 'rooms' && e.op === 'update' && e.id === room.id));
    assert.ok(events.some((e) => e.collection === 'devices' && e.op === 'update' && e.id === dev.id));
    assert.equal((await patch(`/api/rooms/${room.id}`, { floorId: 'flr_missing' })).status, 400);
  });

  test('刪除仍有設備 → 409；沒有設備可刪', async () => {
    await reset();
    const f = await mkFloor('1F');
    const room = await mkRoom(f.id);
    const dev = await mkDev('AP', { floorId: f.id, roomId: room.id });
    const blocked = await del(`/api/rooms/${room.id}`);
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.json.error.details, { devices: 1 });
    await del(`/api/devices/${dev.id}`);
    assert.equal((await del(`/api/rooms/${room.id}`)).status, 204);
  });
});

describe('組別', () => {
  test('建立預設顏色；列表依 name；PATCH', async () => {
    await reset();
    const b = await post('/api/groups', { name: 'b 組' });
    assert.equal(b.status, 201);
    conforms('group', b.json);
    assert.equal(b.json.color, '#64748b');
    await post('/api/groups', { name: 'a 組', color: '#3b82f6' });
    const list = (await get('/api/groups')).json;
    conforms('api-inventory#GroupList', list);
    assert.deepEqual(list.map((g) => g.name), ['a 組', 'b 組']);
    const p = await patch(`/api/groups/${b.json.id}`, { color: '#ff0000' });
    assert.equal(p.json.color, '#ff0000');
    assert.equal((await post('/api/groups', { name: 'x', color: 'red' })).status, 400);
  });

  test('刪組別：從所有設備的 groupIds 移除，受影響設備各發 inventory.changed', async () => {
    await reset();
    const g1 = (await post('/api/groups', { name: 'g1' })).json;
    const g2 = (await post('/api/groups', { name: 'g2' })).json;
    const d1 = await mkDev('d1', { groupIds: [g1.id, g2.id] });
    const d2 = await mkDev('d2', { groupIds: [g2.id] });
    const d3 = await mkDev('d3', { groupIds: [g1.id] });
    events = [];
    assert.equal((await del(`/api/groups/${g1.id}`)).status, 204);
    assert.deepEqual((await get(`/api/devices/${d1.id}`)).json.groupIds, [g2.id]);
    assert.deepEqual((await get(`/api/devices/${d2.id}`)).json.groupIds, [g2.id]);
    assert.deepEqual((await get(`/api/devices/${d3.id}`)).json.groupIds, []);
    const updated = events.filter((e) => e.collection === 'devices' && e.op === 'update').map((e) => e.id).sort();
    assert.deepEqual(updated, [d1.id, d3.id].sort());
    assert.ok(events.some((e) => e.collection === 'groups' && e.op === 'delete' && e.id === g1.id));
  });
});

describe('設備：建立與驗證', () => {
  test('只給必填欄位 → 201，補齊預設值，monitor.method 取類別預設', async () => {
    await reset();
    const r = await post('/api/devices', { name: '我的手機', categoryId: 'cat_mobile' });
    assert.equal(r.status, 201);
    conforms('device', r.json);
    assert.match(r.json.id, /^dev_[A-Za-z0-9_-]{10}$/);
    assert.deepEqual(
      { code: r.json.code, floorId: r.json.floorId, groupIds: r.json.groupIds, uplink: r.json.uplink, monitor: r.json.monitor },
      { code: '', floorId: null, groupIds: [], uplink: null, monitor: { method: 'none', port: null, path: '/', intervalSec: 60, critical: false } },
    );
    assert.equal(r.json.createdAt, r.json.updatedAt);
    assert.deepEqual(events, [{ collection: 'devices', op: 'create', id: r.json.id }]);
    const g = await get(`/api/devices/${r.json.id}`);
    assert.deepEqual(g.json, r.json);
  });

  test('缺必填欄位、未知欄位、格式錯誤 → 400 VALIDATION', async () => {
    for (const body of [
      { categoryId: 'cat_router' },
      { name: 'x' },
      { name: 'x', categoryId: 'cat_router', foo: 1 },
      { name: 'x', categoryId: 'cat_router', ip: '999.1.1.1' },
      { name: 'x', categoryId: 'cat_router', mac: 'zz' },
      { name: 'x', categoryId: 'cat_router', monitor: { intervalSec: 5 } },
      { name: 'x', categoryId: 'cat_router', uplink: { deviceId: 'dev_a' } },
    ]) {
      const r = await post('/api/devices', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'VALIDATION');
      conforms('api-common#ErrorResponse', r.json);
    }
  });

  test('外鍵不存在 → 400：類別、樓層、房間、組別、上游設備', async () => {
    await reset();
    const f = await mkFloor('1F');
    for (const extra of [
      { categoryId: 'cat_missing' },
      { floorId: 'flr_missing' },
      { floorId: f.id, roomId: 'room_missing' },
      { groupIds: ['grp_missing'] },
      { uplink: { deviceId: 'dev_missing', medium: 'ethernet' } },
    ]) {
      const r = await post('/api/devices', { name: 'x', categoryId: 'cat_router', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.json.error.code, 'VALIDATION');
    }
  });

  test('roomId 必須屬於 floorId（含 floorId 為 null）', async () => {
    await reset();
    const f1 = await mkFloor('1F');
    const f2 = await mkFloor('2F');
    const room = await mkRoom(f1.id);
    const wrong = await post('/api/devices', { name: 'x', categoryId: 'cat_router', floorId: f2.id, roomId: room.id });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, 'VALIDATION');
    const noFloor = await post('/api/devices', { name: 'x', categoryId: 'cat_router', roomId: room.id });
    assert.equal(noFloor.status, 400);
    const ok = await post('/api/devices', { name: 'x', categoryId: 'cat_router', floorId: f1.id, roomId: room.id });
    assert.equal(ok.status, 201);
    // PATCH 單改 floorId 造成不一致 → 400
    const bad = await patch(`/api/devices/${ok.json.id}`, { floorId: f2.id });
    assert.equal(bad.status, 400);
    const move = await patch(`/api/devices/${ok.json.id}`, { floorId: f2.id, roomId: null });
    assert.equal(move.status, 200);
  });

  test('code 非空時全域不可重複 → 409；空字串可重複；自己改自己不衝突', async () => {
    await reset();
    const a = await mkDev('a', { code: 'R01' });
    const dup = await post('/api/devices', { name: 'b', categoryId: 'cat_router', code: 'R01' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'CONFLICT');
    await mkDev('c');
    await mkDev('d');
    const self = await patch(`/api/devices/${a.id}`, { code: 'R01', name: 'a2' });
    assert.equal(self.status, 200);
    const b = await mkDev('b', { code: 'R02' });
    assert.equal((await patch(`/api/devices/${b.id}`, { code: 'R01' })).status, 409);
  });
});

describe('設備：PATCH 與迴圈', () => {
  test('PATCH 部分更新；uplink、monitor 整個取代並補齊預設；updatedAt 更新', async () => {
    await reset();
    const up = await mkDev('上游');
    const d = await mkDev('設備', { vendor: 'Zyxel', monitor: { method: 'tcp', port: 80, critical: true } });
    await new Promise((r) => setTimeout(r, 5));
    const p = await patch(`/api/devices/${d.id}`, { uplink: { deviceId: up.id, medium: 'poe', port: 'LAN1' }, monitor: { method: 'http' } });
    assert.equal(p.status, 200);
    conforms('device', p.json);
    assert.equal(p.json.vendor, 'Zyxel');
    assert.deepEqual(p.json.uplink, { deviceId: up.id, port: 'LAN1', localPort: '', medium: 'poe', speed: '' });
    assert.deepEqual(p.json.monitor, { method: 'http', port: null, path: '/', intervalSec: 60, critical: false });
    assert.ok(p.json.updatedAt > d.updatedAt);
    const cleared = await patch(`/api/devices/${d.id}`, { uplink: null });
    assert.equal(cleared.json.uplink, null);
    assert.equal((await patch(`/api/devices/${d.id}`, { id: 'dev_x' })).status, 400);
    assert.equal((await patch('/api/devices/dev_missing', { name: 'x' })).status, 404);
  });

  test('自己連自己 → 422 CYCLE', async () => {
    await reset();
    const d = await mkDev('d');
    const r = await patch(`/api/devices/${d.id}`, { uplink: { deviceId: d.id, medium: 'ethernet' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'CYCLE');
    conforms('api-common#ErrorResponse', r.json);
    assert.equal((await get(`/api/devices/${d.id}`)).json.uplink, null);
  });

  test('直接迴圈：B 的上游是 A，再把 A 的上游設為 B → 422', async () => {
    await reset();
    const a = await mkDev('a');
    const b = await mkDev('b', { uplink: { deviceId: a.id, medium: 'ethernet' } });
    const r = await patch(`/api/devices/${a.id}`, { uplink: { deviceId: b.id, medium: 'ethernet' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'CYCLE');
  });

  test('間接迴圈：C→B→A，把 A 的上游設為 C → 422；資料不變', async () => {
    await reset();
    const a = await mkDev('a');
    const b = await mkDev('b', { uplink: { deviceId: a.id, medium: 'ethernet' } });
    const c = await mkDev('c', { uplink: { deviceId: b.id, medium: 'ethernet' } });
    events = [];
    const r = await patch(`/api/devices/${a.id}`, { uplink: { deviceId: c.id, medium: 'ethernet' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'CYCLE');
    assert.equal((await get(`/api/devices/${a.id}`)).json.uplink, null);
    assert.deepEqual(events, []);
  });

  test('合法的換上游不誤判', async () => {
    await reset();
    const root = await mkDev('root');
    const sw = await mkDev('sw', { uplink: { deviceId: root.id, medium: 'ethernet' } });
    const ap = await mkDev('ap', { uplink: { deviceId: sw.id, medium: 'ethernet' } });
    const r = await patch(`/api/devices/${ap.id}`, { uplink: { deviceId: root.id, medium: 'wifi' } });
    assert.equal(r.status, 200);
  });
});

describe('設備：刪除與下游', () => {
  test('刪除上游設備：下游 uplink 設為 null，回應 204 並以標頭列出受影響設備；每台發事件', async () => {
    await reset();
    const root = await mkDev('root');
    const sw = await mkDev('sw', { uplink: { deviceId: root.id, medium: 'ethernet' } });
    const ap = await mkDev('ap', { uplink: { deviceId: sw.id, medium: 'ethernet' } });
    const pc = await mkDev('pc', { uplink: { deviceId: sw.id, medium: 'ethernet' } });
    events = [];
    const r = await del(`/api/devices/${sw.id}`);
    assert.equal(r.status, 204);
    assert.deepEqual(r.headers['x-detached-devices'].split(',').sort(), [ap.id, pc.id].sort());
    assert.equal((await get(`/api/devices/${ap.id}`)).json.uplink, null);
    assert.equal((await get(`/api/devices/${pc.id}`)).json.uplink, null);
    assert.equal((await get(`/api/devices/${root.id}`)).status, 200);
    assert.equal((await get(`/api/devices/${sw.id}`)).status, 404);
    assert.deepEqual(events.filter((e) => e.op === 'delete'), [{ collection: 'devices', op: 'delete', id: sw.id }]);
    assert.deepEqual(events.filter((e) => e.op === 'update').map((e) => e.id).sort(), [ap.id, pc.id].sort());
  });

  test('沒有下游時不帶標頭；不存在 → 404', async () => {
    await reset();
    const d = await mkDev('d');
    const r = await del(`/api/devices/${d.id}`);
    assert.equal(r.status, 204);
    assert.equal(r.headers['x-detached-devices'], undefined);
    assert.equal((await del(`/api/devices/${d.id}`)).status, 404);
  });
});

describe('GET /api/devices 篩選與排序', () => {
  test('floorId／roomId／groupId／categoryId／q（名稱、編號、IP、MAC）', async () => {
    await reset();
    const f1 = await mkFloor('1F');
    const f2 = await mkFloor('2F');
    const room = await mkRoom(f1.id);
    const g = (await post('/api/groups', { name: '家用' })).json;
    const r01 = await mkDev('客廳路由器', { code: 'R01', ip: '192.168.1.1', mac: 'AA:BB:CC:00:11:22', floorId: f1.id, roomId: room.id, groupIds: [g.id] });
    const c10 = await mkDev('前門攝影機', { code: 'C10', ip: '192.168.1.31', categoryId: 'cat_camera', floorId: f2.id });
    const c2 = await mkDev('後門攝影機', { code: 'C2', ip: '192.168.1.32', categoryId: 'cat_camera', floorId: f2.id });
    const noCode = await mkDev('無編號設備');

    const ids = async (qs) => {
      const r = await get(`/api/devices${qs}`);
      assert.equal(r.status, 200);
      conforms('api-inventory#DeviceList', r.json);
      return r.json.map((d) => d.id);
    };
    assert.deepEqual(await ids(''), [c2.id, c10.id, r01.id, noCode.id]); // 編號自然排序（C2 < C10 < R01），無編號者在後
    assert.deepEqual(await ids(`?floorId=${f1.id}`), [r01.id]);
    assert.deepEqual(await ids(`?roomId=${room.id}`), [r01.id]);
    assert.deepEqual(await ids(`?groupId=${g.id}`), [r01.id]);
    assert.deepEqual(await ids('?categoryId=cat_camera'), [c2.id, c10.id]);
    assert.deepEqual(await ids(`?categoryId=cat_camera&floorId=${f1.id}`), []);
    assert.deepEqual(await ids('?q=%E8%B7%AF%E7%94%B1'), [r01.id]); // 路由
    assert.deepEqual(await ids('?q=c10'), [c10.id]);
    assert.deepEqual(await ids('?q=192.168.1.3'), [c2.id, c10.id]);
    assert.deepEqual(await ids('?q=aa:bb:cc'), [r01.id]);
    assert.deepEqual(await ids('?q=aabbcc0011'), [r01.id]);
  });

  test('query 不合法 → 400', async () => {
    assert.equal((await get('/api/devices?floorId=nope')).status, 400);
    assert.equal((await get('/api/devices?foo=1')).status, 400);
  });
});

describe('持久化與 id', () => {
  test('同一毫秒連續建立多筆不會 id 衝突或遺失', async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/api/devices', { name: `並行 ${i}`, categoryId: 'cat_pc', code: `P${i}` })));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.json.id)).size, 20);
    assert.equal((await get('/api/devices')).json.length, 20);
  });

  test('並行建立相同 code：只有一筆成功，其餘 409', async () => {
    await reset();
    const rs = await Promise.all(Array.from({ length: 5 }, () => post('/api/devices', { name: 'dup', categoryId: 'cat_pc', code: 'SAME' })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 4);
  });
});
