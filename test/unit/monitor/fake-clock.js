// 假時鐘：給 monitor 測試注入 now／setTimer／clearTimer，不依賴真實時間。
//   advance(ms)  時間前進並依序觸發到期的計時器（每次觸發後讓 microtask 跑完）
//   jump(ms)     時間前進但不觸發任何計時器（模擬電腦睡眠）；之後用 tick() 觸發已到期的計時器
//   pending()    尚未觸發也未清除的計時器數量（驗證 stop() 沒有殘留）
export function createFakeClock(start = Date.parse('2026-10-14T08:00:00.000Z')) {
  let t = start;
  let seq = 0;
  /** @type {Map<number, {fn: Function, at: number}>} */
  const timers = new Map();

  const settle = () => new Promise((r) => setImmediate(r));

  async function fireDue(limit) {
    for (;;) {
      let nextId = null;
      for (const [id, tm] of timers) {
        if (tm.at <= limit && (nextId === null || tm.at < timers.get(nextId).at || (tm.at === timers.get(nextId).at && id < nextId))) nextId = id;
      }
      if (nextId === null) return;
      const tm = timers.get(nextId);
      timers.delete(nextId);
      if (tm.at > t) t = tm.at;
      tm.fn();
      await settle();
    }
  }

  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(0, ms) });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = t + ms;
      await settle();
      await fireDue(target);
      t = target;
      await settle();
    },
    jump(ms) {
      t += ms;
    },
    async tick() {
      await settle();
      await fireDue(t);
      await settle();
    },
    settle,
  };
}
