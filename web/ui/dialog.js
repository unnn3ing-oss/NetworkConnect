// 取代原生 confirm()／alert() 的對話框。回傳 Promise；Esc、點遮罩、取消 → false。
import { h, uid, trapTab, lockScroll, unlockScroll } from './util.js';

function show({ title = '', message = '', danger = false, okText = '確定', cancelText = '取消', single = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const tid = uid('nc-dlg-t');
    const mid = uid('nc-dlg-m');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      overlay.remove();
      unlockScroll(overlay);
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
      resolve(value);
    };

    const ok = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, 'data-action': 'ok', text: okText, on: { click: () => finish(true) } });
    const cancel = single ? null : h('button', { type: 'button', class: 'btn', 'data-action': 'cancel', text: cancelText, on: { click: () => finish(false) } });
    const dialog = h('div', {
      class: `nc-dialog${danger ? ' is-danger' : ''}`, role: single ? 'dialog' : 'alertdialog', 'aria-modal': 'true',
      'aria-labelledby': tid, 'aria-describedby': message ? mid : null, tabindex: '-1',
    },
    h('h2', { class: 'nc-dialog-title', id: tid, text: title }),
    message ? h('p', { class: 'nc-dialog-msg', id: mid, text: message }) : null,
    h('div', { class: 'nc-dialog-actions' }, cancel, ok));

    const overlay = h('div', {
      class: 'nc-dialog-overlay',
      on: {
        click: (e) => { if (e.target === overlay) finish(false); },
        keydown: (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
          trapTab(e, dialog);
        },
      },
    }, dialog);

    lockScroll(overlay);
    document.body.append(overlay);
    (danger && cancel ? cancel : ok).focus();
  });
}

/** confirm({title, message, danger, okText, cancelText}) → Promise<boolean> */
export function confirm(opts = {}) {
  return show(opts);
}

/** alert({title, message, okText}) → Promise<void> */
export function alert(opts = {}) {
  return show({ ...opts, single: true }).then(() => undefined);
}
