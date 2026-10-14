// 設備列表：卡片／表格兩種檢視、依全站篩選、排序、每列狀態燈（即時更新）。
import { h, prefs } from './dom.js';
import { matchDevice } from '../../core/filters.js';
import { categoryIconName, locationLabel, sortDevices, statusFor } from './logic.js';
import { uplinkSummary } from './labels.js';

const SORTS = [
  ['name', '名稱'],
  ['code', '編號'],
  ['ip', 'IP'],
  ['status', '狀態'],
];

/**
 * @returns {Promise<{destroy(): void}>}
 */
export async function mountList(host, service) {
  const { ctx, state } = service;
  const { createSegmented, createStatusDot, createEmpty, icon, iconNames } = await service.ui();

  let mode = prefs.get('nc.devices.view', 'cards') === 'table' ? 'table' : 'cards';
  let sortKey = prefs.get('nc.devices.sortKey', 'name');
  if (!SORTS.some(([k]) => k === sortKey)) sortKey = 'name';
  let sortDir = prefs.get('nc.devices.sortDir', 'asc') === 'desc' ? 'desc' : 'asc';

  /** deviceId → { update() }：狀態事件只更新燈號，不重畫整個列表 */
  let dots = new Map();
  let wasAvailable = state.monitorAvailable;

  // ------------------------------------------------------------ 工具列
  const count = h('span', { class: 'dv-count', 'aria-live': 'polite' });
  const segmented = createSegmented({
    options: [{ value: 'cards', label: '卡片' }, { value: 'table', label: '表格' }],
    value: mode, ariaLabel: '檢視方式', role: 'radiogroup',
    onChange(v) {
      mode = v;
      prefs.set('nc.devices.view', v);
      render();
    },
  });
  const sortSelect = h(
    'select',
    {
      class: 'input dv-sort', 'aria-label': '排序欄位',
      onchange: (e) => {
        sortKey = e.target.value;
        prefs.set('nc.devices.sortKey', sortKey);
        render();
      },
    },
    SORTS.map(([value, label]) => h('option', { value, selected: value === sortKey }, `依${label}`)),
  );
  const dirButton = h('button', {
    type: 'button', class: 'btn small dv-dir',
    onclick: () => {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      prefs.set('nc.devices.sortDir', sortDir);
      syncDir();
      render();
    },
  });
  const syncDir = () => {
    dirButton.textContent = sortDir === 'asc' ? '升冪 ↑' : '降冪 ↓';
    dirButton.setAttribute('aria-label', sortDir === 'asc' ? '目前升冪，按下改為降冪' : '目前降冪，按下改為升冪');
  };
  syncDir();
  const addButton = h('button', { type: 'button', class: 'btn primary', onclick: () => service.openWizard().catch(service.reportError) }, '新增設備');
  const toolbar = h('div', { class: 'dv-toolbar' }, segmented.el, sortSelect, dirButton, count, h('span', { class: 'grow' }), addButton);
  const body = h('div', { class: 'dv-list' });
  host.replaceChildren(toolbar, body);

  // ------------------------------------------------------------ 列
  const catOf = (d) => state.categories.find((c) => c.id === d.categoryId);
  const open = (id) => ctx.bus.emit('device.open', { id });
  const rowProps = (d) => ({
    'data-id': d.id,
    onclick: () => open(d.id),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(d.id);
      }
    },
  });

  function statusCell(d, showLabel) {
    const s = statusFor(d, state.status, state.monitorAvailable);
    if (s.na) {
      dots.set(d.id, { update() {} });
      return h('span', { class: 'dv-na', title: '尚未啟用連線偵測' }, '—');
    }
    const dot = createStatusDot({ status: s.state, critical: s.critical, showLabel });
    dots.set(d.id, {
      update() {
        const next = statusFor(d, state.status, state.monitorAvailable);
        if (!next.na) dot.update({ status: next.state, critical: next.critical });
      },
    });
    return dot;
  }

  const tagsOf = (d) =>
    d.groupIds
      .map((id) => state.groups.find((g) => g.id === id))
      .filter(Boolean)
      .map((g) => {
        const tag = h('span', { class: 'dv-tag' }, g.name);
        tag.style.setProperty('--tag', g.color);
        return tag;
      });

  function card(d) {
    const c = catOf(d);
    const where = locationLabel(d, state.floors, state.rooms);
    const up = d.uplink ? state.devices.find((x) => x.id === d.uplink.deviceId) : null;
    return h(
      'button',
      { type: 'button', class: 'card dv-card', ...rowProps(d) },
      h(
        'span',
        { class: 'dv-card-top' },
        h('span', { class: 'dv-card-icon' }, icon(categoryIconName(c, iconNames), { size: 24 })),
        h('span', { class: 'dv-card-name' }, d.name),
        statusCell(d, false),
      ),
      h('span', { class: 'dv-card-sub' }, [d.code, c?.name].filter(Boolean).join(' · ')),
      h('span', { class: 'dv-card-meta' }, d.ip || '未填 IP'),
      where ? h('span', { class: 'dv-card-meta' }, where) : null,
      up ? h('span', { class: 'dv-card-meta' }, `上游：${up.name}`) : null,
      d.groupIds.length ? h('span', { class: 'dv-tags' }, tagsOf(d)) : null,
    );
  }

  function table(list) {
    const head = ['狀態', '編號', '名稱', '類別', 'IP', '位置', '上游', '組別'];
    return h(
      'div',
      { class: 'dv-table-wrap' },
      h(
        'table',
        { class: 'dv-table' },
        h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          list.map((d) => {
            const up = d.uplink ? state.devices.find((x) => x.id === d.uplink.deviceId) : null;
            return h(
              'tr',
              { class: 'dv-row', tabindex: '0', role: 'button', ...rowProps(d) },
              h('td', {}, statusCell(d, true)),
              h('td', {}, d.code),
              h('th', { scope: 'row', class: 'dv-cell-name' }, d.name),
              h('td', {}, catOf(d)?.name ?? ''),
              h('td', { class: 'dv-mono' }, d.ip),
              h('td', {}, locationLabel(d, state.floors, state.rooms)),
              h('td', {}, up ? h('span', { title: uplinkSummary(d.uplink) }, up.name) : ''),
              h('td', {}, h('span', { class: 'dv-tags' }, tagsOf(d))),
            );
          }),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ 畫面
  function render() {
    dots = new Map();
    wasAvailable = state.monitorAvailable;
    const filters = ctx.filters.get();
    const visible = state.devices.filter((d) => matchDevice(d, filters));
    const list = sortDevices(visible, sortKey, sortDir, { status: state.status, available: state.monitorAvailable });
    count.textContent = visible.length === state.devices.length ? `共 ${state.devices.length} 台` : `${visible.length} / ${state.devices.length} 台`;

    if (state.devices.length === 0) {
      body.replaceChildren(
        createEmpty({ icon: 'inventory', title: '還沒有任何設備', description: '新增第一台設備，或用 CSV 匯入舊的設備清單。', actionLabel: '新增設備', onAction: () => service.openWizard().catch(service.reportError) }),
        h('p', { class: 'dv-empty-more' }, h('button', { type: 'button', class: 'btn', onclick: () => service.goto('io') }, '匯入舊表（CSV）')),
      );
    } else if (list.length === 0) {
      body.replaceChildren(createEmpty({ icon: 'search', title: '沒有符合條件的設備', description: '調整或清除上方的篩選條件試試。', actionLabel: '清除篩選', onAction: () => ctx.filters.clear() }));
    } else if (mode === 'table') {
      body.replaceChildren(table(list));
    } else {
      body.replaceChildren(h('div', { class: 'dv-grid' }, list.map(card)));
    }
  }

  render();
  const offService = service.subscribe((kind, deviceId) => {
    if (kind === 'status') {
      // 偵測剛變成可用（第一次收到 status 事件）：整個列表要從「—」換成燈號
      if (sortKey === 'status' || wasAvailable !== state.monitorAvailable) render();
      else if (deviceId) dots.get(deviceId)?.update();
      else for (const d of dots.values()) d.update();
      return;
    }
    render();
  });
  const offFilters = ctx.bus.on('filters.changed', render);

  return {
    destroy() {
      offService();
      offFilters();
      segmented.destroy?.();
      dots = new Map();
      host.replaceChildren();
    },
  };
}
