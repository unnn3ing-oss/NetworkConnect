// hash 路由 + query：#/devices?floorId=flr_1&q=abc
// 路由的資料全在網址裡，所以重新整理、複製連結、上一頁都一致。

/** @returns {{path: string, query: Record<string, string>}} */
export function parseHash(hash) {
  let h = String(hash ?? '');
  if (h.startsWith('#')) h = h.slice(1);
  const qi = h.indexOf('?');
  let path = qi >= 0 ? h.slice(0, qi) : h;
  const qs = qi >= 0 ? h.slice(qi + 1) : '';
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = {};
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq >= 0 ? part.slice(0, eq) : part;
    const rawVal = eq >= 0 ? part.slice(eq + 1) : '';
    try {
      query[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal);
    } catch {
      // 壞掉的百分比編碼：略過這個參數
    }
  }
  return { path, query };
}

/** query 依鍵排序輸出，空值（''、undefined、null）省略，讓同一個狀態永遠是同一個網址 */
export function buildHash(path, query = {}) {
  const parts = Object.keys(query)
    .filter((k) => query[k] !== '' && query[k] !== undefined && query[k] !== null)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`);
  return `#${path}${parts.length ? `?${parts.join('&')}` : ''}`;
}

/** 瀏覽器版 location：只在沒有注入 loc 時才碰 window */
function browserLocation() {
  return {
    getHash: () => window.location.hash,
    setHash(hash, replace) {
      if (replace) window.history.replaceState(window.history.state, '', hash);
      else window.location.hash = hash;
    },
    onChange(cb) {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
  };
}

const sameQuery = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/**
 * @param {{loc?: {getHash(): string, setHash(hash: string, replace?: boolean): void, onChange(cb: () => void): () => void}}} [opts]
 */
export function createRouter({ loc } = {}) {
  const location_ = loc ?? browserLocation();
  let cur = parseHash(location_.getHash());
  let offLoc = null;
  const listeners = new Set();
  const queue = [];
  let dispatching = false;

  // 事件依序送出：監聽者在處理事件時又改了網址（例如 filters 補回 query），新事件排隊，不會插隊
  function emit(evt) {
    queue.push(evt);
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length) {
        const e = queue.shift();
        for (const fn of [...listeners]) {
          try {
            fn(e);
          } catch (err) {
            console.error('router 監聽者發生錯誤', err);
          }
        }
      }
    } finally {
      dispatching = false;
    }
  }

  function sync(initial = false) {
    const next = parseHash(location_.getHash());
    const pathChanged = next.path !== cur.path;
    if (!initial && !pathChanged && sameQuery(next.query, cur.query)) return;
    const prev = cur;
    cur = next;
    emit({ path: next.path, query: { ...next.query }, pathChanged: initial || pathChanged, prev });
  }

  const router = {
    current: () => ({ path: cur.path, query: { ...cur.query } }),
    /** 訂閱路由變化；回傳取消訂閱函式 */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      if (!offLoc) offLoc = location_.onChange(() => sync());
      sync(true);
    },
    stop() {
      offLoc?.();
      offLoc = null;
    },
    /** 導向 '#/path?x=1' 或 '/path?x=1' */
    navigate(target, { replace = false } = {}) {
      const { path, query } = parseHash(target);
      location_.setHash(buildHash(path, query), replace);
      sync();
    },
    /** 只改 query（合併；值為 ''／undefined／null 表示移除），預設用 replace 不增加歷史紀錄 */
    setQuery(patch, { replace = true } = {}) {
      const next = { ...cur.query };
      for (const [k, v] of Object.entries(patch)) {
        if (v === '' || v === undefined || v === null) delete next[k];
        else next[k] = String(v);
      }
      location_.setHash(buildHash(cur.path, next), replace);
      sync();
    },
  };
  return router;
}
