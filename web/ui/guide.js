// 全螢幕導覽（視覺同 QPT「全螢幕安裝教學」.ds-*）：步驟點列、左 SVG 示意右說明、底部上一步／下一步。樣式見 guide.css。
import { h, uid, trapTab, lockScroll, unlockScroll, parseSvg } from './util.js';
import { icon } from './icons.js';
import { confirm } from './dialog.js';

function artNode(art) {
  if (!art) return null;
  if (typeof art === 'string') return parseSvg(art);   // 靜態 SVG 字串：先淨化再放入
  return art;                                           // 呼叫端自己建立的 SVGElement
}

/** createGuide({title, subtitle, steps:[{label, art, body: Node, onEnter?(i), canNext?(i) → true|false|'提示文字'}], onClose({completed})})
 *  → {el, open(), close(), goTo(i), next(), prev(), index} */
export function createGuide({ title = '', subtitle = '', steps = [], onClose } = {}) {
  const tid = uid('nc-guide-t');
  const total = steps.length;
  const last = total - 1;
  let index = 0;
  let isOpen = false;
  let confirming = false;
  let prevFocus = null;

  // ---- 骨架 ----
  const stepsEl = h('ol', { class: 'nc-guide-steps', 'aria-label': '導覽步驟' });
  const stepItems = steps.map((s, i) => {
    const li = h('li', { class: 'nc-guide-step' },
      h('button', { type: 'button', class: 'nc-guide-step-btn', 'aria-label': `步驟 ${i + 1}：${s.label}`, on: { click: () => api.goTo(i) } },
        h('span', { class: 'nc-guide-dot', 'aria-hidden': 'true' }), h('span', { class: 'nc-guide-lbl', text: s.label })));
    stepsEl.append(li);
    return li;
  });

  const panes = steps.map((s, i) => {
    const art = h('div', { class: 'nc-guide-art', 'aria-hidden': 'true' }, artNode(s.art));
    const hid = uid('nc-guide-h');
    const pane = h('section', { class: 'nc-guide-pane', hidden: true, 'aria-labelledby': hid },
      art,
      h('div', { class: 'nc-guide-text' },
        h('p', { class: 'nc-guide-kicker', text: `步驟 ${i + 1}／${total}` }),
        h('h3', { id: hid, tabindex: '-1', text: s.label }),
        s.body || null));
    return { pane, art, heading: pane.querySelector('h3') };
  });

  const msgEl = h('p', { class: 'nc-guide-msg', role: 'status', 'aria-live': 'polite' });
  const countEl = h('span', { class: 'nc-guide-count', 'aria-live': 'polite' });
  const prevBtn = h('button', { type: 'button', class: 'btn', 'data-action': 'prev', text: '上一步', on: { click: () => api.prev() } });
  const nextBtn = h('button', { type: 'button', class: 'btn primary', 'data-action': 'next', on: { click: () => api.next() } });

  const el = h('div', { class: 'nc-guide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid, tabindex: '-1' },
    h('div', { class: 'nc-guide-shell' },
      h('header', { class: 'nc-guide-head' },
        h('div', { class: 'nc-guide-title' }, h('h2', { id: tid, text: title }), subtitle ? h('p', { text: subtitle }) : null),
        h('button', { type: 'button', class: 'nc-guide-close', 'data-action': 'close', 'aria-label': '關閉導覽', on: { click: () => requestClose() } }, icon('close', { size: 18 }))),
      stepsEl,
      h('main', { class: 'nc-guide-main' }, ...panes.map((p) => p.pane)),
      msgEl,
      h('footer', { class: 'nc-guide-foot' }, prevBtn, countEl, nextBtn)));

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose(); return; }
    trapTab(e, el);
  });

  // ---- 內部 ----
  function paint(focus) {
    panes.forEach((p, i) => { p.pane.hidden = i !== index; });
    stepItems.forEach((li, i) => {
      li.classList.toggle('done', i < index);
      li.classList.toggle('current', i === index);
      const b = li.firstElementChild;
      if (i === index) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    countEl.textContent = `步驟 ${index + 1}／${total}`;
    prevBtn.disabled = index === 0;
    nextBtn.textContent = index === last ? '完成' : '下一步';
    msgEl.textContent = '';
    const art = panes[index]?.art;
    if (art) { art.classList.remove('play'); void art.offsetWidth; art.classList.add('play'); }   // 重播示意動畫
    if (focus) panes[index]?.heading.focus();
  }

  function enter(focus) {
    paint(focus);
    steps[index]?.onEnter?.(index);
  }

  /** 檢查第 i 步能不能離開；不能時顯示提示並回傳 false。 */
  function allowed(i) {
    const r = steps[i]?.canNext?.(i);
    if (r === false || (typeof r === 'string' && r)) {
      msgEl.textContent = typeof r === 'string' ? r : '';
      return false;
    }
    return true;
  }

  function finish(completed) {
    if (!isOpen) return;
    isOpen = false;
    el.remove();
    unlockScroll(el);
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    onClose?.({ completed });
  }

  async function requestClose() {
    if (confirming) return;
    confirming = true;
    try {
      const ok = await confirm({ title: '要離開導覽嗎？', message: '之後可以隨時重新開啟導覽。', okText: '離開', cancelText: '繼續導覽' });
      if (ok) finish(false);
    } finally {
      confirming = false;
    }
  }

  // ---- 公開 API ----
  const api = {
    el,
    get index() { return index; },
    open() {
      if (isOpen) return;
      isOpen = true;
      prevFocus = document.activeElement;
      lockScroll(el);
      document.body.append(el);
      enter(true);
    },
    /** 程式關閉（不詢問），onClose({completed:false})。 */
    close() { finish(false); },
    goTo(i) {
      if (i < 0 || i > last) return false;
      if (i === index) return true;
      for (let j = index; j < i; j++) if (!allowed(j)) { if (j !== index) { index = j; enter(true); allowed(j); } return false; }
      index = i;
      enter(true);
      return true;
    },
    next() {
      if (index === last) {
        if (!allowed(index)) return false;
        finish(true);
        return true;
      }
      return api.goTo(index + 1);
    },
    prev() { return api.goTo(index - 1); },
  };

  paint(false);
  return api;
}
