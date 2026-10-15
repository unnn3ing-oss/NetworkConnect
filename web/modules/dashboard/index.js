// dashboard 前端模組（C1）：總覽首頁。
//   - 狀態統計卡、離線的關鍵設備、各樓層設備數與上線率、快速入口
//   - 某個卡片依賴的後端模組停用（或載入失敗）時，該卡片整個隱藏，其他卡片照常
//   - 資料庫全空（沒有樓層、房間、設備、NVR）時自動轉到首次導覽（使用者離開過導覽後不再自動轉）
// 資料整理在 model.js（純函式）。所有文字一律以 textContent 插入。
import { criticalOffline, floorRows, isEmptyDb, moduleOk, OPTIONAL_STEPS, setupProgress, summarize } from './model.js';

const CSS_HREF = '/modules/dashboard/dashboard.css';
const DISMISS_KEY = 'nc.onboarding.dismissed';
const REFRESH_MS = 60_000; // 每分鐘校正一次，補漏掉的事件
const RENDER_DELAY_MS = 80; // 事件密集時合併成一次重畫

const STAT_CARDS = [
  { kind: 'total', label: '設備總數' },
  { kind: 'up', label: '上線' },
  { kind: 'down', label: '離線' },
  { kind: 'unknown', label: '未知' },
  { kind: 'disabled', label: '未偵測' },
];

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return el;
}

