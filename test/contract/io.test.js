// io 契約測試：匯出入 JSON（含失敗不寫入）與 CSV 匯入（contracts/api.md §7）
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';
import { createValidator, readFixture, FIXTURES_DIR } from '../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../helpers/tmp.js';

const validator = createValidator();
const conforms = (ref, data) => {
  const r = validator.validate(ref, data);
  assert.equal(r.valid, true, `${ref} 不符：${JSON.stringify(r.errors).slice(0, 500)}`);
};
const csvFixture = fs.readFileSync(fileURLToPath(new URL('../unit/io/fixtures/legacy-devices.csv', import.meta.url)));

let server;
let dataDir;
let seen;

before(async () => {
  dataDir = makeTmpDir();
  server = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {} });
  for (const name of ['inventory.changed', 'plan.changed', 'nvr.changed']) server.events.on(name, (p) => seen.push([name, p]));
});
after(async () => {
  await server.stop();
  cleanupAllTmpDirs();
});
beforeEach(() => {
  seen = [];
});

const inject = async (opts) => {
  const res = await server.app.inject(opts);
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, headers: res.headers, body: res.body };
};
const getJson = (url) => inject({ method: 'GET', url });
const postJson = (url, body) => inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json' } });

function multipart(fieldname, filename, content, contentType = 'text/csv') {
  const boundary = '----ncTestBoundary7MA4YWxkTrZu0gW';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const postCsv = (content, query = '', fieldname = 'file') =>
  inject({ method: 'POST', url: `/api/import/csv${query}`, ...multipart(fieldname, 'devices.csv', content) });

/** 由 fixtures 組出一份可匯入的 Export */
function sampleExport() {
  const db = structuredClone(readFixture('db.sample.json'));
  const { statusHistory, ...collections } = db;
  return {
    format: 'networkconnect-export',
    version: 1,
    exportedAt: '2026-10-14T08:30:00.000Z',
    includesSecrets: false,
    collections,
    planFiles: { 'flr_1.png': fs.readFileSync(path.join(FIXTURES_DIR, 'plan.sample.png')).toString('base64') },
  };
}

const counts = async () => {
  const out = {};
  for (const name of ['floors', 'rooms', 'groups', 'categories', 'devices']) out[name] = (await getJson(`/api/${name}`)).json.length;
  return out;
};

describe('GET /api/export', () => {
  test('空資料：符合 Export schema，只有內建類別；檔名與標頭', async () => {
    const r = await getJson('/api/export');
    assert.equal(r.status, 200);
    conforms('api-io#Export', r.json);
    assert.equal(r.json.includesSecrets, false);
    assert.equal('secrets' in r.json, false);
    assert.equal(r.json.collections.categories.length, 15);
    assert.equal(r.json.collections.devices.length, 0);
    assert.match(r.headers['content-disposition'], /^attachment; filename="networkconnect-\d{8}\.json"$/);
  });

  test('query 不合法 → 400', async () => {
    assert.equal((await getJson('/api/export?secrets=2')).status, 400);
    assert.equal((await getJson('/api/export?foo=1')).status, 400);
  });
});

describe('POST /api/import → GET /api/export 往返', () => {
  test('匯入 fixtures：200＋筆數；資料可由 API 讀回；匯出與匯入一致；平面圖檔寫入磁碟；發出事件', async () => {
    const data = sampleExport();
    const r = await postJson('/api/import', data);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    conforms('api-io#ImportResult', r.json);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.counts.devices, 30);
    assert.equal(r.json.counts.floors, 3);

    assert.equal((await getJson('/api/devices')).json.length, 30);
    assert.equal((await getJson('/api/rooms')).json.length, 9);

    const out = (await getJson('/api/export')).json;
    conforms('api-io#Export', out);
    for (const name of Object.keys(data.collections)) {
      const key = name === 'statusHistory' ? null : name;
      if (!key) continue;
      const sortId = (a) => [...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      assert.deepEqual(sortId(out.collections[name]), sortId(data.collections[name]), name);
    }
    assert.deepEqual(out.planFiles, data.planFiles);
    const onDisk = fs.readFileSync(path.join(dataDir, 'plans', 'flr_1.png'));
    assert.equal(onDisk.toString('base64'), data.planFiles['flr_1.png']);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'plans')), ['flr_1.png'], '不留暫存檔');

    const names = seen.map(([n]) => n);
    for (const col of ['floors', 'rooms', 'groups', 'categories', 'devices']) {
      assert.ok(seen.some(([n, p]) => n === 'inventory.changed' && p.collection === col && p.id === '*' && p.op === 'update'), `inventory.changed ${col}`);
    }
    assert.ok(names.includes('nvr.changed'));
    assert.deepEqual(seen.find(([n]) => n === 'nvr.changed')[1], { id: '*' });
    assert.deepEqual(
      seen.filter(([n]) => n === 'plan.changed').map(([, p]) => p.floorId).sort(),
      ['flr_1', 'flr_2', 'flr_3'],
    );
  });

  test('預設匯出不含密碼；secrets=1 含 nvr 密碼但不含 auth／auth:key', async () => {
    await server.ctx.secrets.set('nvr:nvr_main', 'p@ss:word/1');
    try {
      const plain = (await getJson('/api/export')).json;
      assert.equal(plain.includesSecrets, false);
      assert.equal('secrets' in plain, false);
      assert.ok(!JSON.stringify(plain).includes('p@ss:word/1'));

      const withSecrets = (await getJson('/api/export?secrets=1')).json;
      conforms('api-io#Export', withSecrets);
      assert.equal(withSecrets.includesSecrets, true);
      assert.deepEqual(withSecrets.secrets, { 'nvr:nvr_main': 'p@ss:word/1' });
    } finally {
      await server.ctx.secrets.delete('nvr:nvr_main');
    }
  });

  test('匯出時 auth／auth:key 不會外洩（即使存在）', async () => {
    await server.ctx.secrets.set('nvr:nvr_main', 'pw');
    await server.ctx.secrets.set('auth:key', 'hmac-key'); // 只有 auth（雜湊）存在才會啟用密碼保護，auth:key 單獨存在不影響請求
    try {
      const out = (await getJson('/api/export?secrets=1')).json;
      assert.deepEqual(out.secrets, { 'nvr:nvr_main': 'pw' });
    } finally {
      await server.ctx.secrets.delete('nvr:nvr_main');
      await server.ctx.secrets.delete('auth:key');
    }
  });

  test('含 secrets 的匯入寫入 nvr 密碼，忽略 auth 類鍵；沒有對應 NVR 的舊密碼被清掉', async () => {
    await server.ctx.secrets.set('nvr:nvr_gone', 'old');
    const data = sampleExport();
    data.includesSecrets = true;
    data.secrets = { 'nvr:nvr_main': 'restored-pw', 'nvr:nvr_unknown': 'x', auth: 'evil-hash', 'auth:key': 'evil-key' };
    const r = await postJson('/api/import', data);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(server.ctx.secrets.get('nvr:nvr_main'), 'restored-pw');
    assert.equal(server.ctx.secrets.has('auth'), false);
    assert.equal(server.ctx.secrets.has('auth:key'), false);
    assert.equal(server.ctx.secrets.has('nvr:nvr_unknown'), false);
    assert.equal(server.ctx.secrets.has('nvr:nvr_gone'), false);
  });

  test('匯入不含內建類別的資料 → 自動補回 15 個內建類別', async () => {
    const data = sampleExport();
    data.collections.categories = [];
    data.collections.devices = [];
    data.collections.placements = [];
    data.collections.nvrs = [];
    const r = await postJson('/api/import', data);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await getJson('/api/categories')).json.length, 15);
  });

  test('沒有帶 statusHistory：保留仍存在設備的歷史', async () => {
    const data = sampleExport();
    assert.equal((await postJson('/api/import', data)).status, 200);
    await server.store.collection('statusHistory').upsert({ deviceId: 'dev_router', samples: [{ at: '2026-10-14T08:00:00.000Z', up: true, rttMs: 1 }] });
    await server.store.collection('statusHistory').upsert({ deviceId: 'dev_printer', samples: [{ at: '2026-10-14T08:00:00.000Z', up: true, rttMs: 1 }] });
    data.collections.devices = data.collections.devices.filter((d) => d.id !== 'dev_printer');
    data.collections.placements = data.collections.placements.filter((p) => p.deviceId !== 'dev_printer');
    data.collections.devices.forEach((d) => {
      if (d.uplink?.deviceId === 'dev_printer') d.uplink = null;
    });
    data.collections.nvrs.forEach((n) => n.channels.forEach((c) => { if (c.deviceId === 'dev_printer') c.deviceId = null; }));
    assert.equal((await postJson('/api/import', data)).status, 200);
    const left = (await server.store.collection('statusHistory').list()).map((h) => h.deviceId);
    assert.deepEqual(left, ['dev_router']);
  });
});

