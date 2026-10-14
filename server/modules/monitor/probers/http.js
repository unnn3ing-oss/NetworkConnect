// HTTP 偵測：fetch GET + AbortController 逾時；狀態碼 < 500 視為 up（規格 §8.1）。
import net from 'node:net';

export const HTTP_TIMEOUT_MS = 1500;

// 對方是 HTTPS 但憑證不被信任（家用設備幾乎都是自簽）：握手有回應代表主機是活的
const CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const HOST_OK = /^[A-Za-z0-9.-]+$/;

/**
 * @param {{host: string, port?: number|null, path?: string, timeoutMs?: number}} req
 * @returns {Promise<{ok: boolean, rttMs: number|null, error?: string}>}
 */
export async function probe(req, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const host = req?.host;
  if (typeof host !== 'string' || !host) return { ok: false, rttMs: null, error: '尚未設定 IP' };
  if (!net.isIP(host) && !HOST_OK.test(host)) return { ok: false, rttMs: null, error: '主機位址格式不正確' };
  const port = req.port ?? 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, rttMs: null, error: '偵測埠號不正確' };
  let path = typeof req.path === 'string' && req.path ? req.path : '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';
  const url = `${scheme}://${host}:${port}${path}`;

  const timeoutMs = req.timeoutMs ?? HTTP_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'NetworkConnect-monitor' },
    });
    res.body?.cancel?.().catch(() => {});
    if (res.status < 500) return { ok: true, rttMs: Math.max(0, now() - started) };
    return { ok: false, rttMs: null };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    if (CERT_CODES.has(code)) return { ok: true, rttMs: Math.max(0, now() - started) };
    if (err instanceof TypeError && /Invalid URL/i.test(String(err.message))) {
      return { ok: false, rttMs: null, error: '偵測網址不正確' };
    }
    return { ok: false, rttMs: null };
  } finally {
    clearTimeout(timer);
  }
}
