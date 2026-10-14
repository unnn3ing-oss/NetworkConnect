// topology 前端模組 stub（A0 建立）：業務邏輯由 B3 實作。請保留 id／route／order，替換 mount／unmount 即可。
// Cytoscape 已 vendored 在 /vendor/cytoscape.min.js。
export default {
  id: 'topology',
  title: '架構圖',
  icon: 'topology',
  route: '#/topology',
  order: 30,
  requires: ['inventory'],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '架構圖';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