describe('POST /api/import：任何錯誤整批不寫入', () => {
  async function snapshotState() {
    return { snap: JSON.stringify(server.store.snapshot()), files: fs.readdirSync(path.join(dataDir, 'plans')).sort(), secrets: JSON.stringify(server.ctx.secrets.all()) };
  }

  async function expectRejected(mutate, { match } = {}) {
    // 先確保有一份既有資料
    assert.equal((await postJson('/api/import', sampleExport())).status, 200);
    const before = await snapshotState();
    seen = [];
    const data = sampleExport();
    mutate(data);
    const r = await postJson('/api/import', data);
    assert.equal(r.status, 400, JSON.stringify(r.json).slice(0, 300));
    assert.equal(r.json.error.code, 'VALIDATION');
    conforms('api-common#ErrorResponse', r.json);
    assert.ok(Array.isArray(r.json.error.details) && r.json.error.details.length > 0);
    if (match) assert.ok(r.json.error.details.some((e) => match.test(`${e.instancePath} ${e.message}`)), JSON.stringify(r.json.error.details).slice(0, 400));
    assert.deepEqual(await snapshotState(), before, '資料、圖檔、密碼都不可改變');
    assert.deepEqual(seen, [], '不可發出任何事件');
    return r;
  }

  test('格式不對（format／version／缺欄位）', async () => {
    await expectRejected((d) => { d.format = 'other'; });
    await expectRejected((d) => { d.version = 2; });
    await expectRejected((d) => { delete d.collections.devices; });
  });

  test('單筆紀錄不符 schema（IP 格式）', async () => {
    await expectRejected((d) => { d.collections.devices[3].ip = '999.9.9.9'; }, { match: /ip/ });
  });

  test('外鍵錯誤：多個錯誤一次全部列出', async () => {
    const r = await expectRejected((d) => {
      d.collections.devices[0].categoryId = 'cat_nope';
      d.collections.devices[1].roomId = 'room_nope';
      d.collections.placements[0].deviceId = 'dev_nope';
    });
    assert.ok(r.json.error.details.length >= 3);
  });

  test('上游迴圈', async () => {
    await expectRejected((d) => {
      const [a, b] = d.collections.devices;
      a.uplink = { deviceId: b.id, port: '', localPort: '', medium: 'ethernet', speed: '' };
      b.uplink = { deviceId: a.id, port: '', localPort: '', medium: 'ethernet', speed: '' };
    }, { match: /迴圈/ });
  });

  test('id 重複', async () => {
    await expectRejected((d) => { d.collections.floors.push({ ...d.collections.floors[0] }); }, { match: /重複/ });
  });

  test('平面圖缺檔、檔名是 ..、base64 損毀', async () => {
    await expectRejected((d) => { delete d.planFiles['flr_1.png']; }, { match: /planFiles/ });
    await expectRejected((d) => { d.collections.plans[0].file = '..'; d.planFiles['..'] = 'AAAA'; }, { match: /file/ });
    await expectRejected((d) => { d.planFiles['flr_1.png'] = '!!!'; }, { match: /base64/ });
  });

  test('不是 JSON 物件 → 400', async () => {
    const r = await inject({ method: 'POST', url: '/api/import', payload: '[1,2]', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
  });
});

describe('POST /api/import/csv', () => {
  beforeEach(async () => {
    // 回到空資料庫
    const empty = sampleExport();
    for (const k of Object.keys(empty.collections)) empty.collections[k] = [];
    empty.planFiles = {};
    assert.equal((await postJson('/api/import', empty)).status, 200);
    seen = [];
  });

  test('dryRun=1：回報預覽，完全不寫入、不發事件', async () => {
    const before = await counts();
    const r = await postCsv(csvFixture, '?dryRun=1');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    conforms('api-io#CsvImportReport', r.json);
    assert.equal(r.json.dryRun, true);
    assert.deepEqual(r.json.created, { devices: 12, floors: 2, rooms: 5 });
    assert.equal(r.json.skipped.length, 3);
    assert.equal(r.json.unmatchedCategories.length, 1);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(seen, []);
  });

  test('dryRun=0（預設）：寫入設備、樓層、房間；上游正確串起；發出事件', async () => {
    const r = await postCsv(csvFixture);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.dryRun, false);
    assert.deepEqual(r.json.created, { devices: 12, floors: 2, rooms: 5 });
    const c = await counts();
    assert.equal(c.devices, 12);
    assert.equal(c.floors, 2);
    assert.equal(c.rooms, 5);

    const devices = (await getJson('/api/devices')).json;
    for (const d of devices) conforms('device', d);
    const m01 = devices.find((d) => d.code === 'M01');
    const r01 = devices.find((d) => d.code === 'R01');
    assert.equal(r01.uplink.deviceId, m01.id);
    assert.equal(r01.mac, 'AA:BB:CC:DD:EE:01');
    assert.equal(devices.find((d) => d.code === 'SW2').categoryId, 'cat_poe_switch');

    const creates = seen.filter(([n, p]) => n === 'inventory.changed' && p.op === 'create');
    assert.equal(creates.filter(([, p]) => p.collection === 'devices').length, 12);
    assert.equal(creates.filter(([, p]) => p.collection === 'floors').length, 2);
    assert.equal(creates.filter(([, p]) => p.collection === 'rooms').length, 5);
  });

  test('再匯入一次：有編號的列全部因「編號已存在」略過', async () => {
    await postCsv(csvFixture);
    const r = await postCsv(csvFixture);
    assert.equal(r.status, 200);
    assert.equal(r.json.skipped.filter((s) => /已存在/.test(s.reason)).length, 12); // 11 筆有編號的設備＋重複的 R01 那一列
    assert.equal(r.json.created.floors, 0);
    assert.equal(r.json.created.rooms, 0);
  });

  test('錯誤：沒有檔案、欄位名稱不是 file、缺「名稱」欄、二進位、dryRun 值不合法、不是 multipart', async () => {
    const noFile = await inject({ method: 'POST', url: '/api/import/csv', ...multipart('other', 'a.csv', 'x') });
    assert.equal(noFile.status, 400);
    assert.equal(noFile.json.error.code, 'VALIDATION');
    assert.equal((await postCsv('編號,類別\nA,路由器\n')).status, 400);
    assert.equal((await postCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe]))).status, 400);
    assert.equal((await postCsv(csvFixture, '?dryRun=maybe')).status, 400);
    const notMultipart = await postJson('/api/import/csv', { a: 1 });
    assert.equal(notMultipart.status, 400);
    assert.deepEqual(await counts(), { floors: 0, rooms: 0, groups: 0, categories: 15, devices: 0 });
  });

  test('不是 UTF-8 → 400', async () => {
    const big5ish = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0xa4, 0x40, 0xa4, 0x41]); // 非法 UTF-8 序列
    const r = await postCsv(big5ish);
    assert.equal(r.status, 400);
  });
});
