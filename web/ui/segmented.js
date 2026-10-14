// 膠囊分段（同 QPT .func-switch）：滑動的圓塊只用 transform 位移；位置以 CSS 變數 --seg-x／--seg-w 傳入（CSSOM，不違反 CSP）。
import { h } from './util.js';

/** createSegmented({options:[{value,label,icon?:Node,disabled?}], value, onChange(v), ariaLabel, role:'radiogroup'|'tablist'})
 *  → {el, value, setValue(v, {silent=true}), destroy()} */
export function createSegmented({ options = [], value, onChange, ariaLabel, role = 'radiogroup' } = {}) {
  const tabs = role === 'tablist';
  let current = options.some((o) => o.value === value) ? value : options.find((o) => !o.disabled)?.value;
  const thumb = h('span', { class: 'nc-seg-thumb', 'aria-hidden': 'true' });
  const el = h('div', { class: 'nc-seg', role, 'aria-label': ariaLabel }, thumb);
  const buttons = options.map((o) => {
    const b = h('button', {
      type: 'button', class: 'nc-seg-btn', role: tabs ? 'tab' : 'radio', disabled: o.disabled ? true : null,
      dataset: { value: String(o.value) },
    }, o.icon || null, h('span', { class: 'nc-seg-label', text: o.label }));
    b.addEventListener('click', () => select(o.value, true, false));
    return b;
  });
  el.append(...buttons);

  function paint() {
    const idx = options.findIndex((o) => o.value === current);
    buttons.forEach((b, i) => {
      const on = i === idx;
      b.setAttribute(tabs ? 'aria-selected' : 'aria-checked', on ? 'true' : 'false');
      b.classList.toggle('active', on);
      b.tabIndex = on ? 0 : -1;
    });
    place();
  }

  // 量測目前選項的位置，設定圓塊。沒有版面（隱藏、測試環境）時略過。
  function place() {
    const b = buttons[options.findIndex((o) => o.value === current)];
    if (!b || !b.offsetWidth) { el.classList.remove('is-ready'); return; }
    el.style.setProperty('--seg-x', `${b.offsetLeft}px`);
    el.style.setProperty('--seg-w', `${b.offsetWidth}px`);
    el.style.setProperty('--seg-h', `${b.offsetHeight}px`);
    el.classList.add('is-ready');
  }

  function select(v, fire, focus) {
    const changed = v !== current;
    current = v;
    paint();
    if (focus) buttons[options.findIndex((o) => o.value === v)]?.focus();
    if (changed && fire) onChange?.(v);
  }

  el.addEventListener('keydown', (e) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length) return;
    const at = enabled.indexOf(options.findIndex((o) => o.value === current));
    let to = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') to = enabled[0];
    else if (e.key === 'End') to = enabled[enabled.length - 1];
    if (to === null) return;
    e.preventDefault();
    select(options[to].value, true, true);
  });

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(place); ro.observe(el); }

  paint();
  return {
    el,
    get value() { return current; },
    setValue(v, { silent = true } = {}) { if (options.some((o) => o.value === v)) select(v, !silent, false); },
    destroy() { ro?.disconnect(); },
  };
}
