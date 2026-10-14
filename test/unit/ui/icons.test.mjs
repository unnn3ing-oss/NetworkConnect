import test from 'node:test';
import assert from 'node:assert/strict';
import { reset } from './helpers.mjs';
import { icon, iconSvg, iconNames, categoryIcons, navIcons } from '../../../web/ui/icons.js';

const BUILTIN = ['modem', 'router', 'mesh', 'switch', 'poe-switch', 'ap', 'nvr', 'camera', 'computer', 'phone', 'tv', 'smart-home', 'printer', 'nas', 'other'];

test.beforeEach(reset);

test('內建 15 類設備都有圖示', () => {
  for (const n of BUILTIN) assert.ok(iconNames.includes(n), n);
  assert.deepEqual([...categoryIcons].sort(), [...BUILTIN].sort());
});

test('主導覽圖示齊全', () => {
  for (const n of ['overview', 'topology', 'floorplan', 'inventory', 'monitor', 'status', 'settings']) {
    assert.ok(navIcons.includes(n), n);
    assert.ok(iconNames.includes(n), n);
  }
});

test('每個圖示都是靜態 SVG：無 script、無行內 style、無事件屬性', () => {
  for (const n of iconNames) {
    const s = iconSvg(n);
    assert.match(s, /^<svg /, n);
    assert.doesNotMatch(s, /<script|style=|\son\w+=|href=/i, n);
  }
});

test('icon() 回傳 SVG 元素，預設 aria-hidden，帶標題時改為 img', () => {
  const a = icon('router', { size: 24 });
  assert.equal(a.tagName.toLowerCase(), 'svg');
  assert.ok(a.classList.contains('nc-icon'));
  assert.equal(a.getAttribute('width'), '24');
  assert.equal(a.getAttribute('aria-hidden'), 'true');
  const b = icon('router', { title: '路由器' });
  assert.equal(b.getAttribute('role'), 'img');
  assert.equal(b.getAttribute('aria-label'), '路由器');
  assert.equal(b.hasAttribute('aria-hidden'), false);
});

test('未知名稱退回 other，不丟錯', () => {
  assert.equal(icon('no-such-icon').getAttribute('data-icon'), 'other');
});
