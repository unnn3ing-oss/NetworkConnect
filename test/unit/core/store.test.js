import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, COLLECTIONS, NotOwnerError } from '../../../server/core/store.js';
import { makeTmpDir, cleanupAllTmpDirs, sleep } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

async function open(opts = {}) {
  const dataDir = opts.dataDir ?? makeTmpDir();
  const store = await createStore({ dataDir, debounceMs: 20, ...opts });
  return { dataDir, store };
}

describe('store：基本 CRUD', () => {
  test('insert 會產生 <前綴>_<10 碼> 的 id，並可 get／list', async () => {
    const { store } = await open();
    const floors = store.collection('floors');
    const f = await floors.insert({ name: '1F', order: 1 });
    assert.match(f.id, /^flr_[A-Za-z0-9_-]{10}$/);
    assert.deepEqual(await floors.get(f.id), f);
    assert.equal((await floors.list()).length, 1);
    await store.close();
  });

  test('insert 保留呼叫者提供的 id；重複的主鍵丟 CONFLICT', async () => {
    const { store } = await open();
    const floors = store.collection('floors');
    await floors.insert({ id: 'flr_1', name: '1F' });
    await assert.rejects(() => floors.insert({ id: 'flr_1', name: 'dup' }), (e) => e.code === 'CONFLICT');
    await store.close();
  });

  test('以其他欄位為主鍵的 collection（placements 用 deviceId）', async () => {
    const { store } = await open();
    const pl = store.collection('placements');
    await pl.insert({ deviceId: 'dev_a', floorId: 'flr_1', x: 0.1, y: 0.2 });
    assert.equal((await pl.get('dev_a')).x, 0.1);
    await assert.rejects(() => pl.insert({ floorId: 'flr_1', x: 0, y: 0 }), /deviceId/);
    await store.close();
  });

  test('update 淺層合併、不能改主鍵；找不到丟 NOT_FOUND', async () => {
    const { store } = await open();
    const floors = store.collection('floors');
    await floors.insert({ id: 'flr_1', name: '1F', order: 1 });
    const u = await floors.update('flr_1', { name: '一樓' });
    assert.deepEqual(u, { id: 'flr_1', name: '一樓', order: 1 });
    await assert.rejects(() => floors.update('flr_1', { id: 'flr_2' }), /主鍵/);
    await assert.rejects(() => floors.update('flr_x', { name: 'x' }), (e) => e.code === 'NOT_FOUND');
    await store.close();
  });

  test('remove 回傳是否刪除；upsert 不存在則新增、存在則取代', async () => {
    const { store } = await open();
    const pl = store.collection('placements');
    await pl.upsert({ deviceId: 'dev_a', floorId: 'flr_1', x: 0.1, y: 0.1 });
    await pl.upsert({ deviceId: 'dev_a', floorId: 'flr_2', x: 0.5, y: 0.5 });
    assert.equal((await pl.list()).length, 1);
    assert.equal((await pl.get('dev_a')).floorId, 'flr_2');
    assert.equal(await pl.remove('dev_a'), true);
    assert.equal(await pl.remove('dev_a'), false);
    await store.close();
  });

  test('list 支援物件相等、陣列包含、函式篩選', async () => {
    const { store } = await open();
    const dev = store.collection('devices');
    await dev.insert({ id: 'dev_1', name: 'a', floorId: 'flr_1', groupIds: ['grp_a', 'grp_b'] });
    await dev.insert({ id: 'dev_2', name: 'b', floorId: 'flr_2', groupIds: ['grp_b'] });
    assert.deepEqual((await dev.list({ floorId: 'flr_1' })).map((d) => d.id), ['dev_1']);
    assert.deepEqual((await dev.list({ groupIds: 'grp_b' })).map((d) => d.id), ['dev_1', 'dev_2']);
    assert.deepEqual((await dev.list((d) => d.name === 'b')).map((d) => d.id), ['dev_2']);
    await store.close();
  });

  test('回傳的是複本，修改它不會影響儲存內容', async () => {
    const { store } = await open();
    const floors = store.collection('floors');
    const f = await floors.insert({ id: 'flr_1', name: '1F' });
    f.name = 'hacked';
    assert.equal((await floors.get('flr_1')).name, '1F');
    await store.close();
  });

  test('未知的 collection 丟錯', async () => {
    const { store } = await open();
    assert.throws(() => store.collection('nope'), /collection/);
    await store.close();
  });
});

