// 精靈（視覺同 LinePush 推播精靈 .lw-*）：分步面板、選項卡 opGroup、資訊框 box、確認清單 kv。
// 驗證失敗時留在原步驟並顯示訊息，不得前進。樣式見 wizard.css。
import { h, uid, trapTab, lockScroll, unlockScroll } from './util.js';
import { icon } from './icons.js';

/** createWizard({title, steps:[{id,label,render(state)→Node,validate(state)→string|null}], onSubmit(state), onCancel, initialState})
 *  → {el, state, index, open(), close(), goTo(i), next(), prev(), submit(), refresh()}
 *  el 是精靈面板；open() 以遮罩彈出，也可以直接把 el 放進自己的容器（內嵌）。 */
export function createWizard({ title = '', steps = [], onSubmit, onCancel, initialState = {} } = {}) {
  const state = { ...initialState };
  const tid = uid('nc-wiz-t');
  const last = steps.length - 1;
  let index = 0;
  let busy = false;
  let overlay = null;
  let prevFocus = null;

  // ---- 骨架 ----
  const stepsEl = h('ol', { class: 'nc-wiz-steps', 'aria-label': '步驟' });
  const stepBtns = steps.map((s, i) => {
    const b = h('button', { type: 'button', class: 'nc-wiz-step', 'aria-label': `步驟 ${i + 1}：${s.label}`, on: { click: () => api.goTo(i) } },
      h('i', { class: 'nc-wiz-num', 'aria-hidden': 'true', text: String(i + 1) }), h('b', { class: 'nc-wiz-lbl', text: s.label }));
    if (i > 0) stepsEl.append(h('li', { class: 'nc-wiz-line', 'aria-hidden': 'true' }));
    stepsEl.append(h('li', { class: 'nc-wiz-item' }, b));
    return b;
  });

  const bodyEl = h('div', { class: 'nc-wizard-body' });
  const errEl = h('p', { class: 'nc-wizard-error', role: 'alert', hidden: true });
  const prevBtn = h('button', { type: 'button', class: 'btn', 'data-action': 'prev', text: '上一步', on: { click: () => api.prev() } });
  const nextBtn = h('button', { type: 'button', class: 'btn primary', 'data-action': 'next', on: { click: () => (index === last ? api.submit() : api.next()) } });
  const el = h('div', { class: 'nc-wizard', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid, tabindex: '-1' },
    h('header', { class: 'nc-wizard-head' },
      h('h2', { class: 'nc-wizard-title', id: tid, text: title }),
      h('button', { type: 'button', class: 'nc-wizard-close', 'data-action': 'close', 'aria-label': '關閉', on: { click: () => cancel() } }, icon('close', { size: 18 }))),
    stepsEl, bodyEl, errEl,
    h('footer', { class: 'nc-wizard-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'cancel', text: '取消', on: { click: () => cancel() } }),
      h('span', { class: 'nc-wizard-spacer' }), prevBtn, nextBtn));

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    trapTab(e, el);
  });
  // 使用者動手修改任何欄位就清掉錯誤訊息
  for (const ev of ['input', 'change']) bodyEl.addEventListener(ev, () => showError(null));

  // ---- 內部 ----
  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  }

  function paint(focus) {
    const step = steps[index];
    const node = step?.render?.(state) || h('div');
    const pane = h('div', { class: 'nc-wizard-pane', tabindex: '-1', dataset: { step: step?.id ?? String(index) } }, node);
    bodyEl.replaceChildren(pane);
    stepBtns.forEach((b, i) => {
      const li = b.parentNode;
      b.classList.toggle('done', i < index);
      b.classList.toggle('on', i === index);
      if (i === index) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      li.previousElementSibling?.classList.toggle('done', i <= index);   // 連到已完成／目前步驟的線
    });
    prevBtn.disabled = index === 0 || busy;
    nextBtn.textContent = index === last ? '送出' : '下一步';
    nextBtn.disabled = busy;
    if (focus) (pane.querySelector('input,select,textarea,button') || pane).focus();
  }

  function setIndex(i, focus = true) {
    index = i;
    showError(null);
    paint(focus);
  }

  const check = (i) => steps[i]?.validate?.(state) || null;

  function cancel() {
    api.close();
    onCancel?.();
  }

  // ---- 公開 API ----
  const api = {
    el,
    state,
    get index() { return index; },
    /** 前進需逐步通過驗證；往回不驗證。成功回傳 true。 */
    goTo(i) {
      if (busy || i < 0 || i > last) return false;
      if (i <= index) { if (i < index) setIndex(i); return true; }
      for (let j = index; j < i; j++) {
        const err = check(j);
        if (err) {
          if (j !== index) setIndex(j);
          showError(err);
          return false;
        }
      }
      setIndex(i);
      return true;
    },
    next() { return api.goTo(index + 1); },
    prev() { return api.goTo(index - 1); },
    refresh() { paint(false); },
    async submit() {
      if (busy) return false;
      for (let j = 0; j <= last; j++) {
        const err = check(j);
        if (err) { if (j !== index) setIndex(j); showError(err); return false; }
      }
      busy = true;
      el.setAttribute('aria-busy', 'true');
      nextBtn.disabled = true; prevBtn.disabled = true;
      nextBtn.textContent = '處理中…';
      try {
        await onSubmit?.(state);
      } catch (e) {
        showError(e?.message || String(e));
        return false;
      } finally {
        busy = false;
        el.removeAttribute('aria-busy');
        paint(false);
      }
      api.close();
      return true;
    },
    open() {
      if (overlay) return;
      prevFocus = document.activeElement;
      overlay = h('div', { class: 'nc-wizard-overlay' }, el);
      lockScroll(overlay);
      document.body.append(overlay);
      paint(true);
    },
    close() {
      if (!overlay) return;
      const o = overlay;
      overlay = null;
      o.remove();
      unlockScroll(o);
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    },
  };

  paint(false);
  return api;
}

