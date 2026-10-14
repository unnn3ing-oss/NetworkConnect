import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, key, click, tick, $, document } from './helpers.mjs';
import { confirm, alert } from '../../../web/ui/dialog.js';

test.beforeEach(reset);

test('confirm：按確定回傳 true 並移除對話框', async () => {
  const p = confirm({ title: '刪除設備', message: '確定嗎？' });
  const dlg = $(document, '.nc-dialog');
  assert.ok(dlg);
  assert.equal(dlg.getAttribute('role'), 'alertdialog');
  assert.match(dlg.textContent, /刪除設備/);
  click($(dlg, '[data-action="ok"]'));
  assert.equal(await p, true);
  assert.equal($(document, '.nc-dialog'), null);
});

test('confirm：按取消、Esc、點遮罩都回傳 false', async () => {
  let p = confirm({ title: 'a' });
  click($(document, '[data-action="cancel"]'));
  assert.equal(await p, false);

  p = confirm({ title: 'b' });
  key($(document, '.nc-dialog'), 'Escape');
  assert.equal(await p, false);

  p = confirm({ title: 'c' });
  click($(document, '.nc-dialog-overlay'));
  assert.equal(await p, false);
  assert.equal($(document, '.nc-dialog-overlay'), null);
});

test('confirm：點對話框內部不會被當成點遮罩', async () => {
  const p = confirm({ title: 'x', message: 'y' });
  click($(document, '.nc-dialog'));
  assert.ok($(document, '.nc-dialog'));
  click($(document, '[data-action="ok"]'));
  assert.equal(await p, true);
});

test('confirm：danger 使用 .btn.danger，預設焦點在取消；一般則在確定', async () => {
  let p = confirm({ title: 'd', danger: true, okText: '刪除' });
  assert.ok($(document, '[data-action="ok"].btn.danger'));
  assert.equal($(document, '[data-action="ok"]').textContent, '刪除');
  assert.equal(document.activeElement, $(document, '[data-action="cancel"]'));
  click($(document, '[data-action="cancel"]'));
  await p;
  p = confirm({ title: 'e' });
  assert.ok($(document, '[data-action="ok"].btn.primary'));
  assert.equal(document.activeElement, $(document, '[data-action="ok"]'));
  click($(document, '[data-action="ok"]'));
  await p;
});

test('confirm：訊息以純文字顯示，不解析 HTML', async () => {
  const p = confirm({ title: '<b>t</b>', message: '<img src=x onerror=alert(1)>' });
  assert.equal($(document, '.nc-dialog img'), null);
  assert.equal($(document, '.nc-dialog b'), null);
  click($(document, '[data-action="cancel"]'));
  await p;
});

test('confirm：Tab 焦點留在對話框內（陷阱）', async () => {
  const p = confirm({ title: 't' });
  const ok = $(document, '[data-action="ok"]');
  ok.focus();
  const ev = key($(document, '.nc-dialog'), 'Tab');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(document.activeElement, $(document, '[data-action="cancel"]'));
  click(ok);
  await p;
});

test('confirm：關閉後焦點還給原本的元素', async () => {
  const btn = document.createElement('button');
  document.body.append(btn);
  btn.focus();
  const p = confirm({ title: 't' });
  click($(document, '[data-action="cancel"]'));
  await p;
  assert.equal(document.activeElement, btn);
});

test('alert：只有一顆按鈕，關閉後 resolve', async () => {
  const p = alert({ title: '提示', message: '完成' });
  assert.equal(document.querySelectorAll('.nc-dialog [data-action]').length, 1);
  click($(document, '[data-action="ok"]'));
  await p;
  await tick();
  assert.equal($(document, '.nc-dialog'), null);
});
