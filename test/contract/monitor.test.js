// monitor 契約測試：透過 startServer() 實際啟動，驗證 REST 回應符合 contracts/ 的 schema、SSE 與模組狀態。
// mock 模式使用 contracts/fixtures 的 30 台設備與假 prober，不碰真實網路。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startServer } from '../../server/index.js';
import { createValidator, readFixture } from '../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../helpers/tmp.js';

const v = createValidator();
const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  cleanupAllTmpDirs();
});

async function boot(opts = {}) {
  const s = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {}, ...opts });
  running.push(s);
  const call = async (method, url, body) => {
    const res = await fetch(`${s.url}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { s, call };
}

/** 連上 SSE，收集事件直到 predicate 成立或逾時 */
function sse(url, until, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '';
    const req = http.get(url, { agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) events.push({ name, payload: JSON.parse(data) });
        }
        if (until(events)) {
          req.destroy();
          resolve(events);
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve(events) : reject(e)));
    setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE 逾時，已收到：${events.map((e) => e.name).join(',')}`));
    }, timeoutMs).unref();
  });
}

const fixtureDevices = readFixture('db.sample.json').devices;

describe('monitor REST（mock 模式）', () => {
  test('/api/system/modules：monitor 為 ok', async () => {
    const { call } = await boot({ mock: true });
    const r = await call('GET', '/api/system/modules');
    assert.deepEqual(r.json.find((m) => m.name === 'monitor'), { name: 'monitor', state: 'ok' });
  });

  test('GET /api/status：每台設備一筆（含 disabled），符合 StatusList', async () => {
    const { call } = await boot({ mock: true });
    const r = await call('GET', '/api/status');
    assert.equal(r.status, 200);
    v.assert('api-monitor#StatusList', r.json);
    assert.equal(r.json.length, fixtureDevices.length);
    const noneIds = fixtureDevices.filter((d) => d.monitor.method === 'none').map((d) => d.id);
    assert.ok(noneIds.length > 0);
    for (const id of noneIds) assert.equal(r.json.find((i) => i.deviceId === id).state, 'disabled');
  });

  test('POST /api/status/:id/check：立即檢查一次，結果符合 StatusItem，並寫入歷史', async () => {
    const { call } = await boot({ mock: true });
    const r = await call('POST', '/api/status/dev_router/check');
    assert.equal(r.status, 200);
    v.assert('api-monitor#StatusItem', r.json);
    assert.equal(r.json.deviceId, 'dev_router');
    assert.equal(r.json.state, 'up');
    assert.notEqual(r.json.lastCheckAt, null);
    const h = await call('GET', '/api/status/dev_router/history?hours=1');
    assert.equal(h.status, 200);
    v.assert('api-monitor#HistoryResponse', h.json);
    assert.equal(h.json.hours, 1);
    assert.ok(h.json.samples.length >= 1);
    assert.equal(h.json.samples.at(-1).up, true);
  });

  test('POST check：method=none 的設備回 disabled 不檢查；不存在 → 404', async () => {
    const { call } = await boot({ mock: true });
    const none = fixtureDevices.find((d) => d.monitor.method === 'none');
    const r = await call('POST', `/api/status/${none.id}/check`);
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'disabled');
    assert.equal(r.json.lastCheckAt, null);
    const miss = await call('POST', '/api/status/dev_nope/check');
    assert.equal(miss.status, 404);
    v.assert('api-common#ErrorResponse', miss.json);
  });

  test('GET history：預設 24 小時；hours 超出 1–24 或不是整數 → 400；設備不存在 → 404', async () => {
    const { call } = await boot({ mock: true });
    const ok = await call('GET', '/api/status/dev_router/history');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.hours, 24);
    v.assert('api-monitor#HistoryResponse', ok.json);
    for (const bad of ['0', '25', 'abc', '1.5', '']) {
      const r = await call('GET', `/api/status/dev_router/history?hours=${bad}`);
      assert.equal(r.status, 400, `hours=${bad}`);
      assert.equal(r.json.error.code, 'VALIDATION');
    }
    const miss = await call('GET', '/api/status/dev_nope/history');
    assert.equal(miss.status, 404);
  });

  test('GET/PUT /api/monitor/settings：預設值、部分更新、驗證', async () => {
    const { call } = await boot({ mock: true });
    const g = await call('GET', '/api/monitor/settings');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json, { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null });
    v.assert('api-monitor#MonitorSettings', g.json);

    const p = await call('PUT', '/api/monitor/settings', { concurrency: 4 });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json, { defaultIntervalSec: 60, concurrency: 4, timeoutMs: 1500, pausedUntil: null });
    assert.equal((await call('GET', '/api/monitor/settings')).json.concurrency, 4);

    for (const bad of [{ concurrency: 0 }, { defaultIntervalSec: 5 }, { timeoutMs: 100 }, { nope: 1 }, { pausedUntil: 'tomorrow' }]) {
      const r = await call('PUT', '/api/monitor/settings', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.error.code, 'VALIDATION');
    }
    assert.equal((await call('GET', '/api/monitor/settings')).json.concurrency, 4, '驗證失敗不改變設定');
  });

  test('PUT pausedUntil 設定未來時間 → 回傳該時間；null → 取消；設定重啟後仍在（存檔）', async () => {
    const dataDir = makeTmpDir();
    const a = await boot({ mock: true, dataDir });
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const p = await a.call('PUT', '/api/monitor/settings', { pausedUntil: until });
    assert.equal(p.json.pausedUntil, until);
    await a.s.stop();
    running.splice(running.indexOf(a.s), 1);
    const b = await boot({ mock: true, dataDir });
    assert.equal((await b.call('GET', '/api/monitor/settings')).json.pausedUntil, until);
    const cleared = await b.call('PUT', '/api/monitor/settings', { pausedUntil: null });
    assert.equal(cleared.json.pausedUntil, null);
  });
});

