// 真實 prober：對應 ctx.prober 的介面（mock 模式注入的假 prober 也是這個形狀）
//   probe({method, host, port?, path?, timeoutMs?}) → Promise<{up, rttMs}>
//   偵測失敗（對方沒回應）→ resolve {up:false, rttMs:null}；檢查本身出錯 → reject
// 各方法自己的統一介面是 probe(req) → {ok, rttMs, error?}（error 只在檢查本身出錯時出現）。
import { probe as icmpProbe, detectPing } from './icmp.js';
import { probe as tcpProbe } from './tcp.js';
import { probe as httpProbe } from './http.js';

export { detectPing };

const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);

/**
 * @param {{platform?: string, icmp?: Function, tcp?: Function, http?: Function}} [deps] 測試可替換各方法的實作
 */
export function createProber({ platform = process.platform, icmp, tcp, http } = {}) {
  const impl = {
    icmp: icmp ?? ((req) => icmpProbe(req, { platform })),
    tcp: tcp ?? tcpProbe,
    http: http ?? httpProbe,
  };
  return {
    async probe(req) {
      const fn = impl[req?.method];
      if (!fn) throw new Error(`不支援的偵測方式：${req?.method}`);
      const r = await fn(req);
      if (r.error) throw new Error(r.error);
      return r.ok ? { up: true, rttMs: round1(r.rttMs) } : { up: false, rttMs: null };
    },
  };
}
