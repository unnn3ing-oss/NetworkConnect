// 視窗導覽與外部連結的安全規則（規格 §8.6 安全）：純函式。

/** 錯誤頁用的內部動作連結：nc-action://restart、nc-action://open-logs */
export const ACTION_SCHEME = 'nc-action:';
const ACTIONS = new Set(['restart', 'open-logs']);

/** 只允許載入 http://127.0.0.1:<伺服器實際埠>。其他一律交給系統瀏覽器。 */
export function isAppUrl(url, port) {
  if (!Number.isInteger(port)) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port) && u.username === '' && u.password === '';
}

/** 交給 shell.openExternal 之前的檢查：只允許 http／https（避免 file:、smb:、自訂協定被拿來執行程式）。 */
export function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** @returns {'restart'|'open-logs'|null} */
export function parseActionUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== ACTION_SCHEME) return null;
  return ACTIONS.has(u.hostname) ? u.hostname : null;
}
