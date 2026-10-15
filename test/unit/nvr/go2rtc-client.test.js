// go2rtc 用戶端：註冊／移除串流、probe（MSE codec）、錯誤分類，逾時與連線失敗一律轉成 UPSTREAM。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGo2rtc } from '../../helpers/fake-go2rtc.js';
import { classifyProbeError, createGo2rtcClient, parseMseCodec } from '../../../server/modules/nvr/go2rtc-client.js';
import { AppError } from '../../../server/core/errors.js';

/** 只收 TCP 連線、永遠不回應的伺服器（模擬 go2rtc 卡死） */
function blackHole() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(r);
        }),
      });
    });
  });
}

/** 取得一個沒人監聽的埠 */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

describe('parseMseCodec／classifyProbeError', () => {
  test('avc1 → h264；hvc1／hev1 → h265', () => {
    assert.deepEqual(parseMseCodec('video/mp4; codecs="avc1.640029,mp4a.40.2"'), { codec: 'h264', codecs: 'avc1.640029,mp4a.40.2' });
    assert.equal(parseMseCodec('video/mp4; codecs="hvc1.1.6.L153.B0"').codec, 'h265');
    assert.equal(parseMseCodec('video/mp4; codecs="hev1.1.6.L93.B0,mp4a.40.2"').codec, 'h265');
    assert.equal(parseMseCodec('video/mp4; codecs="mp4a.40.2"').codec, 'mp4a.40.2');
    assert.equal(parseMseCodec('').codec, 'unknown');
  });

  test('錯誤訊息分類：帳密錯誤、連不到主機、其他', () => {
    assert.equal(classifyProbeError('streams: wrong user/pass'), 'auth');
    assert.equal(classifyProbeError('rtsp: 401 Unauthorized'), 'auth');
    assert.equal(classifyProbeError('streams: dial tcp 192.168.1.20:554: connect: connection refused'), 'unreachable');
    assert.equal(classifyProbeError('streams: dial tcp 192.168.1.20:554: i/o timeout'), 'unreachable');
    assert.equal(classifyProbeError('dial tcp: lookup nvr.local: no such host'), 'unreachable');
    assert.equal(classifyProbeError('connect: no route to host'), 'unreachable');
    assert.equal(classifyProbeError('streams: codecs not matched'), 'error');
  });
});

