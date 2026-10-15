// go2rtc REST／WebSocket 用戶端。逾時與連線錯誤一律轉成 UPSTREAM（502）。
// 不使用 /api/frame.jpeg：它需要 ffmpeg，而 App 不內附 ffmpeg（規格 §8.4 地雷 6）。
import { upstream } from '../../core/errors.js';
import { redactUrls } from './templates.js';

/** probe 送給 go2rtc 的 MSE 請求：列出瀏覽器可能支援的編碼，go2rtc 會回報實際串流的編碼 */
export const PROBE_CODECS =
  'avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5,flac,opus';

/** `video/mp4; codecs="avc1.640029,mp4a.40.2"` → { codec: 'h264', codecs: 'avc1.640029,mp4a.40.2' } */
export function parseMseCodec(value) {
  const codecs = /codecs="([^"]*)"/i.exec(String(value ?? ''))?.[1] ?? '';
  const video = codecs.split(',').map((c) => c.trim()).find((c) => /^(avc[13]|hvc1|hev1|vp0?9|av01)/i.test(c));
  let codec = codecs || 'unknown';
  if (video) codec = /^avc/i.test(video) ? 'h264' : /^(hvc1|hev1)/i.test(video) ? 'h265' : video;
  return { codec, codecs };
}

/**
 * go2rtc 回報的串流錯誤訊息分類：
 *  auth＝帳密錯誤（RTSP 401）、unreachable＝連不到主機、error＝其他
 */
export function classifyProbeError(message) {
  const text = String(message ?? '');
  if (/\b401\b|unauthori[sz]ed|wrong user|wrong pass|auth(entication)? (fail|error)|bad credentials/i.test(text)) return 'auth';
  if (/refused|no route|unreachable|no such host|host is down|i\/o timeout|dial tcp|dial udp|lookup /i.test(text)) return 'unreachable';
  return 'error';
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  例：http://127.0.0.1:1984
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @param {number} [opts.timeoutMs=5000]       HTTP 請求逾時
 * @param {number} [opts.probeTimeoutMs=8000]  probe 逾時（規格：最多 8 秒）
 */
export function createGo2rtcClient({
  baseUrl,
  fetchImpl = (...a) => globalThis.fetch(...a),
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 5000,
  probeTimeoutMs = 8000,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const wsBase = base.replace(/^http/i, 'ws');

  async function call(method, pathAndQuery, { timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${pathAndQuery}`, { method, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw upstream(timedOut ? '串流服務（go2rtc）沒有回應，請稍後再試' : '無法連線到串流服務（go2rtc）', {
        reason: timedOut ? 'timeout' : 'unreachable',
      });
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      throw upstream(`串流服務（go2rtc）回應錯誤（HTTP ${res.status}）`, { status: res.status });
    }
    const text = await res.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const q = (params) => new URLSearchParams(params).toString();

  return {
    baseUrl: base,

    /** GET /api → { version, ... }；連不到丟 UPSTREAM */
    info: (opts) => call('GET', '/api', opts),

    /** GET /api/streams → { <name>: { producers: [{url}] } } */
    async listStreams() {
      return (await call('GET', '/api/streams')) ?? {};
    },

    /**
     * 註冊（或取代）串流。go2rtc 的 PUT 對已存在的串流是「追加來源」，所以先刪再建，
     * 帳密變更後才不會留下舊來源。
     */
    async upsertStream(name, src) {
      await call('DELETE', `/api/streams?${q({ src: name })}`).catch((err) => {
        if (err.details?.status !== 404) throw err;
      });
      await call('PUT', `/api/streams?${q({ name, src })}`);
    },

    async removeStream(name) {
      await call('DELETE', `/api/streams?${q({ src: name })}`).catch((err) => {
        if (err.details?.status !== 404) throw err;
      });
    },

    /**
     * 後端自己開 WebSocket 連 /api/ws?src=<name>，送出 MSE 請求，等 go2rtc 回報編碼後關閉。
     * 回傳 { ok:true, codec, codecs } 或 { ok:false, reason:'auth'|'unreachable'|'timeout'|'error', error }。
     * go2rtc 本身連不上（或 8 秒內連線都沒建立）丟 UPSTREAM。
     */
    probe(name, { timeout = probeTimeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        let ws;
        let opened = false;
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            ws?.close();
          } catch {
            // 已關閉
          }
          fn(value);
        };
        const timer = setTimeout(() => {
          if (opened) finish(resolve, { ok: false, reason: 'timeout', error: `逾時：${Math.round(timeout / 1000)} 秒內沒有收到影像資訊` });
          else finish(reject, upstream('串流服務（go2rtc）沒有回應，請稍後再試', { reason: 'timeout' }));
        }, timeout);

        try {
          ws = new WebSocketImpl(`${wsBase}/api/ws?${q({ src: name })}`);
        } catch {
          finish(reject, upstream('無法連線到串流服務（go2rtc）', { reason: 'unreachable' }));
          return;
        }
        ws.binaryType = 'arraybuffer';
        ws.addEventListener('open', () => {
          opened = true;
          ws.send(JSON.stringify({ type: 'mse', value: PROBE_CODECS }));
        });
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === 'mse') {
            finish(resolve, { ok: true, ...parseMseCodec(msg.value) });
          } else if (msg.type === 'error') {
            const error = redactUrls(msg.value);
            finish(resolve, { ok: false, reason: classifyProbeError(error), error });
          }
        });
        ws.addEventListener('error', () => {
          if (!opened) finish(reject, upstream('無法連線到串流服務（go2rtc）', { reason: 'unreachable' }));
        });
        ws.addEventListener('close', () => {
          if (opened) finish(resolve, { ok: false, reason: 'error', error: '連線被中斷，沒有收到影像資訊' });
          else finish(reject, upstream('無法連線到串流服務（go2rtc）', { reason: 'unreachable' }));
        });
      });
    },
  };
}
