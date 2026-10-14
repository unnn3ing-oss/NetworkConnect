import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../../../contracts/index.js';
import { createHistory, MAX_SAMPLES, FLUSH_INTERVAL_MS } from '../../../server/modules/monitor/history.js';
import { createFakeClock } from './fake-clock.js';

const v = createValidator();

/** 假的 statusHistory repo（記錄寫入次數） */
function fakeRepo(initial = []) {
  const docs = new Map(initial.map((d) => [d.deviceId, structuredClone(d)]));
  const writes = [];
  return {
    docs,
    writes,
    async list() { return [...docs.values()].map((d) => structuredClone(d)); },
    async upsert(doc) { v.assert('status-history', doc); writes.push(['upsert', doc.deviceId]); docs.set(doc.deviceId, structuredClone(doc)); return doc; },
    async remove(id) { writes.push(['remove', id]); return docs.delete(id); },
  };
}

function setup(initial) {
  const clock = createFakeClock();
  const repo = fakeRepo(initial);
  const history = createHistory({ repo, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, repo, history };
}
const sample = (clock, up = true, rttMs = 3) => ({ at: new Date(clock.now()).toISOString(), up, rttMs: up ? rttMs : null });

describe('history：環狀保留', () => {
  test('每台最多 1440 筆，最舊的先丟', async () => {
    assert.equal(MAX_SAMPLES, 1440);
    const { clock, history } = setup();
    for (let i = 0; i < 1500; i++) {
      history.add('dev_a', { at: new Date(clock.now() + i * 1000).toISOString(), up: true, rttMs: i });
    }
    const all = history.get('dev_a', 24, { nowMs: clock.now() + 1500_000 });
    assert.equal(all.length, 1440);
    assert.equal(all[0].rttMs, 60, '最舊的 60 筆被丟掉');
    assert.equal(all.at(-1).rttMs, 1499);
  });

  test('get(hours) 只回最近 N 小時，由舊到新', () => {
    const { clock, history } = setup();
    for (let h = 30; h >= 0; h--) {
      history.add('dev_a', { at: new Date(clock.now() - h * 3600_000).toISOString(), up: true, rttMs: h });
    }
    const last2 = history.get('dev_a', 2);
    assert.deepEqual(last2.map((s) => s.rttMs), [2, 1, 0]);
    const day = history.get('dev_a', 24);
    assert.equal(day.length, 25);
    assert.ok(day[0].at < day.at(-1).at);
  });

  test('沒有紀錄 → 空陣列', () => {
    const { history } = setup();
    assert.deepEqual(history.get('dev_none', 24), []);
  });

  test('remove 之後 get 回空、且 repo 的紀錄被刪除', async () => {
    const { clock, history, repo } = setup();
    history.add('dev_a', sample(clock));
    await history.flush();
    assert.ok(repo.docs.has('dev_a'));
    await history.remove('dev_a');
    assert.deepEqual(history.get('dev_a', 24), []);
    assert.equal(repo.docs.has('dev_a'), false);
    history.add('dev_a', sample(clock)); // 刪除後新資料可重新累積
    assert.equal(history.get('dev_a', 24).length, 1);
  });
});

describe('history：批次落檔（最多每 30 秒一次）', () => {
  test('新增紀錄不會立即寫入；30 秒後一次寫出所有有變動的設備', async () => {
    assert.equal(FLUSH_INTERVAL_MS, 30_000);
    const { clock, history, repo } = setup();
    history.add('dev_a', sample(clock));
    history.add('dev_b', sample(clock));
    history.add('dev_a', sample(clock));
    assert.equal(repo.writes.length, 0);
    await clock.advance(29_000);
    assert.equal(repo.writes.length, 0);
    await clock.advance(1_000);
    assert.deepEqual(repo.writes.sort(), [['upsert', 'dev_a'], ['upsert', 'dev_b']]);
    assert.equal(repo.docs.get('dev_a').samples.length, 2);
  });

  test('一段時間內只落檔一次；沒有新資料就不再寫', async () => {
    const { clock, history, repo } = setup();
    for (let i = 0; i < 20; i++) {
      history.add('dev_a', sample(clock));
      await clock.advance(1_000);
    }
    await clock.advance(60_000);
    assert.equal(repo.writes.length, 1, '20 秒內的 20 筆在第 30 秒一次寫入');
    await clock.advance(120_000);
    assert.equal(repo.writes.length, 1);
    history.add('dev_a', sample(clock));
    await clock.advance(30_000);
    assert.equal(repo.writes.length, 2);
  });

  test('stop() 會把尚未落檔的資料寫出並清掉計時器', async () => {
    const { clock, history, repo } = setup();
    history.add('dev_a', sample(clock));
    assert.equal(clock.pending(), 1);
    await history.stop();
    assert.equal(repo.writes.length, 1);
    assert.equal(clock.pending(), 0);
    history.add('dev_a', sample(clock));
    assert.equal(clock.pending(), 0, 'stop 後不再建立計時器');
  });
});

describe('history：載入', () => {
  test('load() 讀回已存的資料；超過 1440 筆的舊檔只留最新 1440', async () => {
    const at = (i) => new Date(Date.parse('2026-10-14T00:00:00.000Z') + i * 1000).toISOString();
    const samples = Array.from({ length: 1440 }, (_, i) => ({ at: at(i), up: true, rttMs: 1 }));
    const { history } = setup([{ deviceId: 'dev_a', samples }]);
    await history.load();
    history.add('dev_a', { at: at(2000), up: false, rttMs: null });
    const all = history.get('dev_a', 24, { nowMs: Date.parse(at(2000)) });
    assert.equal(all.length, 1440);
    assert.equal(all.at(-1).up, false);
  });

  test('prune(ids) 刪除不在清單內的設備紀錄（匯入／離線期間設備被刪）', async () => {
    const { clock, history, repo } = setup([
      { deviceId: 'dev_a', samples: [] },
      { deviceId: 'dev_gone', samples: [] },
    ]);
    await history.load();
    await history.prune(new Set(['dev_a']));
    assert.deepEqual([...repo.docs.keys()], ['dev_a']);
    void clock;
  });
});
