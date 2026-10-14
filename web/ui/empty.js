// 空狀態卡：圖示、標題、說明、主要按鈕。
import { h } from './util.js';
import { icon } from './icons.js';

export function createEmpty({ icon: iconName = 'other', title = '', description = '', actionLabel, onAction } = {}) {
  const el = h('div', { class: 'nc-empty' },
    h('div', { class: 'nc-empty-icon' }, icon(iconName, { size: 32 })),
    h('h3', { class: 'nc-empty-title', text: title }),
    description ? h('p', { class: 'nc-empty-desc', text: description }) : null);
  if (actionLabel) {
    el.append(h('button', { type: 'button', class: 'btn primary', text: actionLabel, on: { click: (e) => onAction?.(e) } }));
  }
  return el;
}
