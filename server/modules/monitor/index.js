// monitor 模組（B2）：背景偵測、狀態歷史、SSE 推播。規格 §8.1。
//   probers/    icmp／tcp／http 偵測（icmp 的平台參數與輸出解析是純函式）
//   scheduler.js 排程：間隔＋抖動、並發上限、睡眠恢復、暫停
//   state.js     狀態機（連續 3 次失敗才 down）
//   history.js   每台環狀 1440 筆、批次落檔
//   monitor.js   把以上接起來（所有外部依賴皆注入，測試用假時鐘＋假 prober）
import path from 'node:path';
import { validation } from '../../core/errors.js';
import { createProber, detectPing } from './probers/index.js';
import { createMonitor } from './monitor.js';
import { createSettings } from './settings.js';

/** ctx → 服務（同一個行程內可同時存在多個伺服器，例如測試） */
const services = new Map();
/** check() 的結果：本機 ping 是否可用 */
const pingByCtx = new WeakMap();

export default {
  name: 'monitor',
  owns: ['statusHistory'],

  /**
   * 啟動前自我檢查。ping 不可用時模組仍啟用（tcp／http 設備照常偵測），
   * 只有 icmp 設備標 unknown 並在狀態項目的 error 與 log 說明原因。
   */
  async check(ctx) {
    if (ctx.prober) {
      pingByCtx.set(ctx, { available: true }); // mock 模式：prober 由外部注入，不碰系統 ping
      return;
    }
    const ping = await detectPing();
    pingByCtx.set(ctx, ping);
    if (!ping.available) ctx.log?.warn?.(`monitor：${ping.reason}；ICMP 設備將顯示為「未知」`);
  },

  async register(app, ctx) {
    const settings = createSettings({ file: path.join(ctx.dataDir, 'monitor.json'), validate: ctx.validate, log: ctx.log });
    settings.load();
    const monitor = createMonitor({
      devices: ctx.store.collection('devices'),
      historyRepo: ctx.store.collection('statusHistory'),
      events: ctx.events,
      prober: ctx.prober ?? createProber(),
      settings,
      ping: pingByCtx.get(ctx) ?? { available: true },
      log: ctx.log,
    });
    services.set(ctx, monitor);

    app.get('/api/status', async () => monitor.listStatus());

    app.get('/api/status/:deviceId/history', async (req) => {
      const raw = req.query?.hours;
      const hours = raw === undefined ? 24 : Number(raw);
      ctx.validate('api-monitor#HistoryQuery', { hours });
      return monitor.history(req.params.deviceId, hours);
    });

    app.post('/api/status/:deviceId/check', async (req) => monitor.checkNow(req.params.deviceId));

    app.get('/api/monitor/settings', async () => monitor.getSettings());

    app.put('/api/monitor/settings', async (req) => {
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) throw validation('請求內容必須是 JSON 物件');
      ctx.validate('api-monitor#MonitorSettingsUpdate', body);
      return monitor.updateSettings(body);
    });
  },

  async start(ctx) {
    await services.get(ctx)?.start();
  },

  async stop() {
    const all = [...services.entries()];
    services.clear();
    for (const [, monitor] of all) await monitor.stop();
  },
};
