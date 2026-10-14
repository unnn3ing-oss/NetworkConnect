import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, key, click, $, $$, document } from './helpers.mjs';
import { createSegmented } from '../../../web/ui/segmented.js';
import { createChips } from '../../../web/ui/chips.js';
import { createEmpty } from '../../../web/ui/empty.js';

test.beforeEach(reset);

const OPTS = [{ value: '1', label: '1 格' }, { value: '4', label: '4 格' }, { value: '9', label: '9 格' }];

test('segmented：初始選取、點選觸發 onChange、aria-checked', () => {
  const seen = [];
  const s = createSegmented({ options: OPTS, value: '4', onChange: (v) => seen.push(v), ariaLabel: '分割數' });
  document.body.append(s.el);
  assert.equal(s.value, '4');
  assert.equal(s.el.getAttribute('role'), 'radiogroup');
  const bs = $$(s.el, 'button');
  assert.deepEqual(bs.map((b) => b.getAttribute('aria-checked')), ['false', 'true', 'false']);
  click(bs[2]);
  assert.equal(s.value, '9');
  assert.deepEqual(seen, ['9']);
  click(bs[2]);                                 // 重複點同一項不再觸發
  assert.deepEqual(seen, ['9']);
});

test('segmented：方向鍵移動並選取、Home/End、roving tabindex', () => {
  const s = createSegmented({ options: OPTS, value: '1' });
  document.body.append(s.el);
  const bs = $$(s.el, 'button');
  key(bs[0], 'ArrowRight');
  assert.equal(s.value, '4');
  assert.equal(document.activeElement, bs[1]);
  key(bs[1], 'End');
  assert.equal(s.value, '9');
  key(bs[2], 'Home');
  assert.equal(s.value, '1');
  key(bs[0], 'ArrowLeft');
  assert.equal(s.value, '9');
  assert.deepEqual(bs.map((b) => b.tabIndex), [-1, -1, 0]);
});

test('segmented：setValue 預設不觸發 onChange；tablist 模式用 role=tab', () => {
  const seen = [];
  const s = createSegmented({ options: OPTS, value: '1', onChange: (v) => seen.push(v), role: 'tablist' });
  assert.equal(s.el.getAttribute('role'), 'tablist');
  assert.equal($(s.el, 'button').getAttribute('role'), 'tab');
  assert.equal($(s.el, 'button').getAttribute('aria-selected'), 'true');
  s.setValue('9');
  assert.equal(s.value, '9');
  assert.equal(seen.length, 0);
});

test('chips：多選切換、onChange 帶陣列、aria-pressed', () => {
  const seen = [];
  const c = createChips({ options: [{ value: 'a', label: 'A', count: 3 }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], onChange: (v) => seen.push(v), ariaLabel: '樓層' });
  document.body.append(c.el);
  const bs = $$(c.el, 'button.chip');
  click(bs[0]); click(bs[2]);
  assert.deepEqual(c.value, ['a', 'c']);
  assert.deepEqual(seen, [['a'], ['a', 'c']]);
  assert.equal(bs[0].getAttribute('aria-pressed'), 'true');
  assert.equal(bs[1].getAttribute('aria-pressed'), 'false');
  assert.match(bs[0].textContent, /A.*3/);
  click(bs[0]);
  assert.deepEqual(c.value, ['c']);
});

test('chips：multiple:false 為單選；allLabel 的「全部」會清空選取', () => {
  const c = createChips({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], multiple: false, allLabel: '全部' });
  document.body.append(c.el);
  const bs = $$(c.el, 'button.chip');
  assert.equal(bs[0].textContent, '全部');
  assert.equal(bs[0].getAttribute('aria-pressed'), 'true');   // 沒選任何項 = 全部
  click(bs[1]);
  click(bs[2]);
  assert.deepEqual(c.value, ['b']);
  assert.equal(bs[0].getAttribute('aria-pressed'), 'false');
  click(bs[0]);
  assert.deepEqual(c.value, []);
});

test('chips：setValue 與 setOptions 會丟掉不存在的值', () => {
  const c = createChips({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  c.setValue(['a', 'zzz']);
  assert.deepEqual(c.value, ['a']);
  c.setOptions([{ value: 'b', label: 'B' }]);
  assert.deepEqual(c.value, []);
  assert.equal($$(c.el, 'button.chip').length, 1);
});

test('empty：圖示、標題、說明與主要按鈕', () => {
  let n = 0;
  const e = createEmpty({ icon: 'inventory', title: '還沒有設備', description: '先新增第一台', actionLabel: '新增設備', onAction: () => { n += 1; } });
  document.body.append(e);
  assert.ok(e.classList.contains('nc-empty'));
  assert.ok($(e, 'svg.nc-icon'));
  assert.equal($(e, '.nc-empty-title').textContent, '還沒有設備');
  assert.equal($(e, '.nc-empty-desc').textContent, '先新增第一台');
  const b = $(e, 'button.btn.primary');
  assert.equal(b.textContent, '新增設備');
  click(b);
  assert.equal(n, 1);
});

test('empty：沒有 actionLabel 就不出現按鈕', () => {
  const e = createEmpty({ title: 't' });
  assert.equal($(e, 'button'), null);
});
