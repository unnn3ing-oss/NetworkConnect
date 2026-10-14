// system 模組：健康檢查、模組狀態、伺服器設定（A0）
import fs from 'node:fs';
import { loadConfig, saveConfig } from '../../core/config.js';
import { validation } from '../../core/errors.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

const pick = (c) => ({ lanAccess: c.lanAccess, port: c.port, modules: { ...c.modules } });
const sameSettings = (a, b) =>
  a.lanAccess === b.lanAccess && a.port === b.port && Object.keys(a.modules).every((k) => a.modules[k] === b.modules[k]);

export default {
  name: 'system',
  owns: [],
  async check() {},
  async register(app, ctx) {
    const startedAt = ctx.startedAt ?? Date.now();

    app.get('/api/system/health', async () => ({
      ok: true,
      version: pkg.version,
      uptime: Math.round(Date.now() - startedAt) / 1000,
    }));

    app.get('/api/system/modules', async () => ctx.modules.list());

    // 設定：讀寫 <dataDir>/config.json 的 lanAccess、port、modules。
    // 這三項在伺服器啟動時才套用，所以與「啟動當下儲存的值」不同時 restartRequired 為 true。
    const atStart = pick(loadConfig(ctx.dataDir));
    const view = () => {
      const saved = pick(loadConfig(ctx.dataDir));
      return { ...saved, restartRequired: !sameSettings(saved, atStart) };
    };

    app.get('/api/system/settings', async () => view());

    app.put('/api/system/settings', async (req) => {
      ctx.validate('api-system#SettingsUpdate', req.body);
      const disk = loadConfig(ctx.dataDir);
      const { lanAccess, port, modules } = req.body;
      const next = {
        ...disk,
        lanAccess: lanAccess ?? disk.lanAccess,
        port: port ?? disk.port,
        modules: { ...disk.modules, ...(modules ?? {}) },
      };
      if (!Object.values(next.modules).some(Boolean)) {
        throw validation('至少要保留一個功能模組啟用', { modules: next.modules });
      }
      saveConfig(ctx.dataDir, next);
      return view();
    });
  },
  async start() {},
  async stop() {},
};
