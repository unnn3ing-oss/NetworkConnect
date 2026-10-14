import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, key, click, tick, $, $$, document } from './helpers.mjs';
import { createWizard, opGroup, box, kv, field } from '../../../web/ui/wizard.js';

test.beforeEach(reset);

function make(over = {}) {
  const calls = { submit: [], cancel: 0 };
  const w = createWizard({
    title: '新增設備',
    steps: [
      {
        id: 'name', label: '基本資料',
        render: (s) => { const i = document.createElement('input'); i.className = 'in-name'; i.value = s.name || ''; i.addEventListener('input', () => { s.name = i.value; }); return i; },
        validate: (s) => (s.name ? null : '請輸入名稱'),
      },
      { id: 'cat', label: '類別', render: () => document.createElement('div'), validate: (s) => (s.cat ? null : '請選擇類別') },
      { id: 'ok', label: '確認', render: (s) => kv([['名稱', s.name], ['類別', s.cat]]) },
    ],
    onSubmit: async (s) => { calls.submit.push({ ...s }); },
    onCancel: () => { calls.cancel += 1; },
    ...over,
  });
  document.body.append(w.el);
  return { w, calls };
}
const next = (w) => click($(w.el, '[data-action="next"]'));
const prev = (w) => click($(w.el, '[data-action="prev"]'));

test('初始顯示第 1 步，上一步不可用，步驟列數量正確', () => {
  const { w } = make();
  assert.equal(w.index, 0);
  assert.ok($(w.el, '.in-name'));
  assert.equal($(w.el, '[data-action="prev"]').disabled, true);
  assert.equal($$(w.el, '.nc-wiz-step').length, 3);
  assert.equal($(w.el, '.nc-wiz-step[aria-current="step"]').textContent.includes('基本資料'), true);
});

test('驗證失敗：不能前進，並在步驟內顯示訊息', () => {
  const { w } = make();
  next(w);
  assert.equal(w.index, 0);
  const err = $(w.el, '.nc-wizard-error');
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, '請輸入名稱');
  assert.equal(err.getAttribute('role'), 'alert');
});

test('驗證通過：前進、清除訊息；上一步退回且保留 state', () => {
  const { w } = make();
  next(w);
  w.state.name = 'AP-1';
  next(w);
  assert.equal(w.index, 1);
  assert.equal($(w.el, '.nc-wizard-error').hidden, true);
  prev(w);
  assert.equal(w.index, 0);
  assert.equal($(w.el, '.in-name').value, 'AP-1');
});

test('點選步驟列：往前可直接跳；往後必須逐步通過驗證', () => {
  const { w } = make();
  w.state.name = 'a';
  assert.equal(w.goTo(2), false);          // 第 2 步 cat 沒通過
  assert.equal(w.index, 1);
  assert.match($(w.el, '.nc-wizard-error').textContent, /請選擇類別/);
  w.state.cat = 'router';
  assert.equal(w.goTo(2), true);
  assert.equal(w.index, 2);
  assert.equal(w.goTo(0), true);
  assert.equal(w.index, 0);
});

test('步驟列按鈕在 DOM 上也能點', () => {
  const { w } = make();
  w.state.name = 'x'; w.state.cat = 'y';
  click($$(w.el, '.nc-wiz-step')[2]);
  assert.equal(w.index, 2);
  assert.equal($$(w.el, '.nc-wiz-step')[0].classList.contains('done'), true);
});

test('最後一步按鈕為「送出」，呼叫 onSubmit 一次並帶入 state', async () => {
  const { w, calls } = make();
  w.state.name = 'AP-1'; w.state.cat = 'ap';
  w.goTo(2);
  const btn = $(w.el, '[data-action="next"]');
  assert.equal(btn.textContent, '送出');
  click(btn); click(btn);                  // 連點只算一次
  await tick();
  assert.equal(calls.submit.length, 1);
  assert.deepEqual(calls.submit[0], { name: 'AP-1', cat: 'ap' });
});

