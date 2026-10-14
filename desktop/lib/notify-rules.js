// 系統通知規則：純函式。
// 規格 §8.6：critical:true 的設備離線與恢復時通知；同一台 5 分鐘內最多一次。

export const NOTIFY_WINDOW_MS = 5 * 60 * 1000;

/**
 * 每台設備的節流器。tryAcquire 成功才記錄時間；被擋下的嘗試不會延長視窗。
 * @param {{windowMs?: number}} [opts]
 */
export function createNotifyThrottle({ windowMs = NOTIFY_WINDOW_MS } = {}) {
  /** @type {Map<string, number>} */
  const last = new Map();
  return {
    /** @returns {boolean} true＝可以通知（並記錄） */
    tryAcquire(deviceId, nowMs) {
      const prev = last.get(deviceId);
      if (prev !== undefined && nowMs - prev < windowMs) return false;
      last.set(deviceId, nowMs);
      return true;
    },
    forget(deviceId) {
      last.delete(deviceId);
    },
    reset() {
      last.clear();
    },
  };
}

/**
 * 依 status.changed 的 payload 與設備資料決定通知內容；不需通知時回 null。
 * 只處理「變成 down」與「down → up」；unknown／disabled 的轉換不打擾使用者。
 * @param {{payload: {deviceId: string, from: string, to: string, at?: string}, device: {name?: string, critical?: boolean}|null|undefined}} args
 * @returns {{kind: 'down'|'up', title: string, body: string}|null}
 */
export function buildNotification({ payload, device }) {
  if (!device || device.critical !== true) return null;
  const { deviceId, from, to } = payload;
  const name = device.name || deviceId;
  if (to === 'down' && from !== 'down') {
    return { kind: 'down', title: `${name} 離線`, body: '關鍵設備無法連線，請檢查電源與網路線。' };
  }
  if (from === 'down' && to === 'up') {
    return { kind: 'up', title: `${name} 已恢復連線`, body: '關鍵設備已恢復正常。' };
  }
  return null;
}
