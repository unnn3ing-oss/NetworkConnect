import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../../../server/index.js';
import { MODULE_NAMES } from '../../../server/core/module-loader.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor, sleep } from '../../helpers/tmp.js';

const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  cleanupAllTmpDirs();
});

async function boot(opts = {}) {
  const dataDir = opts.dataDir ?? makeTmpDir();
  const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {}, ...opts });
  running.push(s);
  return { ...s, dataDir };
}

/** 不使用連線池（agent:false），避免用戶端殘留 socket 影響「無殘留」判斷 */
function get(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) });
      });
    });
    req.on('error', reject);
  });
}

describe('startServer：基本行為', () => {
  test('port:0 由系統分配；回傳 {port, url, stop}；health 正常', async () => {
    const s = await boot();
    assert.ok(Number.isInteger(s.port) && s.port > 0);
    assert.equal(s.url, `http://127.0.0.1:${s.port}`);
    assert.equal(typeof s.stop, 'function');
    const r = await get(`${s.url}/api/system/health`);
    assert.equal(r.status, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.ok(body.uptime >= 0);
  });

  test('/api/system/modules 列出所有模組為 ok', async () => {
    const s = await boot();
    const r = await get(`${s.url}/api/system/modules`);
    // note 是模組自訂的附加說明（例如 nvr 在 go2rtc 未啟動時的提示），不影響 state
    assert.deepEqual(r.json().map(({ name, state }) => ({ name, state })), MODULE_NAMES.map((name) => ({ name, state: 'ok' })));
  });

  test('config.json 的 modules 可停用模組', async () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ modules: { nvr: false } }));
    const s = await boot({ dataDir });
    const mods = (await get(`${s.url}/api/system/modules`)).json();
    assert.equal(mods.find((m) => m.name === 'nvr').state, 'disabled');
    assert.equal(mods.find((m) => m.name === 'inventory').state, 'ok');
  });

  test('所有回應帶有規格 §11 的 CSP', async () => {
    const s = await boot();
    const csp = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; connect-src 'self'";
    assert.equal((await get(`${s.url}/api/system/health`)).headers['content-security-policy'], csp);
    assert.equal((await get(`${s.url}/`)).headers['content-security-policy'], csp);
    assert.equal((await get(`${s.url}/api/nope`)).headers['content-security-policy'], csp);
  });

  test('不存在的 /api 路由回統一錯誤格式 404', async () => {
    const s = await boot();
    const r = await get(`${s.url}/api/does-not-exist`);
    assert.equal(r.status, 404);
    assert.equal(r.json().error.code, 'NOT_FOUND');
    assert.equal(typeof r.json().error.message, 'string');
  });

  test('環境變數 NC_DATA_DIR 決定資料夾', async () => {
    const dataDir = path.join(makeTmpDir(), 'from-env');
    const s = await startServer({ port: 0, host: '127.0.0.1', env: { NC_DATA_DIR: dataDir } });
    running.push(s);
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
  });

  test('NC_PORT／NC_HOST 環境變數在沒有明確參數時生效', async () => {
    const s = await startServer({ dataDir: makeTmpDir(), env: { NC_PORT: '0', NC_HOST: '127.0.0.1' } });
    running.push(s);
    assert.equal(s.url.startsWith('http://127.0.0.1:'), true);
  });

  test('host 為 0.0.0.0（lanAccess）時 url 仍用 127.0.0.1，lanAccess:false 時綁 127.0.0.1', async () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ lanAccess: false }));
    const s = await startServer({ dataDir, port: 0, env: {} });
    running.push(s);
    assert.equal(s.app.server.address().address, '127.0.0.1');
    const s2 = await startServer({ dataDir: makeTmpDir(), port: 0, env: {} });
    running.push(s2);
    assert.match(s2.app.server.address().address, /^(0\.0\.0\.0|::)$/);
    assert.equal(s2.url, `http://127.0.0.1:${s2.port}`);
  });
});

