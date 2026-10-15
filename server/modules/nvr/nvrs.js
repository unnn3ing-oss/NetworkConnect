// nvrs 的業務邏輯：CRUD、密碼（secrets）、go2rtc 串流註冊、測試連線、WS 白名單。
// 路由層（index.js）只負責驗證請求格式與轉成 HTTP。
import { nanoid } from 'nanoid';
import { notFound, validation } from '../../core/errors.js';
import {
  buildStreamUrl, getTemplate, isRtspTemplate, isValidHost, loadTemplates, parseStreamName, redactUrls, streamName,
} from './templates.js';

/** 複製貼上常多帶前後空白或換行：先去掉（go2rtc 遇到空白會拒絕） */
const trimTemplate = (t) => (typeof t === 'string' ? t.trim() : t);

const nowSecretKey = (id) => `nvr:${id}`;

const H265_WARNING = '偵測到 H.265。瀏覽器對 H.265 支援不穩，請將 NVR 的子碼流改為 H.264 後再試。';

/** 探測失敗 → 給使用者看的原因（區分：連不到主機、帳密錯誤、逾時、其他） */
export function describeProbeFailure(result, nvr) {
  const where = `${nvr.host}:${nvr.port}`;
  switch (result.reason) {
    case 'auth':
      return '帳號或密碼錯誤（RTSP 401）。請確認帳號、密碼，以及該帳號有權限觀看即時影像。';
    case 'unreachable':
      return `連不到主機 ${where}。請確認 NVR 已開機、IP 與 RTSP 埠正確，且與這台電腦在同一個網路。`;
    case 'timeout':
      return '逾時：8 秒內沒有收到影像。請確認 RTSP 埠、頻道編號與碼流設定是否正確。';
    default:
      return `無法取得影像：${redactUrls(result.error || '未知原因')}`;
  }
}

