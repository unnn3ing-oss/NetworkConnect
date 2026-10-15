// floorplan 契約測試（contracts/api.md §5；B4 驗收 1）
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { createValidator } from '../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../helpers/tmp.js';
import { png, jpeg, webpLossy, svgViewBox, htmlDoc } from '../unit/floorplan/samples.js';

const validator = createValidator();
const conforms = (ref, data) => {
  const r = validator.validate(ref, data);
  assert.equal(r.valid, true, `${ref} 不符：${JSON.stringify(r.errors).slice(0, 500)}`);
};

let server;
let dataDir;
let seen;
let floorA;
let floorB;
let dev;

before(async () => {
  dataDir = makeTmpDir();
  server = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {} });
  for (const name of ['plan.changed', 'placement.changed']) server.events.on(name, (p) => seen.push([name, p]));
  seen = [];
  floorA = (await postJson('/api/floors', { name: 'A' })).json.id;
  floorB = (await postJson('/api/floors', { name: 'B' })).json.id;
  dev = (await postJson('/api/devices', { name: '路由器', categoryId: 'cat_router', floorId: floorA })).json.id;
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
  return { status: res.statusCode, json, headers: res.headers, body: res.body, raw: res.rawPayload };
};
const getJson = (url) => inject({ method: 'GET', url });
const postJson = (url, body) => inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json' } });
const putJson = (url, body) => inject({ method: 'PUT', url, payload: body, headers: { 'content-type': 'application/json' } });
const del = (url) => inject({ method: 'DELETE', url });

function multipart(fieldname, filename, content, contentType = 'application/octet-stream') {
  const boundary = '----ncTestBoundary7MA4YWxkTrZu0gW';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const upload = (floorId, filename, content, fieldname = 'file') => inject({ method: 'PUT', url: `/api/plans/${floorId}`, ...multipart(fieldname, filename, content) });
const planFile = (name) => path.join(dataDir, 'plans', name);

describe('PUT /api/plans/:floorId', () => {
  test('三種點陣格式與 SVG：200、符合 Plan schema、寬高正確、檔案落在 plans/、發 plan.changed', async () => {
    const cases = [
      ['a.png', png(1200, 800), 'image/png', 'png', 1200, 800],
      ['a.JPG', jpeg(640, 480), 'image/jpeg', 'jpg', 640, 480],
      ['a.webp', webpLossy(1024, 768), 'image/webp', 'webp', 1024, 768],
      ['a.svg', svgViewBox(900, 450), 'image/svg+xml', 'svg', 900, 450],
    ];
    for (const [name, buf, mime, ext, w, h] of cases) {
      seen = [];
      const r = await upload(floorA, name, buf);
      assert.equal(r.status, 200, `${name}：${r.body}`);
      conforms('plan', r.json);
      assert.deepEqual([r.json.mime, r.json.width, r.json.height, r.json.file], [mime, w, h, `${floorA}.${ext}`]);
      assert.ok(fs.existsSync(planFile(`${floorA}.${ext}`)));
      assert.deepEqual(seen, [['plan.changed', { floorId: floorA }]]);
    }
    // 換圖後只剩最後一張（svg），舊圖檔已刪除
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'plans')).sort(), [`${floorA}.svg`]);
    const list = await getJson('/api/plans');
    conforms('api-floorplan#PlanList', list.json);
    assert.equal(list.json.length, 1);
  });

  test('檔案類型偽裝（副檔名 png、內容是 HTML）→ 400，且不留下檔案與紀錄', async () => {
    const r = await upload(floorB, 'evil.png', htmlDoc());
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION');
    conforms('api-common#ErrorResponse', r.json);
    assert.equal((await getJson('/api/plans')).json.some((p) => p.floorId === floorB), false);
    assert.ok(!fs.existsSync(planFile(`${floorB}.png`)));
  });

  test('內容是 PNG 但副檔名是 jpg／svg／html → 400', async () => {
    for (const name of ['x.jpg', 'x.svg', 'x.html', 'x.exe']) assert.equal((await upload(floorB, name, png(10, 10))).status, 400, name);
  });

  test('超過 10MB → 400', async () => {
    const big = Buffer.concat([png(10, 10), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const r = await upload(floorB, 'big.png', big);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.ok(!fs.existsSync(planFile(`${floorB}.png`)));
  });

  test('剛好 10MB 以內可以上傳', async () => {
    const ok = Buffer.concat([png(10, 10), Buffer.alloc(9 * 1024 * 1024)]);
    assert.equal((await upload(floorB, 'ok.png', ok)).status, 200);
    await del(`/api/plans/${floorB}`);
  });

  test('欄位名不是 file、不是 multipart、空檔 → 400', async () => {
    assert.equal((await upload(floorB, 'a.png', png(5, 5), 'image')).status, 400);
    assert.equal((await putJson(`/api/plans/${floorB}`, { a: 1 })).status, 400);
    assert.equal((await upload(floorB, 'a.png', Buffer.alloc(0))).status, 400);
  });

  test('樓層不存在 → 404', async () => {
    assert.equal((await upload('flr_nope', 'a.png', png(5, 5))).status, 404);
    assert.equal((await upload('..%2Fetc', 'a.png', png(5, 5))).status, 404);
  });

  test('換圖時保留 placements', async () => {
    await upload(floorA, 'a.png', png(100, 100));
    await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.25, y: 0.75 });
    assert.equal((await upload(floorA, 'b.jpg', jpeg(300, 200))).status, 200);
    const p = (await getJson(`/api/placements?floorId=${floorA}`)).json;
    assert.deepEqual(p, [{ deviceId: dev, floorId: floorA, x: 0.25, y: 0.75 }]);
    await del(`/api/placements/${dev}`);
  });
});

