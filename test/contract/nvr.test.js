// nvr 契約測試：startServer() 實際啟動＋假 go2rtc，跑完整流程：
// 建立 NVR → 串流註冊 → 測試連線（H.264／H.265／失敗）→ WebSocket 代理收到資料 → 刪除後串流移除。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { createValidator, readFixture } from '../../contracts/index.js';
import { createFakeGo2rtc } from '../helpers/fake-go2rtc.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor, sleep } from '../helpers/tmp.js';

const v = createValidator();
const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  cleanupAllTmpDirs();
});

async function boot({ fake, dataDir = makeTmpDir(), ...opts } = {}) {
  const f = fake ?? (await createFakeGo2rtc());
  if (!fake) cleanups.push(() => f.close());
  const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {}, go2rtcUrl: f.url, ...opts });
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await s.stop();
    }
  };
  cleanups.push(stop);
  const call = async (method, url, body) => {
    const res = await fetch(`${s.url}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const events = [];
  s.events.on('nvr.changed', (p) => events.push(p));
  return { s, f, call, events, dataDir, stop };
}

const NEW = { name: '家用 NVR', brand: 'hikvision', host: '192.168.1.20', username: 'admin', password: 'p@ss:w/rd #1', channelCount: 2 };
const streamNames = (id, n) => Array.from({ length: n }, (_, i) => [`nvr_${id}_${i + 1}_main`, `nvr_${id}_${i + 1}_sub`]).flat();

/** 連 WebSocket，回傳 { ws, messages, closed } */
function openWs(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const messages = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code })));
  const opened = new Promise((resolve) => ws.addEventListener('open', () => resolve(true), { once: true }));
  ws.addEventListener('message', (e) => messages.push(e.data));
  ws.addEventListener('error', () => {});
  return { ws, messages, closed, opened };
}

describe('範本與 CRUD', () => {
  test('GET /api/nvr/templates 符合契約且等於 fixture', async () => {
    const { call } = await boot();
    const r = await call('GET', '/api/nvr/templates');
    assert.equal(r.status, 200);
    v.assert('api-nvr#TemplateList', r.json);
    assert.deepEqual(r.json, readFixture('nvr-templates.json'));
  });

  test('建立：201、符合 NvrPublic、不含密碼、密碼寫入 secrets.json、預設值取自品牌模板', async () => {
    const { call, s, dataDir, events } = await boot();
    const r = await call('POST', '/api/nvrs', NEW);
    assert.equal(r.status, 201);
    v.assert('api-nvr#NvrPublic', r.json);
    const nvr = r.json;
    assert.match(nvr.id, /^nvr_/);
    assert.equal(nvr.hasPassword, true);
    assert.equal(nvr.port, 554);
    assert.equal(nvr.streamMain, '1');
    assert.equal(nvr.streamSub, '2');
    assert.equal(nvr.urlTemplate, null);
    assert.deepEqual(nvr.channels.map((c) => [c.ch, c.name, c.enabled, c.deviceId]), [[1, '頻道 1', true, null], [2, '頻道 2', true, null]]);
    assert.ok(!('password' in nvr));
    assert.ok(!r.text.includes(NEW.password));
    assert.deepEqual(events, [{ id: nvr.id }]);

    assert.equal(s.ctx.secrets.get(`nvr:${nvr.id}`), NEW.password);
    await s.store.flush();
    const secretsFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    assert.equal(secretsFile[`nvr:${nvr.id}`], NEW.password);
    const dbText = fs.readFileSync(path.join(dataDir, 'db', 'nvrs.json'), 'utf8');
    assert.ok(!dbText.includes(NEW.password), '密碼不可寫入 db/nvrs.json');
    v.assert('nvr', JSON.parse(dbText)[0]);
  });

  test('GET 列表與單筆永遠只回 hasPassword', async () => {
    const { call } = await boot();
    const { json: created } = await call('POST', '/api/nvrs', NEW);
    const list = await call('GET', '/api/nvrs');
    v.assert('api-nvr#NvrPublicList', list.json);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].hasPassword, true);
    assert.ok(!list.text.includes('p@ss'));
    assert.ok(!list.text.includes('"password"'));
    const patched = await call('PATCH', `/api/nvrs/${created.id}`, { name: '改名' });
    assert.ok(!patched.text.includes('"password"'));
    assert.equal(patched.json.hasPassword, true);
  });

  test('建立時串流註冊到 go2rtc：每頻道 main／sub，URL 帳密已編碼', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    assert.deepEqual([...f.streams.keys()].sort(), streamNames(nvr.id, 2).sort());
    const enc = 'admin:p%40ss%3Aw%2Frd%20%231';
    assert.equal(f.streams.get(`nvr_${nvr.id}_1_main`), `rtsp://${enc}@192.168.1.20:554/Streaming/Channels/101`);
    assert.equal(f.streams.get(`nvr_${nvr.id}_2_sub`), `rtsp://${enc}@192.168.1.20:554/Streaming/Channels/202`);
  });

  test('四個品牌各建一台：主／子碼流 URL 正確', async () => {
    const { call, f } = await boot();
    const expect = {
      hikvision: ['/Streaming/Channels/101', '/Streaming/Channels/102'],
      dahua: ['/cam/realmonitor?channel=1&subtype=0', '/cam/realmonitor?channel=1&subtype=1'],
      uniview: ['/unicast/c1/s0/live', '/unicast/c1/s1/live'],
      reolink: ['/h264Preview_01_main', '/h264Preview_01_sub'],
    };
    for (const [brand, [main, sub]] of Object.entries(expect)) {
      const { json: nvr } = await call('POST', '/api/nvrs', { ...NEW, brand, password: 'pw', channelCount: 1 });
      assert.equal(f.streams.get(`nvr_${nvr.id}_1_main`), `rtsp://admin:pw@192.168.1.20:554${main}`, brand);
      assert.equal(f.streams.get(`nvr_${nvr.id}_1_sub`), `rtsp://admin:pw@192.168.1.20:554${sub}`, brand);
    }
  });

  test('自訂品牌：使用 urlTemplate；{ch:02} 與帳密編碼', async () => {
    const { call, f } = await boot();
    const r = await call('POST', '/api/nvrs', {
      ...NEW, brand: 'custom', urlTemplate: 'rtsp://{u}:{p}@{host}:{port}/ch{ch:02}/{s}', streamMain: 'hd', streamSub: 'sd', port: 8554, channelCount: 1, password: 'a b',
    });
    assert.equal(r.status, 201);
    assert.equal(f.streams.get(`nvr_${r.json.id}_1_sub`), 'rtsp://admin:a%20b@192.168.1.20:8554/ch01/sd');
    assert.equal(r.json.urlTemplate, 'rtsp://{u}:{p}@{host}:{port}/ch{ch:02}/{s}');
  });

  test('建立時驗證失敗 → 400 VALIDATION', async () => {
    const { call, f } = await boot();
    const bad = [
      { ...NEW, brand: 'nope' },
      { ...NEW, password: undefined },
      { ...NEW, channelCount: 0 },
      { ...NEW, extra: 1 },
      { ...NEW, brand: 'custom' }, // 缺 urlTemplate
      { ...NEW, brand: 'custom', urlTemplate: 'exec:ffmpeg -i x' }, // 只允許 rtsp://
      { ...NEW, brand: 'custom', urlTemplate: 'http://{host}/x' },
      { ...NEW, host: '192.168.1.20/evil' },
      { ...NEW, host: 'a b' },
      { ...NEW, deviceId: 'dev_missing' },
      { ...NEW, channels: [{ ch: 1, name: 'a', enabled: true, deviceId: 'dev_missing' }] },
      { ...NEW, channels: [{ ch: 3, name: 'x', enabled: true }] }, // 超過 channelCount
      { ...NEW, channels: [{ ch: 1, name: 'x', enabled: true }, { ch: 1, name: 'y', enabled: true }] },
    ];
    for (const body of bad) {
      const r = await call('POST', '/api/nvrs', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'VALIDATION');
    }
    assert.equal(f.streams.size, 0);
    assert.deepEqual((await call('GET', '/api/nvrs')).json, []);
  });

  test('PATCH：改密碼 → 串流以新密碼重新註冊；password:null → hasPassword=false；省略 → 不變', async () => {
    const { call, f, s } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', { ...NEW, password: 'old' });
    const key = `nvr_${nvr.id}_1_sub`;
    assert.match(f.streams.get(key), /admin:old@/);

    let r = await call('PATCH', `/api/nvrs/${nvr.id}`, { password: 'new#pw' });
    assert.equal(r.status, 200);
    v.assert('api-nvr#NvrPublic', r.json);
    assert.match(f.streams.get(key), /admin:new%23pw@/);
    assert.equal(s.ctx.secrets.get(`nvr:${nvr.id}`), 'new#pw');

    r = await call('PATCH', `/api/nvrs/${nvr.id}`, { name: '只改名稱' });
    assert.equal(r.json.hasPassword, true);
    assert.equal(s.ctx.secrets.get(`nvr:${nvr.id}`), 'new#pw');

    r = await call('PATCH', `/api/nvrs/${nvr.id}`, { password: null });
    assert.equal(r.json.hasPassword, false);
    assert.equal(s.ctx.secrets.has(`nvr:${nvr.id}`), false);
  });

  test('PATCH：減少頻道數會移除多出來的串流；增加會補頻道並註冊；換品牌取新品牌預設值', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', { ...NEW, channelCount: 3 });
    assert.equal(f.streams.size, 6);

    let r = await call('PATCH', `/api/nvrs/${nvr.id}`, { channelCount: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.channels.map((c) => c.ch), [1]);
    assert.deepEqual([...f.streams.keys()].sort(), streamNames(nvr.id, 1).sort());

    r = await call('PATCH', `/api/nvrs/${nvr.id}`, { channelCount: 2 });
    assert.deepEqual(r.json.channels.map((c) => c.ch), [1, 2]);
    assert.equal(f.streams.size, 4);

    r = await call('PATCH', `/api/nvrs/${nvr.id}`, { brand: 'dahua' });
    assert.equal(r.json.streamMain, '0');
    assert.equal(r.json.streamSub, '1');
    assert.equal(r.json.urlTemplate, null);
    assert.match(f.streams.get(`nvr_${nvr.id}_1_sub`), /\/cam\/realmonitor\?channel=1&subtype=1$/);
  });

  test('PATCH：頻道名稱、啟用；錯誤情況', async () => {
    const { call } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    let r = await call('PATCH', `/api/nvrs/${nvr.id}`, { channels: [{ ch: 1, name: '前門', enabled: true }, { ch: 2, name: '後門', enabled: false }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.channels, [{ ch: 1, name: '前門', deviceId: null, enabled: true }, { ch: 2, name: '後門', deviceId: null, enabled: false }]);
    assert.equal((await call('PATCH', `/api/nvrs/${nvr.id}`, { id: 'x' })).status, 400);
    assert.equal((await call('PATCH', `/api/nvrs/${nvr.id}`, { host: 'a/b' })).status, 400);
    assert.equal((await call('PATCH', `/api/nvrs/${nvr.id}`, { channels: [{ ch: 9, name: '', enabled: true }] })).status, 400);
    assert.equal((await call('PATCH', '/api/nvrs/nvr_nope', { name: 'x' })).status, 404);
  });

  test('DELETE：204、移除串流與密碼、發 nvr.changed；再刪 404', async () => {
    const { call, f, s, events } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    assert.equal(f.streams.size, 4);
    events.length = 0;
    const r = await call('DELETE', `/api/nvrs/${nvr.id}`);
    assert.equal(r.status, 204);
    assert.equal(f.streams.size, 0, '刪除後串流必須從 go2rtc 移除');
    assert.equal(s.ctx.secrets.has(`nvr:${nvr.id}`), false);
    assert.deepEqual(events, [{ id: nvr.id }]);
    assert.equal((await call('GET', '/api/nvrs')).json.length, 0);
    assert.equal((await call('DELETE', `/api/nvrs/${nvr.id}`)).status, 404);
    assert.equal((await call('POST', `/api/nvrs/${nvr.id}/test`, {})).status, 404);
  });
});

