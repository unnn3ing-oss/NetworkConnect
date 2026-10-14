// monitor 模組 stub（A0 建立）：只提供模組介面骨架，業務邏輯由 B2 實作。
// 偵測請使用 ctx.prober（mock 模式提供）或自己建立真實 prober。
export default {
  name: 'monitor',
  owns: ['statusHistory'],
  async check(ctx) {},
  async register(app, ctx) {},
  async start(ctx) {},
  async stop() {},
};
