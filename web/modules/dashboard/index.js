// dashboard 前端模組 stub（A0 建立）：業務邏輯由 C1 實作。請保留 id／route／order，替換 mount／unmount 即可。
export default {
  id: 'dashboard',
  title: '總覽',
  icon: 'dashboard',
  route: '#/dashboard',
  order: 10,
  showFilters: false,
  requires: [],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'nc-card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '總覽';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
