// cameras 模組的純邏輯（不碰 DOM，可在 Node 單元測試）：串流名稱、分割、頻道清單、上限、網址目標、精靈表單。

export const SPLITS = Object.freeze([1, 4, 9, 16]);
export const DEFAULT_SPLIT = 4;
export const DEFAULT_LIMIT = 9;
export const MAX_LIMIT = 16;

/** 與後端 server/modules/nvr/templates.js 的 streamName 相同：`nvr_<id>_<ch>_(main|sub)`，id 已含 nvr_ 前綴 */
export const streamName = (nvrId, ch, kind) => `nvr_${nvrId}_${ch}_${kind}`;

/** 瀏覽器連的 WebSocket 路徑（相對路徑，VideoRTC 會補上 ws://host） */
export const wsPath = (name) => `/api/nvr/ws?stream=${encodeURIComponent(name)}`;

export const channelKey = (nvrId, ch) => `${nvrId}:${ch}`;

/** 分割數 → 欄數（1→1、4→2、9→3、16→4） */
export const gridCols = (split) => Math.round(Math.sqrt(SPLITS.includes(split) ? split : DEFAULT_SPLIT));

export const clampSplit = (n) => (SPLITS.includes(Number(n)) ? Number(n) : DEFAULT_SPLIT);

/** 畫面牆畫質：子碼流（預設，省頻寬）或主碼流；其他值一律當子碼流 */
export const clampQuality = (q) => (q === 'main' ? 'main' : 'sub');
export const QUALITY_LABELS = Object.freeze({ sub: '子碼流', main: '主碼流' });

export function clampLimit(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, v));
}

/**
 * 所有 NVR 的啟用頻道，攤平成清單（依 NVR 順序、頻道編號）。
 * @returns {Array<{key: string, nvrId: string, nvrName: string, ch: number, name: string, deviceId: string|null}>}
 */
export function flattenChannels(nvrs) {
  const out = [];
  for (const nvr of nvrs ?? []) {
    for (const c of [...(nvr.channels ?? [])].sort((a, b) => a.ch - b.ch)) {
      if (!c.enabled) continue;
      out.push({ key: channelKey(nvr.id, c.ch), nvrId: nvr.id, nvrName: nvr.name, ch: c.ch, name: c.name || `頻道 ${c.ch}`, deviceId: c.deviceId ?? null });
    }
  }
  return out;
}

/**
 * 勾選狀態：存的是「取消勾選」的頻道（hidden），這樣新增 NVR／頻道時預設就是顯示。
 * 回傳目前勾選的頻道 key（依頻道清單順序）。
 */
export function selectedKeys(hidden, channels) {
  const off = new Set(Array.isArray(hidden) ? hidden : []);
  return channels.map((c) => c.key).filter((k) => !off.has(k));
}

export const pageCount = (total, cells) => Math.max(1, Math.ceil(total / Math.max(1, cells)));

export function pageSlice(keys, cells, page) {
  const pages = pageCount(keys.length, cells);
  const p = Math.min(Math.max(0, page), pages - 1);
  return { keys: keys.slice(p * cells, (p + 1) * cells), page: p, pages };
}

/** 同時串流上限：前 limit 個連線，其餘顯示「已達上限」 */
export function applyLimit(keys, limit) {
  const n = clampLimit(limit);
  return { streaming: keys.slice(0, n), limited: keys.slice(n) };
}

/**
 * 網址目標：`#/cameras?device=<deviceId>` 或 `#/cameras?ch=<nvrId>:<ch>`。
 * @returns {{mode: 'all'} | {mode: 'single', key: string} | {mode: 'missing', reason: string}}
 */
export function parseTarget(query, channels) {
  const ch = query?.ch;
  if (ch) {
    const found = channels.find((c) => c.key === ch);
    return found ? { mode: 'single', key: found.key } : { mode: 'missing', reason: `找不到頻道「${ch}」（可能已停用或被刪除）` };
  }
  const device = query?.device;
  if (device) {
    const found = channels.find((c) => c.deviceId === device);
    return found ? { mode: 'single', key: found.key } : { mode: 'missing', reason: '這台攝影機尚未連結到任何 NVR 頻道' };
  }
  return { mode: 'all' };
}

// ---------------------------------------------------------------- 精靈

