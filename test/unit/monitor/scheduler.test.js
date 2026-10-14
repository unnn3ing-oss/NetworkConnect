import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, MIN_INTERVAL_SEC } from '../../../server/modules/monitor/scheduler.js';
import { createFakeClock } from './fake-clock.js';

const job = (id, intervalSec = 60, key = 'k') => ({ id, intervalSec, key });

/** 建立排程器；run 記錄每次執行，可選擇讓它卡住（deferred） */
function setup({ concurrency = 16, random = () => 0, hold = false } = {}) {
  const clock = createFakeClock();
  const runs = [];
  const inflight = [];
  let active = 0;
  let maxActive = 0;
  const events = { sleep: 0, resume: 0 };
  const sched = createScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random,
    getConcurrency: () => concurrency,
    onSleep: () => events.sleep++,
    onResume: () => events.resume++,
    async run(id) {
      runs.push({ id, at: clock.now() });
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (hold) await new Promise((resolve) => inflight.push({ id, resolve }));
      } finally {
        active--;
      }
    },
  });
  return { clock, sched, runs, inflight, events, maxActive: () => maxActive, runsOf: (id) => runs.filter((r) => r.id === id) };
}

describe('scheduler：間隔與抖動', () => {
  test('依 intervalSec 重複執行（抖動為 0 時剛好每 60 秒）', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 60)]);
    sched.start();
    await clock.advance(0);
    assert.equal(runsOf('dev_a').length, 1, '啟動後立刻第一次');
    await clock.advance(59_000);
    assert.equal(runsOf('dev_a').length, 1);
    await clock.advance(1_000);
    assert.equal(runsOf('dev_a').length, 2);
    await clock.advance(60_000);
    assert.equal(runsOf('dev_a').length, 3);
    sched.stop();
  });

  test('每次延遲加 0–20% 抖動（random=1 → 72 秒）', async () => {
    const { clock, sched, runsOf } = setup({ random: () => 1 });
    sched.sync([job('dev_a', 60)]);
    sched.start();
    await clock.advance(5_000); // 第一次最多延遲 5 秒（0–20% 且上限 5 秒）
    assert.equal(runsOf('dev_a').length, 1);
    await clock.advance(71_000);
    assert.equal(runsOf('dev_a').length, 1, '72 秒前不會再跑');
    await clock.advance(1_000);
    assert.equal(runsOf('dev_a').length, 2);
    sched.stop();
  });

  test('間隔最小 15 秒（設更小也當 15 秒）', async () => {
    assert.equal(MIN_INTERVAL_SEC, 15);
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 5)]);
    sched.start();
    await clock.advance(14_000);
    assert.equal(runsOf('dev_a').length, 1);
    await clock.advance(1_000);
    assert.equal(runsOf('dev_a').length, 2);
    sched.stop();
  });

  test('各設備依自己的間隔', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_fast', 15), job('dev_slow', 120)]);
    sched.start();
    await clock.advance(120_000);
    assert.equal(runsOf('dev_fast').length, 9);
    assert.equal(runsOf('dev_slow').length, 2);
    sched.stop();
  });

  test('執行失敗（run reject）不會中斷排程', async () => {
    const clock = createFakeClock();
    let n = 0;
    const sched = createScheduler({
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0,
      run: async () => { n++; throw new Error('boom'); },
      onError: () => {},
    });
    sched.sync([job('dev_a', 15)]);
    sched.start();
    await clock.advance(30_000);
    assert.equal(n, 3);
    sched.stop();
  });
});

describe('scheduler：並發上限', () => {
  test('同時執行的偵測不超過上限，完成一個才開始下一個', async () => {
    const { clock, sched, runs, inflight, maxActive } = setup({ concurrency: 3, hold: true });
    sched.sync(Array.from({ length: 10 }, (_, i) => job(`dev_${i}`, 60)));
    sched.start();
    await clock.advance(0);
    assert.equal(runs.length, 3);
    assert.equal(maxActive(), 3);
    inflight.shift().resolve();
    await clock.settle();
    assert.equal(runs.length, 4, '一個完成後補上一個');
    assert.equal(maxActive(), 3);
    while (inflight.length) {
      inflight.shift().resolve();
      await clock.settle();
    }
    assert.equal(runs.length, 10);
    assert.equal(maxActive(), 3);
    sched.stop();
  });

  test('預設上限 16', async () => {
    const clock = createFakeClock();
    let active = 0;
    let max = 0;
    const pend = [];
    const sched = createScheduler({
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0,
      run: async () => { active++; max = Math.max(max, active); await new Promise((r) => pend.push(r)); active--; },
    });
    sched.sync(Array.from({ length: 40 }, (_, i) => job(`dev_${i}`, 60)));
    sched.start();
    await clock.advance(0);
    assert.equal(max, 16);
    sched.stop();
    pend.forEach((r) => r());
  });
});

