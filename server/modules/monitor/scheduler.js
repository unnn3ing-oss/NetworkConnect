// 排程器（規格 §8.1）：每台依自己的 intervalSec（最小 15 秒）＋0–20% 隨機延遲；整體並發上限；
// 設備異動時重新排程；睡眠恢復與暫停結束時立即重測全部。
// 純排程邏輯：時間（now／setTimer／clearTimer／random）與實際偵測（run）全部由外部注入，測試用假時鐘。

export const MIN_INTERVAL_SEC = 15;
export const JITTER = 0.2; // 0–20%
export const SLEEP_FACTOR = 3; // 兩次排程間隔 > 3 倍設定值 → 視為電腦曾睡眠
export const FIRST_RUN_MAX_MS = 5000; // 新設備第一次偵測的最大延遲（避免狀態長時間停在 unknown）
export const DEFAULT_CONCURRENCY = 16;

/**
 * @param {object} deps
 * @param {() => number} deps.now
 * @param {(fn: Function, ms: number) => any} deps.setTimer
 * @param {(handle: any) => void} deps.clearTimer
 * @param {() => number} [deps.random]
 * @param {(id: string) => Promise<void>} deps.run              執行一次偵測（錯誤由排程器吞掉並交給 onError）
 * @param {() => number} [deps.getConcurrency]
 * @param {() => void} [deps.onSleep]                           偵測到睡眠、立即重測之前呼叫
 * @param {() => void} [deps.onResume]                          暫停結束、立即重測之前呼叫
 * @param {(err: Error, id?: string) => void} [deps.onError]
 */
export function createScheduler({
  now,
  setTimer,
  clearTimer,
  random = Math.random,
  run,
  getConcurrency = () => DEFAULT_CONCURRENCY,
  onSleep,
  onResume,
  onError = () => {},
}) {
  /** @type {Map<string, {id: string, intervalMs: number, key: string, timer: any, lastFireAt: number|null, busy: boolean, again: boolean}>} */
  const jobs = new Map();
  let started = false;
  let pausedUntil = null;
  let resumeTimer = null;

  // ---- 並發上限 ----
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  const pump = () => {
    while (waiting.length && active < Math.max(1, getConcurrency())) {
      active++;
      waiting.shift()();
    }
  };
  const acquire = () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      pump();
    });
  const release = () => {
    active--;
    pump();
  };

  const isPaused = () => pausedUntil !== null && now() < pausedUntil;
  const alive = (job) => started && jobs.get(job.id) === job && !isPaused();

  const intervalOf = (sec) => Math.max(MIN_INTERVAL_SEC, Number(sec) || MIN_INTERVAL_SEC) * 1000;
  const firstDelay = (job) => Math.min(random() * JITTER * job.intervalMs, FIRST_RUN_MAX_MS);
  const nextDelay = (job) => job.intervalMs * (1 + random() * JITTER);

  function clearJobTimer(job) {
    if (job.timer !== null) {
      clearTimer(job.timer);
      job.timer = null;
    }
  }

  function schedule(job, delayMs) {
    clearJobTimer(job);
    job.timer = setTimer(() => {
      job.timer = null;
      fire(job);
    }, delayMs);
  }

  /** 排程到點：先檢查是否剛從睡眠恢復，否則執行一次並在完成後排下一次 */
  function fire(job) {
    if (!alive(job)) return;
    if (job.lastFireAt !== null && now() - job.lastFireAt > SLEEP_FACTOR * job.intervalMs) {
      onSleep?.();
      runAll();
      return;
    }
    trigger(job);
  }

  /** 立刻跑這一台；跑完後依間隔排下一次。執行中又被觸發則跑完再來一次。 */
  function trigger(job) {
    clearJobTimer(job);
    if (job.busy) {
      job.again = true;
      return;
    }
    job.busy = true;
    job.lastFireAt = now();
    execute(job)
      .catch((err) => onError(err, job.id))
      .finally(() => {
        job.busy = false;
        if (!alive(job)) return;
        if (job.again) {
          job.again = false;
          trigger(job);
        } else if (job.timer === null) {
          schedule(job, nextDelay(job));
        }
      });
  }

  async function execute(job) {
    await acquire();
    try {
      if (!alive(job)) return; // 排隊期間被刪除、暫停或 stop
      await run(job.id);
    } finally {
      release();
    }
  }

  function runAll() {
    for (const job of [...jobs.values()]) trigger(job);
  }

  function endPause() {
    if (resumeTimer !== null) {
      clearTimer(resumeTimer);
      resumeTimer = null;
    }
    pausedUntil = null;
    if (!started) return;
    onResume?.();
    runAll();
  }

  return {
    /**
     * 設定要排程的設備清單（整份取代）：新增→排程；消失→移除；key 改變→立即重測；間隔改變→依新間隔。
     * @param {Array<{id: string, intervalSec: number, key?: string}>} list
     */
    sync(list) {
      const seen = new Set();
      for (const j of list) {
        seen.add(j.id);
        const intervalMs = intervalOf(j.intervalSec);
        const key = j.key ?? '';
        const existing = jobs.get(j.id);
        if (!existing) {
          const job = { id: j.id, intervalMs, key, timer: null, lastFireAt: null, busy: false, again: false };
          jobs.set(j.id, job);
          if (started && !isPaused()) schedule(job, firstDelay(job));
          continue;
        }
        const keyChanged = existing.key !== key;
        const intervalChanged = existing.intervalMs !== intervalMs;
        existing.key = key;
        existing.intervalMs = intervalMs;
        if (!started || isPaused()) continue;
        if (keyChanged) schedule(existing, 0);
        else if (intervalChanged && !existing.busy) schedule(existing, nextDelay(existing));
      }
      for (const [id, job] of [...jobs]) {
        if (seen.has(id)) continue;
        clearJobTimer(job);
        jobs.delete(id);
      }
    },

    start() {
      if (started) return;
      started = true;
      if (isPaused()) {
        resumeTimer = setTimer(() => {
          resumeTimer = null;
          endPause();
        }, pausedUntil - now());
        return;
      }
      pausedUntil = null;
      for (const job of jobs.values()) schedule(job, firstDelay(job));
    },

    /** 清掉所有計時器；執行中的偵測會跑完，但不會再排下一次 */
    stop() {
      started = false;
      for (const job of jobs.values()) {
        clearJobTimer(job);
        job.again = false;
      }
      if (resumeTimer !== null) {
        clearTimer(resumeTimer);
        resumeTimer = null;
      }
    },

    /** 暫停到指定時間（毫秒時間戳）；null 或已過去的時間＝取消暫停（若原本在暫停中則立即恢復） */
    setPausedUntil(ts) {
      const wasPaused = isPaused();
      if (resumeTimer !== null) {
        clearTimer(resumeTimer);
        resumeTimer = null;
      }
      pausedUntil = typeof ts === 'number' && ts > now() ? ts : null;
      if (isPaused()) {
        for (const job of jobs.values()) clearJobTimer(job);
        if (started) {
          resumeTimer = setTimer(() => {
            resumeTimer = null;
            endPause();
          }, pausedUntil - now());
        }
      } else if (wasPaused) {
        endPause();
      }
    },

    isPaused,

    /** 立即偵測一台（受並發上限；不改變既有排程節奏）。 */
    async runNow(id) {
      await acquire();
      try {
        await run(id);
      } finally {
        release();
      }
    },

    has: (id) => jobs.has(id),
    size: () => jobs.size,
  };
}