test('送出時前面步驟被改成無效：回到該步並顯示訊息，不呼叫 onSubmit', async () => {
  const { w, calls } = make();
  w.state.name = 'a'; w.state.cat = 'b';
  w.goTo(2);
  w.state.name = '';
  assert.equal(await w.submit(), false);
  assert.equal(calls.submit.length, 0);
  assert.equal(w.index, 0);
  assert.equal($(w.el, '.nc-wizard-error').textContent, '請輸入名稱');
});

test('onSubmit 丟錯：顯示錯誤、停在最後一步、可再送出', async () => {
  let n = 0;
  const { w } = make({ onSubmit: async () => { n += 1; if (n === 1) throw new Error('伺服器忙碌'); } });
  w.state.name = 'a'; w.state.cat = 'b';
  w.goTo(2);
  assert.equal(await w.submit(), false);
  assert.equal($(w.el, '.nc-wizard-error').textContent, '伺服器忙碌');
  assert.equal(w.index, 2);
  assert.equal(await w.submit(), true);
});

test('取消按鈕與 Esc 呼叫 onCancel', () => {
  const { w, calls } = make();
  click($(w.el, '[data-action="cancel"]'));
  key(w.el, 'Escape');
  assert.equal(calls.cancel, 2);
});

test('open() 以遮罩呈現並鎖捲動，close() 還原', () => {
  const w = createWizard({ title: 't', steps: [{ id: 'a', label: 'A', render: () => document.createElement('p') }], onSubmit() {} });
  w.open();
  assert.ok($(document, '.nc-wizard-overlay .nc-wizard'));
  assert.ok(document.documentElement.classList.contains('nc-lock'));
  w.close();
  assert.equal($(document, '.nc-wizard-overlay'), null);
  assert.equal(document.documentElement.classList.contains('nc-lock'), false);
});

test('opGroup：radiogroup、roving tabindex、方向鍵左右切換並 wrap', () => {
  const seen = [];
  const g = opGroup({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], value: 'a', onChange: (v) => seen.push(v), ariaLabel: '類別' });
  document.body.append(g.el);
  assert.equal(g.el.getAttribute('role'), 'radiogroup');
  const radios = $$(g.el, '[role="radio"]');
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.deepEqual(radios.map((r) => r.tabIndex), [0, -1, -1]);
  key(radios[0], 'ArrowRight');
  assert.equal(g.value, 'b');
  assert.equal(document.activeElement, radios[1]);
  key(radios[1], 'ArrowRight');
  key(radios[2], 'ArrowRight');            // wrap 回 a
  assert.equal(g.value, 'a');
  key(radios[0], 'ArrowLeft');             // wrap 到 c
  assert.equal(g.value, 'c');
  assert.deepEqual(seen, ['b', 'c', 'a', 'c']);
  assert.deepEqual(radios.map((r) => r.tabIndex), [-1, -1, 0]);
});

test('opGroup：略過 disabled、點選會選取、setValue 不觸發 onChange', () => {
  const seen = [];
  const g = opGroup({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }], value: 'a', onChange: (v) => seen.push(v) });
  const radios = $$(g.el, '[role="radio"]');
  key(radios[0], 'ArrowRight');
  assert.equal(g.value, 'c');
  click(radios[0]);
  assert.equal(g.value, 'a');
  g.setValue('c');
  assert.equal(seen.length, 2);
  assert.equal(radios[2].getAttribute('aria-checked'), 'true');
});

test('box / kv：結構與純文字', () => {
  const b = box('標題', kv([['名稱', '<i>x</i>'], ['IP', '192.168.1.1']]));
  assert.ok(b.classList.contains('nc-box'));
  assert.equal($(b, '.nc-box-title').textContent, '標題');
  assert.equal($$(b, 'dt').length, 2);
  assert.equal($(b, 'i'), null);
  assert.equal($$(b, 'dd')[1].textContent, '192.168.1.1');
});

test('field：雙向綁定 state', () => {
  const state = { ip: '1.1.1.1' };
  const f = field(state, { name: 'ip', label: 'IP' });
  document.body.append(f);
  const input = $(f, 'input');
  assert.equal(input.value, '1.1.1.1');
  input.value = '2.2.2.2';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(state.ip, '2.2.2.2');
  assert.equal($(f, 'label, .nc-field-label').textContent.includes('IP'), true);
});
