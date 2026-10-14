import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadModules, MODULE_NAMES } from '../../../server/core/module-loader.js';
import { createStore } from '../../../server/core/store.js';
import { installErrorHandler } from '../../../server/core/errors.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

const OWNS = {
  system: [], inventory: ['floors', 'rooms', 'groups', 'categories', 'devices'], io: [],
  monitor: ['statusHistory'], floorplan: ['plans', 'placements'], nvr: ['nvrs'],
};

/** 以 stub 模組組成 importer；overrides[name] 可替換成自訂行為 */
function stubImporter(overrides = {}, calls = []) {
  return async (name) => {
    const base = {
      name,
      owns: OWNS[name],
      async check() { calls.push(`${name}.check`); },
      async register(app) { app.get(`/api/${name}/ping`, async () => ({ name })); calls.push(`${name}.register`); },
      async start() { calls.push(`${name}.start`); },
      async stop() { calls.push(`${name}.stop`); },
    };
    const o = overrides[name];
    if (o instanceof Error) throw o; // 模擬 import 本身失敗
    return { default: { ...base, ...(o ?? {}) } };
  };
}

async function setup({ overrides, config = {}, calls } = {}) {
  const app = Fastify();
  installErrorHandler(app);
  const store = await createStore({ dataDir: makeTmpDir() });
  const loader = await loadModules({
    app,
    config: { modules: { inventory: true, io: true, monitor: true, floorplan: true, nvr: true, ...config } },
    store,
    ctxBase: { events: {}, log: { info() {}, warn() {}, error() {} }, secrets: {} },
    importer: stubImporter(overrides, calls),
  });
  await app.ready();
  return { app, store, loader };
}

describe('module-loader：正常情況', () => {
  test('依序載入全部模組，狀態皆為 ok，路由可用', async () => {
    const { app, loader, store } = await setup();
    assert.deepEqual(loader.list().map((m) => m.name), MODULE_NAMES);
    assert.ok(loader.list().every((m) => m.state === 'ok'));
    const res = await app.inject('/api/monitor/ping');
    assert.equal(res.statusCode, 200);
    await app.close();
    await store.close();
  });

  test('呼叫順序：每個模組 check → register；start 在全部 register 之後；stop 以相反順序', async () => {
    const calls = [];
    const { loader, app, store } = await setup({ calls });
    await loader.start();
    await loader.stop();
    const startIdx = calls.indexOf('system.start');
    assert.ok(calls.filter((c) => c.endsWith('.register')).every((c) => calls.indexOf(c) < startIdx));
    assert.ok(calls.indexOf('inventory.check') < calls.indexOf('inventory.register'));
    const stops = calls.filter((c) => c.endsWith('.stop'));
    assert.deepEqual(stops, [...MODULE_NAMES].reverse().map((n) => `${n}.stop`));
    await app.close();
    await store.close();
  });

  test('每個模組拿到的 ctx：store 是專屬視圖（有 owns 才能寫），並含 modules.list()', async () => {
    let seen;
    const { loader, app, store } = await setup({
      overrides: { monitor: { async register(_app, ctx) { seen = ctx; } } },
    });
    await assert.rejects(() => seen.store.collection('devices').insert({ id: 'dev_1', name: 'x' }), /擁有者/);
    await seen.store.collection('statusHistory').insert({ deviceId: 'dev_1', samples: [] });
    assert.equal(seen.modules.list().length, MODULE_NAMES.length);
    await loader.stop();
    await app.close();
    await store.close();
  });
});

