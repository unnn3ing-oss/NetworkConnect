// floorplan 模組 stub（A0 建立）：只提供模組介面骨架，業務邏輯由 B4 實作。
// 圖檔存放於 path.join(ctx.dataDir, 'plans', plan.file)。
export default {
  name: 'floorplan',
  owns: ['plans', 'placements'],
  async check(ctx) {},
  async register(app, ctx) {},
  async start(ctx) {},
  async stop() {},
};
