// system 模組：健康檢查與模組狀態（A0）
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

export default {
  name: 'system',
  owns: [],
  async check() {},
  async register(app, ctx) {
    const startedAt = ctx.startedAt ?? Date.now();

    app.get('/api/system/health', async () => ({
      ok: true,
      version: pkg.version,
      uptime: Math.round((Date.now() - startedAt)) / 1000,
    }));

    app.get('/api/system/modules', async () => ctx.modules.list());
  },
  async start() {},
  async stop() {},
};
