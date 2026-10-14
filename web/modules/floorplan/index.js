// floorplan 前端模組 stub（A0 建立）：業務邏輯由 B4 實作。請保留 id／route／order，替換 mount／unmount 即可。
export default {
  id: 'floorplan',
  title: '平面圖',
  icon: 'floorplan',
  route: '#/floorplan',
  order: 40,
  requires: ['inventory', 'floorplan'],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'nc-card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '平面圖';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
