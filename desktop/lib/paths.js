// 路徑與環境變數組合：純函式。平台參數可注入，所以 Linux 容器也能測 Windows／macOS 的路徑。
import path from 'node:path';
import fs from 'node:fs';

const SUPPORTED = new Set(['darwin-arm64', 'win32-x64']);

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** @returns {'darwin-arm64'|'win32-x64'|null} v1 不支援 Intel Mac */
export function go2rtcTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  return SUPPORTED.has(key) ? key : null;
}

export function go2rtcBinaryName(platform) {
  return platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
}

/**
 * NC_GO2RTC_PATH 的值。
 * - 打包後：<resources>/go2rtc/go2rtc[.exe]（electron-builder extraResources 放置）
 * - 開發時：<repo>/build/go2rtc/<平台>-<架構>/go2rtc[.exe]（scripts/fetch-go2rtc.js 下載），檔案不存在回 null
 * @returns {string|null}
 */
export function resolveGo2rtcPath({ platform, arch, isPackaged, resourcesPath, appRoot, exists = fs.existsSync }) {
  const target = go2rtcTarget(platform, arch);
  if (!target) return null;
  const p = pathFor(platform);
  const bin = go2rtcBinaryName(platform);
  if (isPackaged) return p.join(resourcesPath, 'go2rtc', bin);
  const dev = p.join(appRoot, 'build', 'go2rtc', target, bin);
  return exists(dev) ? dev : null;
}

export function resolveDataDir(userDataPath, platform = process.platform) {
  return pathFor(platform).join(userDataPath, 'data');
}

/**
 * 伺服器行程的環境變數（規格 §8.6）。
 * 預設不傳 NC_PORT：伺服器自行使用 config.port（8780）並在被佔用時往後找、寫回 config。
 * 只有使用者在 desktop-settings 指定埠，或外部（例如冒煙測試）已設定 NC_PORT 時才傳。
 */
export function buildServerEnv({ baseEnv, dataDir, lanAccess, go2rtcPath, port }) {
  const env = {
    ...baseEnv,
    NC_DATA_DIR: dataDir,
    NC_HOST: lanAccess ? '0.0.0.0' : '127.0.0.1',
    NC_GO2RTC_PATH: go2rtcPath ?? '',
  };
  if (port !== null && port !== undefined) env.NC_PORT = String(port);
  return env;
}
