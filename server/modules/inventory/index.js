// inventory 模組 stub（A0 建立），業務邏輯由 B1 實作；B1 直接整檔取代即可，不需要改 module-loader。
// 請保留 name 與 owns。
//
// 這裡只多放了四個「唯讀列表」路由（直接回 store 內容，未排序、未驗證 query），
// 讓前端 shell 的全站篩選列在 mock 模式下有資料可顯示，也避免 shell 載入時出現 404。
export default {
  name: 'inventory',
  owns: ['floors', 'rooms', 'groups', 'categories', 'devices'],
  async check(ctx) {},
  async register(app, ctx) {
    for (const [path, collection] of [['/api/floors', 'floors'], ['/api/rooms', 'rooms'], ['/api/groups', 'groups'], ['/api/categories', 'categories']]) {
      app.get(path, async () => ctx.store.collection(collection).list());
    }
  },
  async start(ctx) {},
  async stop() {},
};
