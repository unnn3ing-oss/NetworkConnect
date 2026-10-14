// 狀態機（規格 §8.1）：up／down／unknown／disabled。
//   - 成功一次即 up；連續 3 次失敗才 down（失敗未達 3 次時維持原狀態）。
//   - 檢查本身出錯（指令不存在、沒權限…）→ unknown 並帶 error，不計入失敗次數。
//   - method=none → disabled。
// 這個模組是純邏輯（時間注入），不碰 I/O；狀態變化以回傳值交給呼叫者發 status.changed。

export const FAIL_THRESHOLD = 3;

/** 影響「偵測對象」的欄位；任一改變就視為不同設備，狀態重新開始 */
export const probeKey = (d) => JSON.stringify([d.monitor?.method ?? 'none', d.ip ?? '', d.monitor?.port ?? null, d.monitor?.path ?? '/']);

/**
 * @param {{now?: () => number}} [opts]
 */
export function createStateTracker({ now = Date.now } = {}) {
  /** @type {Map<string, {item: object, key: string}>} */
  const entries = new Map();
  const iso = () => new Date(now()).toISOString();

  const copy = (item) => ({ ...item });

  function change(entry, to) {
    const from = entry.item.state;
    if (from === to) return null;
    const at = iso();
    entry.item.state = to;
    entry.item.lastChangeAt = at;
    return { deviceId: entry.item.deviceId, from, to, rttMs: entry.item.rttMs, at };
  }

  const fresh = (device, state) => ({
    deviceId: device.id,
    state,
    rttMs: null,
    lastCheckAt: null,
    lastChangeAt: null,
    consecutiveFailures: 0,
  });

  return {
    /**
     * 建立或更新設備的狀態項目。回傳 {item, change}；change 為狀態值改變時的 status.changed payload（新建立時為 null）。
     */
    ensure(device) {
      const method = device.monitor?.method ?? 'none';
      const target = method === 'none' ? 'disabled' : 'unknown';
      const key = probeKey(device);
      const existing = entries.get(device.id);
      if (!existing) {
        const entry = { item: fresh(device, target), key };
        entries.set(device.id, entry);
        return { item: copy(entry.item), change: null };
      }
      if (existing.key === key) return { item: copy(existing.item), change: null };
      // 偵測對象改變：從頭開始
      existing.key = key;
      existing.item.rttMs = null;
      existing.item.consecutiveFailures = 0;
      existing.item.lastCheckAt = null;
      delete existing.item.error;
      const ch = change(existing, target);
      return { item: copy(existing.item), change: ch };
    },

    /**
     * 記錄一次偵測結果：{up, rttMs}（對方有／沒有回應）或 {error}（檢查本身出錯）。
     * 設備不存在（已被刪除）→ 回傳 null，不會讓它復活。
     */
    record(deviceId, result) {
      const entry = entries.get(deviceId);
      if (!entry) return null;
      const item = entry.item;
      if (item.state === 'disabled') return { item: copy(item), change: null };
      item.lastCheckAt = iso();
      let ch = null;
      if (result.error !== undefined) {
        item.rttMs = null;
        item.error = String(result.error);
        ch = change(entry, 'unknown');
      } else if (result.up) {
        delete item.error;
        item.consecutiveFailures = 0;
        item.rttMs = typeof result.rttMs === 'number' ? result.rttMs : null;
        ch = change(entry, 'up');
      } else {
        delete item.error;
        item.consecutiveFailures += 1;
        item.rttMs = null;
        if (item.consecutiveFailures >= FAIL_THRESHOLD) ch = change(entry, 'down');
      }
      return { item: copy(item), change: ch };
    },

    remove(deviceId) {
      entries.delete(deviceId);
    },

    get(deviceId) {
      const e = entries.get(deviceId);
      return e ? copy(e.item) : undefined;
    },

    list() {
      return [...entries.values()].map((e) => copy(e.item));
    },

    /** 睡眠恢復／暫停結束：清除失敗計數但不改變狀態 */
    resetFailures() {
      for (const e of entries.values()) e.item.consecutiveFailures = 0;
    },

    has: (deviceId) => entries.has(deviceId),
  };
}
