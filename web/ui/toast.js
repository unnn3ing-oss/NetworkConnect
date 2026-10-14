// 輕量通知。toast('已儲存', {type:'ok'})；toast.success／toast.error／toast.warn／toast.info 為捷徑。
import { h } from './util.js';
import { icon } from './icons.js';

const MAX = 4;
const LEAVE_MS = 250;
const ICONS = { ok: 'check', error: 'alert', warn: 'alert', info: 'info' };
const DEFAULT_MS = { ok: 3000, info: 3500, warn: 5000, error: 6000 };

function host() {
  let el = document.querySelector('.nc-toasts');
  if (!el || !el.isConnected) {
    el = h('div', { class: 'nc-toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(el);
  }
  return el;
}

/** toast(message, {type:'info'|'ok'|'warn'|'error', duration}) → {dismiss()}；duration:0 表示不自動消失。 */
export function toast(message, { type = 'info', duration } = {}) {
  if (!ICONS[type]) type = 'info';
  const root = host();
  let timer = null;
  let gone = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), LEAVE_MS);
  };

  const el = h('div', { class: 'nc-toast', dataset: { type }, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'nc-toast-icon' }, icon(ICONS[type], { size: 18 })),
    h('span', { class: 'nc-toast-msg', text: String(message) }),
    h('button', { type: 'button', class: 'nc-toast-close', 'aria-label': '關閉通知', on: { click: dismiss } }, icon('close', { size: 14 })));
  el.dismiss = dismiss;
  root.append(el);

  const live = [...root.querySelectorAll('.nc-toast:not(.is-leaving)')];
  while (live.length > MAX) live.shift().dismiss?.();

  const ms = duration === undefined ? DEFAULT_MS[type] : duration;
  if (ms > 0) timer = setTimeout(dismiss, ms);
  return { dismiss };
}

toast.success = (m, o) => toast(m, { ...o, type: 'ok' });
toast.error = (m, o) => toast(m, { ...o, type: 'error' });
toast.warn = (m, o) => toast(m, { ...o, type: 'warn' });
toast.info = (m, o) => toast(m, { ...o, type: 'info' });
