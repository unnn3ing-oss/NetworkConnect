// 狀態頁（B2）：上方統計（上線／離線／未知／未偵測），下方依樓層分組的設備燈號格，
// 離線的關鍵設備置頂；點設備 → bus 'device.open'；單台 24 小時可用率迷你條（純 SVG）。
// 資料整理在 model.js（純函式）；這裡負責取資料、畫面與事件。所有文字一律以 textContent 插入。
import { buildRows, summarize, groupByFloor, uptimeSummary, UPTIME_BUCKETS } from './model.js';

const CSS_HREF = '/modules/status/status.css';
const SVG_NS = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 60_000; // 每分鐘校正一次（補漏掉的事件、更新暫停橫幅）
const UPTIME_EVERY = 5; // 每 5 次校正重抓一次可用率
const UPTIME_WORKERS = 4;
const STATS = [
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

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 24 格迷你條；回傳 {svg, pct}。bars 用 class 上色（不使用行內樣式） */
function renderUptime(summary) {
  const pctText = summary.pct === null ? '—' : `${summary.pct}%`;
  const label = summary.pct === null ? '24 小時可用率：尚無資料' : `24 小時可用率 ${summary.pct}%`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'nc-uptime');
  svg.setAttribute('viewBox', `0 0 ${UPTIME_BUCKETS * 4 - 1} 12`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  summary.buckets.forEach((b, i) => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', `b-${b.state}`);
    r.setAttribute('x', String(i * 4));
    r.setAttribute('y', '0');
    r.setAttribute('width', '3');
    r.setAttribute('height', '12');
    r.setAttribute('rx', '1');
    svg.append(r);
  });
  return [svg, h('span', { class: 'nc-uptime-pct', text: pctText })];
}

const emptySummary = () => uptimeSummary([], Date.now());

