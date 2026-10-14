// 全站篩選列：樓層／房間／組別／類別下拉＋關鍵字。選項來自 inventory 的列表 API；
// inventory 沒載入或失敗時對應下拉只有「全部」，不影響其他功能。
import { FILTER_KEYS } from './filters.js';

const LABELS = {
  floorId: '全部樓層',
  roomId: '全部房間',
  groupId: '全部組別',
  categoryId: '全部類別',
};
const SOURCES = { floorId: '/api/floors', roomId: '/api/rooms', groupId: '/api/groups', categoryId: '/api/categories' };

export function createFilterBar(container, { api, bus, filters, debounceMs = 200 }) {
  const doc = container.ownerDocument;
  const lists = { floorId: [], roomId: [], groupId: [], categoryId: [] };
  const selects = {};
  let timer = null;
  const offs = [];

  const make = (tag, className, text) => {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---- DOM ----
  const inner = make('div', 'nc-filterbar-inner');
  for (const key of Object.keys(SOURCES)) {
    const label = make('label', 'nc-field');
    const sr = make('span', 'nc-sr', LABELS[key].replace('全部', ''));
    const select = make('select', 'input pill');
    select.dataset.filter = key;
    select.addEventListener('change', () => onSelect(key, select.value));
    label.append(sr, select);
    inner.append(label);
    selects[key] = select;
  }
  const search = make('input', 'input pill nc-search');
  search.type = 'search';
  search.placeholder = '搜尋名稱、IP、MAC…';
  search.setAttribute('aria-label', '關鍵字');
  search.dataset.filter = 'q';
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => filters.set({ q: search.value }), debounceMs);
  });
  const clear = make('button', 'btn small nc-clear', '清除篩選');
  clear.type = 'button';
  clear.hidden = true;
  clear.addEventListener('click', () => filters.clear());
  inner.append(search, clear);
  container.replaceChildren(inner);

  // ---- 行為 ----
  function onSelect(key, value) {
    if (key === 'floorId') {
      // 換樓層時，不屬於新樓層的房間篩選要清掉
      const room = lists.roomId.find((r) => r.id === filters.get().roomId);
      filters.set({ floorId: value, roomId: room && value && room.floorId !== value ? '' : filters.get().roomId });
    } else {
      filters.set({ [key]: value });
    }
  }

  function render() {
    const state = filters.get();
    for (const [key, select] of Object.entries(selects)) {
      let items = lists[key];
      if (key === 'roomId' && state.floorId) items = items.filter((r) => r.floorId === state.floorId);
      const opts = [new Option(LABELS[key], '')];
      for (const it of items) opts.push(new Option(it.name, it.id));
      select.replaceChildren(...opts);
      select.value = state[key];
      if (select.value !== state[key]) select.value = ''; // 選項尚未載入或已被刪除
      select.classList.toggle('is-active', Boolean(state[key]));
    }
    if (doc.activeElement !== search) search.value = state.q;
    clear.hidden = !FILTER_KEYS.some((k) => state[k]);
  }

  async function refresh() {
    const keys = Object.keys(SOURCES);
    const results = await Promise.allSettled(keys.map((k) => api.get(SOURCES[k])));
    results.forEach((r, i) => {
      lists[keys[i]] = r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [];
    });
    render();
  }

  offs.push(bus.on('filters.changed', render));
  offs.push(bus.on('inventory.changed', () => refresh()));
  render();

  return {
    refresh,
    setVisible(visible) {
      container.hidden = !visible;
    },
    destroy() {
      clearTimeout(timer);
      for (const off of offs) off();
      container.replaceChildren();
    },
  };
}