describe('store：持久化', () => {
  test('flush 後寫入 <dataDir>/db/<name>.json，重開可讀回，且沒有殘留暫存檔', async () => {
    const { dataDir, store } = await open();
    await store.collection('floors').insert({ id: 'flr_1', name: '1F' });
    await store.flush();
    const file = path.join(dataDir, 'db', 'floors.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'flr_1', name: '1F' }]);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'db')).filter((f) => f.endsWith('.tmp')), []);
    await store.close();

    const again = await createStore({ dataDir });
    assert.equal((await again.collection('floors').get('flr_1')).name, '1F');
    await again.close();
  });

  test('debounce：連續寫入只落盤一次，且不會立刻寫檔', async () => {
    const { dataDir, store } = await open({ debounceMs: 60 });
    const floors = store.collection('floors');
    for (let i = 0; i < 5; i++) await floors.insert({ id: `flr_${i}`, name: String(i) });
    assert.equal(fs.existsSync(path.join(dataDir, 'db', 'floors.json')), false);
    await sleep(200);
    assert.equal(fs.existsSync(path.join(dataDir, 'db', 'floors.json')), true);
    assert.equal(store.stats().writes, 1);
    await store.close();
  });

  test('只寫入有異動的 collection', async () => {
    const { dataDir, store } = await open();
    await store.collection('floors').insert({ id: 'flr_1', name: '1F' });
    await store.flush();
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'db')), ['floors.json']);
    await store.close();
  });

  test('close 會先把待寫入的資料落盤', async () => {
    const { dataDir, store } = await open({ debounceMs: 10_000 });
    await store.collection('floors').insert({ id: 'flr_1', name: '1F' });
    await store.close();
    assert.equal(fs.existsSync(path.join(dataDir, 'db', 'floors.json')), true);
  });

  test('close 後不留計時器，再寫入會丟錯', async () => {
    const { store } = await open({ debounceMs: 10_000 });
    const floors = store.collection('floors');
    await floors.insert({ id: 'flr_1', name: '1F' });
    await store.close();
    await assert.rejects(() => floors.insert({ id: 'flr_2', name: 'x' }), /已關閉/);
  });

  test('JSON 檔損毀：改名保留為 .corrupt-*，以空資料啟動', async () => {
    const dataDir = makeTmpDir();
    fs.mkdirSync(path.join(dataDir, 'db'));
    fs.writeFileSync(path.join(dataDir, 'db', 'floors.json'), '{ not json');
    const warnings = [];
    const store = await createStore({ dataDir, log: { warn: (...a) => warnings.push(a), info() {}, error() {} } });
    assert.equal((await store.collection('floors').list()).length, 0);
    assert.ok(fs.readdirSync(path.join(dataDir, 'db')).some((f) => f.startsWith('floors.json.corrupt-')));
    assert.equal(warnings.length, 1);
    await store.close();
  });
});

