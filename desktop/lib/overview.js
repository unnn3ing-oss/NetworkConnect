// 從伺服器 REST API 取得「系統匣圖示狀態」與「通知所需的設備資料」。
// status.changed 事件只帶 {deviceId, from, to, rttMs, at}，沒有 critical 與名稱，所以主行程要自己查。
// fetch 由呼叫端注入：正式環境帶著桌面 App 啟動伺服器時給的 x-nc-desktop-token（設了存取密碼、視窗沒登入也能查）。

/**
 * @param {{devices: Array<{id: string, name?: string, monitor?: {critical?: boolean}}>, statuses: Array<{deviceId: string, state: string}>}} data
 * @returns {{alert: boolean, criticalDown: number, criticalDownIds: string[], monitored: number, up: number, down: number}}
 */
export function summarizeOverview({ devices, statuses }) {
  const known = new Set(devices.map((d) => d.id));
  const critical = new Set(devices.filter((d) => d.monitor?.critical === true).map((d) => d.id));
  const items = statuses.filter((s) => known.has(s.deviceId));
  const criticalDownIds = items.filter((s) => s.state === 'down' && critical.has(s.deviceId)).map((s) => s.deviceId);
  return {
    alert: criticalDownIds.length > 0,
    criticalDown: criticalDownIds.length,
    criticalDownIds,
    monitored: items.filter((s) => s.state !== 'disabled').length,
    up: items.filter((s) => s.state === 'up').length,
    down: items.filter((s) => s.state === 'down').length,
  };
}

/**
 * macOS 15 起，使用者拒絕「區域網路」權限時 ping 會全部失敗（規格 §8.6 地雷 2）。
 * 啟發式：至少 3 台受監控設備、沒有任何一台 up、而且全部 down。
 */
export function looksLikeLocalNetworkDenied(summary, platform) {
  if (platform !== 'darwin' || !summary) return false;
  return summary.monitored >= 3 && summary.up === 0 && summary.down === summary.monitored;
}

/**
 * @param {{getBaseUrl: () => string|null, fetch: (url: string, init?: object) => Promise<{ok: boolean, status: number, json: () => Promise<any>}>}} deps
 */
export function createOverviewClient({ getBaseUrl, fetch: doFetch }) {
  async function request(pathname, init) {
    const base = getBaseUrl();
    if (!base) return null;
    try {
      const res = await (init ? doFetch(`${base}${pathname}`, init) : doFetch(`${base}${pathname}`));
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  return {
    /** @returns {Promise<{name: string, critical: boolean}|null>} */
    async getDevice(id) {
      const d = await request(`/api/devices/${encodeURIComponent(id)}`);
      if (!d || typeof d !== 'object') return null;
      return { name: typeof d.name === 'string' ? d.name : '', critical: d.monitor?.critical === true };
    },

    /** @returns {Promise<ReturnType<typeof summarizeOverview>|null>} 查不到（未登入、伺服器重啟中）回 null */
    async getSummary() {
      const [devices, statuses] = await Promise.all([request('/api/devices'), request('/api/status')]);
      if (!Array.isArray(devices) || !Array.isArray(statuses)) return null;
      return summarizeOverview({ devices, statuses });
    },

    /** @returns {Promise<number|null>} 暫停到何時（epoch ms）；未暫停或查不到回 null */
    async getPausedUntil() {
      const s = await request('/api/monitor/settings');
      const t = s?.pausedUntil ? Date.parse(s.pausedUntil) : NaN;
      return Number.isNaN(t) ? null : t;
    },

    /** @param {string|null} iso ISO 時間；null＝恢復偵測 */
    async setPausedUntil(iso) {
      const r = await request('/api/monitor/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pausedUntil: iso }),
      });
      return r !== null;
    },
  };
}