describe('測試連線', () => {
  test('H.264：ok:true、codec h264、沒有 warning；結果符合 NvrTestResult', async () => {
    const { call } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const r = await call('POST', `/api/nvrs/${nvr.id}/test`, {});
    assert.equal(r.status, 200);
    v.assert('api-nvr#NvrTestResult', r.json);
    assert.deepEqual(r.json, { ok: true, codec: 'h264' });
  });

  test('H.265：ok:true、codec h265、warning 提示改子碼流為 H.264', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    f.setCodec(`nvr_${nvr.id}_1_sub`, 'hvc1.1.6.L153.B0');
    let r = await call('POST', `/api/nvrs/${nvr.id}/test`, { channel: 1 });
    v.assert('api-nvr#NvrTestResult', r.json);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.codec, 'h265');
    assert.match(r.json.warning, /H\.264/);
    f.setCodec(`nvr_${nvr.id}_1_sub`, 'hev1.1.6.L93.B0');
    r = await call('POST', `/api/nvrs/${nvr.id}/test`, {});
    assert.equal(r.json.codec, 'h265');
    assert.ok(r.json.warning);
  });

  test('測試的是子碼流；測試時會先（重新）註冊該頻道', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    f.streams.clear();
    await call('POST', `/api/nvrs/${nvr.id}/test`, { channel: 2 });
    assert.ok(f.streams.has(`nvr_${nvr.id}_2_sub`));
    assert.equal(f.wsLog.at(-1).src, `nvr_${nvr.id}_2_sub`);
    assert.equal(f.requests.some((x) => x.url.includes('frame.jpeg')), false);
  });

  test('失敗：區分帳密錯誤、連不到主機', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const name = `nvr_${nvr.id}_1_sub`;
    f.setStreamError(name, 'streams: wrong user/pass');
    let r = await call('POST', `/api/nvrs/${nvr.id}/test`, {});
    assert.equal(r.status, 200);
    v.assert('api-nvr#NvrTestResult', r.json);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /帳號或密碼錯誤/);
    assert.match(r.json.error, /401/);

    f.setStreamError(name, 'streams: dial tcp 192.168.1.20:554: connect: connection refused');
    r = await call('POST', `/api/nvrs/${nvr.id}/test`, {});
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /連不到主機 192\.168\.1\.20:554/);
    assert.ok(!('codec' in r.json));
  });

  test('頻道不存在 → 400；請求格式不正確 → 400', async () => {
    const { call } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    assert.equal((await call('POST', `/api/nvrs/${nvr.id}/test`, { channel: 9 })).status, 400);
    assert.equal((await call('POST', `/api/nvrs/${nvr.id}/test`, { channel: 0 })).status, 400);
    assert.equal((await call('POST', `/api/nvrs/${nvr.id}/test`, { foo: 1 })).status, 400);
  });

  test('go2rtc 本身不可用 → 502 UPSTREAM', async () => {
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    await f.close();
    const r = await call('POST', `/api/nvrs/${nvr.id}/test`, {});
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'UPSTREAM');
  });
});