describe('startServer：靜態檔案', () => {
  test('GET / 回 web/index.html', async () => {
    const s = await boot();
    const r = await get(`${s.url}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.text, /<title>NetworkConnect<\/title>/);
  });

  test('vendor 檔案可取得', async () => {
    const s = await boot();
    const r = await get(`${s.url}/vendor/cytoscape.min.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /javascript/);
  });

  test('.js/.mjs 以 text/javascript 送出，.css 以 text/css 送出（ES Module 才能載入）', async () => {
    const s = await boot();
    for (const p of ['/app.js', '/ui/index.js', '/modules/devices/index.js']) {
      const r = await get(`${s.url}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], /^text\/javascript/, p);
    }
    const css = await get(`${s.url}/ui/tokens.css`);
    assert.match(css.headers['content-type'], /^text\/css/);
  });

  test('index.html 引用的所有樣式表與腳本都存在（不需要特例）', async () => {
    const s = await boot();
    const html = (await get(`${s.url}/`)).text;
    const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+\.(?:css|js|svg))"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 6);
    for (const ref of refs) assert.equal((await get(`${s.url}${ref}`)).status, 200, ref);
  });

  test('不存在的檔案是 404', async () => {
    const s = await boot();
    assert.equal((await get(`${s.url}/ui/not-there.css`)).status, 404);
    assert.equal((await get(`${s.url}/ui/not-there.js`)).status, 404);
    assert.equal((await get(`${s.url}/nope.html`)).status, 404);
  });
});

describe('startServer：埠被佔用時往後找（最多 20 個）', () => {
  test('指定埠被佔用 → 使用較大的下一個可用埠', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    try {
      const s = await boot({ port: busy });
      assert.ok(s.port > busy && s.port <= busy + 20, `port=${s.port} busy=${busy}`);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  test('連續 21 個埠都被佔用 → 啟動失敗並丟出清楚的錯誤', async () => {
    const start = 41000 + Math.floor(Math.random() * 15000);
    const blockers = [];
    try {
      for (let i = 0; i <= 20; i++) {
        const b = net.createServer();
        try {
          await new Promise((res, rej) => { b.once('error', rej); b.listen(start + i, '127.0.0.1', res); });
          blockers.push(b);
        } catch {
          // 這個埠剛好被別的程式占用，也算占用
        }
      }
      await assert.rejects(() => startServer({ dataDir: makeTmpDir(), port: start, host: '127.0.0.1', env: {} }), /埠/);
    } finally {
      await Promise.all(blockers.map((b) => new Promise((r) => b.close(r))));
    }
  });

  test('未明確指定 port、因被佔用而換埠時，實際埠號寫回 config.json', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: busy }));
    try {
      const s = await startServer({ dataDir, host: '127.0.0.1', env: {} });
      running.push(s);
      assert.notEqual(s.port, busy);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).port, s.port);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe('startServer：stop() 後無殘留', () => {
  const interesting = (list) => list.filter((t) => /^(Timeout|TCPServerWrap|TCPSocketWrap|Immediate|FSReqCallback)/.test(t)).sort();

  test('stop 後埠不再可連線，且沒有殘留的計時器與 socket', async () => {
    await sleep(50);
    const before = interesting(process.getActiveResourcesInfo());
    const s = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {} });
    // 開一條 SSE 連線，確認 stop 會主動結束它
    const sse = await new Promise((resolve) => {
      const req = http.get(`${s.url}/api/events`, { agent: false }, (res) => resolve({ req, res }));
    });
    await waitFor(() => s.events.clientCount() === 1);
    sse.res.resume(); // 不讀資料的話 'close' 不會觸發
    const closed = new Promise((r) => sse.res.on('close', r));
    await s.stop();
    await closed;
    await assert.rejects(() => get(`${s.url}/api/system/health`), /ECONNREFUSED/);
    await sleep(100);
    const after = interesting(process.getActiveResourcesInfo());
    assert.deepEqual(after, before, '停止後不應多出計時器或 socket');
  });

  test('stop() 可重複呼叫', async () => {
    const s = await boot();
    await s.stop();
    await assert.doesNotReject(() => s.stop());
  });

  test('stop() 會把待寫入的資料落盤', async () => {
    const dataDir = makeTmpDir();
    const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {} });
    await s.store.collection('floors').insert({ id: 'flr_1', name: '1F', order: 1, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
    await s.stop();
    assert.ok(fs.existsSync(path.join(dataDir, 'db', 'floors.json')));
  });
});

describe('startServer：故障隔離（驗收 3）', () => {
  test('某 stub 的 check() 丟錯 → 該模組 failed，其他 ok，伺服器仍啟動', async () => {
    const real = (name) => import(new URL(`../../../server/modules/${name}/index.js`, import.meta.url).href);
    const moduleImporter = async (name) => {
      const mod = await real(name);
      if (name !== 'floorplan') return mod;
      return { default: { ...mod.default, async check() { throw new Error('模擬自我檢查失敗'); } } };
    };
    const s = await boot({ moduleImporter });
    const mods = (await get(`${s.url}/api/system/modules`)).json();
    assert.deepEqual(mods.find((m) => m.name === 'floorplan'), { name: 'floorplan', state: 'failed', error: '模擬自我檢查失敗' });
    for (const m of mods.filter((x) => x.name !== 'floorplan')) assert.equal(m.state, 'ok', m.name);
    assert.equal((await get(`${s.url}/api/system/health`)).status, 200);
  });
});

describe('startServer：資料寫入以契約驗證', () => {
  test('寫入不符合 schema 的紀錄會被拒絕', async () => {
    const s = await boot();
    await assert.rejects(() => s.store.collection('floors').insert({ id: 'flr_1' }), (e) => e.code === 'VALIDATION');
    await assert.rejects(() => s.store.collection('placements').insert({ deviceId: 'dev_1', floorId: 'flr_1', x: 3, y: 0 }), (e) => e.code === 'VALIDATION');
    await s.store.collection('floors').insert({ id: 'flr_1', name: '1F', order: 1, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' });
  });
});

describe('startServer：認證整合', () => {
  test('設定密碼後 /api/* 需要登入，health 與靜態檔例外', async () => {
    const s = await boot();
    const put = await fetch(`${s.url}/api/auth/password`, {
      method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ password: 'hello-1234' }),
    });
    assert.equal(put.status, 200);
    assert.equal((await get(`${s.url}/api/system/modules`)).status, 401);
    assert.equal((await get(`${s.url}/api/system/health`)).status, 200);
    assert.equal((await get(`${s.url}/`)).status, 200);
    assert.equal((await get(`${s.url}/api/events`)).status, 401);
  });
});

describe('startServer：SSE', () => {
  test('ctx.events 發布的事件會從 /api/events 送出', async () => {
    const s = await boot();
    const got = await new Promise((resolve) => {
      http.get(`${s.url}/api/events`, { agent: false }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('event: placement.changed')) { res.destroy(); resolve(buf); }
        });
        setTimeout(() => s.events.emit('placement.changed', { deviceId: 'dev_a', floorId: 'flr_1' }), 50);
      });
    });
    assert.match(got, /event: placement\.changed\ndata: \{"deviceId":"dev_a","floorId":"flr_1"\}/);
  });
});

describe('startServer：Electron utilityProcess（process.parentPort）', () => {
  function fakeParentPort() {
    const port = new EventEmitter();
    port.sent = [];
    port.postMessage = (m) => port.sent.push(m);
    return port;
  }

  test('就緒後送出 {type:"ready", port}', async () => {
    const parentPort = fakeParentPort();
    const s = await boot({ parentPort, exit: () => {} });
    assert.deepEqual(parentPort.sent[0], { type: 'ready', port: s.port });
  });

  test('status.changed 轉送 {type:"event", name, payload}；其他事件不轉送', async () => {
    const parentPort = fakeParentPort();
    const s = await boot({ parentPort, exit: () => {} });
    const payload = { deviceId: 'dev_a', from: 'up', to: 'down', rttMs: null, at: '2026-10-14T08:30:00.000Z' };
    s.events.emit('status.changed', payload);
    s.events.emit('placement.changed', { deviceId: 'dev_a', floorId: 'flr_1' });
    assert.deepEqual(parentPort.sent.slice(1), [{ type: 'event', name: 'status.changed', payload }]);
  });

  test('收到 {type:"shutdown"}（Electron 以 {data} 包裝）時 stop() 後呼叫 exit', async () => {
    const parentPort = fakeParentPort();
    let exitCode = null;
    const s = await boot({ parentPort, exit: (code) => { exitCode = code; } });
    parentPort.emit('message', { data: { type: 'shutdown' } });
    await waitFor(() => exitCode !== null);
    assert.equal(exitCode, 0);
    await assert.rejects(() => get(`${s.url}/api/system/health`), /ECONNREFUSED/);
  });

  test('沒有 parentPort 時不送任何訊息', async () => {
    const s = await boot();
    assert.ok(s.port > 0);
  });
});

describe('startServer：mock 模式（NC_MOCK=1）', () => {
  test('從 fixtures 載入資料、複製平面圖、啟動假 go2rtc、提供假 prober；不碰真實 data/', async () => {
    const dataDir = path.join(makeTmpDir(), 'data-mock');
    const s = await boot({ dataDir, mock: true });
    assert.equal((await s.store.collection('devices').list()).length >= 25, true);
    assert.equal((await s.store.collection('floors').list()).length, 3);
    assert.equal((await s.store.collection('nvrs').list())[0].channels.length, 8);
    assert.ok(fs.existsSync(path.join(dataDir, 'plans', 'flr_1.png')));
    assert.equal(s.ctx.mock, true);
    assert.equal(typeof s.ctx.prober.probe, 'function');
    const g = await get(`${s.ctx.config.go2rtcUrl}/api`);
    assert.equal(g.status, 200);
    const mods = (await get(`${s.url}/api/system/modules`)).json();
    assert.ok(mods.every((m) => m.state === 'ok'));
  });

  test('NC_MOCK=1 環境變數等同 mock:true；沒給 dataDir 時使用 <cwd>/data-mock', async () => {
    const cwd = makeTmpDir();
    const old = process.cwd();
    process.chdir(cwd);
    try {
      const s = await startServer({ port: 0, host: '127.0.0.1', env: { NC_MOCK: '1' } });
      running.push(s);
      assert.equal(s.ctx.mock, true);
      assert.ok(fs.existsSync(path.join(fs.realpathSync(cwd), 'data-mock', 'config.json')));
      assert.equal(fs.existsSync(path.join(cwd, 'data')), false);
    } finally {
      process.chdir(old);
    }
  });

  test('每次啟動 mock 都重置為 fixtures 內容', async () => {
    const dataDir = makeTmpDir();
    const a = await startServer({ dataDir, port: 0, host: '127.0.0.1', mock: true, env: {} });
    await a.store.collection('devices').remove('dev_router');
    await a.stop();
    const b = await startServer({ dataDir, port: 0, host: '127.0.0.1', mock: true, env: {} });
    running.push(b);
    assert.ok(await b.store.collection('devices').get('dev_router'));
  });
});
