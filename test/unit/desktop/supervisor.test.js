import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSupervisor } from '../../../desktop/lib/server-supervisor.js';

/** 模擬 Electron 的 UtilityProcess */
function makeFork({ onSpawn } = {}) {
  const children = [];
  const fork = () => {
    const c = new EventEmitter();
    c.messages = [];
    c.killed = false;
    c.postMessage = (m) => c.messages.push(m);
    c.kill = () => {
      c.killed = true;
      queueMicrotask(() => c.emit('exit', 137));
      return true;
    };
    children.push(c);
    queueMicrotask(() => onSpawn?.(c, children.length - 1));
    return c;
  };
  return { fork, children };
}

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const base = { restartDelayMs: 0, readyTimeoutMs: 200, shutdownTimeoutMs: 50, stableMs: 10_000, maxRestarts: 3 };

test('收到 ready 後 start() 回傳埠號', async () => {
  const { fork } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 8781 }) });
  const sup = createSupervisor({ fork, ...base });
  const r = await sup.start();
  assert.equal(r.port, 8781);
  assert.equal(sup.state, 'running');
  assert.equal(sup.port, 8781);
});

test('onReady：第一次與每次重啟後就緒都會呼叫', async () => {
  const ready = [];
  const { fork, children } = makeFork({ onSpawn: (c, i) => c.emit('message', { type: 'ready', port: 8780 + i }) });
  const sup = createSupervisor({ fork, ...base, onReady: (info) => ready.push(info) });
  await sup.start();
  children[0].emit('exit', 1);
  await wait();
  assert.deepEqual(ready, [{ port: 8780, restarted: false }, { port: 8781, restarted: true }]);
});

test('伺服器轉送的事件交給 onEvent', async () => {
  const events = [];
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 1 }) });
  const sup = createSupervisor({ fork, ...base, onEvent: (name, payload) => events.push([name, payload]) });
  await sup.start();
  children[0].emit('message', { type: 'event', name: 'status.changed', payload: { deviceId: 'd' } });
  children[0].emit('message', { type: 'noise' });
  assert.deepEqual(events, [['status.changed', { deviceId: 'd' }]]);
});

test('非預期結束：自動重啟，並通知 onRestart', async () => {
  const restarts = [];
  const { fork, children } = makeFork({ onSpawn: (c, i) => c.emit('message', { type: 'ready', port: 8780 + i }) });
  const sup = createSupervisor({ fork, ...base, onRestart: (n) => restarts.push(n) });
  await sup.start();
  children[0].emit('exit', 1);
  await wait();
  assert.equal(children.length, 2);
  assert.equal(sup.port, 8781);
  assert.deepEqual(restarts, [1]);
  assert.equal(sup.state, 'running');
});

test('連續崩潰超過 3 次就放棄，並回報 onGaveUp', async () => {
  let gaveUp = null;
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 1 }) });
  const sup = createSupervisor({ fork, ...base, onGaveUp: (info) => { gaveUp = info; } });
  await sup.start();
  for (let i = 0; i < 4; i++) {
    children.at(-1).emit('exit', 1);
    await wait();
  }
  assert.equal(children.length, 4, '初次 1 次＋重啟 3 次');
  assert.equal(sup.state, 'failed');
  assert.equal(gaveUp.restarts, 3);
  assert.equal(gaveUp.exitCode, 1);
});

test('穩定執行超過 stableMs 後崩潰，重啟次數歸零', async () => {
  let t = 0;
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 1 }) });
  const sup = createSupervisor({ fork, ...base, stableMs: 1000, now: () => t });
  await sup.start();
  for (let i = 0; i < 6; i++) {
    t += 5000; // 每次都跑超過 1 秒才崩潰
    children.at(-1).emit('exit', 1);
    await wait();
  }
  assert.equal(sup.state, 'running');
  assert.equal(children.length, 7);
});

test('啟動期間就結束（尚未 ready）也會重啟；全部失敗時 start() 拒絕', async () => {
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('exit', 2) });
  const sup = createSupervisor({ fork, ...base });
  await assert.rejects(sup.start(), /伺服器/);
  assert.equal(children.length, 4);
  assert.equal(sup.state, 'failed');
});

test('ready 逾時視為失敗並結束該行程', async () => {
  const { fork, children } = makeFork();
  const sup = createSupervisor({ fork, ...base, readyTimeoutMs: 20, maxRestarts: 0 });
  await assert.rejects(sup.start(), /逾時/);
  assert.equal(children[0].killed, true);
});

test('stop()：送出 shutdown，行程自行結束時不強制', async () => {
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 1 }) });
  const sup = createSupervisor({ fork, ...base });
  await sup.start();
  children[0].postMessage = (m) => { children[0].messages.push(m); if (m.type === 'shutdown') setTimeout(() => children[0].emit('exit', 0), 5); };
  const r = await sup.stop();
  assert.deepEqual(children[0].messages, [{ type: 'shutdown' }]);
  assert.equal(r.forced, false);
  assert.equal(children[0].killed, false);
  assert.equal(sup.state, 'stopped');
});

test('stop()：超過等待時間就強制結束；結束後不再重啟', async () => {
  const { fork, children } = makeFork({ onSpawn: (c) => c.emit('message', { type: 'ready', port: 1 }) });
  const sup = createSupervisor({ fork, ...base, shutdownTimeoutMs: 30 });
  await sup.start();
  const t0 = Date.now();
  const r = await sup.stop();
  assert.equal(r.forced, true);
  assert.equal(children[0].killed, true);
  assert.ok(Date.now() - t0 >= 25);
  await wait(20);
  assert.equal(children.length, 1, 'stop 之後不可重啟');
});

test('stop() 在尚未啟動時直接完成', async () => {
  const { fork } = makeFork();
  const sup = createSupervisor({ fork, ...base });
  assert.deepEqual(await sup.stop(), { forced: false });
});

test('restart()：停止舊行程後重新啟動，重啟次數歸零', async () => {
  const { fork, children } = makeFork({ onSpawn: (c, i) => c.emit('message', { type: 'ready', port: 9000 + i }) });
  const sup = createSupervisor({ fork, ...base });
  await sup.start();
  children[0].postMessage = (m) => { if (m.type === 'shutdown') setTimeout(() => children[0].emit('exit', 0), 1); };
  const r = await sup.restart();
  assert.equal(r.port, 9001);
  assert.equal(children.length, 2);
  assert.equal(sup.state, 'running');
});
