// status 前端模組 stub（A0 建立）：業務邏輯由 B2 實作。請保留 id／route／order，替換 mount／unmount 即可。
export default {
  id: 'status',
  title: '狀態',
  icon: 'status',
  route: '#/status',
  order: 60,
  requires: ['monitor'],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '狀態';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
