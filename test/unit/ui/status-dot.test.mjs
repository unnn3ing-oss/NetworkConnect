import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, document } from './helpers.mjs';
import { statusInfo, createStatusDot } from '../../../web/ui/status-dot.js';

test.beforeEach(reset);

test('statusInfo：up → 綠色「正常」', () => {
  const s = statusInfo('up', true);
  assert.equal(s.state, 'up');
  assert.equal(s.label, '正常');
});

test('statusInfo：down 且 critical → 紅色警示；非關鍵 → 灰色離線', () => {
  assert.equal(statusInfo('down', true).state, 'down');
  assert.equal(statusInfo('down', true).label, '離線警示');
  assert.equal(statusInfo('down', false).state, 'offline');
  assert.equal(statusInfo('down', false).label, '離線');
  assert.equal(statusInfo('down').state, 'offline');
});

test('statusInfo：unknown 黃、disabled 停用、未知值視為 unknown', () => {
  assert.equal(statusInfo('unknown').state, 'unknown');
  assert.equal(statusInfo('disabled').state, 'disabled');
  assert.equal(statusInfo('disabled').label, '未監控');
  assert.equal(statusInfo('???').state, 'unknown');
  assert.equal(statusInfo(undefined).state, 'unknown');
});

test('createStatusDot：data-state、class、文字、aria 與 update', () => {
  const el = createStatusDot({ status: 'down', critical: true });
  document.body.append(el);
  assert.equal(el.dataset.state, 'down');
  assert.ok(el.classList.contains('nc-status'));
  assert.equal(el.textContent.trim(), '離線警示');
  el.update({ status: 'up' });
  assert.equal(el.dataset.state, 'up');
  assert.equal(el.textContent.trim(), '正常');
  const quiet = createStatusDot({ status: 'up', showLabel: false });
  assert.equal(quiet.querySelector('.nc-status-label'), null);
  assert.equal(quiet.getAttribute('role'), 'img');
  assert.equal(quiet.getAttribute('aria-label'), '正常');
});
