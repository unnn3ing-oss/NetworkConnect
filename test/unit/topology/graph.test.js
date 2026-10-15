import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildElements, edgeLabel, statusClass, fadedIds, floorNodeId } from '../../../web/modules/topology/graph.js';

const db = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/db.sample.json', import.meta.url), 'utf8'));
const dev = (id, over = {}) => ({ id, name: id, categoryId: 'cat_router', floorId: 'flr_1', groupIds: [], monitor: { method: 'icmp', critical: false }, uplink: null, ...over });
const up = (deviceId, medium = 'ethernet', extra = {}) => ({ deviceId, port: '', localPort: '', medium, speed: '', ...extra });
const nodes = (r) => r.elements.filter((e) => e.group === 'nodes');
const edges = (r) => r.elements.filter((e) => e.group === 'edges');
const byId = (r, id) => r.elements.find((e) => e.data.id === id);
const has = (el, cls) => el.classes.split(' ').includes(cls);
const F = (over) => ({ floorId: '', roomId: '', groupId: '', categoryId: '', q: '', ...over });

describe('buildElements：根節點與邊', () => {
  test('fixtures：單一根（數據機），每個非根設備一條邊，source 是上游', () => {
    const r = buildElements(db.devices, db.categories, db.floors, new Map());
    assert.deepEqual(r.roots, ['dev_modem']);
    assert.equal(nodes(r).length, db.devices.length);
    assert.equal(edges(r).length, db.devices.length - 1);
    const e = byId(r, 'e:dev_router');
    assert.equal(e.data.source, 'dev_modem');
    assert.equal(e.data.target, 'dev_router');
    assert.equal(e.data.label, 'LAN1 ↔ WAN');
    assert.deepEqual(r.warnings, []);
  });

  test('多根：沒有 uplink 的設備全是根節點，順序同設備清單', () => {
    const r = buildElements([dev('a'), dev('b', { uplink: up('a') }), dev('c'), dev('d', { uplink: up('c') })], [], [], {});
    assert.deepEqual(r.roots, ['a', 'c']);
    assert.ok(has(byId(r, 'a'), 'root') && has(byId(r, 'c'), 'root'));
    assert.ok(!has(byId(r, 'b'), 'root'));
    assert.equal(edges(r).length, 2);
  });

  test('斷鏈：uplink 指向不存在的設備 → 視為根節點、標 orphan、不建邊、回報警告', () => {
    const r = buildElements([dev('a'), dev('b', { uplink: up('ghost') }), dev('c', { uplink: up('b') })], [], [], {});
    assert.deepEqual(r.roots, ['a', 'b']);
    assert.ok(has(byId(r, 'b'), 'root') && has(byId(r, 'b'), 'orphan'));
    assert.ok(!has(byId(r, 'a'), 'orphan'));
    assert.deepEqual(edges(r).map((e) => e.data.id), ['e:c']);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].deviceId, 'b');
    assert.equal(r.warnings[0].type, 'missing-uplink');
  });

  test('上游迴圈（含自己指自己）：每個環挑一台當根，所有設備仍在圖上', () => {
    const r = buildElements([dev('a', { uplink: up('b') }), dev('b', { uplink: up('a') }), dev('s', { uplink: up('s') })], [], [], {});
    assert.equal(nodes(r).length, 3);
    assert.deepEqual(r.roots, ['a', 's']);
    assert.ok(r.warnings.every((w) => w.type === 'cycle'));
    assert.ok(edges(r).every((e) => !r.roots.includes(e.data.target)));
  });

  test('邊的標籤與 medium class', () => {
    assert.equal(edgeLabel({ port: 'G1', localPort: 'eth0', medium: 'ethernet' }), 'G1 ↔ eth0');
    assert.equal(edgeLabel({ port: '', localPort: 'WAN', medium: 'fiber' }), '– ↔ WAN');
    assert.equal(edgeLabel({ port: '', localPort: '', medium: 'wifi' }), '');
    assert.equal(edgeLabel({ port: 'P3', localPort: 'eth0', medium: 'poe' }), '⚡ P3 ↔ eth0');
    assert.equal(edgeLabel({ medium: 'poe' }), '⚡');
    const r = buildElements(db.devices, db.categories, db.floors, {});
    assert.ok(has(byId(r, 'e:dev_mesh2'), 'm-mesh'));
    assert.ok(has(byId(r, 'e:dev_poesw'), 'm-fiber'));
    assert.ok(has(byId(r, 'e:dev_cam1'), 'm-poe'));
    assert.ok(has(byId(r, 'e:dev_tv1'), 'm-wifi'));
  });
});

