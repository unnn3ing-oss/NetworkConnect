// topology 前端模組（B3）：網路架構圖。業務邏輯見 graph.js（純函式）、style.js（Cytoscape 樣式）、view.js（畫面）。
// 保留 id／route／order；unmount() 會銷毀 Cytoscape 並解除所有訂閱。
let active = null;

export default {
  id: 'topology',
  title: '架構圖',
  icon: 'topology',
  route: '#/topology',
  order: 30,
  requires: ['inventory'],
  async mount(el, ctx) {
    const me = { view: null, gone: false };
    active = me;
    const { createTopologyView } = await import('./view.js');
    const view = await createTopologyView(el, ctx);
    if (me.gone) {
      view.destroy(); // 載入期間已經離開
      return;
    }
    me.view = view;
  },
  unmount() {
    if (!active) return;
    active.gone = true;
    active.view?.destroy();
    active = null;
  },
};
