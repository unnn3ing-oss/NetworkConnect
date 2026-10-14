import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../../../contracts/index.js';
import { createStateTracker } from '../../../server/modules/monitor/state.js';

const v = createValidator();
const dev = (id, over = {}) => ({ id, ip: '192.168.1.10', monitor: { method: 'icmp', port: null, path: '/', intervalSec: 60, critical: false, ...over } });

function setup() {
  let t = Date.parse('2026-10-14T08:00:00.000Z');
  const tracker = createStateTracker({ now: () => t });
  return { tracker, advance: (ms) => (t += ms), iso: () => new Date(t).toISOString() };
}

describe('state 狀態機', () => {
  test('新設備為 unknown；method=none 為 disabled', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.ensure(dev('dev_b', { method: 'none' }));
    assert.equal(tracker.get('dev_a').state, 'unknown');
    assert.equal(tracker.get('dev_b').state, 'disabled');
    assert.equal(tracker.get('dev_b').lastCheckAt, null);
    for (const i of tracker.list()) v.assert('api-monitor#StatusItem', i);
  });

  test('成功一次即 up，並回報 unknown→up 的變化', () => {
    const { tracker, iso } = setup();
    tracker.ensure(dev('dev_a'));
    const { item, change } = tracker.record('dev_a', { up: true, rttMs: 3.2 });
    assert.equal(item.state, 'up');
    assert.equal(item.rttMs, 3.2);
    assert.equal(item.consecutiveFailures, 0);
    assert.equal(item.lastCheckAt, iso());
    assert.equal(item.lastChangeAt, iso());
    assert.deepEqual(change, { deviceId: 'dev_a', from: 'unknown', to: 'up', rttMs: 3.2, at: iso() });
    v.assert('events#status_changed', change);
  });

  test('連續 3 次失敗才 down；前兩次維持原狀態且不發變化', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.record('dev_a', { up: true, rttMs: 2 });
    for (const n of [1, 2]) {
      const r = tracker.record('dev_a', { up: false, rttMs: null });
      assert.equal(r.item.state, 'up', `第 ${n} 次失敗`);
      assert.equal(r.item.consecutiveFailures, n);
      assert.equal(r.change, null);
    }
    const third = tracker.record('dev_a', { up: false, rttMs: null });
    assert.equal(third.item.state, 'down');
    assert.equal(third.item.consecutiveFailures, 3);
    assert.equal(third.item.rttMs, null);
    assert.equal(third.change.from, 'up');
    assert.equal(third.change.to, 'down');
    // 第 4 次仍是 down，不重複發變化
    assert.equal(tracker.record('dev_a', { up: false, rttMs: null }).change, null);
  });

  test('down 之後成功一次即 up，並重置失敗計數', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    for (let i = 0; i < 3; i++) tracker.record('dev_a', { up: false, rttMs: null });
    assert.equal(tracker.get('dev_a').state, 'down');
    const r = tracker.record('dev_a', { up: true, rttMs: 4 });
    assert.equal(r.item.state, 'up');
    assert.equal(r.item.consecutiveFailures, 0);
    assert.equal(r.change.from, 'down');
  });

  test('失敗中斷後成功，計數重新累計（2 失敗 + 1 成功 + 2 失敗 ≠ down）', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.record('dev_a', { up: true, rttMs: 1 });
    tracker.record('dev_a', { up: false });
    tracker.record('dev_a', { up: false });
    tracker.record('dev_a', { up: true, rttMs: 1 });
    tracker.record('dev_a', { up: false });
    tracker.record('dev_a', { up: false });
    assert.equal(tracker.get('dev_a').state, 'up');
  });

  test('unknown 起頭：連續 3 次失敗才變 down（unknown→down）', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    assert.equal(tracker.record('dev_a', { up: false }).item.state, 'unknown');
    assert.equal(tracker.record('dev_a', { up: false }).item.state, 'unknown');
    const r = tracker.record('dev_a', { up: false });
    assert.equal(r.item.state, 'down');
    assert.equal(r.change.from, 'unknown');
  });

  test('檢查本身出錯 → unknown 並帶 error；恢復後清除 error', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.record('dev_a', { up: true, rttMs: 1 });
    const r = tracker.record('dev_a', { error: '找不到 ping 指令' });
    assert.equal(r.item.state, 'unknown');
    assert.equal(r.item.error, '找不到 ping 指令');
    assert.equal(r.item.rttMs, null);
    assert.equal(r.change.from, 'up');
    assert.equal(r.change.to, 'unknown');
    v.assert('api-monitor#StatusItem', r.item);
    const back = tracker.record('dev_a', { up: true, rttMs: 1 });
    assert.equal(back.item.error, undefined);
  });

  test('method 改成 none → disabled（發變化）；改回來 → unknown', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.record('dev_a', { up: true, rttMs: 1 });
    const off = tracker.ensure(dev('dev_a', { method: 'none' }));
    assert.equal(off.item.state, 'disabled');
    assert.equal(off.change.from, 'up');
    assert.equal(off.change.to, 'disabled');
    const on = tracker.ensure(dev('dev_a', { method: 'tcp', port: 80 }));
    assert.equal(on.item.state, 'unknown');
    assert.equal(on.change.from, 'disabled');
  });

  test('只改間隔／critical 不重置狀態；改 ip 或方法則重置為 unknown', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.record('dev_a', { up: true, rttMs: 1 });
    tracker.ensure(dev('dev_a', { intervalSec: 30, critical: true }));
    assert.equal(tracker.get('dev_a').state, 'up');
    tracker.ensure({ ...dev('dev_a'), ip: '192.168.1.99' });
    assert.equal(tracker.get('dev_a').state, 'unknown');
    assert.equal(tracker.get('dev_a').consecutiveFailures, 0);
  });

  test('remove 之後 get 回 undefined、list 不含；對已移除設備 record 不會復活它', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.remove('dev_a');
    assert.equal(tracker.get('dev_a'), undefined);
    assert.deepEqual(tracker.list(), []);
    assert.equal(tracker.record('dev_a', { up: true, rttMs: 1 }), null);
    assert.deepEqual(tracker.list(), []);
  });

  test('resetFailures：清除所有失敗計數（睡眠恢復用），不改變狀態', () => {
    const { tracker } = setup();
    tracker.ensure(dev('dev_a'));
    tracker.ensure(dev('dev_b'));
    tracker.record('dev_a', { up: true, rttMs: 1 });
    tracker.record('dev_a', { up: false });
    tracker.record('dev_a', { up: false });
    for (let i = 0; i < 3; i++) tracker.record('dev_b', { up: false });
    tracker.resetFailures();
    assert.equal(tracker.get('dev_a').consecutiveFailures, 0);
    assert.equal(tracker.get('dev_a').state, 'up');
    assert.equal(tracker.get('dev_b').consecutiveFailures, 0);
    assert.equal(tracker.get('dev_b').state, 'down');
  });

  test('沒有 IP 的偵測設備 ensure 後仍為 unknown（不丟錯）', () => {
    const { tracker } = setup();
    tracker.ensure({ id: 'dev_noip', ip: '', monitor: { method: 'icmp', intervalSec: 60 } });
    assert.equal(tracker.get('dev_noip').state, 'unknown');
  });
});
