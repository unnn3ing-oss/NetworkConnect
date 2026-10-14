// CSV 匯入：解析器、類別關鍵字、連線方式、整體對應（舊 Google Sheet「設備清單」欄位）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv, matchCategory, mediumFromText, planCsvImport } from '../../../server/modules/io/csv.js';
import { readSeed, createValidator } from '../../../contracts/index.js';

const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/legacy-devices.csv', import.meta.url)), 'utf8');
const categories = readSeed('categories.json');
const validator = createValidator();

describe('parseCsv', () => {
  test('一般欄位、CRLF、尾端換行', () => {
    assert.deepEqual(parseCsv('a,b,c\r\n1,2,3\r\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
    assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });
  test('去掉 BOM', () => {
    assert.deepEqual(parseCsv('﻿名稱,IP\n路由器,1.1.1.1'), [['名稱', 'IP'], ['路由器', '1.1.1.1']]);
  });
  test('引號：欄位內逗號、換行、雙引號跳脫', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","line1\nline2 ""q"""'), [['a', 'b'], ['x, y', 'line1\nline2 "q"']]);
  });
  test('空欄位與全空列保留（列號才對得上）', () => {
    assert.deepEqual(parseCsv('a,b,c\n,,\n1,,3'), [['a', 'b', 'c'], ['', '', ''], ['1', '', '3']]);
  });
  test('引號沒有結尾 → 丟出 VALIDATION', () => {
    assert.throws(() => parseCsv('a,b\n"oops,1'), (e) => e.code === 'VALIDATION');
  });
});

describe('matchCategory：類別關鍵字', () => {
  const cases = [
    ['數據機', 'cat_modem'], ['光纖數據機', 'cat_modem'], ['Modem', 'cat_modem'],
    ['路由器', 'cat_router'], ['路由器 (Router)', 'cat_router'], ['Gateway', 'cat_router'],
    ['Mesh', 'cat_mesh'], ['Mesh 路由器', 'cat_mesh'],
    ['交換器', 'cat_switch'], ['Switch', 'cat_switch'], ['Hub', 'cat_switch'],
    ['PoE交換器', 'cat_poe_switch'], ['PoE Switch', 'cat_poe_switch'],
    ['無線基地台', 'cat_ap'], ['AP', 'cat_ap'], ['Access Point', 'cat_ap'],
    ['NVR', 'cat_nvr'], ['DVR 錄影主機', 'cat_nvr'],
    ['IP Cam', 'cat_camera'], ['攝影機', 'cat_camera'], ['Camera', 'cat_camera'],
    ['電腦', 'cat_pc'], ['筆電', 'cat_pc'], ['Desktop', 'cat_pc'],
    ['手機', 'cat_mobile'], ['平板', 'cat_mobile'], ['iPhone', 'cat_mobile'],
    ['電視', 'cat_tv'], ['電視盒', 'cat_tv'], ['機上盒', 'cat_tv'],
    ['智慧家電', 'cat_iot'], ['智慧插座', 'cat_iot'], ['IoT', 'cat_iot'],
    ['印表機', 'cat_printer'], ['NAS', 'cat_nas'], ['其他', 'cat_other'],
  ];
  for (const [text, id] of cases) {
    test(`「${text}」→ ${id}`, () => {
      assert.deepEqual(matchCategory(text, categories), { categoryId: id, matched: true });
    });
  }
  test('對不到 → 其他（matched:false）；空白也是', () => {
    assert.deepEqual(matchCategory('不明裝置', categories), { categoryId: 'cat_other', matched: false });
    assert.deepEqual(matchCategory('', categories), { categoryId: 'cat_other', matched: false });
  });
  test('自訂類別名稱完全相符時優先', () => {
    const custom = [...categories, { id: 'cat_bell', name: '門鈴', icon: 'other', tier: 'endpoint', builtin: false, defaultMonitor: 'icmp' }];
    assert.deepEqual(matchCategory('門鈴', custom), { categoryId: 'cat_bell', matched: true });
  });
});

describe('mediumFromText', () => {
  test('有線→ethernet、Wi-Fi／無線→wifi、Mesh→mesh、PoE→poe、光纖→fiber，其餘 other', () => {
    for (const [t, m] of [['有線', 'ethernet'], ['Wi-Fi', 'wifi'], ['WiFi', 'wifi'], ['無線', 'wifi'], ['Mesh', 'mesh'], ['PoE', 'poe'], ['光纖', 'fiber'], ['其他', 'other'], ['', 'other'], ['藍牙', 'other']]) {
      assert.equal(mediumFromText(t), m, t);
    }
  });
});

describe('planCsvImport：舊表 fixture（空資料庫）', () => {
  let n = 0;
  const plan = planCsvImport(fixture, { floors: [], rooms: [], devices: [], categories }, { now: '2026-10-14T08:30:00.000Z', newId: (p) => `${p}_t${++n}` });
  const byCode = Object.fromEntries(plan.devices.filter((d) => d.code).map((d) => [d.code, d]));

  test('報告：建立數量、略過列與原因', () => {
    assert.deepEqual(plan.report.created, { devices: 12, floors: 2, rooms: 5 });
    assert.deepEqual(plan.report.skipped, [
      { row: 13, reason: '缺少名稱' },
      { row: 14, reason: '編號 R01 在檔案中重複' },
      { row: 15, reason: 'IP 格式不正確：999.1.1.1' },
    ]);
    assert.deepEqual(plan.report.unmatchedCategories, [{ row: 11, name: '神秘盒子', category: '不明裝置' }]);
    assert.deepEqual(plan.report.warnings, ['第 16 列：找不到上游編號「NOPE」，已設為根節點']);
    validator.assert('api-io#CsvImportReport', { dryRun: false, ...plan.report });
  });

  test('樓層與房間：不存在則建立，房間掛在對應樓層', () => {
    assert.deepEqual(plan.floors.map((f) => f.name), ['1F', '2F']);
    assert.deepEqual(plan.floors.map((f) => f.order), [1, 2]);
    const f1 = plan.floors[0].id;
    const f2 = plan.floors[1].id;
    const roomsOf = (fid) => plan.rooms.filter((r) => r.floorId === fid).map((r) => r.name);
    assert.deepEqual(roomsOf(f1), ['弱電箱', '客廳', '玄關']);
    assert.deepEqual(roomsOf(f2), ['主臥', '書房']);
    assert.equal(byCode.M01.floorId, f1);
    assert.equal(byCode.M01.roomId, plan.rooms.find((r) => r.name === '弱電箱').id);
  });

  test('欄位對應：類別、IP、MAC 正規化、說明＋定位編號、階層不匯入', () => {
    assert.equal(byCode.M01.categoryId, 'cat_modem');
    assert.equal(byCode.R01.categoryId, 'cat_router');
    assert.equal(byCode.SW2.categoryId, 'cat_poe_switch');
    assert.equal(byCode.AP1.categoryId, 'cat_ap');
    assert.equal(byCode.CAM1.categoryId, 'cat_camera');
    assert.equal(byCode.TV1.categoryId, 'cat_tv');
    assert.equal(byCode.GADGET.categoryId, 'cat_other');
    assert.equal(byCode.R01.mac, 'AA:BB:CC:DD:EE:01');
    assert.equal(byCode.R01.ip, '192.168.1.1');
    assert.equal(byCode.M01.notes, 'ISP 提供\n定位編號：A-01');
    assert.equal(byCode.R01.notes, '主要出口, 含 NAT\n定位編號：A-02');
    assert.equal(byCode.CAM1.notes, '防水\r\n戶外 "Door"');
    assert.equal(byCode.SW1.notes, '');
    assert.equal(plan.devices.find((d) => d.name === '沒有編號的 NAS').code, '');
  });

  test('上游：以編號找設備、連線方式／速率／埠', () => {
    assert.equal(byCode.M01.uplink, null);
    assert.deepEqual(byCode.R01.uplink, { deviceId: byCode.M01.id, port: 'LAN1', localPort: 'WAN', medium: 'ethernet', speed: '2.5G' });
    assert.deepEqual(byCode.SW2.uplink, { deviceId: byCode.SW1.id, port: 'SFP1', localPort: 'SFP+', medium: 'fiber', speed: '10G' });
    assert.equal(byCode.AP1.uplink.medium, 'poe');
    assert.equal(byCode.MESH1.uplink.medium, 'mesh');
    assert.equal(byCode.PH1.uplink.medium, 'wifi');
    assert.equal(byCode.TV1.uplink.medium, 'wifi');
    assert.equal(byCode.GADGET.uplink.medium, 'other');
    assert.equal(byCode.ORPH.uplink, null, '找不到上游 → 根節點');
  });

  test('偵測：預設取類別；沒有 IP 的設備不偵測', () => {
    assert.equal(byCode.R01.monitor.method, 'icmp');
    assert.equal(byCode.PH1.monitor.method, 'none');
    assert.equal(byCode.MESH1.monitor.method, 'none');
  });

  test('每一筆都符合 device schema，且 id 不重複', () => {
    for (const d of plan.devices) validator.assert('device', d);
    for (const f of plan.floors) validator.assert('floor', f);
    for (const r of plan.rooms) validator.assert('room', r);
    assert.equal(new Set(plan.devices.map((d) => d.id)).size, plan.devices.length);
  });
});

describe('planCsvImport：已有資料', () => {
  test('既有樓層／房間重用；編號已存在者略過；上游可指到既有設備', () => {
    let n = 0;
    const existing = {
      floors: [{ id: 'flr_1', name: '1F', order: 1, createdAt: 'x', updatedAt: 'x' }],
      rooms: [{ id: 'room_living', floorId: 'flr_1', name: '客廳', order: 1 }],
      devices: [{ id: 'dev_old', code: 'M01', name: '舊數據機', uplink: null }],
      categories,
    };
    const plan = planCsvImport(fixture, existing, { now: '2026-10-14T08:30:00.000Z', newId: (p) => `${p}_t${++n}` });
    assert.deepEqual(plan.report.skipped[0], { row: 2, reason: '編號 M01 已存在' });
    assert.equal(plan.report.created.floors, 1);
    assert.equal(plan.report.created.rooms, 4);
    assert.equal(plan.floors.length, 1);
    const r01 = plan.devices.find((d) => d.code === 'R01');
    assert.equal(r01.uplink.deviceId, 'dev_old');
    const tv = plan.devices.find((d) => d.code === 'TV1');
    assert.equal(tv.roomId, 'room_living');
    assert.equal(tv.floorId, 'flr_1');
  });

  test('上游編號形成迴圈或指向自己 → 設為根節點並警告', () => {
    const csv = '編號,名稱,上游編號\nA,甲,B\nB,乙,A\nC,丙,C\n';
    const plan = planCsvImport(csv, { floors: [], rooms: [], devices: [], categories }, { now: '2026-10-14T08:30:00.000Z', newId: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}` });
    const [a, b, c] = plan.devices;
    assert.equal(a.uplink.deviceId, b.id);
    assert.equal(b.uplink, null);
    assert.equal(c.uplink, null);
    assert.equal(plan.report.warnings.length, 2);
    assert.match(plan.report.warnings[0], /第 3 列.*迴圈/);
    assert.match(plan.report.warnings[1], /第 4 列.*自己/);
  });

  test('有位置沒有分區：位置只對得到一個既有房間時沿用該樓層，否則忽略並警告', () => {
    const csv = '名稱,位置\n甲,客廳\n乙,不存在的房間\n';
    const existing = {
      floors: [{ id: 'flr_1', name: '1F', order: 1, createdAt: 'x', updatedAt: 'x' }],
      rooms: [{ id: 'room_living', floorId: 'flr_1', name: '客廳', order: 1 }],
      devices: [],
      categories,
    };
    const plan = planCsvImport(csv, existing, { now: '2026-10-14T08:30:00.000Z', newId: (p) => `${p}_x${Math.random().toString(36).slice(2, 8)}` });
    assert.equal(plan.devices[0].roomId, 'room_living');
    assert.equal(plan.devices[0].floorId, 'flr_1');
    assert.equal(plan.devices[1].roomId, null);
    assert.equal(plan.devices[1].floorId, null);
    assert.match(plan.report.warnings[0], /第 3 列.*不存在的房間/);
  });
});

describe('planCsvImport：標題列檢查', () => {
  const empty = { floors: [], rooms: [], devices: [], categories };
  const opts = { now: '2026-10-14T08:30:00.000Z', newId: (p) => `${p}_x` };
  test('缺少「名稱」欄 → 400', () => {
    assert.throws(() => planCsvImport('編號,類別\nA,路由器', empty, opts), (e) => e.code === 'VALIDATION' && /名稱/.test(e.message));
  });
  test('空檔案、只有標題列', () => {
    assert.throws(() => planCsvImport('', empty, opts), (e) => e.code === 'VALIDATION');
    const plan = planCsvImport('名稱\n', empty, opts);
    assert.deepEqual(plan.report.created, { devices: 0, floors: 0, rooms: 0 });
  });
  test('二進位內容（含 NUL）不是 CSV → 400', () => {
    assert.throws(() => planCsvImport('名稱\u0000\u0001,x', empty, opts), (e) => e.code === 'VALIDATION');
  });
  test('欄位順序不拘、多餘欄位忽略、標題前後空白與大小寫容忍', () => {
    const plan = planCsvImport(' ip ,備註,名稱 \n192.168.1.5,隨便,印表機甲\n', empty, opts);
    assert.equal(plan.devices.length, 1);
    assert.equal(plan.devices[0].ip, '192.168.1.5');
    assert.equal(plan.devices[0].name, '印表機甲');
  });
  test('全空白的列直接略過、不列入 skipped', () => {
    const plan = planCsvImport('名稱,IP\n,\n甲,\n', empty, opts);
    assert.equal(plan.devices.length, 1);
    assert.deepEqual(plan.report.skipped, []);
  });
});