describe('對假 go2rtc 的操作', () => {
  let fake;
  let client;
  before(async () => {
    fake = await createFakeGo2rtc();
    client = createGo2rtcClient({ baseUrl: fake.url, probeTimeoutMs: 400 });
  });
  after(() => fake.close());

  test('info：回傳版本', async () => {
    assert.equal((await client.info()).version, '1.9.14-fake');
  });

  test('upsertStream 註冊、再次呼叫取代；removeStream 移除', async () => {
    await client.upsertStream('nvr_nvr_x_1_sub', 'rtsp://u:p%40@h:554/a?b=1&c=2');
    assert.equal(fake.streams.get('nvr_nvr_x_1_sub'), 'rtsp://u:p%40@h:554/a?b=1&c=2', 'src 要原樣傳到 go2rtc（含 query 與百分比編碼）');
    await client.upsertStream('nvr_nvr_x_1_sub', 'rtsp://other/b');
    assert.equal(fake.streams.get('nvr_nvr_x_1_sub'), 'rtsp://other/b');
    assert.deepEqual(Object.keys(await client.listStreams()), ['nvr_nvr_x_1_sub']);
    await client.removeStream('nvr_nvr_x_1_sub');
    assert.equal(fake.streams.has('nvr_nvr_x_1_sub'), false);
    await client.removeStream('不存在的串流'); // 不丟錯
  });

  test('絕不使用 /api/frame.jpeg（App 沒有內附 ffmpeg）', async () => {
    fake.streams.set('s', 'rtsp://x');
    await client.probe('s');
    assert.equal(fake.requests.some((r) => r.url.includes('frame.jpeg')), false);
  });

  test('probe：H.264', async () => {
    fake.streams.set('h264', 'rtsp://x');
    assert.deepEqual(await client.probe('h264'), { ok: true, codec: 'h264', codecs: 'avc1.640029' });
  });

  test('probe：H.265', async () => {
    fake.streams.set('h265', 'rtsp://x');
    fake.setCodec('h265', 'hvc1.1.6.L153.B0');
    const r = await client.probe('h265');
    assert.equal(r.ok, true);
    assert.equal(r.codec, 'h265');
  });

  test('probe：串流錯誤依訊息分類，且訊息中的 RTSP 帳密被遮掉', async () => {
    fake.streams.set('bad', 'rtsp://x');
    fake.setStreamError('bad', 'streams: wrong user/pass');
    assert.deepEqual(await client.probe('bad'), { ok: false, reason: 'auth', error: 'streams: wrong user/pass' });
    fake.setStreamError('bad', 'dial tcp 10.0.0.9:554: connect: connection refused');
    assert.equal((await client.probe('bad')).reason, 'unreachable');
    fake.setStreamError('bad', 'failed rtsp://admin:hunter2@10.0.0.9/x');
    const r = await client.probe('bad');
    assert.equal(r.reason, 'error');
    assert.doesNotMatch(r.error, /hunter2/);
  });

  test('probe：未註冊的串流 → ok:false', async () => {
    const r = await client.probe('沒註冊過');
    assert.equal(r.ok, false);
  });

  test('probe：WebSocket 已連上但 go2rtc 不回編碼 → ok:false reason=timeout，且連線被關閉', async () => {
    fake.streams.set('mute', 'rtsp://x');
    fake.setSilent('mute');
    const t0 = Date.now();
    const r = await client.probe('mute');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.ok(Date.now() - t0 >= 350);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(fake.connectionCount('mute'), 0, 'probe 結束後必須關閉 WebSocket');
  });

  test('probe 成功後也會關閉連線', async () => {
    fake.streams.set('closing', 'rtsp://x');
    await client.probe('closing');
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(fake.connectionCount('closing'), 0);
  });
});

describe('go2rtc 本身不可用 → UPSTREAM', () => {
  const isUpstream = (err) => err instanceof AppError && err.code === 'UPSTREAM' && err.status === 502;

  test('連不上（埠沒人聽）', async () => {
    const client = createGo2rtcClient({ baseUrl: `http://127.0.0.1:${await closedPort()}`, probeTimeoutMs: 400 });
    await assert.rejects(client.upsertStream('a', 'rtsp://x'), isUpstream);
    await assert.rejects(client.removeStream('a'), isUpstream);
    await assert.rejects(client.info(), isUpstream);
    await assert.rejects(client.listStreams(), isUpstream);
    await assert.rejects(client.probe('a'), isUpstream);
  });

  test('HTTP 逾時（伺服器收了連線卻不回應）', async () => {
    const hole = await blackHole();
    try {
      const client = createGo2rtcClient({ baseUrl: hole.url, timeoutMs: 150, probeTimeoutMs: 250 });
      const t0 = Date.now();
      await assert.rejects(client.upsertStream('a', 'rtsp://x'), (err) => isUpstream(err) && err.details?.reason === 'timeout');
      assert.ok(Date.now() - t0 < 2000);
      await assert.rejects(client.info({ timeout: 100 }), isUpstream);
    } finally {
      await hole.close();
    }
  });

  test('probe：WebSocket 握手逾時 → UPSTREAM', async () => {
    const hole = await blackHole();
    try {
      const client = createGo2rtcClient({ baseUrl: hole.url, probeTimeoutMs: 250 });
      await assert.rejects(client.probe('a'), (err) => isUpstream(err) && err.details?.reason === 'timeout');
    } finally {
      await hole.close();
    }
  });

  test('go2rtc 回非 2xx → UPSTREAM', async () => {
    const fake = await createFakeGo2rtc();
    try {
      const client = createGo2rtcClient({ baseUrl: fake.url });
      await assert.rejects(client.upsertStream('', ''), (err) => isUpstream(err) && err.details?.status === 400);
    } finally {
      await fake.close();
    }
  });
});
