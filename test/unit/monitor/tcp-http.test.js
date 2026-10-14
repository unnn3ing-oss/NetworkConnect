import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { probe as tcpProbe, TCP_TIMEOUT_MS } from '../../../server/modules/monitor/probers/tcp.js';
import { probe as httpProbe } from '../../../server/modules/monitor/probers/http.js';
import { createProber } from '../../../server/modules/monitor/probers/index.js';

const closers = [];
after(async () => {
  for (const c of closers) await new Promise((r) => c(r));
});

function listenTcp() {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => sock.end());
    s.listen(0, '127.0.0.1', () => {
      closers.push((r) => s.close(r));
      resolve(s.address().port);
    });
  });
}
function listenHttp(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      closers.push((r) => {
        s.closeAllConnections();
        s.close(r);
      });
      resolve(s.address().port);
    });
  });
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

describe('tcp prober', () => {
  test('埠開著 → ok 並有延遲', async () => {
    const port = await listenTcp();
    const r = await tcpProbe({ host: '127.0.0.1', port, timeoutMs: 1500 });
    assert.equal(r.ok, true);
    assert.equal(typeof r.rttMs, 'number');
    assert.equal(r.error, undefined);
  });
  test('埠沒開（連線被拒）→ ok:false，無 error', async () => {
    const port = await freePort();
    const r = await tcpProbe({ host: '127.0.0.1', port, timeoutMs: 1500 });
    assert.deepEqual(r, { ok: false, rttMs: null });
  });
  test('逾時或無路由 → ok:false，在 timeoutMs 附近返回', async () => {
    const started = Date.now();
    // 192.0.2.0/24 為文件用保留網段，不會有回應
    const r = await tcpProbe({ host: '192.0.2.1', port: 81, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 2500);
  });
  test('缺少埠號 → 檢查本身出錯', async () => {
    const r = await tcpProbe({ host: '127.0.0.1', port: null });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
  test('預設逾時為 1500ms', () => {
    assert.equal(TCP_TIMEOUT_MS, 1500);
  });
});

describe('http prober', () => {
  test('200 → ok', async () => {
    const port = await listenHttp((req, res) => res.end('hi'));
    const r = await httpProbe({ host: '127.0.0.1', port, path: '/', timeoutMs: 1500 });
    assert.equal(r.ok, true);
    assert.equal(typeof r.rttMs, 'number');
  });
  test('301／401／404 等 < 500 也視為 up', async () => {
    for (const code of [301, 401, 404]) {
      const port = await listenHttp((req, res) => {
        res.statusCode = code;
        res.setHeader('location', '/x');
        res.end();
      });
      const r = await httpProbe({ host: '127.0.0.1', port, path: '/', timeoutMs: 1500 });
      assert.equal(r.ok, true, String(code));
    }
  });
  test('500／503 → ok:false', async () => {
    for (const code of [500, 503]) {
      const port = await listenHttp((req, res) => {
        res.statusCode = code;
        res.end();
      });
      const r = await httpProbe({ host: '127.0.0.1', port, path: '/', timeoutMs: 1500 });
      assert.deepEqual(r, { ok: false, rttMs: null }, String(code));
    }
  });
  test('使用指定 path', async () => {
    let seen;
    const port = await listenHttp((req, res) => {
      seen = req.url;
      res.end();
    });
    await httpProbe({ host: '127.0.0.1', port, path: '/status?x=1', timeoutMs: 1500 });
    assert.equal(seen, '/status?x=1');
  });
  test('連線被拒 → ok:false', async () => {
    const port = await freePort();
    const r = await httpProbe({ host: '127.0.0.1', port, path: '/', timeoutMs: 1500 });
    assert.deepEqual(r, { ok: false, rttMs: null });
  });
  test('伺服器不回應 → 逾時（AbortController）→ ok:false', async () => {
    const port = await listenHttp(() => {});
    const started = Date.now();
    const r = await httpProbe({ host: '127.0.0.1', port, path: '/', timeoutMs: 200 });
    assert.deepEqual(r, { ok: false, rttMs: null });
    assert.ok(Date.now() - started < 2000);
  });
  test('path 沒有開頭的 / 也能運作', async () => {
    const port = await listenHttp((req, res) => res.end());
    const r = await httpProbe({ host: '127.0.0.1', port, path: 'status', timeoutMs: 1500 });
    assert.equal(r.ok, true);
  });
  test('host 含不合法字元 → 檢查本身出錯，不發出請求', async () => {
    let called = false;
    const r = await httpProbe(
      { host: '127.0.0.1/evil?x=', port: 80, path: '/', timeoutMs: 300 },
      { fetchImpl: async () => { called = true; return { status: 200 }; } },
    );
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(called, false);
  });
  test('自簽憑證（握手有回應）→ 主機活著，視為 up', async () => {
    const certErr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
    const r = await httpProbe({ host: '192.168.1.1', port: 443, path: '/' }, { fetchImpl: async () => { throw certErr; } });
    assert.equal(r.ok, true);
  });
});

describe('createProber（對應 ctx.prober 介面：{up, rttMs}，檢查出錯 reject）', () => {
  test('依 method 分派', async () => {
    const tcpPort = await listenTcp();
    const calls = [];
    const prober = createProber({
      icmp: async (req) => {
        calls.push(['icmp', req.host]);
        return { ok: true, rttMs: 2 };
      },
    });
    assert.deepEqual(await prober.probe({ method: 'icmp', host: '10.0.0.1' }), { up: true, rttMs: 2 });
    assert.deepEqual(calls, [['icmp', '10.0.0.1']]);
    const r = await prober.probe({ method: 'tcp', host: '127.0.0.1', port: tcpPort, timeoutMs: 1500 });
    assert.equal(r.up, true);
  });
  test('失敗 → {up:false, rttMs:null}', async () => {
    const prober = createProber({ icmp: async () => ({ ok: false, rttMs: null }) });
    assert.deepEqual(await prober.probe({ method: 'icmp', host: '10.0.0.1' }), { up: false, rttMs: null });
  });
  test('檢查本身出錯（error）→ reject', async () => {
    const prober = createProber({ icmp: async () => ({ ok: false, rttMs: null, error: '找不到 ping' }) });
    await assert.rejects(prober.probe({ method: 'icmp', host: '10.0.0.1' }), /找不到 ping/);
  });
  test('未知 method → reject', async () => {
    const prober = createProber({});
    await assert.rejects(prober.probe({ method: 'carrier-pigeon', host: '10.0.0.1' }));
  });
});