describe('WebSocket 代理 /api/nvr/ws', () => {
  const wsUrl = (s, name) => `${s.url.replace('http', 'ws')}/api/nvr/ws?stream=${encodeURIComponent(name)}`;

  test('白名單內的串流：雙向轉送文字與二進位，任一端關閉就關另一端', async () => {
    const { call, s, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const name = `nvr_${nvr.id}_1_sub`;

    const a = openWs(wsUrl(s, name));
    await a.opened;
    a.ws.send(JSON.stringify({ type: 'mse', value: 'avc1.640029,mp4a.40.2' }));
    await waitFor(() => a.messages.length >= 2, { message: '沒有收到 go2rtc 的資料' });
    assert.equal(typeof a.messages[0], 'string');
    assert.deepEqual(JSON.parse(a.messages[0]), { type: 'mse', value: 'video/mp4; codecs="avc1.640029"' });
    assert.ok(a.messages[1] instanceof ArrayBuffer, '二進位訊息必須原樣轉送');
    assert.deepEqual([...new Uint8Array(a.messages[1])], [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    assert.deepEqual(f.received.filter((m) => m.src === name).map((m) => m.message.type), ['mse'], '瀏覽器的訊息要轉給 go2rtc');
    assert.equal(f.connectionCount(name), 1);

    // 瀏覽器端關閉 → go2rtc 端關閉
    a.ws.close();
    await a.closed;
    await waitFor(() => f.connectionCount(name) === 0, { message: '瀏覽器關閉後 go2rtc 連線仍在' });

    // go2rtc 端關閉 → 瀏覽器端關閉
    const b = openWs(wsUrl(s, name));
    await b.opened;
    await waitFor(() => f.connectionCount(name) === 1);
    for (const e of f.app.websocketServer.clients) e.terminate();
    await b.closed;
  });

  test('連線建立後立刻送出的訊息不會遺失（上游尚未連上時先排隊）', async () => {
    const { call, s, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const name = `nvr_${nvr.id}_2_main`;
    const a = openWs(wsUrl(s, name));
    a.ws.addEventListener('open', () => a.ws.send(JSON.stringify({ type: 'mse', value: 'x' })));
    await waitFor(() => a.messages.length >= 1, { message: '立刻送出的 mse 請求被丟掉了' });
    a.ws.close();
    await a.closed;
    assert.ok(f.received.some((m) => m.src === name));
  });

  test('白名單：未註冊的名稱、別人的串流、格式不符、頻道不存在 → close 4404，且絕不連到 go2rtc', async () => {
    const { call, s, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    f.streams.set('camera1', 'rtsp://10.9.9.9/steal'); // go2rtc 裡有，但不是本系統註冊的
    const before = f.wsLog.length;
    const names = [
      'camera1',
      'nvr_nvr_nope_1_sub', // NVR 不存在
      `nvr_${nvr.id}_9_sub`, // 頻道不存在
      `nvr_${nvr.id}_1_other`,
      `nvr_${nvr.id}_1_sub/../camera1`,
      'rtsp://10.9.9.9/x',
      'exec:rm -rf /',
      '',
    ];
    for (const name of names) {
      const c = openWs(wsUrl(s, name));
      assert.deepEqual(await c.closed, { code: 4404 }, `「${name}」應被拒絕`);
    }
    // 沒有 stream 參數
    const noParam = openWs(`${s.url.replace('http', 'ws')}/api/nvr/ws`);
    assert.deepEqual(await noParam.closed, { code: 4404 });
    assert.equal(f.wsLog.length, before, '被拒絕的連線不可轉到 go2rtc');
  });

  test('刪除 NVR 後，原本合法的名稱立刻被拒絕', async () => {
    const { call, s } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const name = `nvr_${nvr.id}_1_sub`;
    await call('DELETE', `/api/nvrs/${nvr.id}`);
    assert.deepEqual(await openWs(wsUrl(s, name)).closed, { code: 4404 });
  });

  test('伺服器關閉時代理連線一併結束', async () => {
    const { call, s, f, stop } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    const c = openWs(wsUrl(s, `nvr_${nvr.id}_1_sub`));
    await c.opened;
    await waitFor(() => f.connectionCount() === 1);
    await stop();
    await c.closed;
    await waitFor(() => f.connectionCount() === 0);
  });
});

describe('狀態與模組狀態', () => {
  test('GET /api/nvr/status：go2rtc 執行中', async () => {
    const { call } = await boot();
    const r = await call('GET', '/api/nvr/status');
    assert.equal(r.status, 200);
    v.assert('api-nvr#NvrStatus', r.json);
    const { streams, ...rest } = r.json;
    assert.deepEqual(rest, { running: true, version: '1.9.14-fake', mode: 'external' });
    assert.ok(Number.isInteger(streams) && streams >= 0);
    const created = await call('POST', '/api/nvrs', NEW);
    assert.equal(created.status, 201);
    const after = (await call('GET', '/api/nvr/status')).json;
    assert.ok(after.streams > streams, '新增 NVR 後已註冊串流數應增加');
  });

  test('check()：連不到 go2rtc 時模組仍啟用，/api/system/modules 顯示「串流服務未啟動」；status.running=false', async () => {
    const dead = net.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    const { call } = await boot({ go2rtcUrl: `http://127.0.0.1:${port}`, fake: { url: `http://127.0.0.1:${port}`, close() {} } });
    const modules = await call('GET', '/api/system/modules');
    v.assert('api-system#ModuleList', modules.json);
    const nvr = modules.json.find((m) => m.name === 'nvr');
    assert.deepEqual(nvr, { name: 'nvr', state: 'ok', note: '串流服務未啟動' });
    const st = await call('GET', '/api/nvr/status');
    v.assert('api-nvr#NvrStatus', st.json);
    assert.deepEqual(st.json, { running: false, version: null, mode: 'external' });
    // 設定仍可建立（密碼照樣保存），只是串流註冊不了
    const created = await call('POST', '/api/nvrs', NEW);
    assert.equal(created.status, 201);
    assert.equal(created.json.hasPassword, true);
    // 測試連線回 502
    assert.equal((await call('POST', `/api/nvrs/${created.json.id}/test`, {})).status, 502);
  });

  test('go2rtc 正常時 note 不存在', async () => {
    const { call } = await boot();
    const nvr = (await call('GET', '/api/system/modules')).json.find((m) => m.name === 'nvr');
    assert.deepEqual(nvr, { name: 'nvr', state: 'ok' });
  });

  test('啟動（start）時重新註冊全部串流：go2rtc 重啟後串流會消失', async () => {
    const dataDir = makeTmpDir();
    const first = await boot({ dataDir });
    const { json: nvr } = await first.call('POST', '/api/nvrs', NEW);
    await first.stop();

    const second = await boot({ dataDir }); // 全新的 go2rtc（沒有任何串流）
    assert.equal(second.f.streams.size, 0 + 4, '啟動後應重新註冊');
    assert.deepEqual([...second.f.streams.keys()].sort(), streamNames(nvr.id, 2).sort());
    assert.match(second.f.streams.get(`nvr_${nvr.id}_1_sub`), /p%40ss%3Aw%2Frd%20%231@/);
  });

  test('啟動時移除 go2rtc 裡過期的 nvr_ 串流（NVR 已不存在）', async () => {
    const fake = await createFakeGo2rtc();
    cleanups.push(() => fake.close());
    fake.streams.set('nvr_nvr_gone_1_sub', 'rtsp://old');
    fake.streams.set('其他程式的串流', 'rtsp://keep');
    await boot({ fake });
    assert.equal(fake.streams.has('nvr_nvr_gone_1_sub'), false);
    assert.equal(fake.streams.has('其他程式的串流'), true, '不是 nvr_ 開頭的串流不可動');
  });
});

describe('go2rtc 被重啟後自動恢復', () => {
  test('串流被清空（go2rtc 被外部重啟）→ 健康檢查補註冊；go2rtc 停掉再回來 → note 消失並重新註冊', async () => {
    process.env.NC_NVR_HEALTH_MS = '150';
    cleanups.push(() => { delete process.env.NC_NVR_HEALTH_MS; });
    const { call, f } = await boot();
    const { json: nvr } = await call('POST', '/api/nvrs', NEW);
    assert.equal(f.streams.size, 4);

    f.streams.clear(); // go2rtc 重啟：串流消失
    await waitFor(() => f.streams.size === 4, { timeoutMs: 3000, message: '串流被清空後沒有重新註冊' });

    // go2rtc 整個停掉：note 顯示未啟動
    const port = f.port;
    await f.close();
    await waitFor(async () => (await call('GET', '/api/system/modules')).json.find((m) => m.name === 'nvr').note === '串流服務未啟動', { timeoutMs: 3000, message: 'go2rtc 停掉後沒有顯示「串流服務未啟動」' });
    // 回來（同一個埠，空的串流表）：note 消失，串流重新註冊
    const again = await createFakeGo2rtc({ port });
    cleanups.push(() => again.close());
    await waitFor(async () => (await call('GET', '/api/system/modules')).json.find((m) => m.name === 'nvr').note === undefined, { timeoutMs: 3000, message: 'go2rtc 回來後 note 沒有消失' });
    await waitFor(() => again.streams.size === 4, { timeoutMs: 3000, message: 'go2rtc 回來後沒有重新註冊串流' });
    assert.ok(again.streams.has(`nvr_${nvr.id}_1_sub`));
  });
});

describe('mock 模式', () => {
  test('fixture 的 NVR 可讀取，密碼不外洩，串流已註冊到假 go2rtc', async () => {
    const s = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {}, mock: true });
    cleanups.push(() => s.stop());
    const list = await (await fetch(`${s.url}/api/nvrs`)).json();
    v.assert('api-nvr#NvrPublicList', list);
    assert.equal(list[0].id, 'nvr_main');
    assert.equal(list[0].hasPassword, true);
    assert.ok(!JSON.stringify(list).includes('mock-password'));
    const streams = await (await fetch(`${s.ctx.config.go2rtcUrl}/api/streams`)).json();
    assert.equal(Object.keys(streams).length, 16);
    assert.ok(streams['nvr_nvr_main_1_sub']);
    const status = await (await fetch(`${s.url}/api/nvr/status`)).json();
    assert.equal(status.running, true);
  });

  test('刪除設備 → NVR 與頻道對它的連結被清掉（api.md：收到 devices delete 後各自清理）', async () => {
    const s = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {}, mock: true });
    cleanups.push(() => s.stop());
    const before = await (await fetch(`${s.url}/api/nvrs`)).json();
    assert.equal(before[0].channels[0].deviceId, 'dev_cam1');
    const del = await fetch(`${s.url}/api/devices/dev_cam1`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    await waitFor(async () => (await (await fetch(`${s.url}/api/nvrs`)).json())[0].channels[0].deviceId === null, { message: '頻道連結沒有被清掉' });
    const after = await (await fetch(`${s.url}/api/nvrs`)).json();
    assert.equal(after[0].channels[1].deviceId, 'dev_cam2');
    v.assert('api-nvr#NvrPublicList', after);
    // NVR 本身的設備連結
    await fetch(`${s.url}/api/devices/dev_nvr`, { method: 'DELETE' });
    await waitFor(async () => (await (await fetch(`${s.url}/api/nvrs`)).json())[0].deviceId === null, { message: 'NVR 設備連結沒有被清掉' });
  });
});

describe('受管模式：由 nvr 模組啟動並結束 go2rtc 行程', { skip: process.platform === 'win32' && '假 go2rtc 腳本只在 Linux／macOS 執行' }, () => {
  /** 一個極簡的假 go2rtc 執行檔：讀 -config 的 api.listen，在該埠回應 /api */
  function fakeBinary(dir) {
    const file = path.join(dir, 'go2rtc');
    const body = `
const fs = require('node:fs');
const http = require('node:http');
const yaml = fs.readFileSync(process.argv[process.argv.indexOf('-config') + 1], 'utf8');
const listen = /api:\\n  listen: "([^"]+)"/.exec(yaml)[1];
const [host, port] = listen.split(':');
http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url === '/api' ? '{"version":"managed-fake"}' : '{}'); }).listen(Number(port), host);
`;
    fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    return file;
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('啟動時產生 go2rtc.yaml 與 pid 檔，status.mode=managed；stop() 後行程已結束', async () => {
    const dataDir = makeTmpDir();
    const bin = fakeBinary(makeTmpDir());
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));

    const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {}, go2rtcPath: bin, go2rtcUrl: `http://127.0.0.1:${port}` });
    let stopped = false;
    cleanups.push(async () => { if (!stopped) await s.stop(); });
    const pidFile = path.join(dataDir, 'go2rtc', 'go2rtc.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'go2rtc 行程應在執行');
    const yaml = fs.readFileSync(path.join(dataDir, 'go2rtc', 'go2rtc.yaml'), 'utf8');
    assert.match(yaml, new RegExp(`listen: "127\\.0\\.0\\.1:${port}"`));
    assert.match(yaml, /rtsp:\n {2}listen: ""/);
    assert.match(yaml, /webrtc:\n {2}listen: ""/);

    const status = await (await fetch(`${s.url}/api/nvr/status`)).json();
    assert.deepEqual(status, { running: true, version: 'managed-fake', mode: 'managed', streams: 0 });

    await s.stop();
    stopped = true;
    await waitFor(() => !alive(pid), { message: 'stop() 之後 go2rtc 行程仍在' });
    assert.equal(fs.existsSync(pidFile), false);
  });
});