function ensureCss() {
  if (document.head.querySelector(`link[href="${CSS_HREF}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF }));
}

const wasDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

const fmtSince = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  if (mins < 1) return '剛剛離線';
  if (mins < 60) return `離線 ${mins} 分鐘`;
  if (mins < 24 * 60) return `離線 ${Math.floor(mins / 60)} 小時`;
  return `離線 ${Math.floor(mins / (24 * 60))} 天`;
};

/** 目前掛載中的狀態（unmount() 沒有參數，所以放在模組層） */
let active = null;

async function mount(el, ctx) {
  ensureCss();
  const { api, bus, router, filters } = ctx;
  const ui = await ctx.ui.load();
  const { icon, createStatusDot, toast } = ui;

  const me = { offs: [], timers: new Set(), gone: false, renderTimer: null };
  active = me;

  const fetchOr = async (path, fallback) => {
    try {
      return await api.get(path);
    } catch {
      return fallback;
    }
  };

  const data = { modules: [], floors: [], rooms: [], devices: [], categories: [], plans: [], nvrs: [], status: new Map() };

  async function load() {
    data.modules = await fetchOr('/api/system/modules', []);
    const ok = moduleOk(data.modules);
    const [floors, rooms, devices, categories, status, plans, nvrs] = await Promise.all([
      ok('inventory') ? fetchOr('/api/floors', []) : [],
      ok('inventory') ? fetchOr('/api/rooms', []) : [],
      ok('inventory') ? fetchOr('/api/devices', []) : [],
      ok('inventory') ? fetchOr('/api/categories', []) : [],
      ok('monitor') ? fetchOr('/api/status', []) : [],
      ok('floorplan') ? fetchOr('/api/plans', []) : [],
      ok('nvr') ? fetchOr('/api/nvrs', []) : [],
    ]);
    Object.assign(data, { floors, rooms, devices, categories, plans, nvrs });
    data.status = new Map(status.map((s) => [s.deviceId, s]));
  }

  try {
    await load();
  } catch (err) {
    if (active === me) toast?.error?.(err?.message ?? String(err));
  }
  if (active !== me) return; // 載入期間已經離開

  const ok = moduleOk(data.modules);
  if (ok('inventory') && isEmptyDb(data) && !wasDismissed()) {
    router.navigate('#/onboarding', { replace: true });
    return;
  }

  const root = h('div', { class: 'dsh' });
  el.replaceChildren(root);

  // ---------------------------------------------------------------- 各張卡片
  function statsCard() {
    const sum = summarize(data.devices, data.status);
    const wrap = h('section', { class: 'dsh-stats', 'aria-label': '狀態統計', dataset: { card: 'stats' } });
    for (const { kind, label } of STAT_CARDS) {
      wrap.append(
        h(
          'a',
          { class: 'dsh-stat', href: '#/status', dataset: { kind }, 'aria-label': `${label} ${sum[kind]}` },
          h('span', { class: 'dsh-stat-num', text: String(sum[kind]) }),
          h('span', { class: 'dsh-stat-label', text: label }),
        ),
      );
    }
    return wrap;
  }

  function criticalCard() {
    const rows = criticalOffline(data.devices, data.status);
    const card = h('section', { class: 'card', dataset: { card: 'critical' } });
    card.append(h('h3', { class: 'dsh-card-title' }, '離線的關鍵設備', h('span', { class: `dsh-badge${rows.length ? ' crit' : ''}`, text: String(rows.length) })));
    if (!rows.length) {
      card.append(h('p', { class: 'dsh-ok-line' }, icon('check', { size: 18 }), '所有關鍵設備都在線上'));
      return card;
    }
    const list = h('ul', { class: 'dsh-list' });
    for (const { device, since } of rows) {
      const btn = h(
        'button',
        { type: 'button', class: 'dsh-item', dataset: { deviceId: device.id }, on: { click: () => bus.emit('device.open', { id: device.id }) } },
        createStatusDot({ status: 'down', critical: true, showLabel: false }),
        h(
          'span',
          { class: 'dsh-item-main' },
          h('span', { class: 'dsh-item-name', text: device.name }),
          h('span', { class: 'dsh-item-meta', text: [device.ip, fmtSince(since)].filter(Boolean).join(' · ') }),
        ),
      );
      list.append(h('li', {}, btn));
    }
    card.append(list);
    return card;
  }

  function goDevices(floorId) {
    filters.set({ floorId, roomId: '' });
    router.navigate('#/devices');
  }

  function floorsCard() {
    const rows = floorRows(data.floors, data.devices, data.status);
    const card = h('section', { class: 'card', dataset: { card: 'floors' } });
    card.append(h('h3', { class: 'dsh-card-title' }, '各樓層設備'));
    if (!rows.length) {
      card.append(h('p', { class: 'dsh-muted', text: '還沒有樓層。到「設備」的分類管理新增後，這裡會顯示各樓層的上線率。' }));
      return card;
    }
    const list = h('ul', { class: 'dsh-floors' });
    for (const r of rows) {
      const bar = h('div', { class: `dsh-bar${r.rate !== null && r.rate < 50 ? ' bad' : r.rate !== null && r.rate < 100 ? ' warn' : ''}`, 'aria-hidden': 'true' }, h('i'));
      bar.firstElementChild.style.width = `${r.rate ?? 0}%`; // CSSOM 不受 CSP style-src 限制
      const btn = h(
        'button',
        {
          type: 'button', class: 'dsh-floor', dataset: { floorId: r.id },
          'aria-label': `${r.name}：${r.total} 台設備，${r.rate === null ? '無偵測資料' : `上線率 ${r.rate}%`}`,
          on: { click: () => goDevices(r.id) },
        },
        h('span', { class: 'dsh-floor-name', text: r.name }),
        h(
          'span',
          { class: 'dsh-floor-meta' },
          bar,
          h('span', { class: 'dsh-floor-count', text: `${r.total} 台${r.down ? ` · ${r.down} 離線` : ''}${r.unknown ? ` · ${r.unknown} 未知` : ''}` }),
        ),
        h('span', { class: 'dsh-floor-rate', text: r.rate === null ? '—' : `${r.rate}%` }),
      );
      list.append(h('li', {}, btn));
    }
    card.append(list);
    return card;
  }

  function quickCard() {
    const card = h('section', { class: 'card', dataset: { card: 'quick' } });
    card.append(h('h3', { class: 'dsh-card-title' }, '快速入口'));
    const row = h('div', { class: 'dsh-quick' });
    if (ok('inventory')) {
      row.append(
        h('a', { class: 'btn primary', href: '#/devices?new=1', dataset: { action: 'add-device' } }, icon('plus', { size: 16 }), '新增設備'),
        h('a', { class: 'btn', href: '#/topology' }, icon('layers', { size: 16 }), '看架構圖'),
      );
    }
    if (ok('floorplan')) row.append(h('a', { class: 'btn', href: '#/floorplan' }, icon('home', { size: 16 }), '看平面圖'));
    if (ok('nvr')) row.append(h('a', { class: 'btn', href: '#/cameras', dataset: { action: 'open-cameras' } }, icon('play', { size: 16 }), '看監視器'));
    card.append(row);
    return card;
  }

  function setupCard() {
    if (!ok('inventory')) return null;
    const steps = setupProgress(data, ok);
    const todo = steps.filter((s) => !s.done && !OPTIONAL_STEPS.has(s.id));
    if (!todo.length) return null;
    const first = steps.findIndex((s) => s.id === todo[0].id);
    const card = h('section', { class: 'card dsh-setup', dataset: { card: 'setup' } });
    card.append(
      h(
        'div',
        { class: 'dsh-setup-text' },
        h('h3', { text: '完成初始設定' }),
        h('p', { text: `還有 ${todo.length} 個必要步驟沒做：建立樓層、房間與核心設備後，架構圖和平面圖才會有內容。` }),
        h('div', { class: 'dsh-dots', 'aria-hidden': 'true' }, steps.map((s) => h('i', { class: s.done ? 'done' : '' }))),
      ),
      h('a', { class: 'btn primary', href: `#/onboarding?step=${first + 1}`, dataset: { action: 'resume-onboarding' } }, '繼續導覽'),
    );
    return card;
  }

  const hasStatus = () => ok('inventory') && ok('monitor');

  function render() {
    me.renderTimer = null;
    const parts = [
      h('header', { class: 'dsh-head' }, h('h2', { class: 'dsh-title', text: '總覽' }), h('p', { class: 'dsh-sub', text: '家裡網路的整體狀況' })),
      setupCard(),
      hasStatus() ? statsCard() : null,
    ];
    const cols = h('div', { class: 'dsh-cols' }, hasStatus() ? criticalCard() : null, hasStatus() ? floorsCard() : null);
    if (cols.children.length) parts.push(cols);
    if (ok('inventory') && !ok('monitor')) {
      // 沒有 monitor 時仍可看到各樓層設備數（沒有上線率）
      parts.push(h('div', { class: 'dsh-cols' }, floorsCard()));
    }
    parts.push(quickCard());
    root.replaceChildren(...parts.filter(Boolean));
  }
  const renderSoon = () => {
    if (me.gone || me.renderTimer) return;
    me.renderTimer = setTimeout(() => { if (!me.gone) render(); }, RENDER_DELAY_MS);
    me.timers.add(me.renderTimer);
  };

  // ---------------------------------------------------------------- 即時更新
  const reload = async () => {
    try {
      await load();
    } catch {
      return;
    }
    if (!me.gone) render();
  };
  me.offs.push(
    bus.on('status.changed', (p) => {
      const prev = data.status.get(p.deviceId);
      data.status.set(p.deviceId, { ...prev, deviceId: p.deviceId, state: p.to, rttMs: p.rttMs ?? null, lastChangeAt: p.at ?? prev?.lastChangeAt ?? null });
      renderSoon();
    }),
    bus.on('status.snapshot', (p) => {
      data.status = new Map((p.items ?? []).map((s) => [s.deviceId, s]));
      renderSoon();
    }),
    bus.on('inventory.changed', () => { reload(); }),
    bus.on('plan.changed', () => { reload(); }),
    bus.on('nvr.changed', () => { reload(); }),
  );
  const tick = setInterval(() => { reload(); }, REFRESH_MS);
  me.offs.push(() => clearInterval(tick));

  render();
}

function unmount() {
  const me = active;
  if (!me) return;
  active = null;
  me.gone = true;
  for (const off of me.offs) off();
  for (const t of me.timers) clearTimeout(t);
}

export default {
  id: 'dashboard',
  title: '總覽',
  icon: 'dashboard',
  route: '#/dashboard',
  order: 10,
  showFilters: false,
  requires: [],
  mount,
  unmount,
};
