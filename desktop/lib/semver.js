// 版本比較與「檢查更新」：純函式（fetch 由呼叫端注入，方便測試）。

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @returns {{major: number, minor: number, patch: number, pre: Array<string|number>}|null} */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function comparePre(a, b) {
  // 沒有預發行欄位＝正式版，大於任何預發行版
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const an = typeof a[i] === 'number';
    const bn = typeof b[i] === 'number';
    if (an && bn) return a[i] < b[i] ? -1 : 1;
    if (an) return -1; // 數字識別字小於文字識別字
    if (bn) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** @returns {-1|0|1} */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`無法解析版本號：${!pa ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

export function isNewerVersion(latest, current) {
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  return compareVersions(latest, current) === 1;
}

/** 這台電腦該下載哪個安裝檔：檔名結尾（對應 electron-builder.yml 的 artifactName） */
export function installerSuffix(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return '-mac-arm64.dmg';
  if (platform === 'win32' && arch === 'x64') return '-win-x64.exe';
  return null;
}

const SHA256 = /^sha256:([0-9a-f]{64})$/;
const RELEASE_ASSET_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;

/**
 * 從 release 的 assets 挑出這台電腦的安裝檔；GitHub 有提供 sha256（asset.digest）才算可自動安裝。
 * @returns {{name: string, url: string, size: number, sha256: string}|null}
 */
export function pickInstallerAsset(assets, suffix) {
  if (!suffix || !Array.isArray(assets)) return null;
  for (const a of assets) {
    if (typeof a?.name !== 'string' || !a.name.endsWith(suffix)) continue;
    const m = SHA256.exec(typeof a.digest === 'string' ? a.digest : '');
    const url = typeof a.browser_download_url === 'string' ? a.browser_download_url : '';
    if (!m || !RELEASE_ASSET_URL.test(url) || !Number.isSafeInteger(a.size) || a.size <= 0) return null;
    return { name: a.name, url, size: a.size, sha256: m[1] };
  }
  return null;
}

/**
 * 查 GitHub Releases 最新版。永不丟例外。
 * @param {{currentVersion: string, repo: string, fetch: typeof fetch, timeoutMs?: number, suffix?: string|null}} args
 *   suffix：安裝檔檔名結尾（installerSuffix()），有給才會挑出 asset
 * @returns {Promise<{status: 'available', latest: string, url: string, notes: string, asset: object|null}|{status: 'up-to-date'}|{status: 'error', message: string}>}
 */
export async function checkForUpdate({ currentVersion, repo, fetch: doFetch, timeoutMs = 10_000, suffix = null }) {
  const fallbackUrl = `https://github.com/${repo}/releases`;
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NetworkConnect-Desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 'up-to-date' }; // 尚未發行任何版本
    if (!res.ok) return { status: 'error', message: `GitHub 回應 HTTP ${res.status}` };
    const body = await res.json();
    const tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
    if (!isNewerVersion(tag, currentVersion)) return { status: 'up-to-date' };
    const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://') ? body.html_url : fallbackUrl;
    const notes = typeof body.body === 'string' ? body.body.trim().slice(0, 600) : '';
    return { status: 'available', latest: tag.replace(/^v/, ''), url, notes, asset: pickInstallerAsset(body.assets, suffix) };
  } catch (err) {
    return { status: 'error', message: err?.message ?? String(err) };
  }
}
