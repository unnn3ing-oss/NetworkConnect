// 分類管理子頁：樓層（可排序）、房間、組別（顏色）、類別的新增、改名、刪除。
import { h } from './dom.js';
import { categoryIconName, reorderOrders } from './logic.js';
import { ICON_LABELS, METHOD_LABELS, TIER_LABELS } from './labels.js';

const options = (map) => Object.entries(map).map(([value, label]) => h('option', { value }, label));

/**
 * @returns {Promise<{destroy(): void}>}
 */
export async function mountManage(host, service) {
  const { ctx, state } = service;
  const { api } = ctx;
  const { confirm, toast, icon, iconNames } = await service.ui();

  let editing = null; // 正在編輯的列，例：'floor:flr_1'
  const setEditing = (key) => {
    editing = key;
    render();
  };

  /** 執行一個寫入動作：成功重新載入並提示，失敗顯示後端的繁中訊息（例如 409 仍被引用） */
  async function run(fn, doneMessage) {
    try {
      await fn();
      if (doneMessage) toast.success(doneMessage);
      editing = null;
      await service.load();
    } catch (err) {
      toast.error(err.message ?? String(err));
    }
  }

  const count = (list, pick) => list.filter(pick).length;
  const muted = (text) => h('span', { class: 'dv-muted dv-row-meta' }, text);
  const small = (label, onclick, cls = '', attrs = {}) => h('button', { type: 'button', class: `btn small ${cls}`.trim(), onclick, ...attrs }, label);

  /** 內嵌編輯表單；Enter 儲存、Esc 取消 */
  function inlineForm(controls, onSave) {
    const form = h(
      'form',
      {
        class: 'dv-inline',
        onsubmit: (e) => {
          e.preventDefault();
          onSave();
        },
        onkeydown: (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(null);
          }
        },
      },
      controls,
      h('button', { type: 'submit', class: 'btn small primary' }, '儲存'),
      small('取消', () => setEditing(null)),
    );
    queueMicrotask(() => form.querySelector('input, select')?.focus());
    return form;
  }

  function addForm(controls, label, onAdd) {
    return h(
      'form',
      {
        class: 'dv-inline dv-add',
        onsubmit: (e) => {
          e.preventDefault();
          onAdd();
        },
      },
      controls,
      h('button', { type: 'submit', class: 'btn small primary' }, label),
    );
  }

  const nameInput = (value = '', placeholder = '名稱') => h('input', { class: 'input', type: 'text', value, placeholder, maxlength: '100', 'aria-label': placeholder, required: true });
  const colorInput = (value) => h('input', { class: 'dv-color', type: 'color', value, 'aria-label': '顏色' });
  const selectOf = (opts, value, label) => {
    const s = h('select', { class: 'input', 'aria-label': label }, opts);
    s.value = value;
    return s;
  };

  // ------------------------------------------------------------ 樓層
  function floorsSection() {
    const floors = [...state.floors].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hant'));
    const rows = floors.map((f, i) => {
      const key = `floor:${f.id}`;
      if (editing === key) {
        const input = nameInput(f.name, '樓層名稱');
        return h('li', { class: 'dv-item' }, inlineForm([input], () => run(() => api.patch(`/api/floors/${f.id}`, { name: input.value.trim() }), '已更新樓層')));
      }
      const move = (delta) => run(async () => {
        for (const c of reorderOrders(floors, f.id, delta)) await api.patch(`/api/floors/${c.id}`, { order: c.order });
      });
      return h(
        'li',
        { class: 'dv-item' },
        h('span', { class: 'dv-item-name' }, f.name),
        muted(`${count(state.rooms, (r) => r.floorId === f.id)} 房間 · ${count(state.devices, (d) => d.floorId === f.id)} 設備`),
        h('span', { class: 'grow' }),
        small('↑', () => move(-1), '', { 'aria-label': `${f.name} 上移`, disabled: i === 0 }),
        small('↓', () => move(1), '', { 'aria-label': `${f.name} 下移`, disabled: i === floors.length - 1 }),
        small('編輯', () => setEditing(key)),
        small('刪除', async () => {
          if (await confirm({ title: `刪除樓層「${f.name}」？`, message: '樓層內還有房間或設備時無法刪除。', danger: true, okText: '刪除' })) await run(() => api.delete(`/api/floors/${f.id}`), '已刪除樓層');
        }, 'danger'),
      );
    });
    const input = nameInput('', '新樓層名稱（例：1F）');
    return h(
      'section',
      { class: 'card dv-sec' },
      h('h3', { class: 'dv-sec-title' }, '樓層'),
      floors.length ? h('ul', { class: 'dv-items' }, rows) : h('p', { class: 'dv-muted' }, '還沒有樓層。'),
      addForm([input], '新增樓層', () => {
        const name = input.value.trim();
        if (!name) return input.focus();
        const order = state.floors.reduce((m, f) => Math.max(m, f.order), 0) + 1;
        return run(() => api.post('/api/floors', { name, order }), '已新增樓層');
      }),
    );
  }

  // ------------------------------------------------------------ 房間
  function roomsSection() {
    const floors = [...state.floors].sort((a, b) => a.order - b.order);
    const groupsUi = floors.map((f) => {
      const rooms = state.rooms.filter((r) => r.floorId === f.id).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hant'));
      const rows = rooms.map((r) => {
        const key = `room:${r.id}`;
        if (editing === key) {
          const input = nameInput(r.name, '房間名稱');
          const floorSel = selectOf(floors.map((x) => h('option', { value: x.id }, x.name)), r.floorId, '所在樓層');
          return h('li', { class: 'dv-item' }, inlineForm([input, floorSel], () => run(() => api.patch(`/api/rooms/${r.id}`, { name: input.value.trim(), floorId: floorSel.value }), '已更新房間')));
        }
        return h(
          'li',
          { class: 'dv-item' },
          h('span', { class: 'dv-item-name' }, r.name),
          muted(`${count(state.devices, (d) => d.roomId === r.id)} 設備`),
          h('span', { class: 'grow' }),
          small('編輯', () => setEditing(key)),
          small('刪除', async () => {
            if (await confirm({ title: `刪除房間「${f.name}／${r.name}」？`, message: '房間內還有設備時無法刪除。', danger: true, okText: '刪除' })) await run(() => api.delete(`/api/rooms/${r.id}`), '已刪除房間');
          }, 'danger'),
        );
      });
      return h('div', { class: 'dv-subgroup' }, h('h4', { class: 'dv-sub-title' }, f.name), rooms.length ? h('ul', { class: 'dv-items' }, rows) : h('p', { class: 'dv-muted' }, '沒有房間'));
    });
    const input = nameInput('', '新房間名稱（例：客廳）');
    const floorSel = selectOf(floors.map((f) => h('option', { value: f.id }, f.name)), floors[0]?.id ?? '', '房間所在樓層');
    return h(
      'section',
      { class: 'card dv-sec' },
      h('h3', { class: 'dv-sec-title' }, '房間'),
      floors.length ? groupsUi : h('p', { class: 'dv-muted' }, '請先建立樓層，才能新增房間。'),
      floors.length
        ? addForm([floorSel, input], '新增房間', () => {
            const name = input.value.trim();
            if (!name) return input.focus();
            const order = state.rooms.filter((r) => r.floorId === floorSel.value).reduce((m, r) => Math.max(m, r.order), 0) + 1;
            return run(() => api.post('/api/rooms', { floorId: floorSel.value, name, order }), '已新增房間');
          })
        : null,
    );
  }

  // ------------------------------------------------------------ 組別
  const swatch = (color) => {
    const el = h('span', { class: 'dv-swatch', 'aria-hidden': 'true' });
    el.style.setProperty('--tag', color);
    return el;
  };

  function groupsSection() {
    const groups = [...state.groups].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const rows = groups.map((g) => {
      const key = `group:${g.id}`;
      const used = count(state.devices, (d) => d.groupIds.includes(g.id));
      if (editing === key) {
        const input = nameInput(g.name, '組別名稱');
        const color = colorInput(g.color);
        return h('li', { class: 'dv-item' }, inlineForm([color, input], () => run(() => api.patch(`/api/groups/${g.id}`, { name: input.value.trim(), color: color.value }), '已更新組別')));
      }
      return h(
        'li',
        { class: 'dv-item' },
        swatch(g.color),
        h('span', { class: 'dv-item-name' }, g.name),
        muted(`${used} 設備`),
        h('span', { class: 'grow' }),
        small('編輯', () => setEditing(key)),
        small('刪除', async () => {
          if (await confirm({ title: `刪除組別「${g.name}」？`, message: used ? `會從 ${used} 台設備移除這個組別（設備本身不會被刪除）。` : '這個組別目前沒有設備。', danger: true, okText: '刪除' })) await run(() => api.delete(`/api/groups/${g.id}`), '已刪除組別');
        }, 'danger'),
      );
    });
    const input = nameInput('', '新組別名稱（例：家用）');
    const color = colorInput('#3b82f6');
    return h(
      'section',
      { class: 'card dv-sec' },
      h('h3', { class: 'dv-sec-title' }, '組別'),
      groups.length ? h('ul', { class: 'dv-items' }, rows) : h('p', { class: 'dv-muted' }, '還沒有組別。組別可以讓同一群設備一起篩選（一台設備可屬於多個組別）。'),
      addForm([color, input], '新增組別', () => {
        const name = input.value.trim();
        if (!name) return input.focus();
        return run(() => api.post('/api/groups', { name, color: color.value }), '已新增組別');
      }),
    );
  }

  // ------------------------------------------------------------ 類別
  const monitorOptions = () => options(METHOD_LABELS);
  const iconOptions = () => iconNames.slice(0, 15).map((n) => h('option', { value: n }, ICON_LABELS[n] ?? n));

  function categoriesSection() {
    const rows = state.categories.map((c) => {
      const key = `cat:${c.id}`;
      const used = count(state.devices, (d) => d.categoryId === c.id);
      if (editing === key) {
        const monitor = selectOf(monitorOptions(), c.defaultMonitor, '預設偵測方式');
        if (c.builtin) {
          return h('li', { class: 'dv-item' }, h('span', { class: 'dv-item-name' }, c.name), muted('內建類別只能修改預設偵測方式'), inlineForm([monitor], () => run(() => api.patch(`/api/categories/${c.id}`, { defaultMonitor: monitor.value }), '已更新類別')));
        }
        const input = nameInput(c.name, '類別名稱');
        const tier = selectOf(options(TIER_LABELS), c.tier, '階層');
        const ico = selectOf(iconOptions(), categoryIconName(c, iconNames), '圖示');
        return h('li', { class: 'dv-item' }, inlineForm([input, tier, ico, monitor], () => run(() => api.patch(`/api/categories/${c.id}`, { name: input.value.trim(), tier: tier.value, icon: ico.value, defaultMonitor: monitor.value }), '已更新類別')));
      }
      return h(
        'li',
        { class: 'dv-item' },
        h('span', { class: 'dv-item-icon' }, icon(categoryIconName(c, iconNames), { size: 20 })),
        h('span', { class: 'dv-item-name' }, c.name),
        h('span', { class: 'dv-badge' }, c.builtin ? '內建' : '自訂'),
        muted(`${TIER_LABELS[c.tier] ?? c.tier} · 預設${METHOD_LABELS[c.defaultMonitor] ?? c.defaultMonitor} · ${used} 設備`),
        h('span', { class: 'grow' }),
        small('編輯', () => setEditing(key)),
        c.builtin
          ? null
          : small('刪除', async () => {
              if (await confirm({ title: `刪除類別「${c.name}」？`, message: used ? `仍有 ${used} 台設備使用這個類別，無法刪除。` : '此操作無法復原。', danger: true, okText: '刪除' })) await run(() => api.delete(`/api/categories/${c.id}`), '已刪除類別');
            }, 'danger'),
      );
    });
    const input = nameInput('', '新類別名稱（例：門鈴）');
    const tier = selectOf(options(TIER_LABELS), 'endpoint', '階層');
    const ico = selectOf(iconOptions(), 'other', '圖示');
    const monitor = selectOf(monitorOptions(), 'icmp', '預設偵測方式');
    return h(
      'section',
      { class: 'card dv-sec' },
      h('h3', { class: 'dv-sec-title' }, '設備類別'),
      h('ul', { class: 'dv-items' }, rows),
      addForm([input, tier, ico, monitor], '新增類別', () => {
        const name = input.value.trim();
        if (!name) return input.focus();
        return run(() => api.post('/api/categories', { name, tier: tier.value, icon: ico.value, defaultMonitor: monitor.value }), '已新增類別');
      }),
    );
  }

  function render() {
    // 重畫會讓輸入框失焦；只有資料變動或進入／離開編輯時才會呼叫
    host.replaceChildren(h('div', { class: 'dv-manage' }, floorsSection(), roomsSection(), groupsSection(), categoriesSection()));
  }

  render();
  const off = service.subscribe((kind) => {
    if (kind === 'data') render();
  });
  return {
    destroy() {
      off();
      host.replaceChildren();
    },
  };
}
