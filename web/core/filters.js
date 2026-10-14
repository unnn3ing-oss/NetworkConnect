// 全站共用篩選狀態（樓層／房間／組別／類別／關鍵字）。
// 鍵名與 REST 的 query 參數同名；狀態同步到網址 query，變動時 bus.emit('filters.changed', state)。

export const FILTER_KEYS = Object.freeze(['floorId', 'roomId', 'groupId', 'categoryId', 'q']);

export const emptyFilters = () => ({ floorId: '', roomId: '', groupId: '', categoryId: '', q: '' });

/** 網址 query 有的鍵覆寫 base，沒有的鍵保留 base */
export function filtersFromQuery(query, base = emptyFilters()) {
  const out = { ...base };
  for (const k of FILTER_KEYS) if (typeof query[k] === 'string') out[k] = query[k];
  return out;
}

/** 只輸出非空的欄位 */
export function filtersToQuery(state) {
  const out = {};
  for (const k of FILTER_KEYS) if (state[k]) out[k] = state[k];
  return out;
}

const SEARCH_FIELDS = ['code', 'name', 'ip', 'mac', 'hostname', 'vendor', 'model', 'notes'];

/** 設備是否符合篩選（所有條件 AND）；各列表型模組統一用這個函式 */
export function matchDevice(device, f) {
  if (f.floorId && device.floorId !== f.floorId) return false;
  if (f.roomId && device.roomId !== f.roomId) return false;
  if (f.groupId && !(device.groupIds ?? []).includes(f.groupId)) return false;
  if (f.categoryId && device.categoryId !== f.categoryId) return false;
  if (f.q) {
    const needle = f.q.trim().toLowerCase();
    if (needle && !SEARCH_FIELDS.some((k) => String(device[k] ?? '').toLowerCase().includes(needle))) return false;
  }
  return true;
}

const same = (a, b) => FILTER_KEYS.every((k) => a[k] === b[k]);

/**
 * @param {{router: ReturnType<import('./router.js').createRouter>, bus: {emit(name: string, payload: unknown): void}}} deps
 */
export function createFilters({ router, bus }) {
  let state = filtersFromQuery(router.current().query);

  router.on(({ query }) => {
    const next = filtersFromQuery(query, state);
    if (!same(next, state)) {
      state = next;
      bus.emit('filters.changed', { ...state });
    }
    // 切換分頁後的新網址沒有帶篩選：補回去，讓複製網址永遠是完整的
    const want = filtersToQuery(state);
    if (Object.entries(want).some(([k, v]) => query[k] !== v)) router.setQuery(want);
  });

  return {
    get: () => ({ ...state }),
    set(patch) {
      const next = { ...state };
      for (const k of FILTER_KEYS) if (typeof patch[k] === 'string') next[k] = patch[k];
      if (same(next, state)) return;
      state = next;
      bus.emit('filters.changed', { ...state });
      router.setQuery(Object.fromEntries(FILTER_KEYS.map((k) => [k, state[k]])));
    },
    clear() {
      this.set(emptyFilters());
    },
  };
}
