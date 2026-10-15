// App 內更新：下載安裝檔並驗證 sha256 → 結束後由外部程序安裝 → 重新開啟。
// 這裡只有可測的部分（下載、驗證、安裝方式判斷、Mac 安裝腳本）；接上 Electron 的部分在 main.js。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 下載到 <dir>/<asset.name>，大小與 sha256 都要相符才保留；已下載過且相符就直接沿用。
 * 先寫到 .part，驗證通過才改名，資料夾裡其他舊安裝檔一併清掉。
 * @param {{asset: {name: string, url: string, size: number, sha256: string}, dir: string, fetch: typeof fetch,
 *          onProgress?: (ratio: number) => void, timeoutMs?: number}} args
 * @returns {Promise<string>} 安裝檔路徑
 */
export async function downloadInstaller({ asset, dir, fetch: doFetch, onProgress = () => {}, timeoutMs = 15 * 60_000 }) {
  if (path.basename(asset.name) !== asset.name) throw new Error(`安裝檔名稱不合法：${asset.name}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  for (const f of fs.readdirSync(dir)) {
    if (f !== asset.name) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
  if (fs.existsSync(file) && (await sha256File(file)) === asset.sha256) return file;

  const res = await doFetch(asset.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`下載失敗（HTTP ${res.status}）`);
  const part = `${file}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > asset.size) return cb(new Error('下載的檔案比預期大，已中止'));
      hash.update(chunk);
      onProgress(received / asset.size);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part));
    if (received !== asset.size) throw new Error(`下載不完整（${received}／${asset.size} bytes）`);
    if (hash.digest('hex') !== asset.sha256) throw new Error('安裝檔驗證失敗（sha256 不符），可能下載過程損毀，請再試一次');
    fs.renameSync(part, file);
    return file;
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** 執行檔 …/X.app/Contents/MacOS/X → …/X.app；不是 .app 結構回 null */
export function macAppBundle(exePath) {
  const bundle = path.resolve(exePath, '..', '..', '..');
  return bundle.endsWith('.app') && path.basename(path.dirname(exePath)) === 'MacOS' ? bundle : null;
}

/**
 * 能不能自己安裝：Windows 一律可以（NSIS 安裝在使用者資料夾）；
 * Mac 要求 App 放在可寫入的位置，而不是直接從 dmg 或「下載」資料夾的隔離位置（App Translocation）執行。
 * @returns {{ok: true, appPath?: string}|{ok: false, reason: string}}
 */
export function selfInstallSupport({ platform, exePath, isWritable }) {
  if (platform === 'win32') return { ok: true };
  if (platform !== 'darwin') return { ok: false, reason: '這個平台不支援 App 內更新' };
  const appPath = macAppBundle(exePath);
  if (!appPath) return { ok: false, reason: '找不到 App 的位置' };
  if (appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) {
    return { ok: false, reason: 'App 目前不是從「應用程式」資料夾執行（例如直接從 dmg 開啟）。請先把 NetworkConnect 拖到「應用程式」資料夾再開啟。' };
  }
  if (!isWritable(path.dirname(appPath)) || !isWritable(appPath)) {
    return { ok: false, reason: `沒有權限覆寫 ${appPath}` };
  }
  return { ok: true, appPath };
}

/**
 * Mac 安裝腳本：等 App 結束 → 掛載 dmg → 複製出新版 → 取代舊版 → 重新開啟。
 * 任何一步失敗都還原舊版並重新開啟；路徑只用位置參數傳入，不拼進腳本內容。
 * 用法：bash <script> <pid> <dmg> <App 路徑> <log 檔>
 */
export const MAC_INSTALL_SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "[$(date)] 開始更新：$DMG → $APP"
for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
MNT="$(mktemp -d "\${TMPDIR:-/tmp}/nc-update.XXXXXX")"
detach() { hdiutil detach "$MNT" -quiet -force >/dev/null 2>&1; rmdir "$MNT" 2>/dev/null; }
fail() {
  echo "更新失敗：$1"
  detach
  if [ ! -d "$APP" ] && [ -d "$APP.old" ]; then mv "$APP.old" "$APP"; fi
  rm -rf "$APP.new"
  open "$APP"
  exit 1
}
hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$MNT" "$DMG" || fail "無法掛載 dmg"
SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$SRC" ] || fail "dmg 裡找不到 App"
rm -rf "$APP.new"
ditto "$SRC" "$APP.new" || fail "複製新版失敗"
detach
rm -rf "$APP.old"
mv "$APP" "$APP.old" || fail "無法移走舊版"
mv "$APP.new" "$APP" || fail "無法放入新版"
rm -rf "$APP.old"
rm -f "$DMG"
echo "[$(date)] 更新完成"
open "$APP"
`;

/**
 * App 結束後要執行的安裝指令。
 * @returns {{command: string, args: string[], script?: string}}
 */
export function buildInstallCommand({ platform, installer, appPath, pid, logFile, scriptFile }) {
  if (platform === 'win32') {
    // electron-builder 的 NSIS：/S 靜默安裝、--updated 表示是更新、--force-run 裝完自動開啟
    return { command: installer, args: ['--updated', '/S', '--force-run'] };
  }
  if (platform === 'darwin') {
    return { command: '/bin/bash', args: [scriptFile, String(pid), installer, appPath, logFile], script: MAC_INSTALL_SCRIPT };
  }
  throw new Error(`不支援的平台：${platform}`);
}
