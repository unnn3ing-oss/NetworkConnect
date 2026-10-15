import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrayMenu, trayTooltip } from '../../../desktop/lib/tray-menu.js';

const noop = () => {};
const handlers = () => {
  const calls = [];
  const h = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  return { h, calls };
};
const base = (over = {}) => ({
  version: '0.1.0',
  alert: false,
  paused: false,
  settings: { autoLaunch: false, preventSleep: false, lanAccess: true, port: null },
  ...over,
});
const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label);

test('選單項目與規格 §8.6 一致，結束在最後', () => {
  const { h } = handlers();
  const items = buildTrayMenu({ ...base(), handlers: h });
  const l = labels(items);
  for (const needle of ['開啟主控台', '手機連線', '暫停偵測 30 分鐘', '開機自動啟動', '防止電腦閒置睡眠', '允許手機在區網連線', '檢查更新', '結束 NetworkConnect']) {
    assert.ok(l.some((x) => x.includes(needle)), `缺少：${needle}`);
  }
  assert.match(l.at(-1), /結束 NetworkConnect/);
});

test('狀態標題：正常與有關鍵設備離線', () => {
  const { h } = handlers();
  assert.match(labels(buildTrayMenu({ ...base(), handlers: h }))[0], /全部正常/);
  assert.match(labels(buildTrayMenu({ ...base({ alert: true }), handlers: h }))[0], /關鍵設備離線/);
});

test('勾選狀態反映設定', () => {
  const { h } = handlers();
  const items = buildTrayMenu({ ...base({ settings: { autoLaunch: true, preventSleep: false, lanAccess: false, port: null } }), handlers: h });
  const by = (s) => items.find((i) => i.label?.includes(s));
  assert.equal(by('開機自動啟動').checked, true);
  assert.equal(by('防止電腦閒置睡眠').checked, false);
  assert.equal(by('允許手機在區網連線').checked, false);
  assert.equal(by('開機自動啟動').type, 'checkbox');
});

test('暫停中時顯示「恢復偵測」', () => {
  const { h } = handlers();
  const items = buildTrayMenu({ ...base({ paused: true }), handlers: h });
  assert.ok(items.some((i) => i.label === '恢復偵測'));
  assert.ok(!items.some((i) => i.label === '暫停偵測 30 分鐘'));
});

test('點選項目呼叫對應的 handler，checkbox 帶新值', () => {
  const { h, calls } = handlers();
  const items = buildTrayMenu({ ...base(), handlers: h });
  const by = (s) => items.find((i) => i.label?.includes(s));
  by('開啟主控台').click();
  by('手機連線').click();
  by('暫停偵測').click();
  by('開機自動啟動').click({ checked: true });
  by('防止電腦閒置睡眠').click({ checked: true });
  by('允許手機在區網連線').click({ checked: false });
  by('檢查更新').click();
  by('結束').click();
  assert.deepEqual(calls.map((c) => c[0]), ['openMain', 'showMobile', 'pauseMonitoring', 'setAutoLaunch', 'setPreventSleep', 'setLanAccess', 'checkUpdates', 'quit']);
  assert.deepEqual(calls[3], ['setAutoLaunch', true]);
  assert.deepEqual(calls[5], ['setLanAccess', false]);
});

test('版本資訊列為停用項目', () => {
  const { h } = handlers();
  const items = buildTrayMenu({ ...base(), handlers: h });
  const v = items.find((i) => i.label?.includes('0.1.0'));
  assert.equal(v.enabled, false);
});

test('trayTooltip', () => {
  assert.match(trayTooltip({ alert: false, paused: false }), /正常/);
  assert.match(trayTooltip({ alert: true, paused: false }), /離線/);
  assert.match(trayTooltip({ alert: false, paused: true }), /暫停/);
});

void noop;

test('背景發現新版本時改顯示「安裝新版本 X」；下載中停用', () => {
  const { h, calls } = handlers();
  const item = buildTrayMenu({ ...base({ updateVersion: '0.1.20' }), handlers: h }).find((i) => i.label?.includes('安裝新版本'));
  assert.equal(item.label, '安裝新版本 0.1.20…');
  item.click();
  assert.deepEqual(calls.map((c) => c[0]), ['checkUpdates']);
  const busy = buildTrayMenu({ ...base({ updateVersion: '0.1.20', downloading: true }), handlers: h }).find((i) => i.label?.includes('下載'));
  assert.equal(busy.enabled, false);
});
