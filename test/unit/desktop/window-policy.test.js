import test from 'node:test';
import assert from 'node:assert/strict';
import { isAppUrl, isSafeExternalUrl, parseActionUrl, ACTION_SCHEME } from '../../../desktop/lib/window-policy.js';

test('isAppUrl：只接受 http://127.0.0.1:<實際埠>', () => {
  assert.equal(isAppUrl('http://127.0.0.1:8780/', 8780), true);
  assert.equal(isAppUrl('http://127.0.0.1:8780/#/devices?q=1', 8780), true);
  assert.equal(isAppUrl('http://127.0.0.1:8781/', 8780), false);
  assert.equal(isAppUrl('http://localhost:8780/', 8780), false);
  assert.equal(isAppUrl('http://192.168.1.2:8780/', 8780), false);
  assert.equal(isAppUrl('https://127.0.0.1:8780/', 8780), false);
  assert.equal(isAppUrl('http://127.0.0.1:8780.evil.com/', 8780), false);
  assert.equal(isAppUrl('http://127.0.0.1@evil.com:8780/', 8780), false);
  assert.equal(isAppUrl('file:///etc/passwd', 8780), false);
  assert.equal(isAppUrl('not a url', 8780), false);
  assert.equal(isAppUrl('http://127.0.0.1:8780/', null), false);
});

test('isSafeExternalUrl：只允許 http／https', () => {
  assert.equal(isSafeExternalUrl('https://example.com/a?b=c'), true);
  assert.equal(isSafeExternalUrl('http://192.168.1.1/'), true);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('smb://server/share'), false);
  assert.equal(isSafeExternalUrl('x-apple.systempreferences:com.apple.preference.security'), false);
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl(undefined), false);
});

test('parseActionUrl：錯誤頁的內部動作連結', () => {
  assert.equal(ACTION_SCHEME, 'nc-action:');
  assert.equal(parseActionUrl('nc-action://restart'), 'restart');
  assert.equal(parseActionUrl('nc-action://open-logs'), 'open-logs');
  assert.equal(parseActionUrl('nc-action://rm-rf'), null);
  assert.equal(parseActionUrl('https://nc-action//restart'), null);
  assert.equal(parseActionUrl('garbage'), null);
});
