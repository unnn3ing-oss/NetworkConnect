import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator, listSchemaFiles, COLLECTION_SCHEMAS, FIXTURES_DIR } from '../../contracts/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, ...p), 'utf8'));
const v = createValidator();

function assertValid(ref, data, label = ref) {
  const r = v.validate(ref, data);
  assert.equal(r.valid, true, `${label} 應通過 ${ref}：${JSON.stringify(r.errors)}`);
}
function assertInvalid(ref, data) {
  assert.equal(v.validate(ref, data).valid, false, `預期 ${ref} 驗證失敗`);
}

describe('schema 檔案本身', () => {
  test('所有 schema 檔都能被 ajv（strict）編譯，且 $id 與檔名一致', () => {
    const files = listSchemaFiles();
    assert.ok(files.length >= 10, 'schema 數量不足');
    for (const f of files) {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', f);
      assert.ok(s.$id.endsWith('/' + path.basename(f)), `${f} 的 $id 必須以檔名結尾`);
      assert.doesNotThrow(() => v.ajv.getSchema(s.$id), f);
    }
  });

  test('每個 collection 都有對應的 schema', () => {
    for (const name of ['floors', 'rooms', 'groups', 'categories', 'devices', 'plans', 'placements', 'statusHistory', 'nvrs']) {
      assert.ok(COLLECTION_SCHEMAS[name], `${name} 缺 schema`);
    }
  });

  test('未知的 schema 名稱會丟錯', () => {
    assert.throws(() => v.validate('nope', {}), /schema/);
  });
});

describe('fixtures 通過 schema', () => {
  const db = readJson('db.sample.json');

  test('db.sample.json 的每個 collection 都符合各自 schema', () => {
    for (const [name, ref] of Object.entries(COLLECTION_SCHEMAS)) {
      assert.ok(Array.isArray(db[name]), `${name} 必須是陣列`);
      db[name].forEach((doc, i) => assertValid(ref, doc, `${name}[${i}]`));
    }
  });

  test('status.sample.json 符合 StatusList，且混合四種狀態', () => {
    const status = readJson('status.sample.json');
    assertValid('api-monitor#StatusList', status);
    const states = new Set(status.map((s) => s.state));
    for (const s of ['up', 'down', 'unknown', 'disabled']) assert.ok(states.has(s), `缺 ${s}`);
    const deviceIds = new Set(db.devices.map((d) => d.id));
    assert.deepEqual(new Set(status.map((s) => s.deviceId)), deviceIds, '每台設備都要有狀態');
  });

  test('nvr-templates.json 符合 TemplateList 且含規格 §8.4 的品牌', () => {
    const tpl = readJson('nvr-templates.json');
    assertValid('api-nvr#TemplateList', tpl);
    assert.deepEqual(tpl.map((t) => t.id), ['hikvision', 'dahua', 'uniview', 'reolink', 'custom']);
  });

  test('export 格式可由 db.sample.json 組成', () => {
    const exp = {
      format: 'networkconnect-export', version: 1, exportedAt: '2026-10-14T00:00:00.000Z',
      includesSecrets: false, collections: db,
      planFiles: { 'flr_1.png': fs.readFileSync(path.join(FIXTURES_DIR, 'plan.sample.png')).toString('base64') },
    };
    assertValid('api-io#Export', exp);
  });

  test('內建類別 seed 符合 schema，且 sample 內含全部內建類別', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'contracts', 'seed', 'categories.json'), 'utf8'));
    assert.equal(seed.length, 15);
    seed.forEach((c) => { assertValid('category', c); assert.equal(c.builtin, true); });
    const ids = new Set(db.categories.map((c) => c.id));
    for (const c of seed) assert.ok(ids.has(c.id), `sample 缺內建類別 ${c.id}`);
    assert.equal(seed.find((c) => c.id === 'cat_mobile').defaultMonitor, 'none');
  });

  test('plan.sample.png 是合法 PNG，尺寸與 plans 紀錄一致', () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'plan.sample.png'));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const plan = db.plans.find((p) => p.file === 'flr_1.png');
    assert.ok(plan, 'plans 要有 flr_1.png');
    assert.equal(plan.width, w);
    assert.equal(plan.height, h);
    assert.ok(buf.length < 100 * 1024, '範例圖要小');
  });
});

