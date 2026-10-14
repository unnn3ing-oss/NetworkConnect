import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { reset, key, click, $, $$, document } from './helpers.mjs';
import { toast } from '../../../web/ui/toast.js';
import { createDrawer } from '../../../web/ui/drawer.js';

test.beforeEach(reset);
test.afterEach(() => mock.timers.reset());

test('toast：顯示訊息、aria-live、逾時後自動移除', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  toast('已儲存', { type: 'ok', duration: 2000 });
  const host = $(document, '.nc-toasts');
  assert.equal(host.getAttribute('aria-live'), 'polite');
  const t = $(host, '.nc-toast');
  assert.equal(t.dataset.type, 'ok');
  assert.equal(t.textContent.includes('已儲存'), true);
  mock.timers.tick(1999);
  assert.ok($(host, '.nc-toast'));
  mock.timers.tick(1);
  mock.timers.tick(400);                       // 離場動畫
  assert.equal($(host, '.nc-toast'), null);
});

test('toast：純文字、錯誤類型用 role=alert、可手動關閉、duration:0 不自動消失', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = toast('<b>x</b>', { type: 'error', duration: 0 });
  const t = $(document, '.nc-toast');
  assert.equal($(t, 'b'), null);
  assert.equal(t.getAttribute('role'), 'alert');
  mock.timers.tick(60000);
  assert.ok($(document, '.nc-toast'));
  click($(t, '.nc-toast-close'));
  mock.timers.tick(400);
  assert.equal($(document, '.nc-toast'), null);
  h.dismiss();                                 // 重複關閉不丟錯
});

test('toast：最多同時 4 則，超過會擠掉最舊的；快捷方法', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 6; i++) toast(`m${i}`, { duration: 0 });
  mock.timers.tick(400);
  const items = $$(document, '.nc-toast');
  assert.equal(items.length, 4);
  assert.match(items[0].textContent, /m2/);
  toast.success('ok');
  toast.error('bad');
  assert.ok($$(document, '.nc-toast').some((x) => x.dataset.type === 'ok'));
});

test('drawer：open/close、Esc、點遮罩、焦點還原、鎖捲動', () => {
  const closed = [];
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const body = document.createElement('p');
  body.textContent = '內容';
  const d = createDrawer({ title: '設備資料', content: body, onClose: () => closed.push(1) });
  assert.equal(d.isOpen, false);
  d.open();
  assert.equal(d.isOpen, true);
  assert.equal($(document, '.nc-drawer').getAttribute('role'), 'dialog');
  assert.equal($(document, '.nc-drawer-title').textContent, '設備資料');
  assert.ok($(document, '.nc-drawer-body p'));
  assert.ok(document.documentElement.classList.contains('nc-lock'));
  key($(document, '.nc-drawer'), 'Escape');
  assert.equal(d.isOpen, false);
  assert.equal(document.activeElement, opener);
  assert.equal(document.documentElement.classList.contains('nc-lock'), false);

  d.open();
  click($(document, '.nc-drawer-overlay'));
  assert.equal(d.isOpen, false);
  assert.equal(closed.length, 2);
});

test('drawer：setContent / setTitle 可在開啟中更新；點抽屜內部不關閉', () => {
  const d = createDrawer({ title: 'a', content: document.createElement('div') });
  d.open();
  const n = document.createElement('span');
  n.className = 'new';
  d.setContent(n);
  d.setTitle('b');
  assert.ok($(document, '.nc-drawer-body .new'));
  assert.equal($(document, '.nc-drawer-title').textContent, 'b');
  click($(document, '.nc-drawer'));
  assert.equal(d.isOpen, true);
  click($(document, '.nc-drawer-close'));
  assert.equal(d.isOpen, false);
});