export const WIZARD_STEPS = Object.freeze(['brand', 'connect', 'test', 'channels', 'confirm']);

/** 新增時的表單初始值（所有欄位都是字串／布林，方便綁定輸入框） */
export function newWizardState(templates = []) {
  const t = templates[0];
  return {
    nvrId: null, brand: t?.id ?? 'hikvision', host: '', port: String(t?.defaultPort ?? 554), username: 'admin', password: '',
    channelCount: '4', urlTemplate: '', streamMain: t?.streamMain ?? '', streamSub: t?.streamSub ?? '',
    name: '家用 NVR', deviceId: '', channels: [], hasPassword: false,
    test: { status: 'idle', result: null, thumbnail: '', signature: '' }, skipTest: false,
  };
}

export function stateFromNvr(nvr, templates = []) {
  return {
    ...newWizardState(templates),
    nvrId: nvr.id, brand: nvr.brand, host: nvr.host, port: String(nvr.port), username: nvr.username, password: '',
    channelCount: String(nvr.channelCount), urlTemplate: nvr.urlTemplate ?? '', streamMain: nvr.streamMain, streamSub: nvr.streamSub,
    name: nvr.name, deviceId: nvr.deviceId ?? '', hasPassword: Boolean(nvr.hasPassword),
    channels: nvr.channels.map((c) => ({ ...c })),
  };
}

/** 自訂品牌沒有可沿用的網址時，預先帶入的開頭 */
export const CUSTOM_URL_STARTER = 'rtsp://{u}:{p}@{host}:{port}/';

/**
 * 選品牌時帶入模板預設值。
 * 改選「自訂」時，若網址還是空的，帶入剛才那個品牌的 RTSP 網址與碼流代號，只要改不同的地方就好；
 * 自訂品牌保留使用者已輸入的 URL。
 * @param {object} [from] 切換前的品牌模板
 */
export function applyBrand(state, template, from = null) {
  state.brand = template.id;
  state.port = String(template.defaultPort);
  if (template.id !== 'custom') {
    state.urlTemplate = '';
    state.streamMain = template.streamMain;
    state.streamSub = template.streamSub;
    return;
  }
  if (state.urlTemplate.trim()) return;
  const base = from?.urlTemplate ? from : null;
  state.urlTemplate = base?.urlTemplate ?? CUSTOM_URL_STARTER;
  state.streamMain = base?.streamMain ?? template.streamMain;
  state.streamSub = base?.streamSub ?? template.streamSub;
}

const HOST_RE = /^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[?[0-9A-Fa-f:.]+\]?)$/;