describe('module-loader：故障隔離（規格 §5 第 4 點）', () => {
  test('check() 丟錯 → 該模組 failed 並帶原因，其他模組 ok，路由不註冊', async () => {
    const calls = [];
    const { app, loader, store } = await setup({
      calls,
      overrides: { monitor: { async check() { throw new Error('找不到 ping 指令'); } } },
    });
    const byName = Object.fromEntries(loader.list().map((m) => [m.name, m]));
    assert.equal(byName.monitor.state, 'failed');
    assert.equal(byName.monitor.error, '找不到 ping 指令');
    for (const n of MODULE_NAMES.filter((x) => x !== 'monitor')) assert.equal(byName[n].state, 'ok', n);
    assert.equal(calls.includes('monitor.register'), false, 'check 失敗就不該 register');
    assert.equal((await app.inject('/api/monitor/ping')).statusCode, 404);
    assert.equal((await app.inject('/api/floorplan/ping')).statusCode, 200);
    await loader.start();
    assert.equal(calls.includes('monitor.start'), false, 'failed 模組不該 start');
    await loader.stop();
    assert.equal(calls.includes('monitor.stop'), false, 'failed 模組不該 stop');
    await app.close();
    await store.close();
  });

  test('register() 丟錯 → failed；register 前已註冊的路由改回 503 UPSTREAM', async () => {
    const { app, loader, store } = await setup({
      overrides: {
        nvr: {
          async register(a) {
            a.get('/api/nvr/early', async () => ({ ok: true }));
            throw new Error('註冊失敗');
          },
        },
      },
    });
    const nvr = loader.list().find((m) => m.name === 'nvr');
    assert.deepEqual(nvr, { name: 'nvr', state: 'failed', error: '註冊失敗' });
    const res = await app.inject('/api/nvr/early');
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'UPSTREAM');
    assert.equal((await app.inject('/api/io/ping')).statusCode, 200);
    await app.close();
    await store.close();
  });

  test('import 失敗（語法錯誤等）→ failed', async () => {
    const { app, loader, store } = await setup({ overrides: { floorplan: new SyntaxError('Unexpected token') } });
    const m = loader.list().find((x) => x.name === 'floorplan');
    assert.equal(m.state, 'failed');
    assert.match(m.error, /Unexpected token/);
    await app.close();
    await store.close();
  });

  test('start() 丟錯 → 該模組變 failed，其他模組照常 start', async () => {
    const calls = [];
    const { app, loader, store } = await setup({
      calls,
      overrides: { io: { async start() { throw new Error('背景工作啟動失敗'); } } },
    });
    await loader.start();
    assert.equal(loader.list().find((m) => m.name === 'io').state, 'failed');
    assert.ok(calls.includes('nvr.start'));
    assert.equal((await app.inject('/api/io/ping')).statusCode, 503);
    await loader.stop();
    await app.close();
    await store.close();
  });

  test('stop() 丟錯不影響其他模組的 stop', async () => {
    const calls = [];
    const { app, loader, store } = await setup({
      calls,
      overrides: { nvr: { async stop() { throw new Error('boom'); } } },
    });
    await loader.start();
    await assert.doesNotReject(() => loader.stop());
    assert.ok(calls.includes('inventory.stop'));
    await app.close();
    await store.close();
  });

  test('模組宣告的 owns 與 registry 不符 → failed', async () => {
    const { app, loader, store } = await setup({ overrides: { monitor: { owns: ['devices'] } } });
    const m = loader.list().find((x) => x.name === 'monitor');
    assert.equal(m.state, 'failed');
    assert.match(m.error, /擁有者/);
    await app.close();
    await store.close();
  });

  test('模組的 name 與目錄名稱不符 → failed', async () => {
    const { app, loader, store } = await setup({ overrides: { monitor: { name: 'whatever' } } });
    assert.equal(loader.list().find((x) => x.name === 'monitor').state, 'failed');
    await app.close();
    await store.close();
  });
});

describe('module-loader：停用', () => {
  test('config.modules.<name> 為 false → disabled，完全不 import', async () => {
    const calls = [];
    const imported = [];
    const app = Fastify();
    const store = await createStore({ dataDir: makeTmpDir() });
    const inner = stubImporter({}, calls);
    const loader = await loadModules({
      app, store,
      config: { modules: { nvr: false, inventory: true, io: true, monitor: true, floorplan: true } },
      ctxBase: { events: {}, log: { info() {}, warn() {}, error() {} }, secrets: {} },
      importer: async (n) => { imported.push(n); return inner(n); },
    });
    assert.equal(loader.list().find((m) => m.name === 'nvr').state, 'disabled');
    assert.equal(imported.includes('nvr'), false);
    await app.close();
    await store.close();
  });

  test('system 模組不能被停用', async () => {
    const { loader, app, store } = await setup({ config: { system: false } });
    assert.equal(loader.list().find((m) => m.name === 'system').state, 'ok');
    await app.close();
    await store.close();
  });
});

test('模組可用 ctx.modules.setNote() 在 ok 狀態下附註說明，null 清除（CR：B2）', async () => {
  const app = Fastify();
  let saved;
  const mod = { name: 'monitor', owns: [], async check(ctx) { saved = ctx; ctx.modules.setNote('ping 不可用'); }, async register() {} };
  const store = { forModule: () => ({}) };
  const loader = await loadModules({ app, config: { modules: {} }, store, ctxBase: {}, importer: async () => ({ default: mod }), names: ['monitor'] });
  await app.ready();
  assert.deepEqual(loader.list(), [{ name: 'monitor', state: 'ok', note: 'ping 不可用' }]);
  saved.modules.setNote(null);
  assert.deepEqual(loader.list(), [{ name: 'monitor', state: 'ok' }]);
  await app.close();
});