describe('fixtures 資料完整性（規格 G0）', () => {
  const db = readJson('db.sample.json');
  const devById = new Map(db.devices.map((d) => [d.id, d]));

  test('3 層樓、9 個房間、3 個組別', () => {
    assert.equal(db.floors.length, 3);
    assert.equal(db.rooms.length, 9);
    assert.equal(db.groups.length, 3);
  });

  test('至少 25 台設備，id 與 code 不重複', () => {
    assert.ok(db.devices.length >= 25);
    assert.equal(devById.size, db.devices.length);
    const codes = db.devices.map((d) => d.code).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length);
  });

  test('所有外鍵都存在', () => {
    const floors = new Set(db.floors.map((x) => x.id));
    const rooms = new Map(db.rooms.map((x) => [x.id, x]));
    const groups = new Set(db.groups.map((x) => x.id));
    const cats = new Set(db.categories.map((x) => x.id));
    for (const r of db.rooms) assert.ok(floors.has(r.floorId), `房間 ${r.id}`);
    for (const d of db.devices) {
      assert.ok(cats.has(d.categoryId), `${d.id} categoryId`);
      if (d.floorId) assert.ok(floors.has(d.floorId), `${d.id} floorId`);
      if (d.roomId) {
        assert.ok(rooms.has(d.roomId), `${d.id} roomId`);
        assert.equal(rooms.get(d.roomId).floorId, d.floorId, `${d.id} 房間必須屬於該樓層`);
      }
      for (const g of d.groupIds) assert.ok(groups.has(g), `${d.id} groupId`);
      if (d.uplink) assert.ok(devById.has(d.uplink.deviceId), `${d.id} uplink`);
    }
    for (const p of db.placements) {
      assert.ok(devById.has(p.deviceId));
      assert.ok(floors.has(p.floorId));
    }
    for (const p of db.plans) assert.ok(floors.has(p.floorId));
  });

  test('uplink 形成森林：沒有迴圈，且恰有一個根（數據機）', () => {
    for (const d of db.devices) {
      const seen = new Set();
      let cur = d;
      while (cur && cur.uplink) {
        assert.ok(!seen.has(cur.id), `${d.id} 有迴圈`);
        seen.add(cur.id);
        cur = devById.get(cur.uplink.deviceId);
      }
    }
    const roots = db.devices.filter((d) => !d.uplink);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].categoryId, 'cat_modem');
  });

  test('涵蓋 ethernet、wifi、mesh、poe、fiber 各種連線方式', () => {
    const media = new Set(db.devices.filter((d) => d.uplink).map((d) => d.uplink.medium));
    for (const m of ['ethernet', 'wifi', 'mesh', 'poe', 'fiber']) assert.ok(media.has(m), `缺 ${m}`);
  });

  test('NVR：恰 1 台、8 頻道，頻道對應的設備存在', () => {
    assert.equal(db.nvrs.length, 1);
    const nvr = db.nvrs[0];
    assert.equal(nvr.channelCount, 8);
    assert.equal(nvr.channels.length, 8);
    assert.deepEqual(nvr.channels.map((c) => c.ch), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(devById.has(nvr.deviceId));
    for (const c of nvr.channels) if (c.deviceId) assert.ok(devById.has(c.deviceId));
    assert.equal('password' in nvr, false, 'NVR 紀錄不得含密碼');
  });
});

describe('schema 能擋下錯誤資料', () => {
  const db = readJson('db.sample.json');
  const dev = db.devices[0];

  test('device 缺必填欄位', () => {
    const { name, ...rest } = dev;
    assertInvalid('device', rest);
  });
  test('device 的未知欄位', () => {
    assertInvalid('device', { ...dev, extra: 1 });
  });
  test('device.uplink.medium 不在列舉內', () => {
    assertInvalid('device', { ...dev, uplink: { deviceId: 'dev_x', port: '', localPort: '', medium: 'laser', speed: '' } });
  });
  test('monitor.intervalSec 最小 15', () => {
    assertInvalid('device', { ...dev, monitor: { ...dev.monitor, intervalSec: 5 } });
  });
  test('placement 座標必須在 0–1', () => {
    assertInvalid('placement', { deviceId: 'dev_x', floorId: 'flr_1', x: 1.2, y: 0.5 });
  });
  test('錯誤格式只接受規格定義的 code', () => {
    assertValid('api-common#ErrorResponse', { error: { code: 'NOT_FOUND', message: '找不到設備' } });
    assertInvalid('api-common#ErrorResponse', { error: { code: 'BOOM', message: 'x' } });
  });
  test('DeviceCreate 只要求 name 與 categoryId', () => {
    assertValid('api-inventory#DeviceCreate', { name: '測試', categoryId: 'cat_pc' });
    assertInvalid('api-inventory#DeviceCreate', { name: '測試' });
  });
  test('NVR 公開格式有 hasPassword 而無 password', () => {
    const nvr = db.nvrs[0];
    assertValid('api-nvr#NvrPublic', { ...nvr, hasPassword: true });
    assertInvalid('api-nvr#NvrPublic', { ...nvr, hasPassword: true, password: 'x' });
    assertValid('api-nvr#NvrCreate', { name: 'n', brand: 'hikvision', host: '1.2.3.4', username: 'a', password: 'b', channelCount: 4 });
  });
});