/** 步驟 2（連線）驗證；回傳錯誤訊息或 null */
export function validateConnection(state, { editing = false } = {}) {
  const host = state.host.trim();
  if (!host) return '請輸入 NVR 的 IP 位址或主機名稱';
  if (!HOST_RE.test(host)) return '主機位址格式不正確（只能是 IP 或網域名稱，不含 rtsp:// 與路徑）';
  const port = Number(state.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'RTSP 埠必須是 1–65535 的整數（預設 554）';
  if (!state.username.trim()) return '請輸入帳號';
  if (!editing && !state.password) return '請輸入密碼';
  const n = Number(state.channelCount);
  if (!Number.isInteger(n) || n < 1 || n > 64) return '頻道數必須是 1–64 的整數';
  if (state.brand === 'custom') {
    if (!/^rtsps?:\/\//i.test(state.urlTemplate.trim())) return '自訂 URL 必須以 rtsp:// 開頭';
    if (!state.streamMain.trim() || !state.streamSub.trim()) return '請填入主碼流與子碼流的代號（代入 {s}）';
  }
  return null;
}

/** 連線設定的簽章：改了任何一項，先前的測試結果就作廢 */
export function connectionSignature(state) {
  return JSON.stringify([state.brand, state.host.trim(), state.port, state.username, state.password, state.channelCount, state.urlTemplate, state.streamMain, state.streamSub]);
}

/** 建立／更新 NVR 時送出的欄位（連線部分）。password 空字串＝不送（編輯時沿用舊密碼） */
export function connectionPayload(state) {
  const body = {
    name: state.name.trim() || '家用 NVR',
    brand: state.brand,
    host: state.host.trim(),
    port: Number(state.port),
    username: state.username.trim(),
    channelCount: Number(state.channelCount),
    streamMain: state.streamMain,
    streamSub: state.streamSub,
  };
  if (state.brand === 'custom') body.urlTemplate = state.urlTemplate.trim();
  if (state.password) body.password = state.password;
  return body;
}

/** 頻道步驟：補齊 1..N、保留已填的名稱 */
export function ensureChannels(state) {
  const n = Number(state.channelCount);
  const by = new Map(state.channels.map((c) => [c.ch, c]));
  state.channels = Array.from({ length: n }, (_, i) => by.get(i + 1) ?? { ch: i + 1, name: `頻道 ${i + 1}`, deviceId: null, enabled: true });
}

export function validateChannels(state) {
  if (!state.channels.some((c) => c.enabled)) return '至少要啟用一個頻道';
  return null;
}

/** 測試結果 → 給精靈顯示的訊息（kind：ok／warn／error） */
export function describeTest(result) {
  if (!result) return null;
  if (!result.ok) return { kind: 'error', title: '連線失敗', text: result.error || '無法取得影像' };
  if (result.warning) return { kind: 'warn', title: `連線成功，但偵測到 ${String(result.codec).toUpperCase()}`, text: result.warning };
  return { kind: 'ok', title: '連線成功', text: `影像編碼：${result.codec === 'h264' ? 'H.264' : result.codec}` };
}

/**
 * 連線設定的 RTSP 網址預覽（密碼一律顯示 ****，只用於畫面說明；實際組裝在後端）。
 * @param {{urlTemplate: string|null}} template 品牌模板；custom 品牌改用 state.urlTemplate
 */
export function previewUrl(state, template, kind = 'sub', ch = 1) {
  const text = state.brand === 'custom' ? state.urlTemplate.trim() : template?.urlTemplate;
  if (!text) return '';
  const s = kind === 'main' ? state.streamMain : state.streamSub;
  const values = { u: encodeURIComponent(state.username || ''), p: '****', host: state.host.trim() || '<主機>', port: state.port || '554', ch: String(ch), s: String(s ?? '') };
  return text.replace(/\{(u|p|host|port|ch|s)(?::0?(\d+))?\}/g, (m, key, width) => (width ? values[key].padStart(Number(width), '0') : values[key]));
}

/** 這個瀏覽器（或 App）的播放器能不能播 H.265；VideoRTC 也是用同一個字串問 MediaSource */
export function browserSupportsHevc(win = globalThis) {
  const MS = win.ManagedMediaSource ?? win.MediaSource;
  try {
    return Boolean(MS?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L153.B0"'));
  } catch {
    return false;
  }
}

/**
 * 把 go2rtc 串流錯誤翻成格子上的說明。
 * 「<模式>: streams: codecs not matched: <NVR 提供的> => <播放器能播的>」代表編碼不合，重連也不會好（fatal）。
 * 播放器先試 MSE，失敗才退到 mjpeg（需要 ffmpeg，本 App 沒有附），所以真正的原因要看 NVR 提供的編碼。
 * @returns {{message: string, fatal: boolean}}
 */
export function describeStreamError(raw, { hevc = false } = {}) {
  const text = String(raw ?? '').trim();
  const m = /codecs not matched:\s*(.*?)\s*=>\s*(.*)$/i.exec(text);
  if (!m) return { message: text || '串流發生錯誤', fatal: false };
  const source = m[1];
  if (!source) return { message: 'NVR 有回應，但這個頻道沒有提供影像（請確認有接攝影機、碼流代號正確）', fatal: true };
  if (/H265|HEVC/i.test(source)) {
    return {
      message: hevc
        ? '這個頻道是 H.265，但播放器沒辦法解這路影像。請到 NVR 把這個頻道（這個碼流）的編碼改成 H.264。'
        : '這個頻道是 H.265，這台電腦的播放器不支援。請到 NVR 把這個頻道（這個碼流）的編碼改成 H.264，或改看另一個碼流。',
      fatal: true,
    };
  }
  const codecs = source.replace(/(video|audio):/gi, '').replace(/\s*,\s*/g, '、');
  return { message: `播放器不支援這個頻道的編碼（${codecs}）。請到 NVR 把編碼改成 H.264。`, fatal: true };
}
