// cameras 前端模組 stub（A0 建立）：業務邏輯由 B5 實作。請保留 id／route／order，替換 mount／unmount 即可。
// go2rtc 前端元件已 vendored 在 /vendor/video-rtc.js、/vendor/video-stream.js（注意事項見 web/vendor/VERSIONS.md）。
export default {
  id: 'cameras',
  title: '監視器',
  icon: 'cameras',
  route: '#/cameras',
  order: 50,
  requires: ['nvr'],
  async mount(el, ctx) {
    const card = document.createElement('div');
    card.className = 'card nc-stub';
    const h = document.createElement('h2');
    h.className = 'nc-card-title';
    h.textContent = '監視器';
    const badge = document.createElement('span');
    badge.className = 'nc-stub-badge';
    badge.textContent = '建置中';
    card.append(h, badge);
    el.replaceChildren(card);
  },
  unmount() {},
};