describe('scheduler：設備異動', () => {
  test('設備刪除後不再排程，計時器也被清掉', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 30), job('dev_b', 30)]);
    sched.start();
    await clock.advance(30_000);
    assert.equal(runsOf('dev_a').length, 2);
    sched.sync([job('dev_b', 30)]);
    await clock.advance(120_000);
    assert.equal(runsOf('dev_a').length, 2, 'dev_a 不再執行');
    assert.ok(runsOf('dev_b').length >= 6);
    assert.equal(clock.pending(), 1, '只剩 dev_b 的計時器');
    sched.stop();
  });

  test('新增設備：立刻（短延遲內）偵測第一次', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 60)]);
    sched.start();
    await clock.advance(10_000);
    sched.sync([job('dev_a', 60), job('dev_new', 60)]);
    await clock.advance(0);
    assert.equal(runsOf('dev_new').length, 1);
    assert.equal(runsOf('dev_a').length, 1, '既有設備的節奏不受影響');
    sched.stop();
  });

  test('設備設定改變（key 不同）→ 立即重測；間隔改變 → 依新間隔', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 60, 'ip1')]);
    sched.start();
    await clock.advance(10_000);
    assert.equal(runsOf('dev_a').length, 1);
    sched.sync([job('dev_a', 60, 'ip2')]);
    await clock.advance(0);
    assert.equal(runsOf('dev_a').length, 2);
    sched.sync([job('dev_a', 15, 'ip2')]);
    await clock.advance(15_000);
    assert.equal(runsOf('dev_a').length, 3);
    sched.stop();
  });

  test('相同內容重複 sync 不會多跑', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 60)]);
    sched.start();
    await clock.advance(0);
    for (let i = 0; i < 5; i++) sched.sync([job('dev_a', 60)]);
    await clock.advance(0);
    assert.equal(runsOf('dev_a').length, 1);
    sched.stop();
  });

  test('start 之前 sync 的設備，start 後才開始排程', async () => {
    const { clock, sched, runs } = setup();
    sched.sync([job('dev_a', 60)]);
    await clock.advance(120_000);
    assert.equal(runs.length, 0);
    sched.start();
    await clock.advance(0);
    assert.equal(runs.length, 1);
    sched.stop();
  });
});

describe('scheduler：stop()', () => {
  test('stop 後沒有任何殘留計時器，也不再執行', async () => {
    const { clock, sched, runs } = setup();
    sched.sync(Array.from({ length: 8 }, (_, i) => job(`dev_${i}`, 30)));
    sched.start();
    await clock.advance(45_000);
    sched.stop();
    assert.equal(clock.pending(), 0);
    const before = runs.length;
    await clock.advance(600_000);
    assert.equal(runs.length, before);
    assert.equal(clock.pending(), 0);
  });

  test('stop 時仍在執行中的偵測結束後不會重新排程', async () => {
    const { clock, sched, inflight, runs } = setup({ hold: true });
    sched.sync([job('dev_a', 30)]);
    sched.start();
    await clock.advance(0);
    assert.equal(inflight.length, 1);
    sched.stop();
    inflight[0].resolve();
    await clock.settle();
    assert.equal(clock.pending(), 0);
    await clock.advance(300_000);
    assert.equal(runs.length, 1);
  });

  test('stop 時排隊中（尚未開始）的偵測不會被執行', async () => {
    const { clock, sched, inflight, runs } = setup({ hold: true, concurrency: 1 });
    sched.sync([job('dev_a', 30), job('dev_b', 30), job('dev_c', 30)]);
    sched.start();
    await clock.advance(0);
    assert.equal(runs.length, 1);
    sched.stop();
    inflight[0].resolve();
    await clock.settle();
    assert.equal(runs.length, 1);
    assert.equal(clock.pending(), 0);
  });
});

