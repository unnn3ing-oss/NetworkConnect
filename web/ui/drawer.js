// 右側抽屜（手機寬度改為全螢幕，見 components.css）。
import { h, uid, trapTab, lockScroll, unlockScroll } from './util.js';
import { icon } from './icons.js';

/** createDrawer({title, content: Node, onClose}) → {el, open(), close(), isOpen, setContent(node), setTitle(text)} */
export function createDrawer({ title = '', content = null, onClose } = {}) {
  const tid = uid('nc-drawer-t');
  let opened = false;
  let prev = null;

  const titleEl = h('h2', { class: 'nc-drawer-title', id: tid, text: title });
  const body = h('div', { class: 'nc-drawer-body' }, content);
  const closeBtn = h('button', { type: 'button', class: 'nc-drawer-close', 'aria-label': '關閉', on: { click: () => api.close() } }, icon('close', { size: 18 }));
  const panel = h('aside', { class: 'nc-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid, tabindex: '-1' },
    h('header', { class: 'nc-drawer-head' }, titleEl, closeBtn), body);
  const overlay = h('div', {
    class: 'nc-drawer-overlay',
    on: {
      click: (e) => { if (e.target === overlay) api.close(); },
      keydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); return; }
        trapTab(e, panel);
      },
    },
  }, panel);

  const api = {
    el: overlay,
    get isOpen() { return opened; },
    open() {
      if (opened) return;
      opened = true;
      prev = document.activeElement;
      lockScroll(overlay);
      document.body.append(overlay);
      overlay.classList.add('is-open');
      closeBtn.focus();
    },
    close() {
      if (!opened) return;
      opened = false;
      overlay.classList.remove('is-open');
      overlay.remove();
      unlockScroll(overlay);
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
      onClose?.();
    },
    setContent(node) { body.replaceChildren(...(node ? [node] : [])); },
    setTitle(text) { titleEl.textContent = text; },
  };
  return api;
}
