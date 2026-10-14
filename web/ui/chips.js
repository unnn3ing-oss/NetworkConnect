// 篩選 chip 群組（可多選）。沒有選任何項目 = 不篩選；若給 allLabel，會多一顆「全部」chip 代表此狀態。
import { h } from './util.js';

/** createChips({options:[{value,label,count?}], value:[...], multiple=true, allLabel, onChange(values[]), ariaLabel})
 *  → {el, value(陣列), setValue(arr), setOptions(options)} */
export function createChips({ options = [], value = [], multiple = true, allLabel, onChange, ariaLabel } = {}) {
  let opts = options;
  let selected = [];
  const el = h('div', { class: 'nc-chips', role: 'group', 'aria-label': ariaLabel });

  const sanitize = (arr) => [...new Set(arr)].filter((v) => opts.some((o) => o.value === v)).slice(0, multiple ? Infinity : 1);
  selected = sanitize(value);

  function chip(label, count, pressed, onClick, data) {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': pressed ? 'true' : 'false', dataset: data, on: { click: onClick } }, h('span', { class: 'chip-label', text: label }));
    if (count !== undefined && count !== null) b.append(h('small', { class: 'chip-count', text: String(count) }));
    return b;
  }

  function render() {
    el.replaceChildren();
    if (allLabel) el.append(chip(allLabel, undefined, selected.length === 0, () => change([]), { value: '' }));
    for (const o of opts) {
      el.append(chip(o.label, o.count, selected.includes(o.value), () => toggle(o.value), { value: String(o.value) }));
    }
  }

  // 只更新 aria-pressed，不重建按鈕，鍵盤焦點才不會跑掉
  function paint() {
    const btns = [...el.children];
    if (allLabel) btns.shift().setAttribute('aria-pressed', selected.length === 0 ? 'true' : 'false');
    btns.forEach((b, i) => b.setAttribute('aria-pressed', selected.includes(opts[i].value) ? 'true' : 'false'));
  }

  function change(next) {
    selected = next;
    paint();
    onChange?.([...selected]);
  }
  function toggle(v) {
    if (selected.includes(v)) change(selected.filter((x) => x !== v));
    else change(multiple ? [...selected, v] : [v]);
  }

  render();
  return {
    el,
    get value() { return [...selected]; },
    setValue(arr) { selected = sanitize(arr); paint(); },
    setOptions(next) { opts = next; selected = sanitize(selected); render(); },
  };
}
