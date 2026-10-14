// NetworkConnect 前端 shell：頂欄、主導覽、全站篩選列、模組掛載（含故障隔離）。
import { createApi } from './core/api.js';
import { createBus } from './core/bus.js';
import { createRouter, buildHash } from './core/router.js';
import { createFilters, filtersToQuery } from './core/filters.js';
import { createFilterBar } from './core/filterbar.js';
import { loadFrontModules, mountEntry } from './core/module-loader.js';
import { showLogin } from './core/login.js';
import { renderErrorCard } from './core/cards.js';

const DEFAULT_ROUTE = '#/dashboard';
const $ = (id) => document.getElementById(id);

async function main() {
  const overlay = $('nc-overlay');
  const nav = $('nc-nav');
  const outlet = $('nc-main');
  const conn = $('nc-conn');

  // ---- 核心物件 ----
  let loginShown = false;
  const api = createApi({
    onUnauthorized() {
      if (loginShown) return;
      loginShown = true;
      showLogin(overlay, api, () => window.location.reload());
    },
  });

  // 設定了存取密碼且尚未登入：先登入再往下走（否則 SSE 與所有 API 都是 401）
  try {
    const st = await api.get('/api/auth/status');
    if (st.enabled && !st.authenticated) {
      loginShown = true;
      await new Promise((resolve) => showLogin(overlay, api, resolve));
      loginShown = false;
    }
  } catch {
    // 伺服器暫時連不上：照常載入 shell，各模組會自己顯示錯誤
  }

  const bus = createBus();
  const router = createRouter();
  const filters = createFilters({ router, bus });
  // ctx.ui.load()＝用到才載入 web/ui 的元件：load() 取得 /ui/index.js 的全部匯出（toast、confirm、createWizard…），
  // load('toast') 則只載入單一檔案
  const ui = { load: (name = 'index') => import(`/ui/${name}.js`) };

  const entries = await loadFrontModules();
  let backend = [];
  const loadBackend = async () => {
    backend = await api.get('/api/system/modules').catch(() => []);
  };
  await loadBackend();

  const ctx = {
    api,
    bus,
    filters,
    ui,
    router,
    modules: entries.map((e) => ({ id: e.id, title: e.title, route: e.route, order: e.order, failed: Boolean(e.error) })),
  };

  // ---- 主導覽 ----
  const byPath = new Map(entries.map((e) => [e.route.slice(1), e]));
  const links = new Map();
  for (const entry of entries.filter((e) => e.nav)) {
    const a = document.createElement('a');
    a.className = 'nc-nav-link';
    a.textContent = entry.title;
    a.dataset.module = entry.id;
    if (entry.error) a.classList.add('is-failed');
    links.set(entry.id, a);
    nav.append(a);
  }
  const refreshNavLinks = () => {
    const query = filtersToQuery(filters.get());
    for (const entry of entries) {
      const a = links.get(entry.id);
      if (a) a.href = buildHash(entry.route.slice(1), query);
    }
  };
  refreshNavLinks();
  bus.on('filters.changed', refreshNavLinks);

  // ---- 篩選列與連線燈號 ----
  const filterbar = createFilterBar($('nc-filterbar'), { api, bus, filters });
  bus.on('sse.connected', () => { conn.dataset.state = 'connected'; conn.title = '即時連線正常'; });
  bus.on('sse.disconnected', () => { conn.dataset.state = 'disconnected'; conn.title = '即時連線中斷，重新連線中…'; });

  // ---- 路由與模組掛載 ----
  let mounted = { path: null, handle: null };
  let token = 0;

  async function showRoute() {
    const { path } = router.current();
    const entry = byPath.get(path);
    if (!entry) {
      router.navigate(DEFAULT_ROUTE, { replace: true });
      return;
    }
    if (mounted.path === path) return;

    const my = ++token;
    mounted.handle?.unmount();
    mounted = { path, handle: null };

    const el = document.createElement('section');
    el.className = 'nc-view';
    el.dataset.module = entry.id;
    outlet.replaceChildren(el);
    for (const [id, a] of links) {
      if (id === entry.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    filterbar.setVisible(entry.showFilters);
    document.title = `${entry.title} · NetworkConnect`;

    const handle = await mountEntry(entry, el, ctx, {
      backend,
      onRetry: async () => {
        await loadBackend();
        mounted = { path: null, handle: null };
        showRoute();
      },
    });
    if (my !== token) {
      handle.unmount(); // 掛載期間使用者已經切到別的分頁
      return;
    }
    mounted.handle = handle;
  }

  router.on(() => {
    showRoute();
  });
  bus.connectSse();
  filterbar.refresh();
  router.start();

  window.__NC__ = { api, bus, router, filters, entries, ctx };
}

main().catch((err) => {
  console.error('NetworkConnect 啟動失敗', err);
  const outlet = document.getElementById('nc-main');
  if (outlet) renderErrorCard(outlet, { title: 'NetworkConnect', message: err?.message ?? String(err), error: err, onRetry: () => window.location.reload() });
});
