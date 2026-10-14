import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, key, click, tick, $, $$, document } from './helpers.mjs';
import { createGuide } from '../../../web/ui/guide.js';

test.beforeEach(reset);

const ART = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

function make(over = {}) {
  const log = { enter: [], close: [] };
  const mk = (n, extra = {}) => ({
    label: `步驟${n}`, art: ART, body: Object.assign(document.createElement('p'), { textContent: `內容${n}` }),
    onEnter: () => log.enter.push(n), ...extra,
  });
  const g = createGuide({
    title: '首次導覽', subtitle: '約 3 分鐘',
    steps: [mk(1), mk(2), mk(3)],
    onClose: (info) => log.close.push(info),
    ...over,
  });
  g.open();
  return { g, log };
}
const shown = (g) => $$(g.el, '.nc-guide-pane').map((p) => !p.hidden);
const btn = (g, a) => $(g.el, `[data-action="${a}"]`);

test('open() 掛到 body、鎖捲動、設定 dialog 屬性、顯示第 1 步並呼叫 onEnter', () => {
  const { g, log } = make();
  assert.equal(g.el.parentNode, document.body);
  assert.equal(g.el.getAttribute('role'), 'dialog');
  assert.equal(g.el.getAttribute('aria-modal'), 'true');
  assert.ok(document.documentElement.classList.contains('nc-lock'));
  assert.deepEqual(shown(g), [true, false, false]);
  assert.deepEqual(log.enter, [1]);
  assert.equal($(g.el, '.nc-guide-count').textContent, '步驟 1／3');
  assert.equal(btn(g, 'prev').disabled, true);
});

test('下一步／上一步切換窗格、更新點列與計數', () => {
  const { g, log } = make();
  click(btn(g, 'next'));
  assert.deepEqual(shown(g), [false, true, false]);
  assert.equal($(g.el, '.nc-guide-count').textContent, '步驟 2／3');
  const steps = $$(g.el, '.nc-guide-step');
  assert.ok(steps[0].classList.contains('done'));
  assert.ok(steps[1].classList.contains('current'));
  assert.equal($$(g.el, '.nc-guide-step-btn')[1].getAttribute('aria-current'), 'step');
  click(btn(g, 'prev'));
  assert.deepEqual(shown(g), [true, false, false]);
  assert.deepEqual(log.enter, [1, 2, 1]);
});

test('步驟點列可點選跳到該步', () => {
  const { g } = make();
  click($$(g.el, '.nc-guide-step-btn')[2]);
  assert.equal(g.index, 2);
  click($$(g.el, '.nc-guide-step-btn')[0]);
  assert.equal(g.index, 0);
});

test('canNext 回傳 false 會擋住前進；字串會當成提示顯示', () => {
  let ok = false;
  const { g } = make({
    steps: [
      { label: 'A', art: ART, body: document.createElement('p'), canNext: () => (ok ? true : '請先完成設定') },
      { label: 'B', art: ART, body: document.createElement('p') },
    ],
  });
  click(btn(g, 'next'));
  assert.equal(g.index, 0);
  assert.equal($(g.el, '.nc-guide-msg').textContent, '請先完成設定');
  click($$(g.el, '.nc-guide-step-btn')[1]);   // 點列往後跳也要被擋
  assert.equal(g.index, 0);
  ok = true;
  click(btn(g, 'next'));
  assert.equal(g.index, 1);
  assert.equal($(g.el, '.nc-guide-msg').textContent, '');
});

test('canNext 回傳 false（無訊息）也擋住', () => {
  const { g } = make({ steps: [{ label: 'A', art: ART, body: document.createElement('p'), canNext: () => false }, { label: 'B', art: ART, body: document.createElement('p') }] });
  assert.equal(g.next(), false);
  assert.equal(g.index, 0);
});

test('最後一步按鈕為「完成」，按下關閉並回報 completed', () => {
  const { g, log } = make();
  g.goTo(2);
  assert.equal(btn(g, 'next').textContent, '完成');
  click(btn(g, 'next'));
  assert.deepEqual(log.close, [{ completed: true }]);
  assert.equal(g.el.parentNode, null);
  assert.equal(document.documentElement.classList.contains('nc-lock'), false);
});

test('Esc 先確認：取消則留在導覽，確定才關閉', async () => {
  const { g, log } = make();
  key(g.el, 'Escape');
  await tick();
  assert.ok($(document, '.nc-dialog'));
  click($(document, '[data-action="cancel"]'));
  await tick();
  assert.equal(log.close.length, 0);
  assert.ok(g.el.parentNode);

  key(g.el, 'Escape');
  await tick();
  click($(document, '[data-action="ok"]'));
  await tick();
  assert.deepEqual(log.close, [{ completed: false }]);
  assert.equal(g.el.parentNode, null);
});

test('右上角 ✕ 同樣先確認', async () => {
  const { g, log } = make();
  click($(g.el, '[data-action="close"]'));
  await tick();
  assert.ok($(document, '.nc-dialog'));
  click($(document, '[data-action="ok"]'));
  await tick();
  assert.equal(log.close.length, 1);
  assert.equal(g.el.parentNode, null);
});

test('焦點陷阱：Tab 在最後一個可聚焦元素時回到第一個，Shift+Tab 反向', () => {
  const { g } = make();
  const items = $$(g.el, 'button:not([disabled])').filter((b) => !b.closest('[hidden]'));
  const first = items[0]; const last = items[items.length - 1];
  last.focus();
  assert.equal(key(g.el, 'Tab').defaultPrevented, true);
  assert.equal(document.activeElement, first);
  first.focus();
  assert.equal(key(g.el, 'Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement, last);
});

test('關閉後焦點還給開啟前的元素', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const { g } = make();
  g.close();
  assert.equal(document.activeElement, opener);
});

test('art：字串 SVG 會被淨化（移除 script、事件屬性、style），SVGElement 原樣放入', () => {
  const dirty = '<svg viewBox="0 0 1 1" onload="x()"><script>alert(1)</script><rect style="fill:red" onclick="y()" width="1" height="1"/><foreignObject><div>hi</div></foreignObject></svg>';
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('class', 'mine');
  const { g } = make({ steps: [{ label: 'A', art: dirty, body: document.createElement('p') }, { label: 'B', art: el, body: document.createElement('p') }] });
  const art = $$(g.el, '.nc-guide-art');
  assert.ok($(art[0], 'svg'));
  assert.equal($(art[0], 'script'), null);
  assert.equal($(art[0], 'foreignObject'), null);
  assert.equal($(art[0], 'svg').hasAttribute('onload'), false);
  assert.equal($(art[0], 'rect').hasAttribute('onclick'), false);
  assert.equal($(art[0], 'rect').hasAttribute('style'), false);
  assert.equal($(art[1], 'svg.mine'), el);
});

test('body 以 Node 放入對應窗格；標題與副標題為純文字', () => {
  const { g } = make({ title: '<b>T</b>' });
  assert.equal($(g.el, '.nc-guide-title h2').textContent, '<b>T</b>');
  assert.equal($(g.el, '.nc-guide-title b'), null);
  assert.equal($$(g.el, '.nc-guide-pane')[1].textContent.includes('內容2'), true);
});
