import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProber, createMockProber } from '../../helpers/fake-prober.js';
import { createFakeGo2rtc, FAKE_JPEG } from '../../helpers/fake-go2rtc.js';
import { readFixture } from '../../../contracts/index.js';

describe('fake-prober', () => {
  test('預設全部 up 並回固定 rtt；down 清單內的主機回失敗', async () => {
    const p = createFakeProber({ down: ['192.168.1.9'], rttMs: 4 });
    assert.deepEqual(await p.probe({ method: 'icmp', host: '192.168.1.1' }), { up: true, rttMs: 4 });
    assert.deepEqual(await p.probe({ method: 'icmp', host: '192.168.1.9' }), { up: false, rttMs: null });
  });

  test('執行中可切換狀態，並記錄呼叫', async () => {
    const p = createFakeProber();
    p.setDown('1.1.1.1', true);
    assert.equal((await p.probe({ method: 'tcp', host: '1.1.1.1', port: 80 })).up, false);
    p.setDown('1.1.1.1', false);
    assert.equal((await p.probe({ method: 'tcp', host: '1.1.1.1', port: 80 })).up, true);
    assert.equal(p.calls.length, 2);
    assert.deepEqual(p.calls[0], { method: 'tcp', host: '1.1.1.1', port: 80 });
  });

  test('errorHosts 代表「檢查本身出錯」：丟例外（對應 state=unknown）', async () => {
    const p = createFakeProber({ errorHosts: ['2.2.2.2'] });
    await assert.rejects(() => p.probe({ method: 'icmp', host: '2.2.2.2' }), /fake/);
  });

  test('createMockProber：依 status.sample.json 把 down／unknown 的設備 IP 設為失敗／出錯', async () => {
    const db = readFixture('db.sample.json');
    const status = readFixture('status.sample.json');
    const p = createMockProber(db.devices, status);
    const printer = db.devices.find((d) => d.id === 'dev_printer');
    assert.equal((await p.probe({ method: 'tcp', host: printer.ip, port: 9100 })).up, false);
    const router = db.devices.find((d) => d.id === 'dev_router');
    assert.equal((await p.probe({ method: 'icmp', host: router.ip })).up, true);
    const console_ = db.devices.find((d) => d.id === 'dev_console');
    await assert.rejects(() => p.probe({ method: 'icmp', host: console_.ip }));
  });
});

describe('fake-go2rtc', () => {
  let g;
  afterEach(async () => { await g?.close(); g = null; });

  test('GET /api 回版本；PUT /api/streams 註冊串流；GET /api/streams 可查', async () => {
    g = await createFakeGo2rtc();
    const info = await (await fetch(`${g.url}/api`)).json();
    assert.match(info.version, /fake/);
    const put = await fetch(`${g.url}/api/streams?name=nvr_a_1_sub&src=${encodeURIComponent('rtsp://u:p@h/x')}`, { method: 'PUT' });
    assert.equal(put.status, 200);
    const streams = await (await fetch(`${g.url}/api/streams`)).json();
    assert.deepEqual(streams.nvr_a_1_sub.producers[0].url, 'rtsp://u:p@h/x');
    assert.equal(g.streams.get('nvr_a_1_sub'), 'rtsp://u:p@h/x');
    const del = await fetch(`${g.url}/api/streams?src=nvr_a_1_sub`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(g.streams.size, 0);
  });

  test('PUT /api/streams 缺少參數回 400', async () => {
    g = await createFakeGo2rtc();
    assert.equal((await fetch(`${g.url}/api/streams?name=x`, { method: 'PUT' })).status, 400);
  });

  test('GET /api/frame.jpeg 回固定 JPEG', async () => {
    g = await createFakeGo2rtc();
    const r = await fetch(`${g.url}/api/frame.jpeg?src=x`);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(buf, FAKE_JPEG);
    assert.deepEqual([...buf.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  });

  test('WS /api/ws 回固定訊息（先 mse 文字訊息，再二進位）', async () => {
    g = await createFakeGo2rtc();
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/api/ws?src=x`);
    const msgs = [];
    await new Promise((resolve, reject) => {
      ws.onmessage = (e) => { msgs.push(e.data); if (msgs.length >= 2) resolve(); };
      ws.onerror = reject;
    });
    ws.close();
    assert.equal(typeof msgs[0], 'string');
    assert.equal(JSON.parse(msgs[0]).type, 'mse');
    assert.match(JSON.parse(msgs[0]).value, /avc1/);
  });

  test('close() 後不再接受連線', async () => {
    g = await createFakeGo2rtc();
    const url = g.url;
    await g.close();
    g = null;
    await assert.rejects(() => fetch(`${url}/api`));
  });
});