describe('scheduler：睡眠恢復', () => {
  test('兩次排程間隔 > 3 倍設定值 → 視為睡眠：呼叫 onSleep 並立即重測全部', async () => {
    const { clock, sched, runs, events } = setup();
    sched.sync([job('dev_a', 60), job('dev_b', 60), job('dev_c', 120)]);
    sched.start();
    await clock.advance(60_000);
    const before = runs.length;
    clock.jump(30 * 60_000); // 電腦睡了 30 分鐘，計時器全部延誤
    await clock.tick();
    assert.equal(events.sleep, 1, '只通知一次');
    assert.equal(runs.length - before, 3, '三台立刻各重測一次');
    // 之後恢復正常節奏
    const after = runs.length;
    await clock.advance(60_000);
    assert.ok(runs.length > after);
    assert.equal(events.sleep, 1);
    sched.stop();
  });

  test('間隔只是稍微延誤（< 3 倍）不算睡眠', async () => {
    const { clock, sched, events } = setup();
    sched.sync([job('dev_a', 60)]);
    sched.start();
    await clock.advance(0);
    clock.jump(2 * 60_000); // 2 倍
    await clock.tick();
    assert.equal(events.sleep, 0);
    sched.stop();
  });
});

describe('scheduler：暫停（pausedUntil）', () => {
  test('暫停期間不偵測；時間到後立即重測全部並呼叫 onResume', async () => {
    const { clock, sched, runs, events } = setup();
    sched.sync([job('dev_a', 30), job('dev_b', 30)]);
    sched.start();
    await clock.advance(0);
    assert.equal(runs.length, 2);
    sched.setPausedUntil(clock.now() + 30 * 60_000);
    assert.equal(sched.isPaused(), true);
    await clock.advance(29 * 60_000);
    assert.equal(runs.length, 2, '暫停中沒有任何偵測');
    assert.equal(clock.pending(), 1, '只剩「恢復」計時器');
    await clock.advance(60_000);
    assert.equal(events.resume, 1);
    assert.equal(runs.length, 4, '恢復後立即重測');
    assert.equal(sched.isPaused(), false);
    await clock.advance(30_000);
    assert.equal(runs.length, 6, '恢復後回到正常節奏');
    sched.stop();
  });

  test('提早取消暫停（null）→ 立即恢復', async () => {
    const { clock, sched, runs, events } = setup();
    sched.sync([job('dev_a', 30)]);
    sched.start();
    await clock.advance(0);
    sched.setPausedUntil(clock.now() + 60 * 60_000);
    await clock.advance(10 * 60_000);
    assert.equal(runs.length, 1);
    sched.setPausedUntil(null);
    await clock.advance(0);
    assert.equal(events.resume, 1);
    assert.equal(runs.length, 2);
    sched.stop();
  });

  test('暫停中 stop() 也不留計時器', async () => {
    const { clock, sched } = setup();
    sched.sync([job('dev_a', 30)]);
    sched.start();
    sched.setPausedUntil(clock.now() + 60_000);
    sched.stop();
    assert.equal(clock.pending(), 0);
  });

  test('start 之前就設了未來的 pausedUntil（App 重啟）→ 啟動後不偵測，到期才開始', async () => {
    const { clock, sched, runs } = setup();
    sched.sync([job('dev_a', 30)]);
    sched.setPausedUntil(clock.now() + 5 * 60_000);
    sched.start();
    await clock.advance(4 * 60_000);
    assert.equal(runs.length, 0);
    await clock.advance(60_000);
    assert.equal(runs.length, 1);
    sched.stop();
  });

  test('已過期的 pausedUntil 視為未暫停', async () => {
    const { clock, sched, runs } = setup();
    sched.sync([job('dev_a', 30)]);
    sched.setPausedUntil(clock.now() - 1000);
    assert.equal(sched.isPaused(), false);
    sched.start();
    await clock.advance(0);
    assert.equal(runs.length, 1);
    sched.stop();
  });
});

describe('scheduler：runNow', () => {
  test('runNow 立刻執行指定設備（受並發上限）並回傳 promise', async () => {
    const { clock, sched, runsOf } = setup();
    sched.sync([job('dev_a', 600)]);
    sched.start();
    await clock.advance(0);
    await sched.runNow('dev_a');
    assert.equal(runsOf('dev_a').length, 2);
    sched.stop();
  });
});
