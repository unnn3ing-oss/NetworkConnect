import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../../server/index.js';
import { createValidator } from '../../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs, readJsonFile } from '../../helpers/tmp.js';

const running = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  cleanupAllTmpDirs();
});

const v = createValidator();

async function boot() {
  const dataDir = makeTmpDir();
  const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {} });
  running.push(s);
  const call = async (method, url, body) => {
    const res = await fetch(`${s.url}${url}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { s, dataDir, call };
}

describe('GET/PUT /api/system/settings', () => {
  test('GET 回目前設定：lanAccess、port、modules，restartRequired 為 false；符合 schema', async () => {
    const { call } = await boot();
    const r = await call('GET', '/api/system/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      lanAccess: true, port: 8780,
      modules: { inventory: true, io: true, monitor: true, floorplan: true, nvr: true },
      restartRequired: false,
    });
    v.assert('api-system#Settings', r.json);
  });

  test('PUT lanAccess:false → 寫入 config.json，回應 restartRequired:true', async () => {
    const { call, dataDir } = await boot();
    const r = await call('PUT', '/api/system/settings', { lanAccess: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.lanAccess, false);
    assert.equal(r.json.restartRequired, true);
    v.assert('api-system#Settings', r.json);
    assert.equal(readJsonFile(dataDir, 'config.json').lanAccess, false);
    assert.equal((await call('GET', '/api/system/settings')).json.restartRequired, true, '重新啟動前一直是 true');
  });

  test('PUT port → 寫入並要求重新啟動；其他欄位不變', async () => {
    const { call, dataDir } = await boot();
    const r = await call('PUT', '/api/system/settings', { port: 9123 });
    assert.equal(r.json.port, 9123);
    assert.equal(r.json.lanAccess, true);
    assert.equal(r.json.restartRequired, true);
    assert.equal(readJsonFile(dataDir, 'config.json').port, 9123);
  });

  test('PUT modules 只更新有帶的模組（部分更新），也需要重新啟動才會生效', async () => {
    const { call, dataDir } = await boot();
    const r = await call('PUT', '/api/system/settings', { modules: { nvr: false } });
    assert.deepEqual(r.json.modules, { inventory: true, io: true, monitor: true, floorplan: true, nvr: false });
    assert.equal(r.json.restartRequired, true);
    assert.equal(readJsonFile(dataDir, 'config.json').modules.nvr, false);
  });

  test('改成與啟動時相同的值 → restartRequired 回到 false', async () => {
    const { call } = await boot();
    await call('PUT', '/api/system/settings', { lanAccess: false });
    const r = await call('PUT', '/api/system/settings', { lanAccess: true });
    assert.equal(r.json.restartRequired, false);
  });

  test('不得讓所有功能模組同時停用 → 400 VALIDATION，設定不變', async () => {
    const { call, dataDir } = await boot();
    const r = await call('PUT', '/api/system/settings', { modules: { inventory: false, io: false, monitor: false, floorplan: false, nvr: false } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.equal(readJsonFile(dataDir, 'config.json').modules.inventory, true);
    // 分次關閉到最後一個也要擋
    for (const m of ['inventory', 'io', 'monitor', 'floorplan']) assert.equal((await call('PUT', '/api/system/settings', { modules: { [m]: false } })).status, 200);
    const last = await call('PUT', '/api/system/settings', { modules: { nvr: false } });
    assert.equal(last.status, 400);
  });

  test('system 模組本身不可被設定停用（modules 不接受 system 鍵）', async () => {
    const { call } = await boot();
    assert.equal((await call('PUT', '/api/system/settings', { modules: { system: false } })).status, 400);
  });

  test('不合法的值：port 超出範圍、型別錯誤、未知欄位 → 400', async () => {
    const { call } = await boot();
    for (const body of [{ port: 0 }, { port: 70000 }, { port: 'abc' }, { lanAccess: 'yes' }, { go2rtcPath: '/x' }, { modules: { nvr: 'no' } }]) {
      const r = await call('PUT', '/api/system/settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'VALIDATION');
    }
  });

  test('已設存取密碼時需要登入', async () => {
    const { call } = await boot();
    await call('PUT', '/api/auth/password', { password: 'pw-1234' });
    assert.equal((await call('GET', '/api/system/settings')).status, 401);
    assert.equal((await call('PUT', '/api/system/settings', { lanAccess: false })).status, 401);
  });

  test('設定在下次啟動生效：lanAccess:false 時只綁 127.0.0.1，停用的模組為 disabled', async () => {
    const { call, dataDir, s } = await boot();
    await call('PUT', '/api/system/settings', { lanAccess: false, modules: { nvr: false } });
    await s.stop();
    const again = await startServer({ dataDir, port: 0, env: {} });
    running.push(again);
    assert.equal(again.app.server.address().address, '127.0.0.1');
    assert.equal(again.modules.list().find((m) => m.name === 'nvr').state, 'disabled');
    assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), true);
  });
});
