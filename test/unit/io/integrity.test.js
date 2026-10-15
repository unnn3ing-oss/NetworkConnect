// 匯入前的完整性檢查（外鍵、重複、迴圈、平面圖檔案）：回傳所有錯誤，不在第一個就停
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrity, mergeBuiltinCategories } from '../../../server/modules/io/integrity.js';
import { readFixture, readSeed } from '../../../contracts/index.js';

const sample = () => {
  const db = structuredClone(readFixture('db.sample.json'));
  const { statusHistory, ...collections } = db;
  return { collections: { ...collections, statusHistory }, planFiles: { 'flr_1.png': Buffer.from('png-bytes').toString('base64') } };
};
const paths = (errors) => errors.map((e) => e.instancePath);

describe('checkIntegrity', () => {
  test('fixtures 的範例資料沒有任何錯誤', () => {
    assert.deepEqual(checkIntegrity(sample()), []);
  });

  test('id 重複', () => {
    const d = sample();
    d.collections.devices.push({ ...d.collections.devices[0] });
    d.collections.floors.push({ ...d.collections.floors[0] });
    const errs = checkIntegrity(d);
    assert.ok(paths(errs).includes(`/collections/devices/${d.collections.devices.length - 1}`));
    assert.ok(paths(errs).includes(`/collections/floors/${d.collections.floors.length - 1}`));
  });

  test('設備編號（code）重複', () => {
    const d = sample();
    d.collections.devices[1].code = d.collections.devices[0].code;
    assert.ok(paths(checkIntegrity(d)).includes('/collections/devices/1/code'));
  });

  test('外鍵：類別、樓層、房間、組別、上游設備不存在', () => {
    const d = sample();
    Object.assign(d.collections.devices[0], { categoryId: 'cat_nope', floorId: 'flr_nope', roomId: 'room_nope', groupIds: ['grp_nope'] });
    d.collections.devices[1].uplink = { deviceId: 'dev_nope', port: '', localPort: '', medium: 'ethernet', speed: '' };
    const p = paths(checkIntegrity(d));
    for (const want of ['/collections/devices/0/categoryId', '/collections/devices/0/floorId', '/collections/devices/0/roomId', '/collections/devices/0/groupIds/0', '/collections/devices/1/uplink/deviceId']) {
      assert.ok(p.includes(want), `缺少 ${want}`);
    }
  });

  test('房間不屬於設備的樓層', () => {
    const d = sample();
    const dev = d.collections.devices.find((x) => x.roomId);
    const otherFloor = d.collections.floors.find((f) => f.id !== dev.floorId);
    dev.floorId = otherFloor.id;
    assert.ok(paths(checkIntegrity(d)).some((p) => p.endsWith('/roomId')));
  });

  test('上游設備是自己、或形成迴圈', () => {
    const d = sample();
    const [a, b, c] = d.collections.devices;
    const up = (id) => ({ deviceId: id, port: '', localPort: '', medium: 'ethernet', speed: '' });
    a.uplink = up(a.id);
    b.uplink = up(c.id);
    c.uplink = up(b.id);
    const errs = checkIntegrity(d);
    assert.ok(errs.some((e) => e.instancePath === '/collections/devices/0/uplink/deviceId' && /自己/.test(e.message)));
    assert.equal(errs.filter((e) => /迴圈/.test(e.message)).length, 1, '同一個迴圈只報一次');
  });

  test('房間、落點、NVR 的外鍵', () => {
    const d = sample();
    d.collections.rooms[0].floorId = 'flr_nope';
    d.collections.placements[0].deviceId = 'dev_nope';
    d.collections.placements[1].floorId = 'flr_nope';
    d.collections.nvrs[0].deviceId = 'dev_nope';
    d.collections.nvrs[0].channels[0].deviceId = 'dev_nope';
    d.collections.statusHistory[0].deviceId = 'dev_nope';
    const p = paths(checkIntegrity(d));
    for (const want of ['/collections/rooms/0/floorId', '/collections/placements/0/deviceId', '/collections/placements/1/floorId', '/collections/nvrs/0/deviceId', '/collections/nvrs/0/channels/0/deviceId', '/collections/statusHistory/0/deviceId']) {
      assert.ok(p.includes(want), `缺少 ${want}`);
    }
  });

  test('平面圖：樓層不存在、缺圖檔、base64 不合法、檔名是 . 或 ..', () => {
    const d = sample();
    d.collections.plans.push({ floorId: 'flr_nope', file: 'a.png', mime: 'image/png', width: 1, height: 1, updatedAt: '2026-10-14T08:30:00.000Z' });
    d.collections.plans.push({ floorId: 'flr_2', file: 'missing.png', mime: 'image/png', width: 1, height: 1, updatedAt: '2026-10-14T08:30:00.000Z' });
    d.collections.plans.push({ floorId: 'flr_3', file: '..', mime: 'image/png', width: 1, height: 1, updatedAt: '2026-10-14T08:30:00.000Z' });
    d.planFiles['a.png'] = 'AAAA';
    d.planFiles['..'] = 'AAAA';
    d.planFiles['flr_1.png'] = '***not base64***';
    const p = paths(checkIntegrity(d));
    assert.ok(p.includes('/collections/plans/1/floorId'));
    assert.ok(p.includes('/collections/plans/2/file'), '缺圖檔');
    assert.ok(p.includes('/collections/plans/3/file'), '危險檔名');
    assert.ok(p.includes('/planFiles/flr_1.png'), 'base64 不合法');
  });

  test('平面圖：兩個樓層共用同一個圖檔名稱', () => {
    const d = sample();
    const first = d.collections.plans[0];
    d.collections.plans.push({ ...first, floorId: d.collections.floors.find((f) => f.id !== first.floorId).id });
    const p = paths(checkIntegrity(d));
    assert.ok(p.includes(`/collections/plans/${d.collections.plans.length - 1}/file`));
  });
});

describe('mergeBuiltinCategories', () => {
  test('補上缺的內建類別，已有的不動', () => {
    const seed = readSeed('categories.json');
    const custom = { id: 'cat_bell', name: '門鈴', icon: 'other', tier: 'endpoint', builtin: false, defaultMonitor: 'icmp' };
    const edited = { ...seed[0], defaultMonitor: 'none' };
    const merged = mergeBuiltinCategories([custom, edited]);
    assert.equal(merged.length, 16);
    assert.deepEqual(merged.find((c) => c.id === seed[0].id), edited);
    assert.ok(merged.find((c) => c.id === 'cat_bell'));
    assert.ok(seed.every((s) => merged.some((c) => c.id === s.id)));
  });
});