// ---- 附屬元件 ----

/** opGroup({options:[{value,label,hint?,disabled?}], value, onChange(v), ariaLabel}) → {el, value, setValue(v)}
 *  選項卡群組（role=radiogroup，方向鍵左右／上下切換並選取，頭尾循環）。setValue 不觸發 onChange。 */
export function opGroup({ options = [], value, onChange, ariaLabel } = {}) {
  let current = options.some((o) => o.value === value) ? value : undefined;
  const btns = options.map((o, i) => h('button', {
    type: 'button', class: 'nc-op', role: 'radio', disabled: o.disabled ? true : null, dataset: { value: String(o.value) },
    on: { click: () => choose(i, true) },
  }, o.label, o.hint ? h('small', { text: o.hint }) : null));
  const el = h('div', { class: 'nc-ops', role: 'radiogroup', 'aria-label': ariaLabel }, ...btns);

  function paint() {
    const sel = options.findIndex((o) => o.value === current);
    const firstEnabled = options.findIndex((o) => !o.disabled);
    btns.forEach((b, i) => {
      b.setAttribute('aria-checked', i === sel ? 'true' : 'false');
      b.classList.toggle('on', i === sel);
      b.tabIndex = i === (sel >= 0 ? sel : firstEnabled) ? 0 : -1;
    });
  }
  function choose(i, fire, focus) {
    const v = options[i].value;
    const changed = v !== current;
    current = v;
    paint();
    if (focus) btns[i].focus();
    if (changed && fire) onChange?.(v);
  }
  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length) return;
    e.preventDefault();
    const at = enabled.indexOf(options.findIndex((o) => o.value === current));
    const to = at < 0 ? enabled[dir > 0 ? 0 : enabled.length - 1] : enabled[(at + dir + enabled.length) % enabled.length];
    choose(to, true, true);
  });
  paint();
  return {
    el,
    get value() { return current; },
    setValue(v) { const i = options.findIndex((o) => o.value === v); if (i >= 0) { current = v; paint(); } },
  };
}

/** box(title, node) → 資訊框（圓角 14px、淡邊框）。 */
export function box(title, node) {
  return h('section', { class: 'nc-box' }, title ? h('div', { class: 'nc-box-title', text: title }) : null, node);
}

/** kv([[key, value], ...]) → 確認清單 <dl>。value 可為字串（純文字）或 Node。 */
export function kv(pairs = []) {
  const dl = h('dl', { class: 'nc-kv' });
  for (const [k, v] of pairs) {
    dl.append(h('dt', { text: k }), h('dd', {}, v === undefined || v === null || v === '' ? '—' : v));
  }
  return dl;
}

/** field(state, {name,label,type,placeholder,hint,options,rows,required}) → 綁定 state[name] 的欄位。
 *  type: text／number／password／textarea／select（select 需 options:[{value,label}]）。數值也以字串存入。 */
export function field(state, { name, label = '', type = 'text', placeholder, hint, options = [], rows = 3, required = false } = {}) {
  let control;
  if (type === 'select') {
    control = h('select', { class: 'input', name }, ...options.map((o) => h('option', { value: o.value, text: o.label })));
    if (state[name] === undefined && options.length) state[name] = options[0].value;
  } else if (type === 'textarea') {
    control = h('textarea', { class: 'input', name, rows, placeholder });
  } else {
    control = h('input', { class: 'input', name, type, placeholder });
  }
  control.value = state[name] ?? '';
  if (required) control.setAttribute('aria-required', 'true');
  const sync = () => { state[name] = control.value; };
  control.addEventListener('input', sync);
  control.addEventListener('change', sync);
  return h('label', { class: 'nc-field' },
    h('span', { class: 'nc-field-label' }, label, required ? h('em', { class: 'nc-req', 'aria-hidden': 'true', text: ' *' }) : null),
    control, hint ? h('small', { class: 'nc-field-hint', text: hint }) : null);
}
