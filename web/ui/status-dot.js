// 燈號：依監控狀態＋是否關鍵設備決定顏色與文字（規格 §6：critical:false 離線 → 灰；critical:true → 紅色警示）。
import { h } from './util.js';

const INFO = {
  up: { label: '正常' },
  down: { label: '離線警示' },
  offline: { label: '離線' },
  unknown: { label: '未知' },
  disabled: { label: '未監控' },
};

/** statusInfo('down', false) → { state:'offline', label:'離線' }。state 對應 CSS 的 [data-state]。 */
export function statusInfo(status, critical = false) {
  let state = status === 'up' || status === 'down' || status === 'offline' || status === 'unknown' || status === 'disabled' ? status : 'unknown';
  if (state === 'down' && !critical) state = 'offline';
  return { state, label: INFO[state].label };
}

/** 建立燈號元素。回傳的元素帶有 update({status, critical}) 方法。 */
export function createStatusDot({ status, critical = false, showLabel = true } = {}) {
  const el = h('span', { class: 'nc-status' });
  const dot = h('span', { class: 'nc-status-dot', 'aria-hidden': 'true' });
  const text = showLabel ? h('span', { class: 'nc-status-label' }) : null;
  el.append(dot);
  if (text) el.append(text);
  el.update = ({ status: s, critical: c = false } = {}) => {
    const info = statusInfo(s, c);
    el.dataset.state = info.state;
    if (text) text.textContent = info.label;
    else { el.setAttribute('role', 'img'); el.setAttribute('aria-label', info.label); el.title = info.label; }
    return el;
  };
  return el.update({ status, critical });
}
