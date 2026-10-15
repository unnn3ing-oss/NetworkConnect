// 新增／編輯設備精靈（6 步）：類別 → 基本資料 → 位置 → 連線 → 偵測 → 確認。
// 表單欄位一律以字串存在 wizard.state，送出時由 logic.buildPayload() 轉型。
import { h, field, textInput, selectInput } from './dom.js';
import {
  buildPayload, categoryIconName, monitorDefaults, newWizardState, stateFromDevice,
  uplinkCandidates, validateStep, WIZARD_STEP_IDS,
} from './logic.js';
import { MEDIUM_LABELS, METHOD_LABELS, TIER_LABELS, monitorSummary } from './labels.js';

const STEP_LABELS = { category: '類別', basic: '基本資料', location: '位置', link: '連線', monitor: '偵測', confirm: '確認' };

/**
 * @param {ReturnType<import('./service.js').getService>} service
 * @param {{device?: object, categoryId?: string}} [opts] device＝編輯該設備；否則新增
 */
export async function openDeviceWizard(service, { device = null, categoryId = '' } = {}) {
  const { createWizard, createChips, box, kv, icon, iconNames } = await service.ui();
  const { api, filters } = service.ctx;
  const { state: data } = service;
  const editing = Boolean(device);

  // 新增時預填設定頁的「預設偵測間隔」；monitor 停用或讀不到就用 60
  let defaultIntervalSec = 60;
  if (!editing) {
    try {
      const v = (await api.get('/api/monitor/settings'))?.defaultIntervalSec;
      if (Number.isInteger(v)) defaultIntervalSec = v;
    } catch {
      // 用預設
    }
  }
  const start = editing
    ? stateFromDevice(device)
    : newWizardState({ categories: data.categories, categoryId, floorId: filters.get().floorId, roomId: filters.get().roomId, defaultIntervalSec });
  // 全站篩選選了房間但沒選樓層（或房間不屬於該樓層）時，不預填房間
  if (!editing && start.roomId && !data.rooms.some((r) => r.id === start.roomId && r.floorId === start.floorId)) start.roomId = '';

  const categoryOf = (id) => data.categories.find((c) => c.id === id);

  // ------------------------------------------------------------ 步驟 1：類別
  function renderCategory(state) {
    const grid = h('div', { class: 'dv-cats', role: 'radiogroup', 'aria-label': '設備類別' });
    const cards = data.categories.map((c) => {
      const selected = state.categoryId === c.id;
      return h(
        'button',
        {
          type: 'button', role: 'radio', 'aria-checked': String(selected),
          class: `dv-cat${selected ? ' is-selected' : ''}`, tabindex: selected || (!state.categoryId && c === data.categories[0]) ? '0' : '-1',
          dataset: { id: c.id },
        },
        icon(categoryIconName(c, iconNames), { size: 28 }),
        h('span', { class: 'dv-cat-name' }, c.name),
        h('span', { class: 'dv-cat-tier' }, TIER_LABELS[c.tier] ?? ''),
      );
    });
    const select = (card) => {
      const id = card.dataset.id;
      state.categoryId = id;
      if (!state.monitorTouched) {
        const m = monitorDefaults(categoryOf(id));
        state.monitorMethod = m.method;
        state.critical = m.critical;
      }
      for (const c of cards) {
        const on = c === card;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-checked', String(on));
        c.tabIndex = on ? 0 : -1;
      }
    };
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.dv-cat');
      if (card) select(card);
    });
    grid.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const i = cards.findIndex((c) => c === document.activeElement);
      const next = cards[(Math.max(i, 0) + keys[e.key] + cards.length) % cards.length];
      next.focus();
      select(next);
    });
    grid.append(...cards);
    return h('div', { class: 'nc-stack' }, h('p', { class: 'dv-muted' }, '選擇這台設備的類別，之後會依類別帶入偵測預設值。'), grid);
  }

  // ------------------------------------------------------------ 步驟 2：基本資料
  function renderBasic(state) {
    return h(
      'div',
      { class: 'nc-stack' },
      h(
        'div',
        { class: 'dv-form-grid' },
        field('名稱 *', textInput(state, 'name', { maxlength: '100', autocomplete: 'off', placeholder: '例：客廳 Mesh 主節點' })),
        field('編號', textInput(state, 'code', { maxlength: '40', autocomplete: 'off', placeholder: '例：R01' }), '選填；不可與其他設備重複'),
        field('IP 位址', textInput(state, 'ip', { inputmode: 'decimal', autocomplete: 'off', placeholder: '192.168.1.1' })),
        field('MAC 位址', textInput(state, 'mac', { autocomplete: 'off', placeholder: 'AA:BB:CC:DD:EE:FF' })),
        field('廠牌', textInput(state, 'vendor', { maxlength: '100', autocomplete: 'off', placeholder: '例：Zyxel' })),
        field('型號', textInput(state, 'model', { maxlength: '100', autocomplete: 'off' })),
      ),
      field('說明', h('textarea', { class: 'input', rows: '3', maxlength: '2000', oninput: (e) => { state.notes = e.target.value; } }, state.notes)),
    );
  }

  // ------------------------------------------------------------ 步驟 3：位置
  function renderLocation(state) {
    const floorOptions = [{ value: '', label: '（未指定）' }, ...data.floors.map((f) => ({ value: f.id, label: f.name }))];
    const roomsOf = (floorId) => data.rooms.filter((r) => r.floorId === floorId);
    const roomSelect = h('select', { class: 'input', 'aria-label': '房間' });
    const fillRooms = () => {
      roomSelect.replaceChildren();
      const rooms = roomsOf(state.floorId);
      roomSelect.disabled = !state.floorId;
      roomSelect.append(h('option', { value: '' }, state.floorId ? (rooms.length ? '（未指定）' : '（此樓層還沒有房間）') : '（請先選擇樓層）'));
      for (const r of rooms) roomSelect.append(h('option', { value: r.id, selected: r.id === state.roomId }, r.name));
    };
    roomSelect.addEventListener('change', (e) => { state.roomId = e.target.value; });
    const floorSelect = selectInput(state, 'floorId', floorOptions, {
      'aria-label': '樓層',
      onChange() {
        if (!roomsOf(state.floorId).some((r) => r.id === state.roomId)) state.roomId = '';
        fillRooms();
      },
    });
    fillRooms();

    const chips = data.groups.length
      ? createChips({
          options: data.groups.map((g) => ({ value: g.id, label: g.name })),
          value: state.groupIds, multiple: true, ariaLabel: '組別',
          onChange(values) { state.groupIds = values; },
        }).el
      : h('p', { class: 'dv-muted' }, '還沒有任何組別。可到「分類管理」新增。');

    return h(
      'div',
      { class: 'nc-stack' },
      h('div', { class: 'dv-form-grid' }, field('樓層', floorSelect, data.floors.length ? null : '還沒有樓層，可到「分類管理」新增'), field('房間', roomSelect)),
      h('div', { class: 'nc-field' }, h('span', { class: 'nc-field-label' }, '組別（可多選）'), chips),
    );
  }

  // ------------------------------------------------------------ 步驟 4：連線
  function renderLink(state) {
    const candidates = uplinkCandidates(data.devices, state.id);
    const label = (d) => `${d.code ? `${d.code}　` : ''}${d.name}${d.ip ? `（${d.ip}）` : ''}`;
    const search = h('input', { class: 'input', type: 'search', placeholder: '搜尋上游設備（名稱、編號、IP）', 'aria-label': '搜尋上游設備', autocomplete: 'off' });
    const list = h('select', { class: 'input dv-uplink-list', size: '6', 'aria-label': '上游設備' });
    const fields = h('div', { class: 'dv-form-grid' });

    const syncFields = () => {
      const has = Boolean(state.uplinkId);
      fields.classList.toggle('is-off', !has);
      for (const el of fields.querySelectorAll('input, select')) el.disabled = !has;
    };
    const fillList = () => {
      const needle = search.value.trim().toLowerCase();
      list.replaceChildren(h('option', { value: '', selected: !state.uplinkId }, '（無，作為根節點）'));
      for (const d of candidates) {
        const hit = !needle || [d.code, d.name, d.ip, d.mac, d.vendor, d.model].some((v) => String(v ?? '').toLowerCase().includes(needle));
        if (hit || d.id === state.uplinkId) list.append(h('option', { value: d.id, selected: d.id === state.uplinkId }, label(d)));
      }
    };
    search.addEventListener('input', fillList);
    list.addEventListener('change', () => {
      state.uplinkId = list.value;
      syncFields();
    });

    fields.append(
      field('上游設備的埠', textInput(state, 'uplinkPort', { maxlength: '40', placeholder: '例：LAN1' })),
      field('本機的埠', textInput(state, 'localPort', { maxlength: '40', placeholder: '例：WAN' })),
      field('連線媒介', selectInput(state, 'medium', Object.entries(MEDIUM_LABELS).map(([value, text]) => ({ value, label: text })))),
      field('速率', textInput(state, 'speed', { maxlength: '20', placeholder: '例：1G' })),
    );
    fillList();
    syncFields();
    return h(
      'div',
      { class: 'nc-stack' },
      box('上游設備', h('p', {}, '這台設備接在哪一台設備下面？沒有上游代表它是根節點（通常是數據機）。架構圖會依此自動畫出樹狀。')),
      search,
      list,
      fields,
    );
  }

  // ------------------------------------------------------------ 步驟 5：偵測
  function renderMonitor(state) {
    const touch = () => { state.monitorTouched = true; };
    const portField = field('偵測埠', textInput(state, 'monitorPort', { inputmode: 'numeric', placeholder: '例：22' }), 'TCP 必填；HTTP 留空代表 80');
    const pathField = field('HTTP 路徑', textInput(state, 'monitorPath', { placeholder: '/' }));
    const detail = h('div', { class: 'dv-form-grid' }, portField, pathField);
    const more = h('div', { class: 'dv-form-grid' });
    const sync = () => {
      const m = state.monitorMethod;
      portField.hidden = !(m === 'tcp' || m === 'http');
      pathField.hidden = m !== 'http';
      detail.hidden = portField.hidden && pathField.hidden;
      more.hidden = m === 'none';
    };
    const critical = h('input', { type: 'checkbox', checked: Boolean(state.critical), onchange: (e) => { state.critical = e.target.checked; touch(); } });
    more.append(
      field('偵測間隔（秒）', textInput(state, 'intervalSec', { inputmode: 'numeric' }), '最少 15 秒'),
      h('label', { class: 'dv-check' }, critical, h('span', {}, '關鍵設備（離線時顯示紅色警示並發出系統通知）')),
    );
    const methodSelect = selectInput(state, 'monitorMethod', Object.entries(METHOD_LABELS).map(([value, text]) => ({ value, label: text })), {
      onChange() {
        touch();
        sync();
      },
    });
    sync();
    const category = categoryOf(state.categoryId);
    return h(
      'div',
      { class: 'nc-stack' },
      box('連線偵測', h('p', {}, category ? `已依「${category.name}」帶入預設值，可以修改。連續 3 次失敗才會判定離線。` : '連續 3 次失敗才會判定離線。')),
      field('偵測方式', methodSelect),
      detail,
      more,
    );
  }

  // ------------------------------------------------------------ 步驟 6：確認
  function renderConfirm(state) {
    const p = buildPayload(state);
    const cat = categoryOf(p.categoryId);
    const floor = data.floors.find((f) => f.id === p.floorId);
    const room = data.rooms.find((r) => r.id === p.roomId);
    const groups = p.groupIds.map((id) => data.groups.find((g) => g.id === id)?.name).filter(Boolean);
    const up = p.uplink ? data.devices.find((d) => d.id === p.uplink.deviceId) : null;
    const link = p.uplink
      ? [up ? up.name : p.uplink.deviceId, [p.uplink.port, p.uplink.localPort].some(Boolean) ? `${p.uplink.port || '—'} ↔ ${p.uplink.localPort || '—'}` : '', MEDIUM_LABELS[p.uplink.medium], p.uplink.speed].filter(Boolean).join(' · ')
      : '無（根節點）';
    return h(
      'div',
      { class: 'nc-stack' },
      kv([
        ['類別', cat?.name ?? ''],
        ['名稱', p.name],
        ['編號', p.code],
        ['IP', p.ip],
        ['MAC', p.mac],
        ['廠牌型號', [p.vendor, p.model].filter(Boolean).join(' ')],
        ['位置', [floor?.name, room?.name].filter(Boolean).join('／')],
        ['組別', groups.join('、')],
        ['上游連線', link],
        ['偵測', monitorSummary(p.monitor)],
        ['說明', p.notes],
      ]),
    );
  }

  const renderers = { category: renderCategory, basic: renderBasic, location: renderLocation, link: renderLink, monitor: renderMonitor, confirm: renderConfirm };

  const wizard = createWizard({
    title: editing ? `編輯設備：${device.name}` : '新增設備',
    initialState: start,
    steps: WIZARD_STEP_IDS.map((id) => ({
      id,
      label: STEP_LABELS[id],
      render: (state) => renderers[id](state),
      validate: (state) => validateStep(id, state),
    })),
    async onSubmit(state) {
      const payload = buildPayload(state);
      const saved = state.id ? await api.patch(`/api/devices/${state.id}`, payload) : await api.post('/api/devices', payload);
      await service.load();
      service.announceSaved(saved, !state.id);
    },
    onCancel() {},
  });
  wizard.open();
  return wizard;
}