describe('buildElements：狀態', () => {
  test('statusClass：離線＋關鍵＝紅、離線＋非關鍵＝灰、無資料＝未知、method none＝未監控', () => {
    const crit = dev('x', { monitor: { method: 'icmp', critical: true } });
    const norm = dev('y');
    assert.equal(statusClass(norm, 'up'), 'st-up');
    assert.equal(statusClass(crit, 'down'), 'st-down');
    assert.equal(statusClass(norm, 'down'), 'st-offline');
    assert.equal(statusClass(norm, 'unknown'), 'st-unknown');
    assert.equal(statusClass(norm, undefined), 'st-unknown');
    assert.equal(statusClass(dev('z', { monitor: { method: 'none' } }), undefined), 'st-disabled');
  });

  test('statusMap 可以是 Map 或物件', () => {
    const list = [dev('a'), dev('b', { monitor: { method: 'icmp', critical: true } })];
    const m = buildElements(list, [], [], new Map([['a', 'up'], ['b', 'down']]));
    const o = buildElements(list, [], [], { a: 'up', b: 'down' });
    for (const r of [m, o]) {
      assert.ok(has(byId(r, 'a'), 'st-up'));
      assert.ok(has(byId(r, 'b'), 'st-down'));
    }
  });
});

describe('buildElements：篩選淡化', () => {
  const f = F({ floorId: 'flr_2' });

  test('不符合的節點加 faded 而不是移除；元素總數不變', () => {
    const all = buildElements(db.devices, db.categories, db.floors, {});
    const r = buildElements(db.devices, db.categories, db.floors, {}, { filters: f });
    assert.equal(r.elements.length, all.elements.length);
    for (const d of db.devices) assert.equal(has(byId(r, d.id), 'faded'), d.floorId !== 'flr_2', d.id);
    assert.deepEqual([...fadedIds(db.devices, f)].sort(), db.devices.filter((d) => d.floorId !== 'flr_2').map((d) => d.id).sort());
  });

  test('邊：任一端被淡化就淡化（保持樹完整但視覺退後）', () => {
    const r = buildElements(db.devices, db.categories, db.floors, {}, { filters: f });
    assert.ok(has(byId(r, 'e:dev_router'), 'faded')); // modem、router 都在 1F
    assert.ok(has(byId(r, 'e:dev_ap2'), 'faded')); // ap2 在 2F，但上游 poesw 在 1F
    assert.ok(!has(byId(r, 'e:dev_phone2'), 'faded')); // phone2、ap2 都在 2F
  });

  test('關鍵字篩選與沒有篩選', () => {
    const r = buildElements(db.devices, db.categories, db.floors, {}, { filters: F({ q: 'mesh' }) });
    const visible = nodes(r).filter((n) => !has(n, 'faded')).map((n) => n.data.id);
    assert.ok(visible.includes('dev_mesh1') && visible.includes('dev_mesh2'));
    assert.ok(!visible.includes('dev_modem'));
    const none = buildElements(db.devices, db.categories, db.floors, {}, {});
    assert.ok(nodes(none).every((n) => !has(n, 'faded')));
  });
});

describe('buildElements：依樓層分群（compound）', () => {
  test('每個有設備的樓層一個 compound 父節點，設備的 parent 指向其樓層；依樓層 order 排序', () => {
    const r = buildElements(db.devices, db.categories, db.floors, {}, { groupByFloor: true });
    const parents = nodes(r).filter((n) => n.data.isFloor);
    assert.deepEqual(parents.map((p) => p.data.id), ['floor:flr_1', 'floor:flr_2', 'floor:flr_3']);
    assert.deepEqual(parents.map((p) => p.data.label), ['1F', '2F', '3F']);
    for (const d of db.devices) assert.equal(byId(r, d.id).data.parent, floorNodeId(d.floorId), d.id);
    assert.ok(parents.every((p) => !p.data.parent));
    // 邊仍然跨樓層連線，source／target 都是設備而不是樓層
    const ids = new Set(db.devices.map((d) => d.id));
    assert.ok(edges(r).every((e) => ids.has(e.data.source) && ids.has(e.data.target)));
    assert.equal(byId(r, 'e:dev_ap2').data.source, 'dev_poesw');
  });

  test('沒有設備的樓層不產生父節點；未指定／未知樓層歸「未指定樓層」', () => {
    const list = [dev('a', { floorId: 'flr_1' }), dev('b', { floorId: null }), dev('c', { floorId: 'flr_gone' })];
    const r = buildElements(list, [], db.floors, {}, { groupByFloor: true });
    assert.deepEqual(nodes(r).filter((n) => n.data.isFloor).map((n) => n.data.id), ['floor:flr_1', 'floor:none']);
    assert.equal(byId(r, 'b').data.parent, 'floor:none');
    assert.equal(byId(r, 'c').data.parent, 'floor:none');
  });

  test('未分群時沒有任何 parent；分群時篩選淡化同樣有效且樓層節點不淡化', () => {
    const flat = buildElements(db.devices, db.categories, db.floors, {});
    assert.ok(nodes(flat).every((n) => !('parent' in n.data) && !n.data.isFloor));
    const g = buildElements(db.devices, db.categories, db.floors, {}, { groupByFloor: true, filters: F({ floorId: 'flr_3' }) });
    assert.ok(nodes(g).filter((n) => n.data.isFloor).every((n) => !has(n, 'faded')));
    assert.ok(has(byId(g, 'dev_modem'), 'faded'));
    assert.ok(!has(byId(g, 'dev_laptop'), 'faded'));
  });
});
