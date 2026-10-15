// 極小的 DOM 工具：字串一律以文字節點插入（不使用 innerHTML），不使用行內樣式（CSP style-src 'self'）。
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'multiple']);

/** h('button', {class: 'btn', onclick: fn, disabled: true}, '文字', node, [更多子節點]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** localStorage 讀寫（私密視窗或被封鎖時會丟錯，一律吞掉；頁面不依賴它也要能正常運作） */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 存不了就算了
    }
  },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
