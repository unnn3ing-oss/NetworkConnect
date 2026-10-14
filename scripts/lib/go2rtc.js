// go2rtc 執行檔下載（D1 任務書第 7 項）。
// 版本唯一來源：package.json 的 config.go2rtcVersion。sha256 清單：scripts/go2rtc-checksums.json（對下載到的 zip 比對）。
// 只支援 darwin-arm64 與 win32-x64（不支援 Intel Mac）。執行檔放在 build/go2rtc/<平台>-<架構>/，不進 git。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSingle } from './unzip.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'AlexxIT/go2rtc';

export const DEFAULT_OUT_DIR = path.join(ROOT, 'build', 'go2rtc');
export const CHECKSUMS_FILE = path.join(ROOT, 'scripts', 'go2rtc-checksums.json');

export function readGo2rtcVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const v = pkg.config?.go2rtcVersion;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error('package.json 缺少有效的 config.go2rtcVersion');
  return v;
}

/** @returns {Array<{target: string, asset: string, url: string, binary: string}>} */
export function go2rtcAssets(version) {
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  return [
    { target: 'darwin-arm64', asset: 'go2rtc_mac_arm64.zip', url: `${base}/go2rtc_mac_arm64.zip`, binary: 'go2rtc' },
    { target: 'win32-x64', asset: 'go2rtc_win64.zip', url: `${base}/go2rtc_win64.zip`, binary: 'go2rtc.exe' },
  ];
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const MARKER = '.archive-sha256';

/**
 * @param {object} opts
 * @param {string} opts.version
 * @param {Record<string, Record<string, string>>} opts.checksums
 * @param {string} [opts.outDir]
 * @param {typeof fetch} [opts.fetch]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force]
 * @param {string[]} [opts.targets]
 * @param {(msg: string) => void} [opts.log]
 */
export async function fetchGo2rtc({ version, checksums, outDir = DEFAULT_OUT_DIR, fetch: doFetch = fetch, dryRun = false, force = false, targets, log = console.log }) {
  const assets = go2rtcAssets(version).filter((a) => !targets || targets.includes(a.target));
  const sums = checksums[version];
  if (!sums) {
    throw new Error(`scripts/go2rtc-checksums.json 沒有 ${version} 的 sha256。請下載該版本的兩個 zip，執行 sha256sum 後補進檔案（詳見 desktop/README.md）。`);
  }

  for (const a of assets) {
    const expected = sums[a.asset];
    if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error(`go2rtc-checksums.json 缺少 ${version} 的 ${a.asset}`);
    const dir = path.join(outDir, a.target);
    const binPath = path.join(dir, a.binary);

    if (dryRun) {
      log(`[dry-run] ${a.target}: ${a.url} → ${binPath}（sha256 ${expected}）`);
      continue;
    }
    if (!force && fs.existsSync(binPath) && fs.existsSync(path.join(dir, MARKER)) && fs.readFileSync(path.join(dir, MARKER), 'utf8').trim() === expected) {
      log(`${a.target}: 已是 go2rtc ${version}，略過`);
      continue;
    }

    log(`${a.target}: 下載 ${a.url}`);
    const res = await doFetch(a.url);
    if (!res.ok) throw new Error(`下載 ${a.url} 失敗：HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const actual = sha256(zip);
    if (actual !== expected) {
      throw new Error(`${a.asset} 的 sha256 不符：預期 ${expected}，實際 ${actual}。檔案可能被竄改，或需要更新 go2rtc-checksums.json。`);
    }
    const binary = unzipSingle(zip, a.binary);

    fs.mkdirSync(dir, { recursive: true });
    // 資料夾自帶 .gitignore（內容 *，連同自己一起忽略），執行檔不會被誤 commit
    fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n');
    const tmp = `${binPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, binary, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, binPath);
    fs.writeFileSync(path.join(dir, MARKER), `${expected}\n`);
    log(`${a.target}: 完成（${(binary.length / 1e6).toFixed(1)} MB，sha256 驗證通過）`);
  }
}
