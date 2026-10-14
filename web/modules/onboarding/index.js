// onboarding 前端模組 stub（A0 建立）：業務邏輯由 C1 實作。請保留 id／route／order，替換 mount／unmount 即可。
// nav:false＝不顯示在主導覽（由資料庫為空時自動開啟，或從設定頁進入）。
export default {
  id: 'onboarding',
  title: '首次導覽',
  icon: 'onboarding',
  route: '#/onboarding',
  order: 99,
  nav: false,
  showFilters: false,
  requires: [],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'nc-card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '首次導覽';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
