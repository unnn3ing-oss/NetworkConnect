// nvr 模組 stub（A0 建立）：只提供模組介面骨架，業務邏輯由 B5 實作。
// go2rtc 位置：ctx.config.go2rtcPath（受管）或 ctx.config.go2rtcUrl（外部／mock 的假 go2rtc）。
export default {
  name: 'nvr',
  owns: ['nvrs'],
  async check(ctx) {},
  async register(app, ctx) {},
  async start(ctx) {},
  async stop() {},
};
