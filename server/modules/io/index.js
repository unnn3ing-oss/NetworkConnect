// io 模組 stub（A0 建立）：只提供模組介面骨架，業務邏輯由 B1 實作。
// io 不擁有任何 collection；整批匯入透過 ctx.store.restore(snapshot)（規格 §7 唯一例外）。
export default {
  name: 'io',
  owns: [],
  async check(ctx) {},
  async register(app, ctx) {},
  async start(ctx) {},
  async stop() {},
};
