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

/**
 * 查 GitHub Releases 最新版。永不丟例外。
 * @param {{currentVersion: string, repo: string, fetch: typeof fetch, timeoutMs?: number}} args
 * @returns {Promise<{status: 'available', latest: string, url: string}|{status: 'up-to-date'}|{status: 'error', message: string}>}
 */
export async function checkForUpdate({ currentVersion, repo, fetch: doFetch, timeoutMs = 10_000 }) {
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
    return { status: 'available', latest: tag.replace(/^v/, ''), url };
  } catch (err) {
    return { status: 'error', message: err?.message ?? String(err) };
  }
}
