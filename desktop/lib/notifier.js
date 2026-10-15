// 把伺服器轉送的 status.changed 變成系統通知：查設備資料 → 規則 → 節流 → 顯示。
import { buildNotification } from './notify-rules.js';

/**
 * @param {object} deps
 * @param {(id: string) => Promise<{name: string, critical: boolean}|null>} deps.getDevice
 * @param {(n: {kind: string, title: string, body: string}) => void} deps.show
 * @param {{tryAcquire: (id: string, nowMs: number) => boolean}} deps.throttle
 * @param {() => number} [deps.now]
 * @param {{warn: Function}} [deps.log]
 */
export function createNotifier({ getDevice, show, throttle, now = Date.now, log = { warn() {} } }) {
  return {
    async handleStatusChanged(payload) {
      try {
        if (!payload || typeof payload.deviceId !== 'string') return;
        const { from, to } = payload;
        // 只有「變成 down」與「down → up」可能需要通知；其他轉換不必查設備資料
        if (!(to === 'down' || (from === 'down' && to === 'up'))) return;
        // 伺服器轉送時已附上設備資料（不需登入）；舊版或查不到時才走 getDevice
        const device = payload.device ?? (await getDevice(payload.deviceId));
        const n = buildNotification({ payload, device });
        if (!n) return;
        if (!throttle.tryAcquire(payload.deviceId, now())) return;
        show(n);
      } catch (err) {
        log.warn(`顯示通知失敗：${err?.message ?? err}`);
      }
    },
  };
}
