// 偵測歷史（collection statusHistory，規格 §7）：每台環狀保留最近 1440 筆；
// 寫入 store 採批次——有新資料後最多等 30 秒一次寫出所有有變動的設備，stop() 時補寫。
export const MAX_SAMPLES = 1440;
export const FLUSH_INTERVAL_MS = 30_000;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {object} deps
 * @param {{list(): Promise<object[]>, upsert(doc: object): Promise<object>, remove(id: string): Promise<boolean>}} deps.repo  statusHistory collection
 * @param {() => number} deps.now
 * @param {(fn: Function, ms: number) => any} deps.setTimer
 * @param {(handle: any) => void} deps.clearTimer
 */
export function createHistory({ repo, now = Date.now, setTimer, clearTimer, flushMs = FLUSH_INTERVAL_MS, log = noopLog }) {
  /** @type {Map<string, Array<{at: string, up: boolean, rttMs: number|null}>>} */
  const data = new Map();
  const dirty = new Set();
  let timer = null;
  let stopped = false;

  function armTimer() {
    if (timer !== null || stopped) return;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, flushMs);
  }

  async function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const samples = data.get(id);
      if (!samples) continue;
      try {
        await repo.upsert({ deviceId: id, samples: samples.map((s) => ({ ...s })) });
      } catch (err) {
        log.error({ err }, `寫入偵測歷史失敗（${id}）：${err.message}`);
        dirty.add(id);
        armTimer();
      }
    }
  }

  return {
    /** 啟動時讀回已存的歷史 */
    async load() {
      for (const doc of await repo.list()) {
        const samples = Array.isArray(doc.samples) ? doc.samples : [];
        data.set(doc.deviceId, samples.slice(-MAX_SAMPLES).map((s) => ({ at: s.at, up: s.up, rttMs: s.rttMs })));
      }
    },

    add(deviceId, sample) {
      let list = data.get(deviceId);
      if (!list) {
        list = [];
        data.set(deviceId, list);
      }
      list.push({ at: sample.at, up: Boolean(sample.up), rttMs: sample.up ? (sample.rttMs ?? null) : null });
      if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
      dirty.add(deviceId);
      armTimer();
    },

    /** 最近 hours 小時的紀錄，由舊到新 */
    get(deviceId, hours = 24, { nowMs } = {}) {
      const list = data.get(deviceId);
      if (!list) return [];
      const cutoff = (nowMs ?? now()) - hours * 3600_000;
      return list.filter((s) => Date.parse(s.at) >= cutoff).map((s) => ({ ...s }));
    },

    async remove(deviceId) {
      data.delete(deviceId);
      dirty.delete(deviceId);
      await repo.remove(deviceId);
    },

    /** 刪除不屬於 keepIds 的設備紀錄 */
    async prune(keepIds) {
      const doomed = new Set([...data.keys()].filter((id) => !keepIds.has(id)));
      for (const doc of await repo.list()) if (!keepIds.has(doc.deviceId)) doomed.add(doc.deviceId);
      for (const id of doomed) await this.remove(id);
    },

    flush,

    /** 停止計時器並把尚未寫出的資料落檔 */
    async stop() {
      stopped = true;
      await flush();
    },

    has: (deviceId) => data.has(deviceId),
  };
}