function createView(el, ctx) {
  const { api, bus } = ctx;
  let destroyed = false;
  let ui = null;
  const offs = [];
  const timeouts = new Set();
  let interval = null;
  let ticks = 0;
  let reloadTimer = null;

  const state = {
    devices: [],
    floors: [],
    items: new Map(),
    uptime: new Map(),
    settings: null,
    error: null,
  };
  /** deviceId → 可用率欄位（render 後重建，給非同步更新使用） */
  let uptimeSlots = new Map();

  const root = h('section', { class: 'nc-status-page', 'aria-label': '連線狀態' });
  const banners = h('div', { class: 'nc-status-banners' });
  const stats = h('div', { class: 'nc-status-stats', role: 'group', 'aria-label': '連線統計' });
  const groupsEl = h('div', { class: 'nc-status-groups' });
  root.append(banners, stats, groupsEl);

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timeouts.delete(t);
      if (!destroyed) fn();
    }, ms);
    timeouts.add(t);
    return t;
  };

  // ---- 畫面 ----
  function renderBanners() {
    const list = [];
    const s = state.settings;
    if (s?.pausedUntil && Date.parse(s.pausedUntil) > Date.now()) {
      list.push(
        h('div', { class: 'nc-status-banner', dataset: { kind: 'paused' }, role: 'status' },
          h('span', { class: 'nc-status-banner-text', text: `偵測已暫停，預計 ${fmtTime(s.pausedUntil)} 自動恢復。` }),
          h('button', { type: 'button', class: 'btn small', text: '恢復偵測', on: { click: resume } })),
      );
    }
    if (s?.hint) {
      list.push(
        h('div', { class: 'nc-status-banner warn', dataset: { kind: 'hint' }, role: 'alert' },
          ui.icon('alert', { size: 18 }),
          h('span', { class: 'nc-status-banner-text', text: s.hint })),
      );
    }
    banners.replaceChildren(...list);
  }

  function renderStats(summary) {
    stats.replaceChildren(
      ...STATS.map(({ kind, label }) => {
        const sub = kind === 'down' && summary.criticalDown > 0 ? h('span', { class: 'nc-stat-sub', text: `關鍵設備 ${summary.criticalDown} 台` }) : null;
        return h('div', { class: 'nc-stat', dataset: { kind } },
          h('span', { class: 'nc-stat-num', text: String(summary[kind]) }),
          h('span', { class: 'nc-stat-label', text: label }),
          sub);
      }),
    );
  }

  function renderTile(row) {
    const { device, item, state: st, critical } = row;
    const dot = ui.createStatusDot({ status: st, critical, showLabel: true });
    const info = dot.dataset.state;
    const subParts = [device.ip || '未設定 IP'];
    if (st === 'up' && typeof item?.rttMs === 'number') subParts.push(`${item.rttMs} ms`);
    const sub = h('div', { class: 'nc-tile-sub', text: subParts.join(' · ') });
    const note = st === 'unknown' && item?.error ? h('div', { class: 'nc-tile-note', text: item.error }) : null;

    const slot = h('div', { class: 'nc-uptime-slot' });
    if (st !== 'disabled') {
      slot.append(...renderUptime(state.uptime.get(device.id) ?? emptySummary()));
      uptimeSlots.set(device.id, slot);
    } else {
      slot.append(h('span', { class: 'nc-uptime-off', text: '未偵測' }));
    }
    return h('button', {
      type: 'button',
      class: 'nc-tile',
      dataset: { deviceId: device.id, state: info },
      'aria-label': `${device.name}，${dot.querySelector('.nc-status-label')?.textContent ?? ''}`,
    },
    h('div', { class: 'nc-tile-head' }, dot, critical ? h('span', { class: 'nc-tile-critical', text: '關鍵', title: '關鍵設備' }) : null),
    h('div', { class: 'nc-tile-name', text: device.name }),
    sub, note, slot);
  }

  function renderGroups(rows) {
    uptimeSlots = new Map();
    if (state.devices.length === 0) {
      groupsEl.replaceChildren(
        ui.createEmpty({
          icon: 'inventory',
          title: '還沒有設備',
          description: '先到「設備」頁新增設備，這裡就會顯示它們的連線狀態。',
          actionLabel: '前往設備',
          onAction: () => {
            location.hash = '#/devices';
          },
        }),
      );
      return;
    }
    if (rows.length === 0) {
      groupsEl.replaceChildren(ui.createEmpty({ icon: 'search', title: '沒有符合篩選條件的設備', description: '調整上方的篩選列，或清除關鍵字。' }));
      return;
    }
    const groups = groupByFloor(rows, state.floors);
    groupsEl.replaceChildren(
      ...groups.map((g) =>
        h('section', { class: 'nc-status-group', dataset: { floorId: g.id } },
          h('div', { class: 'nc-status-group-head' },
            h('h2', { class: 'nc-status-group-title' }, g.name, h('span', { class: 'nc-status-group-count', text: ` ${g.rows.length} 台` })),
            g.summary.down > 0
              ? h('span', { class: `nc-status-group-badge${g.summary.criticalDown > 0 ? ' crit' : ''}`, text: `${g.summary.down} 台離線` })
              : null),
          h('div', { class: 'nc-status-grid' }, g.rows.map(renderTile))),
      ),
    );
  }

  function render() {
    if (destroyed || !ui) return;
    const focusId = document.activeElement?.dataset?.deviceId;
    const rows = buildRows(state.devices, [...state.items.values()], ctx.filters.get());
    renderBanners();
    renderStats(summarize(rows));
    renderGroups(rows);
    if (focusId) [...groupsEl.querySelectorAll('.nc-tile')].find((t) => t.dataset.deviceId === focusId)?.focus?.();
  }

  function showError(err) {
    if (destroyed || !ui) return;
    banners.replaceChildren();
    stats.replaceChildren();
    groupsEl.replaceChildren(
      ui.createEmpty({
        icon: 'alert',
        title: '無法載入連線狀態',
        description: err?.message || '請確認程式仍在執行後再試一次。',
        actionLabel: '重試',
        onAction: () => load(),
      }),
    );
  }

  // ---- 資料 ----
  async function fetchAll() {
    const [devices, floors, items, settings] = await Promise.all([
      api.get('/api/devices'),
      api.get('/api/floors'),
      api.get('/api/status'),
      api.get('/api/monitor/settings').catch(() => null),
    ]);
    if (destroyed) return false;
    state.devices = devices ?? [];
    state.floors = floors ?? [];
    state.items = new Map((items ?? []).map((i) => [i.deviceId, i]));
    state.settings = settings;
    return true;
  }

  async function load() {
    try {
      if (!(await fetchAll())) return;
      render();
      queueUptime(state.devices.filter((d) => d.monitor?.method !== 'none').map((d) => d.id));
    } catch (err) {
      showError(err);
    }
  }

  // 24 小時可用率：限制同時 4 個請求，結果只更新該台的欄位（不重畫整頁）
  let uptimeQueue = [];
  let uptimeActive = 0;
  function queueUptime(ids) {
    for (const id of ids) if (!uptimeQueue.includes(id)) uptimeQueue.push(id);
    pumpUptime();
  }
  function pumpUptime() {
    while (!destroyed && uptimeActive < UPTIME_WORKERS && uptimeQueue.length) {
      const id = uptimeQueue.shift();
      uptimeActive += 1;
      api
        .get(`/api/status/${encodeURIComponent(id)}/history`, { query: { hours: 24 } })
        .then((res) => {
          if (destroyed) return;
          const summary = uptimeSummary(res.samples, Date.now());
          state.uptime.set(id, summary);
          uptimeSlots.get(id)?.replaceChildren(...renderUptime(summary));
        })
        .catch(() => {})
        .finally(() => {
          uptimeActive -= 1;
          pumpUptime();
        });
    }
  }

  async function resume() {
    try {
      state.settings = await api.put('/api/monitor/settings', { pausedUntil: null });
      if (!destroyed) renderBanners();
    } catch (err) {
      ui.toast?.error?.(err?.message ?? '無法恢復偵測');
    }
  }

  async function refresh() {
    ticks += 1;
    try {
      if (!(await fetchAll())) return;
      render();
      if (ticks % UPTIME_EVERY === 0) queueUptime(state.devices.filter((d) => d.monitor?.method !== 'none').map((d) => d.id));
    } catch {
      // 下一輪再試；畫面維持目前內容
    }
  }

  // ---- 事件 ----
  function onChanged(p) {
    if (!p?.deviceId) return;
    const prev = state.items.get(p.deviceId) ?? { deviceId: p.deviceId, consecutiveFailures: 0 };
    state.items.set(p.deviceId, { ...prev, state: p.to, rttMs: p.rttMs ?? null, lastCheckAt: p.at, lastChangeAt: p.at });
    render();
    later(() => queueUptime([p.deviceId]), 1000);
  }

  function onInventory(p) {
    if (p?.collection !== 'devices' && p?.collection !== 'floors') return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = later(() => {
      reloadTimer = null;
      load();
    }, 150);
  }

  return {
    async start() {
      ensureCss();
      const [dotMod, emptyMod, iconMod, toastMod] = await Promise.all([
        ctx.ui.load('status-dot'),
        ctx.ui.load('empty'),
        ctx.ui.load('icons'),
        ctx.ui.load('toast').catch(() => ({})),
      ]);
      if (destroyed) return;
      ui = { createStatusDot: dotMod.createStatusDot, createEmpty: emptyMod.createEmpty, icon: iconMod.icon, toast: toastMod.toast };
      el.replaceChildren(root);

      offs.push(
        bus.on('status.changed', onChanged),
        bus.on('status.snapshot', (p) => {
          state.items = new Map((p?.items ?? []).map((i) => [i.deviceId, i]));
          render();
        }),
        bus.on('inventory.changed', onInventory),
        bus.on('filters.changed', render),
      );
      groupsEl.addEventListener('click', (e) => {
        const tile = e.target.closest?.('.nc-tile');
        if (tile) bus.emit('device.open', { id: tile.dataset.deviceId });
      });
      interval = setInterval(refresh, REFRESH_MS);
      await load();
    },

    destroy() {
      destroyed = true;
      for (const off of offs.splice(0)) off();
      if (interval !== null) clearInterval(interval);
      interval = null;
      for (const t of timeouts) clearTimeout(t);
      timeouts.clear();
      uptimeQueue = [];
      el.replaceChildren();
    },
  };
}

let active = null;

export default {
  id: 'status',
  title: '狀態',
  icon: 'status',
  route: '#/status',
  order: 60,
  requires: ['monitor'],

  async mount(el, ctx) {
    active?.destroy();
    const view = createView(el, ctx);
    active = view;
    await view.start();
  },

  unmount() {
    active?.destroy();
    active = null;
  },
};
