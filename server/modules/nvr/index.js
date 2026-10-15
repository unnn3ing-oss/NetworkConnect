// nvr 模組（B5）：NVR 設定、go2rtc 生命週期、串流註冊、測試連線、MSE WebSocket 代理。
// 契約：contracts/api.md §6。go2rtc 位置：ctx.config.go2rtcPath（受管）或 ctx.config.go2rtcUrl（外部／mock 的假 go2rtc）。
//
// 檔案：
//   templates.js        品牌 RTSP 模板、URL 組裝、串流名稱
//   go2rtc-process.js   go2rtc.yaml、pid 檔、自動重啟、結束行程
//   go2rtc-client.js    go2rtc REST／WebSocket 用戶端（upsertStream、removeStream、probe）
//   nvrs.js             CRUD、密碼、串流註冊、測試連線、白名單
//   ws-proxy.js         /api/nvr/ws 反向代理
//   rtsp-fix-proxy.js   RTSP 相容代理（修正把影像軌標成 sendonly 的 NVR；只用於自訂品牌＋受管 go2rtc）
import path from 'node:path';
import { createGo2rtcClient } from './go2rtc-client.js';
import { apiListenFromUrl, createGo2rtcProcess } from './go2rtc-process.js';
import { createNvrService } from './nvrs.js';
import { createRtspFixProxy } from './rtsp-fix-proxy.js';
import { registerWsProxy } from './ws-proxy.js';

export const NOTE_DOWN = '串流服務未啟動';
/** 健康檢查間隔（測試可用 NC_NVR_HEALTH_MS 縮短） */
const healthIntervalMs = () => Number(process.env.NC_NVR_HEALTH_MS) || 5000;
const READY_TIMEOUT_MS = 10_000;

/** ctx → 狀態（同一個行程內可同時存在多個伺服器，例如測試） */
const states = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getState(ctx) {
  let st = states.get(ctx);
  if (st) return st;
  const client = createGo2rtcClient({ baseUrl: ctx.config.go2rtcUrl });
  const managed = Boolean(ctx.config.go2rtcPath);
  // RTSP 相容代理只在受管模式（go2rtc 與本伺服器在同一台電腦）使用：go2rtc 要連得到 127.0.0.1 的代理埠
  const rtspFix = managed ? createRtspFixProxy({ log: ctx.log }) : null;
  const service = createNvrService({ ctx, client, rtspFix });
  st = { ctx, client, service, managed, rtspFix, proc: null, wsProxy: null, timer: null, offs: [], running: null, started: false };
  if (managed) {
    st.proc = createGo2rtcProcess({
      binPath: ctx.config.go2rtcPath,
      dir: path.join(ctx.dataDir, 'go2rtc'),
      apiListen: apiListenFromUrl(ctx.config.go2rtcUrl),
      log: ctx.log,
      onRestart: () => {
        waitReady(st, 8000).then((ok) => ok && service.syncAll()).catch(() => {});
      },
    });
  }
  states.set(ctx, st);
  return st;
}

/** 輪詢到 go2rtc 回應為止 */
async function waitReady(st, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await st.client.info({ timeout: 500 });
      return true;
    } catch {
      // 還沒起來
    }
    if (Date.now() >= deadline || st.proc?.state === 'failed') return false;
    await sleep(200);
  }
}

/** 更新「串流服務未啟動」提示；從連不上變成連得上時重新註冊全部串流 */
async function refreshHealth(st) {
  if (st.checking) return;
  st.checking = true;
  try {
    await refreshHealthOnce(st);
  } finally {
    st.checking = false;
  }
}

async function refreshHealthOnce(st) {
  const { running } = await st.service.status();
  const was = st.running;
  st.running = running;
  st.ctx.modules?.setNote?.(running ? null : NOTE_DOWN);
  if (running && was === false) await st.service.syncAll();
  // go2rtc 被外部重啟（串流清空）時補註冊
  else if (running && (await st.service.hasMissingStreams().catch(() => false))) await st.service.syncAll();
}

export default {
  name: 'nvr',
  owns: ['nvrs'],

  /** 連不到 go2rtc 時模組仍啟用，只是 /api/system/modules 的 note 顯示「串流服務未啟動」 */
  async check(ctx) {
    const st = getState(ctx);
    if (st.managed) return; // 受管模式：go2rtc 要等 start() 才會啟動
    await refreshHealth(st).catch(() => {});
  },

  async register(app, ctx) {
    const st = getState(ctx);
    const { service } = st;

    app.get('/api/nvr/templates', async () => service.templates());

    app.get('/api/nvrs', async () => service.list());

    app.post('/api/nvrs', async (req, reply) => {
      const body = ctx.validate('api-nvr#NvrCreate', req.body);
      return reply.code(201).send(await service.create(body));
    });

    app.patch('/api/nvrs/:id', async (req) => {
      const body = ctx.validate('api-nvr#NvrPatch', req.body);
      return service.patch(req.params.id, body);
    });

    app.delete('/api/nvrs/:id', async (req, reply) => {
      await service.remove(req.params.id);
      return reply.code(204).send();
    });

    app.post('/api/nvrs/:id/test', async (req) => {
      const body = ctx.validate('api-nvr#NvrTestRequest', req.body ?? {});
      return service.test(req.params.id, body.channel ?? 1);
    });

    app.get('/api/nvr/status', async () => service.status());

    st.wsProxy = registerWsProxy(app, {
      isAllowed: (name) => service.isAllowedStream(name),
      go2rtcUrl: ctx.config.go2rtcUrl,
      log: ctx.log,
    });
  },

  async start(ctx) {
    const st = getState(ctx);
    st.started = true;

    // 刪除設備時清掉 NVR／頻道對它的連結
    st.offs.push(
      ctx.events.on('inventory.changed', (ev) => {
        if (ev?.collection === 'devices' && ev.op === 'delete') {
          st.service.unlinkDevice(ev.id).catch((err) => ctx.log?.warn?.(`清理設備連結失敗：${err.message}`));
        }
      }),
    );

    if (st.proc) {
      try {
        await st.proc.start();
      } catch (err) {
        ctx.log?.error?.(`go2rtc 啟動失敗：${err.message}`);
      }
      await waitReady(st, READY_TIMEOUT_MS);
    }
    st.running = null;
    await refreshHealth(st).catch(() => {});
    if (st.running) await st.service.syncAll(); // go2rtc 重啟後串流會消失，每次啟動都重新註冊
    st.running = (await st.service.status()).running;

    st.timer = setInterval(() => refreshHealth(st).catch(() => {}), healthIntervalMs());
    st.timer.unref?.();
  },

  async stop() {
    const all = [...states.values()];
    states.clear();
    for (const st of all) {
      clearInterval(st.timer);
      for (const off of st.offs) off();
      st.wsProxy?.closeAll();
      await st.proc?.stop(); // 必須確實結束 go2rtc（Windows 不會隨父行程結束）
      await st.rtspFix?.close();
    }
  },
};