describe('monitor SSE', () => {
  test('連線建立時送一次 status.snapshot（items 同 GET /api/status）', async () => {
    const { s, call } = await boot({ mock: true });
    const events = await sse(`${s.url}/api/events`, (e) => e.some((x) => x.name === 'status.snapshot'));
    const snap = events.find((e) => e.name === 'status.snapshot');
    v.assert('events#status_snapshot', snap.payload);
    assert.equal(snap.payload.items.length, fixtureDevices.length);
    assert.deepEqual(snap.payload.items.map((i) => i.deviceId), (await call('GET', '/api/status')).json.map((i) => i.deviceId));
  });

  test('狀態改變時推播 status.changed（符合 schema）', async () => {
    const { s } = await boot({ mock: true });
    const pending = sse(`${s.url}/api/events`, (e) => e.some((x) => x.name === 'status.changed'), 8000);
    // 啟動後 5 秒內每台會做第一次偵測（unknown → up／維持 unknown），這裡直接等第一則
    const events = await pending;
    const ch = events.find((e) => e.name === 'status.changed');
    v.assert('events#status_changed', ch.payload);
    assert.notEqual(ch.payload.from, ch.payload.to);
  });
});

describe('monitor 與 inventory 事件（真實 tcp prober）', () => {
  test('新增／修改／刪除設備時重新排程；刪除後狀態與歷史消失', async () => {
    const { s, call } = await boot();
    const server = net.createServer((sock) => sock.end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const now = new Date().toISOString();
      const device = {
        id: 'dev_local', code: 'L01', name: '本機', categoryId: 'cat_other', floorId: null, roomId: null, groupIds: [],
        ip: '127.0.0.1', mac: '', hostname: '', vendor: '', model: '', uplink: null,
        monitor: { method: 'tcp', port, path: '/', intervalSec: 15, critical: false }, notes: '', createdAt: now, updatedAt: now,
      };
      assert.deepEqual((await call('GET', '/api/status')).json, []);
      const devices = s.store.collection('devices');
      await devices.insert(device).catch(() => {}); // devices 由 inventory 擁有；根 store 可寫
      s.events.emit('inventory.changed', { collection: 'devices', op: 'create', id: 'dev_local' });
      await waitFor(async () => (await call('GET', '/api/status')).json.find((i) => i.deviceId === 'dev_local')?.state === 'up', { message: '本機 tcp 設備應該變成 up' });
      const h = await call('GET', '/api/status/dev_local/history');
      assert.ok(h.json.samples.length >= 1);

      await devices.remove('dev_local');
      s.events.emit('inventory.changed', { collection: 'devices', op: 'delete', id: 'dev_local' });
      await waitFor(async () => (await call('GET', '/api/status')).json.length === 0);
      assert.equal((await call('GET', '/api/status/dev_local/history')).status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
