import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify from 'fastify';
import { createEvents } from '../../../server/core/events.js';
import { waitFor } from '../../helpers/tmp.js';

describe('events：發布／訂閱', () => {
  test('on／emit／off', () => {
    const ev = createEvents();
    const got = [];
    const off = ev.on('status.changed', (p) => got.push(p));
    ev.emit('status.changed', { a: 1 });
    ev.emit('other', { b: 2 });
    off();
    ev.emit('status.changed', { a: 2 });
    assert.deepEqual(got, [{ a: 1 }]);
  });

  test('onAny 收到所有事件（附事件名稱）', () => {
    const ev = createEvents();
    const got = [];
    ev.onAny((name, payload) => got.push([name, payload]));
    ev.emit('x', 1);
    ev.emit('y', 2);
    assert.deepEqual(got, [['x', 1], ['y', 2]]);
  });

  test('訂閱者丟錯不影響其他訂閱者，也不影響發布者', () => {
    const errors = [];
    const ev = createEvents({ log: { error: (...a) => errors.push(a) } });
    const got = [];
    ev.on('x', () => { throw new Error('boom'); });
    ev.on('x', (p) => got.push(p));
    assert.doesNotThrow(() => ev.emit('x', 1));
    assert.deepEqual(got, [1]);
    assert.equal(errors.length, 1);
  });
});

describe('events：SSE', () => {
  const apps = [];
  afterEach(async () => {
    for (const { app, ev } of apps.splice(0)) {
      ev.closeAll();
      await app.close();
    }
  });

  async function boot(opts) {
    const ev = createEvents(opts);
    const app = Fastify();
    ev.registerRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push({ app, ev });
    return { ev, app, port: app.server.address().port };
  }

  function connect(port) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (c) => chunks.push(c));
        resolve({ res, req, text: () => chunks.join('') });
      });
      req.on('error', reject);
    });
  }

  test('Content-Type 為 text/event-stream，事件格式為 event/data 兩行', async () => {
    const { ev, port } = await boot();
    const c = await connect(port);
    assert.match(c.res.headers['content-type'], /^text\/event-stream/);
    await waitFor(() => ev.clientCount() === 1);
    ev.emit('status.changed', { deviceId: 'dev_a', to: 'down' });
    await waitFor(() => c.text().includes('event: status.changed'));
    assert.match(c.text(), /event: status\.changed\ndata: \{"deviceId":"dev_a","to":"down"\}\n\n/);
    c.req.destroy();
    await waitFor(() => ev.clientCount() === 0, { message: '用戶端斷線後要移除' });
  });

  test('定時送出註解心跳（預設 25 秒，可注入）', async () => {
    const { port } = await boot({ heartbeatMs: 30 });
    const c = await connect(port);
    await waitFor(() => (c.text().match(/: ping/g) ?? []).length >= 2);
    c.req.destroy();
  });

  test('onSseConnect：連線建立時呼叫，可用 send 送出該連線專屬的事件（status.snapshot）', async () => {
    const { ev, port } = await boot();
    ev.onSseConnect((send) => send('status.snapshot', { items: [] }));
    const c = await connect(port);
    await waitFor(() => c.text().includes('event: status.snapshot'));
    assert.match(c.text(), /data: \{"items":\[\]\}/);
    c.req.destroy();
  });

  test('closeAll 結束所有連線並停止計時器', async () => {
    const { ev, app, port } = await boot({ heartbeatMs: 30 });
    const c = await connect(port);
    await waitFor(() => ev.clientCount() === 1);
    const closed = new Promise((r) => c.res.on('close', r));
    ev.closeAll();
    await closed;
    assert.equal(ev.clientCount(), 0);
    await app.close(); // 不會因為殘留連線而卡住
    apps.length = 0;
  });
});
