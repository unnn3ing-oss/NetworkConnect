// 桌面 App 自己的設定：<userData>/desktop-settings.json。
// 與伺服器的 <dataDir>/config.json 分開（規格 §8.6 / D1 任務書第 5 項），避免動到 A0 的 core。
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'desktop-settings.json';

export const DEFAULT_SETTINGS = Object.freeze({
  autoLaunch: false, // 開機自動啟動
  preventSleep: false, // 偵測期間防止電腦閒置睡眠
  lanAccess: true, // 允許手機在區網連線（綁 0.0.0.0）
  port: null, // null＝由伺服器的 config 決定（預設 8780，被佔用時往後找）
});

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const bool = (k) => (typeof src[k] === 'boolean' ? src[k] : d[k]);
  return {
    autoLaunch: bool('autoLaunch'),
    preventSleep: bool('preventSleep'),
    lanAccess: bool('lanAccess'),
    port: Number.isInteger(src.port) && src.port >= 0 && src.port <= 65535 ? src.port : d.port,
  };
}

export function loadDesktopSettings(dir) {
  const file = path.join(dir, SETTINGS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }
  try {
    return normalizeSettings(JSON.parse(text));
  } catch {
    // 損毀：保留原檔供檢查，改用預設值
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 備份失敗不影響啟動
    }
    return { ...DEFAULT_SETTINGS };
  }
}

/** 原子寫入（先寫暫存檔再改名）。回傳實際儲存的（已 normalize）設定。 */
export function saveDesktopSettings(dir, settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return normalized;
}
