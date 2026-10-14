// TCP 偵測：net.connect 到指定埠，預設逾時 1500ms（規格 §8.1）。
import net from 'node:net';

export const TCP_TIMEOUT_MS = 1500;

/**
 * @param {{host: string, port: number, timeoutMs?: number}} req
 * @returns {Promise<{ok: boolean, rttMs: number|null, error?: string}>}
 */
export function probe(req, { now = Date.now } = {}) {
  const { host, port } = req ?? {};
  if (typeof host !== 'string' || !host) {
    return Promise.resolve({ ok: false, rttMs: null, error: '尚未設定 IP' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, rttMs: null, error: '尚未設定偵測埠號' });
  }
  const timeoutMs = req.timeoutMs ?? TCP_TIMEOUT_MS;
  return new Promise((resolve) => {
    const started = now();
    let done = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, rttMs: Math.max(0, now() - started) }));
    socket.once('timeout', () => finish({ ok: false, rttMs: null }));
    socket.once('error', () => finish({ ok: false, rttMs: null }));
  });
}
