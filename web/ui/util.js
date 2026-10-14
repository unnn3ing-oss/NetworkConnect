// 元件庫內部共用小工具（B 組不需要直接使用）。
// 所有 DOM 都用 createElement／textContent 建立，不使用 innerHTML 塞使用者文字，也不寫 style 屬性（CSP style-src 'self'）。

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div', {class:'x', dataset:{a:1}, on:{click:fn}, 'aria-label':'..'}, child, 'text', ...) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') continue; // 一律不允許行內樣式
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, ...children);
  return el;
}

export function append(el, ...children) {
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

let seq = 0;
export const uid = (prefix = 'nc') => `${prefix}-${++seq}`;

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && !el.closest('[hidden]'));
}

/** keydown 的 Tab 處理：焦點循環在 root 內。已處理則 preventDefault。 */
export function trapTab(e, root) {
  if (e.key !== 'Tab') return;
  const list = focusables(root);
  if (!list.length) { e.preventDefault(); root.focus?.(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  const inside = root.contains(active);
  if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
}

// ---- 捲動鎖（可巢狀）：以元素上的 data-nc-lock 標記，只要還有已掛載的標記元素就維持鎖定 ----
export function lockScroll(el) {
  el.setAttribute('data-nc-lock', '');
  document.documentElement.classList.add('nc-lock');
}
export function unlockScroll(el) {
  el.removeAttribute('data-nc-lock');
  if (!document.querySelector('[data-nc-lock]')) document.documentElement.classList.remove('nc-lock');
}

// ---- SVG ----
const BAD_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'style', 'link', 'animate', 'set', 'animatetransform', 'animatemotion']);

/** 淨化 SVG：移除 script／foreignObject 等元素，以及 on* 事件、style、外部連結屬性。就地修改並回傳。 */
export function sanitizeSvg(root) {
  const walk = (el) => {
    for (const child of [...el.children]) {
      if (BAD_ELEMENTS.has(child.localName.toLowerCase())) { child.remove(); continue; }
      walk(child);
    }
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      const external = (n === 'href' || n === 'xlink:href') && !v.startsWith('#');
      if (n.startsWith('on') || n === 'style' || external || v.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
  };
  walk(root);
  return root;
}

/** 靜態 SVG 字串 → 已淨化的 SVGElement；不是 SVG 則回傳 null。 */
export function parseSvg(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  const svg = t.content.querySelector('svg');
  return svg ? sanitizeSvg(svg) : null;
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** 供 aria 使用：回報使用者是否偏好減少動態。 */
export function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
