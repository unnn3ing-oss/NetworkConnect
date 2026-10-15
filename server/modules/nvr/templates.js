// 品牌 RTSP 模板與串流名稱（規格 §8.4）。模板來源：contracts/fixtures/nvr-templates.json。
import { readFixture } from '../../../contracts/index.js';

let cache = null;

/** 品牌模板清單（每次回傳拷貝，呼叫端可任意修改） */
export function loadTemplates() {
  cache ??= readFixture('nvr-templates.json');
  return structuredClone(cache);
}

export function getTemplate(brand) {
  return loadTemplates().find((t) => t.id === brand) ?? null;
}

/** 允許的 URL 協定：只允許 RTSP，避免自訂範本被拿去執行 go2rtc 的 exec:、ffmpeg: 等來源 */
const ALLOWED_SCHEME = /^rtsps?:\/\//i;

/** 自訂範本必須是 rtsp:// 或 rtsps:// 開頭 */
export function isRtspTemplate(text) {
  return typeof text === 'string' && ALLOWED_SCHEME.test(text.trim());
}

/** 主機只允許網域／IPv4／IPv6 常見字元，避免把路徑或帳密塞進 host 欄位 */
export function isValidHost(host) {
  if (typeof host !== 'string' || !host || host.length > 255) return false;
  if (host.startsWith('[') || host.includes(':')) return /^\[?[0-9A-Fa-f:.]+(%[A-Za-z0-9._-]+)?\]?$/.test(host);
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host);
}

const bracketHost = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/**
 * 代入模板產生 RTSP URL。
 * @param {string|{urlTemplate: string|null}} template 模板字串，或品牌模板物件
 * @param {{u?: string, p?: string, host: string, port: number|string, ch: number, stream: string}} vars
 *   u、p 一律 encodeURIComponent（帳密含 @ # : / 空白時才不會破壞 URL）；stream 是 {s} 的值
 */
export function buildUrl(template, { u = '', p = '', host, port, ch, stream }) {
  const text = typeof template === 'string' ? template : template?.urlTemplate;
  if (typeof text !== 'string' || !text) throw new Error('此品牌沒有 URL 範本（自訂品牌請提供 urlTemplate）');
  const values = {
    u: encodeURIComponent(u ?? ''),
    p: encodeURIComponent(p ?? ''),
    host: bracketHost(String(host)),
    port: String(port),
    ch: String(ch),
    s: String(stream),
  };
  return text.replace(/\{(u|p|host|port|ch|s)(?::0?(\d+))?\}/g, (m, key, width) => {
    const v = values[key];
    return width ? v.padStart(Number(width), '0') : v;
  });
}

// ---------------------------------------------------------------- 串流名稱

/** `nvr_<id>_<ch>_(main|sub)`；id 是 NVR 紀錄的完整 id（本身已含 nvr_ 前綴） */
export function streamName(nvrId, ch, kind) {
  return `nvr_${nvrId}_${ch}_${kind}`;
}

/** @returns {{nvrId: string, ch: number, kind: 'main'|'sub'} | null} */
export function parseStreamName(name) {
  const m = /^nvr_(nvr_[A-Za-z0-9_-]{1,32})_(\d{1,2})_(main|sub)$/.exec(String(name ?? ''));
  if (!m) return null;
  return { nvrId: m[1], ch: Number(m[2]), kind: m[3] };
}

/**
 * 某個 NVR 紀錄的某頻道、某碼流的 RTSP URL。
 * @param {object} nvr  nvrs 紀錄
 * @param {string} password 從 secrets 取得的密碼
 */
export function buildStreamUrl(nvr, password, ch, kind) {
  const tpl = nvr.brand === 'custom' ? nvr.urlTemplate : getTemplate(nvr.brand)?.urlTemplate;
  const url = buildUrl(tpl, {
    u: nvr.username,
    p: password ?? '',
    host: nvr.host,
    port: nvr.port,
    ch,
    stream: kind === 'main' ? nvr.streamMain : nvr.streamSub,
  });
  if (!isRtspTemplate(url)) throw new Error('RTSP URL 必須以 rtsp:// 或 rtsps:// 開頭');
  return url;
}

/** 把訊息裡的 rtsp://帳號:密碼@ 遮成 rtsp://***@，避免密碼進日誌或回應 */
export function redactUrls(text) {
  return String(text ?? '').replace(/(rtsps?:\/\/)[^\s@/]*@/gi, '$1***@');
}
