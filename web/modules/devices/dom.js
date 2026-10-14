// 極小的 DOM 工具：一律以文字節點插入字串（不使用 innerHTML），避免 XSS；不使用行內樣式（CSP）。
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'multiple']);

/**
 * h('button', {class: 'btn', onclick: fn, disabled: true}, '文字', node, [更多子節點])
 * - class／dataset／aria-*／其他屬性 → setAttribute；onXxx → addEventListener；value／checked／disabled… → DOM 屬性
 * - children：字串（純文字）、Node、陣列（會攤平）、null／false／undefined（略過）
 */
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

/** <label class="nc-field"> 外框（web/ui/README 的欄位標記） */
export function field(label, control, hint) {
  return h('label', { class: 'nc-field' }, h('span', { class: 'nc-field-label' }, label), control, hint ? h('small', { class: 'nc-field-hint' }, hint) : null);
}

/** 文字輸入，雙向綁定到 state[key]（字串） */
export function textInput(state, key, attrs = {}) {
  return h('input', { class: 'input', type: 'text', value: state[key] ?? '', ...attrs, oninput: (e) => { state[key] = e.target.value; } });
}

/** 下拉選單；options: [{value, label}]；綁定 state[key] */
export function selectInput(state, key, options, { onChange, ...attrs } = {}) {
  const sel = h('select', { class: 'input', ...attrs });
  for (const o of options) sel.append(h('option', { value: o.value, selected: String(state[key] ?? '') === String(o.value) }, o.label));
  sel.addEventListener('change', (e) => {
    state[key] = e.target.value;
    onChange?.(e.target.value);
  });
  return sel;
}

/** localStorage 只當作「個人偏好」：讀寫失敗（私密視窗、被封鎖）時安靜略過 */
export const prefs = {
  get(key, fallback) {
    try {
      return globalThis.localStorage?.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // 忽略
    }
  },
};
