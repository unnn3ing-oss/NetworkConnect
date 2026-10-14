import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../../../desktop/lib/notifier.js';
import { createNotifyThrottle } from '../../../desktop/lib/notify-rules.js';

const setup = ({ device = { name: '主路由器', critical: true }, now = { t: 0 } } = {}) => {
  const shown = [];
  const lookups = [];
  const notifier = createNotifier({
    getDevice: async (id) => { lookups.push(id); return device; },
    show: (n) => shown.push(n),
    throttle: createNotifyThrottle(),
    now: () => now.t,
  });
  return { notifier, shown, lookups, now };
};
const ev = (from, to, deviceId = 'dev_a') => ({ deviceId, from, to, rttMs: null, at: '2026-10-14T08:30:00.000Z' });

test('關鍵設備離線 → 顯示通知', async () => {
  const { notifier, shown } = setup();
  await notifier.handleStatusChanged(ev('up', 'down'));
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /主路由器/);
});

test('非關鍵設備不通知', async () => {
  const { notifier, shown } = setup({ device: { name: 'TV', critical: false } });
  await notifier.handleStatusChanged(ev('up', 'down'));
  assert.equal(shown.length, 0);
});

test('同一台 5 分鐘內只通知一次，過了視窗再通知', async () => {
  const { notifier, shown, now } = setup();
  await notifier.handleStatusChanged(ev('up', 'down'));
  now.t = 60_000;
  await notifier.handleStatusChanged(ev('down', 'up'));
  assert.equal(shown.length, 1);
  now.t = 5 * 60_000;
  await notifier.handleStatusChanged(ev('up', 'down'));
  assert.equal(shown.length, 2);
});

test('與通知無關的轉換不查詢設備資料（省一次 API 呼叫）', async () => {
  const { notifier, shown, lookups } = setup();
  await notifier.handleStatusChanged(ev('unknown', 'up'));
  await notifier.handleStatusChanged(ev('up', 'disabled'));
  assert.equal(lookups.length, 0);
  assert.equal(shown.length, 0);
});

test('查不到設備資料（例如尚未登入）時安靜略過，且不佔用節流額度', async () => {
  const shown = [];
  const throttle = createNotifyThrottle();
  const notifier = createNotifier({ getDevice: async () => null, show: (n) => shown.push(n), throttle, now: () => 0 });
  await notifier.handleStatusChanged(ev('up', 'down'));
  assert.equal(shown.length, 0);
  assert.equal(throttle.tryAcquire('dev_a', 0), true);
});

test('payload 格式錯誤或 show 丟錯都不會讓 handler 丟例外', async () => {
  const { notifier } = setup();
  await notifier.handleStatusChanged(null);
  await notifier.handleStatusChanged({ nope: 1 });
  const boom = createNotifier({ getDevice: async () => ({ name: 'X', critical: true }), show: () => { throw new Error('no display'); }, throttle: createNotifyThrottle(), now: () => 0 });
  await boom.handleStatusChanged(ev('up', 'down'));
});
