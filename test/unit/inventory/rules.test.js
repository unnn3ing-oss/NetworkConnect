// inventory 純規則：迴圈偵測、下游計算、排序、篩選、預設值補齊
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findUplinkCycle,
  downstreamIds,
  sortDevices,
  filterDevices,
  buildDevice,
  naturalCompare,
} from '../../../server/modules/inventory/rules.js';

const dev = (id, uplinkId = null, extra = {}) => ({
  id,
  code: '',
  name: id,
  uplink: uplinkId ? { deviceId: uplinkId, port: '', localPort: '', medium: 'ethernet', speed: '' } : null,
  ...extra,
});
const byId = (...list) => new Map(list.map((d) => [d.id, d]));

describe('findUplinkCycle：把 id 的上游設為 target 會不會形成迴圈', () => {
  test('自己連自己 → 有迴圈', () => {
    const map = byId(dev('dev_a'));
    assert.ok(findUplinkCycle(map, 'dev_a', 'dev_a'));
  });

  test('直接迴圈：B 的上游是 A，再把 A 的上游設為 B', () => {
    const map = byId(dev('dev_a'), dev('dev_b', 'dev_a'));
    assert.ok(findUplinkCycle(map, 'dev_a', 'dev_b'));
  });

  test('間接迴圈：C→B→A（上游鏈），把 A 的上游設為 C', () => {
    const map = byId(dev('dev_a'), dev('dev_b', 'dev_a'), dev('dev_c', 'dev_b'));
    const cycle = findUplinkCycle(map, 'dev_a', 'dev_c');
    assert.deepEqual(cycle, ['dev_a', 'dev_c', 'dev_b', 'dev_a']);
  });

  test('正常的樹狀、換上游不會誤判', () => {
    const map = byId(dev('dev_root'), dev('dev_sw', 'dev_root'), dev('dev_ap', 'dev_sw'), dev('dev_pc', 'dev_sw'));
    assert.equal(findUplinkCycle(map, 'dev_pc', 'dev_ap'), null);
    assert.equal(findUplinkCycle(map, 'dev_pc', 'dev_root'), null);
    assert.equal(findUplinkCycle(map, 'dev_ap', null), null);
  });

  test('資料本身已有迴圈時不會無窮迴圈', () => {
    const map = byId(dev('dev_x', 'dev_y'), dev('dev_y', 'dev_x'), dev('dev_z'));
    assert.equal(findUplinkCycle(map, 'dev_z', 'dev_x'), null);
  });
});

describe('downstreamIds', () => {
  test('直接下游（directOnly）與所有後代', () => {
    const list = [dev('dev_root'), dev('dev_sw', 'dev_root'), dev('dev_ap', 'dev_sw'), dev('dev_pc', 'dev_sw'), dev('dev_other')];
    assert.deepEqual(downstreamIds(list, 'dev_root', { directOnly: true }).sort(), ['dev_sw']);
    assert.deepEqual(downstreamIds(list, 'dev_root').sort(), ['dev_ap', 'dev_pc', 'dev_sw']);
    assert.deepEqual(downstreamIds(list, 'dev_pc'), []);
  });
});

describe('naturalCompare／sortDevices', () => {
  test('數字依大小而非字元排序', () => {
    assert.ok(naturalCompare('R2', 'R10') < 0);
    assert.ok(naturalCompare('R01', 'R2') < 0);
  });

  test('有編號者依編號自然排序在前，沒編號者依名稱', () => {
    const sorted = sortDevices([
      { id: 'dev_1', code: '', name: 'beta' },
      { id: 'dev_2', code: 'S10', name: 'x' },
      { id: 'dev_3', code: 'S2', name: 'y' },
      { id: 'dev_4', code: '', name: 'alpha' },
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ['dev_3', 'dev_2', 'dev_4', 'dev_1']);
  });
});

describe('filterDevices', () => {
  const list = [
    { id: 'dev_1', code: 'R01', name: '客廳路由器', ip: '192.168.1.1', mac: 'AA:BB:CC:00:11:22', hostname: '', vendor: 'Zyxel', model: '', notes: '', floorId: 'flr_1', roomId: 'room_a', groupIds: ['grp_x'], categoryId: 'cat_router' },
    { id: 'dev_2', code: 'C01', name: '前門攝影機', ip: '192.168.1.31', mac: '', hostname: '', vendor: '', model: '', notes: '防水', floorId: 'flr_2', roomId: null, groupIds: [], categoryId: 'cat_camera' },
  ];
  test('各條件 AND', () => {
    assert.deepEqual(filterDevices(list, { floorId: 'flr_1' }).map((d) => d.id), ['dev_1']);
    assert.deepEqual(filterDevices(list, { groupId: 'grp_x' }).map((d) => d.id), ['dev_1']);
    assert.deepEqual(filterDevices(list, { categoryId: 'cat_camera', floorId: 'flr_1' }), []);
    assert.deepEqual(filterDevices(list, { roomId: 'room_a' }).map((d) => d.id), ['dev_1']);
  });
  test('q 不分大小寫子字串：名稱、編號、IP、MAC、廠牌、說明', () => {
    assert.deepEqual(filterDevices(list, { q: 'zyxel' }).map((d) => d.id), ['dev_1']);
    assert.deepEqual(filterDevices(list, { q: 'c01' }).map((d) => d.id), ['dev_2']);
    assert.deepEqual(filterDevices(list, { q: '.31' }).map((d) => d.id), ['dev_2']);
    assert.deepEqual(filterDevices(list, { q: 'aa:bb' }).map((d) => d.id), ['dev_1']);
    assert.deepEqual(filterDevices(list, { q: '防水' }).map((d) => d.id), ['dev_2']);
  });
  test('MAC 可不帶分隔符號比對', () => {
    assert.deepEqual(filterDevices(list, { q: 'aabbcc0011' }).map((d) => d.id), ['dev_1']);
    assert.deepEqual(filterDevices(list, { q: 'AA-BB-CC' }).map((d) => d.id), ['dev_1']);
  });
  test('空條件回傳全部', () => {
    assert.equal(filterDevices(list, {}).length, 2);
    assert.equal(filterDevices(list, { q: '' }).length, 2);
  });
});

describe('buildDevice：補齊預設值', () => {
  const category = { id: 'cat_mobile', defaultMonitor: 'none' };
  const now = '2026-10-14T08:30:00.000Z';

  test('只給必填欄位：其餘補預設，monitor.method 取類別預設', () => {
    const d = buildDevice({ name: '手機', categoryId: 'cat_mobile' }, { id: 'dev_n1', category, now });
    assert.deepEqual(d, {
      id: 'dev_n1', code: '', name: '手機', categoryId: 'cat_mobile', floorId: null, roomId: null, groupIds: [],
      ip: '', mac: '', hostname: '', vendor: '', model: '', uplink: null,
      monitor: { method: 'none', port: null, path: '/', intervalSec: 60, critical: false },
      notes: '', createdAt: now, updatedAt: now,
    });
  });

  test('uplink 與 monitor 缺的欄位補齊；有帶的保留', () => {
    const d = buildDevice(
      { name: 'x', categoryId: 'cat_mobile', uplink: { deviceId: 'dev_a', medium: 'wifi' }, monitor: { method: 'tcp', port: 22 } },
      { id: 'dev_n2', category, now },
    );
    assert.deepEqual(d.uplink, { deviceId: 'dev_a', port: '', localPort: '', medium: 'wifi', speed: '' });
    assert.deepEqual(d.monitor, { method: 'tcp', port: 22, path: '/', intervalSec: 60, critical: false });
  });
});