describe('GET /api/plans/:floorId/image', () => {
  test('回傳圖檔本體與安全標頭', async () => {
    const buf = png(321, 123);
    await upload(floorA, 'a.png', buf);
    const r = await getJson(`/api/plans/${floorA}/image`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(Buffer.from(r.raw).equals(buf));
  });
  test('SVG 的 Content-Type 為 image/svg+xml', async () => {
    await upload(floorA, 'a.svg', svgViewBox(10, 10));
    assert.equal((await getJson(`/api/plans/${floorA}/image`)).headers['content-type'], 'image/svg+xml');
  });
  test('沒有平面圖 → 404', async () => {
    assert.equal((await getJson(`/api/plans/${floorB}/image`)).status, 404);
  });
});

describe('placements', () => {
  test('PUT 建立、再 PUT 取代；符合 schema；發 placement.changed', async () => {
    const a = await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.1, y: 0.2 });
    assert.equal(a.status, 200);
    conforms('placement', a.json);
    assert.deepEqual(seen.at(-1), ['placement.changed', { deviceId: dev, floorId: floorA }]);
    const b = await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.5, y: 0.6 });
    assert.deepEqual([b.json.x, b.json.y], [0.5, 0.6]);
    const all = (await getJson('/api/placements')).json;
    conforms('api-floorplan#PlacementList', all);
    assert.equal(all.filter((p) => p.deviceId === dev).length, 1);
  });

  test('座標超出 0–1 時夾在邊界', async () => {
    const r = await putJson(`/api/placements/${dev}`, { floorId: floorA, x: -3, y: 1.7 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.x, r.json.y], [0, 1]);
  });

  test('非數字座標、缺欄位、未知欄位 → 400；設備或樓層不存在 → 404', async () => {
    assert.equal((await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 'a', y: 0 })).status, 400);
    assert.equal((await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0 })).status, 400);
    assert.equal((await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0, y: 0, z: 1 })).status, 400);
    assert.equal((await putJson('/api/placements/dev_nope', { floorId: floorA, x: 0, y: 0 })).status, 404);
    assert.equal((await putJson(`/api/placements/${dev}`, { floorId: 'flr_nope', x: 0, y: 0 })).status, 404);
  });

  test('GET ?floorId= 篩選；不合法的 floorId → 400', async () => {
    await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.3, y: 0.3 });
    assert.equal((await getJson(`/api/placements?floorId=${floorA}`)).json.length, 1);
    assert.equal((await getJson(`/api/placements?floorId=${floorB}`)).json.length, 0);
    assert.equal((await getJson('/api/placements?floorId=zzz')).status, 400);
  });

  test('DELETE：204、發事件；再刪 → 404', async () => {
    seen = [];
    assert.equal((await del(`/api/placements/${dev}`)).status, 204);
    assert.deepEqual(seen, [['placement.changed', { deviceId: dev, floorId: floorA }]]);
    assert.equal((await del(`/api/placements/${dev}`)).status, 404);
  });
});

describe('DELETE /api/plans/:floorId 與連帶清除', () => {
  test('刪平面圖：204、刪圖檔、發事件、placements 保留', async () => {
    await upload(floorA, 'a.png', png(50, 50));
    await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.5, y: 0.5 });
    seen = [];
    assert.equal((await del(`/api/plans/${floorA}`)).status, 204);
    assert.deepEqual(seen, [['plan.changed', { floorId: floorA }]]);
    assert.equal(fs.readdirSync(path.join(dataDir, 'plans')).filter((f) => f.startsWith(floorA)).length, 0);
    assert.equal((await getJson(`/api/placements?floorId=${floorA}`)).json.length, 1);
    assert.equal((await del(`/api/plans/${floorA}`)).status, 404);
  });

  test('刪設備 → 刪除其 placement', async () => {
    const d2 = (await postJson('/api/devices', { name: 'AP', categoryId: 'cat_ap', floorId: floorB })).json.id;
    await putJson(`/api/placements/${d2}`, { floorId: floorB, x: 0.1, y: 0.1 });
    seen = [];
    assert.equal((await del(`/api/devices/${d2}`)).status, 204);
    await waitFor(async () => (await getJson('/api/placements')).json.every((p) => p.deviceId !== d2), { message: 'placement 未被清除' });
    assert.ok(seen.some(([n, p]) => n === 'placement.changed' && p.deviceId === d2));
  });

  test('刪樓層 → 刪除該層的 plan（含圖檔）與 placements，其他樓層不受影響', async () => {
    const fl = (await postJson('/api/floors', { name: 'C' })).json.id;
    await upload(fl, 'c.webp', webpLossy(64, 64));
    const dC = (await postJson('/api/devices', { name: 'X', categoryId: 'cat_other' })).json.id;
    await putJson(`/api/placements/${dC}`, { floorId: fl, x: 0.2, y: 0.2 });
    await putJson(`/api/placements/${dev}`, { floorId: floorA, x: 0.9, y: 0.9 });
    seen = [];
    assert.equal((await del(`/api/floors/${fl}`)).status, 204);
    await waitFor(async () => !(await getJson('/api/plans')).json.some((p) => p.floorId === fl), { message: 'plan 未被清除' });
    await waitFor(async () => (await getJson(`/api/placements?floorId=${fl}`)).json.length === 0, { message: 'placements 未被清除' });
    assert.ok(!fs.existsSync(planFile(`${fl}.webp`)));
    assert.ok(seen.some(([n, p]) => n === 'plan.changed' && p.floorId === fl));
    assert.ok(seen.some(([n, p]) => n === 'placement.changed' && p.deviceId === dC));
    assert.equal((await getJson(`/api/placements?floorId=${floorA}`)).json.length, 1, '其他樓層的落點不應被刪');
  });
});