/** 補齊 1..N 頻道（保留已有的設定）、移除超過 N 的頻道 */
export function normalizeChannels(existing, count) {
  const byCh = new Map((existing ?? []).filter((c) => c.ch <= count).map((c) => [c.ch, c]));
  const out = [];
  for (let ch = 1; ch <= count; ch++) {
    out.push(byCh.get(ch) ?? { ch, name: `頻道 ${ch}`, deviceId: null, enabled: true });
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.ctx          模組 ctx（store、secrets、events、validate、config、log）
 * @param {ReturnType<import('./go2rtc-client.js').createGo2rtcClient>} deps.client
 */
export function createNvrService({ ctx, client }) {
  const log = ctx.log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const nvrs = () => ctx.store.collection('nvrs');
  const devices = () => ctx.store.collection('devices');
  const mode = () => (ctx.config.go2rtcPath ? 'managed' : 'external');

  // 所有寫入與註冊依序執行：檢查與寫入之間、註冊與刪除之間不會互相插隊
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const view = (nvr) => ({ ...nvr, hasPassword: ctx.secrets.has(nowSecretKey(nvr.id)) });

  // ---------------------------------------------------------------- 串流註冊
  function desiredStreams(nvr) {
    const password = ctx.secrets.get(nowSecretKey(nvr.id)) ?? '';
    const out = [];
    for (const c of nvr.channels) {
      for (const kind of ['main', 'sub']) {
        try {
          out.push({ name: streamName(nvr.id, c.ch, kind), src: buildStreamUrl(nvr, password, c.ch, kind) });
        } catch (err) {
          log.warn(`NVR ${nvr.id} 頻道 ${c.ch} 的 ${kind} URL 無法產生：${err.message}`);
        }
      }
    }
    return out;
  }

  /** 註冊某個 NVR 的全部串流；previous 是異動前的紀錄，用來移除不再存在的頻道 */
  async function syncNvr(nvr, previous = null) {
    const wanted = desiredStreams(nvr);
    const names = new Set(wanted.map((s) => s.name));
    try {
      if (previous) {
        for (const c of previous.channels) {
          for (const kind of ['main', 'sub']) {
            const name = streamName(previous.id, c.ch, kind);
            if (!names.has(name)) await client.removeStream(name);
          }
        }
      }
      for (const s of wanted) await client.upsertStream(s.name, s.src);
      return true;
    } catch (err) {
      log.warn(`註冊 NVR ${nvr.id} 的串流失敗：${redactUrls(err.message)}`);
      return false;
    }
  }

  async function removeNvrStreams(nvr) {
    try {
      for (const c of nvr.channels) {
        for (const kind of ['main', 'sub']) await client.removeStream(streamName(nvr.id, c.ch, kind));
      }
    } catch (err) {
      log.warn(`移除 NVR ${nvr.id} 的串流失敗：${redactUrls(err.message)}`);
    }
  }

  /** 重新註冊全部（啟動、go2rtc 重啟或恢復連線後呼叫；go2rtc 重啟後串流會消失） */
  function syncAll() {
    return serial(async () => {
      const all = await nvrs().list();
      const wanted = new Map();
      for (const nvr of all) for (const s of desiredStreams(nvr)) wanted.set(s.name, s.src);
      try {
        const existing = await client.listStreams();
        for (const name of Object.keys(existing)) {
          if (name.startsWith('nvr_') && !wanted.has(name)) await client.removeStream(name);
        }
        for (const [name, src] of wanted) {
          if (existing[name]?.producers?.some((p) => p.url === src)) continue;
          await client.upsertStream(name, src);
        }
        return wanted.size;
      } catch (err) {
        log.warn(`重新註冊串流失敗：${redactUrls(err.message)}`);
        return 0;
      }
    });
  }

  /** go2rtc 目前是否缺少應註冊的串流（go2rtc 被外部重啟、串流被清掉時為 true） */
  async function hasMissingStreams() {
    const wanted = [];
    for (const nvr of await nvrs().list()) for (const s of desiredStreams(nvr)) wanted.push(s.name);
    if (!wanted.length) return false;
    const existing = await client.listStreams();
    return wanted.some((name) => !(name in existing));
  }

  // ---------------------------------------------------------------- 驗證規則
  async function checkRules(record) {
    if (!isValidHost(record.host)) throw validation('主機位址格式不正確（只能是 IP 或網域名稱）');
    if (record.brand === 'custom' && !isRtspTemplate(record.urlTemplate)) {
      throw validation('自訂 URL 必須以 rtsp:// 或 rtsps:// 開頭');
    }
    if (record.brand === 'custom' && /\s/.test(record.urlTemplate)) {
      throw validation('自訂 RTSP 網址中間不能有空白或換行，請檢查複製貼上時有沒有多帶到');
    }
    const seen = new Set();
    for (const c of record.channels) {
      if (c.ch > record.channelCount) throw validation(`頻道 ${c.ch} 超過頻道數 ${record.channelCount}`);
      if (seen.has(c.ch)) throw validation(`頻道 ${c.ch} 重複`);
      seen.add(c.ch);
    }
    for (const id of new Set([record.deviceId, ...record.channels.map((c) => c.deviceId)].filter(Boolean))) {
      if (!(await devices().get(id))) throw validation(`找不到設備 ${id}`);
    }
    try {
      if (record.channels.length) buildStreamUrl(record, 'x', record.channels[0].ch, 'sub');
    } catch (err) {
      throw validation(`RTSP URL 範本不正確：${err.message}`);
    }
  }

  const emitChanged = (id) => ctx.events.emit('nvr.changed', { id });

  // ---------------------------------------------------------------- CRUD
  return {
    mode,
    view,
    syncAll,
    syncNvr,
    hasMissingStreams,

    templates: () => loadTemplates(),

    async list() {
      return (await nvrs().list()).map(view);
    },

    async get(id) {
      const nvr = await nvrs().get(id);
      if (!nvr) throw notFound('找不到 NVR');
      return view(nvr);
    },

    create(body) {
      return serial(async () => {
        const tpl = getTemplate(body.brand);
        const record = {
          id: `nvr_${nanoid(10)}`,
          deviceId: body.deviceId ?? null,
          name: body.name,
          brand: body.brand,
          host: body.host,
          port: body.port ?? tpl.defaultPort,
          username: body.username,
          channelCount: body.channelCount,
          streamMain: body.streamMain ?? tpl.streamMain,
          streamSub: body.streamSub ?? tpl.streamSub,
          urlTemplate: body.brand === 'custom' ? trimTemplate(body.urlTemplate) : null,
          channels: body.channels
            ? [...body.channels].sort((a, b) => a.ch - b.ch).map((c) => ({ ch: c.ch, name: c.name ?? '', deviceId: c.deviceId ?? null, enabled: c.enabled ?? true }))
            : normalizeChannels([], body.channelCount),
        };
        await checkRules(record);
        await ctx.secrets.set(nowSecretKey(record.id), body.password);
        let saved;
        try {
          saved = await nvrs().insert(record);
        } catch (err) {
          await ctx.secrets.delete(nowSecretKey(record.id));
          throw err;
        }
        await syncNvr(saved);
        emitChanged(saved.id);
        return view(saved);
      });
    },

    patch(id, body) {
      return serial(async () => {
        const cur = await nvrs().get(id);
        if (!cur) throw notFound('找不到 NVR');
        const { password, ...fields } = body;
        const next = { ...cur, ...fields };
        if (fields.brand && fields.brand !== cur.brand) {
          const tpl = getTemplate(fields.brand);
          next.port = fields.port ?? tpl.defaultPort;
          next.streamMain = fields.streamMain ?? tpl.streamMain;
          next.streamSub = fields.streamSub ?? tpl.streamSub;
        }
        next.urlTemplate = next.brand === 'custom' ? trimTemplate(fields.urlTemplate ?? cur.urlTemplate) : null;
        next.deviceId ??= null;
        if (fields.channels) {
          next.channels = [...fields.channels].sort((a, b) => a.ch - b.ch).map((c) => ({ ch: c.ch, name: c.name ?? '', deviceId: c.deviceId ?? null, enabled: c.enabled ?? true }));
        } else if (fields.channelCount !== undefined && fields.channelCount !== cur.channelCount) {
          next.channels = normalizeChannels(cur.channels, fields.channelCount);
        }
        await checkRules(next);

        if (typeof password === 'string') await ctx.secrets.set(nowSecretKey(id), password);
        else if (password === null) await ctx.secrets.delete(nowSecretKey(id));

        const saved = await nvrs().update(id, next);
        await syncNvr(saved, cur);
        emitChanged(id);
        return view(saved);
      });
    },

    remove(id) {
      return serial(async () => {
        const cur = await nvrs().get(id);
        if (!cur) throw notFound('找不到 NVR');
        await removeNvrStreams(cur);
        await nvrs().remove(id);
        await ctx.secrets.delete(nowSecretKey(id));
        emitChanged(id);
      });
    },

    /** 設備被刪除：清掉 NVR 與頻道對它的連結（契約 api.md：收到 devices 的 delete 後各自清理） */
    unlinkDevice(deviceId) {
      return serial(async () => {
        for (const nvr of await nvrs().list()) {
          const touched = nvr.deviceId === deviceId || nvr.channels.some((c) => c.deviceId === deviceId);
          if (!touched) continue;
          await nvrs().update(nvr.id, {
            deviceId: nvr.deviceId === deviceId ? null : nvr.deviceId,
            channels: nvr.channels.map((c) => (c.deviceId === deviceId ? { ...c, deviceId: null } : c)),
          });
          emitChanged(nvr.id);
        }
      });
    },

    // ---------------------------------------------------------------- 測試連線
    async test(id, channel = 1) {
      const nvr = await nvrs().get(id);
      if (!nvr) throw notFound('找不到 NVR');
      if (!nvr.channels.some((c) => c.ch === channel)) throw validation(`頻道 ${channel} 不存在`);
      const name = streamName(id, channel, 'sub');
      const src = buildStreamUrl(nvr, ctx.secrets.get(nowSecretKey(id)) ?? '', channel, 'sub');
      await serial(() => client.upsertStream(name, src)); // go2rtc 本身不可用 → UPSTREAM
      const r = await client.probe(name); // 同上
      if (!r.ok) return { ok: false, error: describeProbeFailure(r, nvr) };
      const out = { ok: true, codec: r.codec };
      if (r.codec === 'h265') out.warning = H265_WARNING;
      return out;
    },

    // ---------------------------------------------------------------- WS 白名單
    /** 只有本系統註冊過（存在於 nvrs 紀錄）的串流名稱可以被代理，避免被當成任意 RTSP／go2rtc 代理 */
    async isAllowedStream(name) {
      const parsed = parseStreamName(name);
      if (!parsed) return false;
      const nvr = await nvrs().get(parsed.nvrId);
      return Boolean(nvr?.channels.some((c) => c.ch === parsed.ch));
    },

    /** go2rtc 狀態 */
    async status() {
      try {
        const info = await client.info({ timeout: 1500 });
        const out = { running: true, version: typeof info?.version === 'string' ? info.version : null, mode: mode() };
        // 串流數只是附加資訊，查不到不影響 running 判斷
        const streams = await client.listStreams().catch(() => null);
        if (streams) out.streams = Object.keys(streams).filter((n) => n.startsWith('nvr_')).length;
        return out;
      } catch {
        return { running: false, version: null, mode: mode() };
      }
    },
  };
}