describe('store：資料所有權（規格 §5 第 2 點）', () => {
  test('非擁有者寫入被拒絕（insert／update／remove／upsert 都一樣）', async () => {
    const { store } = await open();
    const monitor = store.forModule('monitor', ['statusHistory']);
    const devices = monitor.collection('devices');
    for (const op of [
      () => devices.insert({ id: 'dev_1', name: 'x' }),
      () => devices.update('dev_1', { name: 'x' }),
      () => devices.remove('dev_1'),
      () => devices.upsert({ id: 'dev_1', name: 'x' }),
    ]) {
      await assert.rejects(op, (e) => e instanceof NotOwnerError && /monitor/.test(e.message) && /devices/.test(e.message));
    }
    assert.equal((await store.collection('devices').list()).length, 0);
    await store.close();
  });

  test('擁有者可以寫入；任何模組都可以讀取別人的 collection', async () => {
    const { store } = await open();
    const inventory = store.forModule('inventory', ['devices']);
    const monitor = store.forModule('monitor', ['statusHistory']);
    await inventory.collection('devices').insert({ id: 'dev_1', name: 'x' });
    assert.equal((await monitor.collection('devices').get('dev_1')).name, 'x');
    assert.equal((await monitor.collection('devices').list()).length, 1);
    await monitor.collection('statusHistory').insert({ deviceId: 'dev_1', samples: [] });
    await store.close();
  });

  test('owns 宣告的 collection 必須存在，且 registry 的擁有者要一致', async () => {
    const { store } = await open();
    assert.throws(() => store.forModule('x', ['nope']), /collection/);
    assert.throws(() => store.forModule('monitor', ['devices']), /擁有者/);
    await store.close();
  });

  test('COLLECTIONS registry 與規格 §7 一致', () => {
    const owners = Object.fromEntries(Object.entries(COLLECTIONS).map(([k, v]) => [k, v.owner]));
    assert.deepEqual(owners, {
      floors: 'inventory', rooms: 'inventory', groups: 'inventory', categories: 'inventory', devices: 'inventory',
      plans: 'floorplan', placements: 'floorplan', statusHistory: 'monitor', nvrs: 'nvr',
    });
  });
});

describe('store：restore（io 模組唯一例外）', () => {
  const snapshot = () => ({
    floors: [{ id: 'flr_1', name: '1F' }],
    devices: [{ id: 'dev_1', name: 'a' }],
  });

  test('只有 io 模組能呼叫 restore，其他模組被拒絕', async () => {
    const { store } = await open();
    await assert.rejects(() => store.forModule('inventory', ['devices']).restore(snapshot()), NotOwnerError);
    await store.close();
  });

  test('io 的 restore 整批覆寫所有 collection（沒給的 collection 變空）', async () => {
    const { dataDir, store } = await open();
    await store.collection('rooms').insert({ id: 'room_1', floorId: 'flr_old', name: 'old' });
    const io = store.forModule('io', []);
    await io.restore(snapshot());
    assert.equal((await store.collection('floors').list()).length, 1);
    assert.equal((await store.collection('rooms').list()).length, 0);
    await store.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'db', 'rooms.json'), 'utf8')), []);
    await store.close();
  });

  test('任何一筆不合法就整批拒絕，原資料不變', async () => {
    const { store } = await open();
    await store.collection('floors').insert({ id: 'flr_keep', name: 'keep' });
    const io = store.forModule('io', []);
    await assert.rejects(() => io.restore({ floors: [{ id: 'flr_1', name: 'ok' }], devices: [{ id: 'dev_1' }, { id: 'dev_1' }] }), /重複/);
    await assert.rejects(() => io.restore({ nope: [] }), /collection/);
    await assert.rejects(() => io.restore({ floors: [{ name: '沒有 id' }] }), /id/);
    assert.deepEqual((await store.collection('floors').list()).map((f) => f.id), ['flr_keep']);
    await store.close();
  });
});

describe('store：寫入驗證 hook', () => {
  test('validate 丟錯時 insert／update 失敗，且資料不變', async () => {
    const validate = (name, doc) => {
      if (name === 'floors' && !doc.name) throw Object.assign(new Error('name 必填'), { code: 'VALIDATION' });
    };
    const { store } = await open({ validate });
    const floors = store.collection('floors');
    await assert.rejects(() => floors.insert({ id: 'flr_1' }), /name 必填/);
    await floors.insert({ id: 'flr_1', name: 'ok' });
    await assert.rejects(() => floors.update('flr_1', { name: '' }), /name 必填/);
    assert.equal((await floors.get('flr_1')).name, 'ok');
    await store.close();
  });
});
