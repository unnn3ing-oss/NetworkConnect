import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifyThrottle, buildNotification, NOTIFY_WINDOW_MS } from '../../../desktop/lib/notify-rules.js';

const MIN = 60_000;

test('節流視窗預設 5 分鐘', () => {
  assert.equal(NOTIFY_WINDOW_MS, 5 * MIN);
});

test('同一台 5 分鐘內最多通知一次', () => {
  const t = createNotifyThrottle();
  assert.equal(t.tryAcquire('dev_a', 0), true);
  assert.equal(t.tryAcquire('dev_a', 4 * MIN + 59_000), false);
  assert.equal(t.tryAcquire('dev_a', 5 * MIN), true);
});

test('不同設備互不影響', () => {
  const t = createNotifyThrottle();
  assert.equal(t.tryAcquire('dev_a', 0), true);
  assert.equal(t.tryAcquire('dev_b', 1), true);
  assert.equal(t.tryAcquire('dev_a', 2), false);
});

test('被擋下的嘗試不會延長視窗', () => {
  const t = createNotifyThrottle({ windowMs: 10 * MIN });
  assert.equal(t.tryAcquire('dev_a', 0), true);
  assert.equal(t.tryAcquire('dev_a', 9 * MIN), false);
  assert.equal(t.tryAcquire('dev_a', 10 * MIN), true);
});

test('reset 清除紀錄；forget 只清一台', () => {
  const t = createNotifyThrottle();
  t.tryAcquire('dev_a', 0);
  t.tryAcquire('dev_b', 0);
  t.forget('dev_a');
  assert.equal(t.tryAcquire('dev_a', 1), true);
  assert.equal(t.tryAcquire('dev_b', 1), false);
  t.reset();
  assert.equal(t.tryAcquire('dev_b', 2), true);
});

test('buildNotification：非關鍵設備不通知', () => {
  const n = buildNotification({ payload: { deviceId: 'dev_a', from: 'up', to: 'down' }, device: { name: '客廳電視', critical: false } });
  assert.equal(n, null);
});

test('buildNotification：關鍵設備離線', () => {
  const n = buildNotification({ payload: { deviceId: 'dev_a', from: 'up', to: 'down', at: '2026-10-14T08:30:00.000Z' }, device: { name: '主路由器', critical: true } });
  assert.equal(n.kind, 'down');
  assert.match(n.title, /主路由器/);
  assert.match(n.title, /離線/);
});

test('buildNotification：關鍵設備恢復（down → up）', () => {
  const n = buildNotification({ payload: { deviceId: 'dev_a', from: 'down', to: 'up' }, device: { name: '主路由器', critical: true } });
  assert.equal(n.kind, 'up');
  assert.match(n.title, /恢復/);
});

test('buildNotification：unknown／disabled 之間的轉換與首次偵測不通知', () => {
  const dev = { name: 'X', critical: true };
  for (const [from, to] of [['unknown', 'up'], ['up', 'unknown'], ['disabled', 'up'], ['up', 'disabled'], ['unknown', 'disabled'], ['down', 'unknown'], ['down', 'disabled']]) {
    assert.equal(buildNotification({ payload: { deviceId: 'd', from, to }, device: dev }), null, `${from}→${to}`);
  }
});

test('buildNotification：unknown → down 也算離線', () => {
  const n = buildNotification({ payload: { deviceId: 'd', from: 'unknown', to: 'down' }, device: { name: 'X', critical: true } });
  assert.equal(n.kind, 'down');
});

test('buildNotification：找不到設備資料時不通知', () => {
  assert.equal(buildNotification({ payload: { deviceId: 'd', from: 'up', to: 'down' }, device: null }), null);
});

test('buildNotification：設備名稱為空時用 id 代替', () => {
  const n = buildNotification({ payload: { deviceId: 'dev_a', from: 'up', to: 'down' }, device: { name: '', critical: true } });
  assert.match(n.title, /dev_a/);
});
