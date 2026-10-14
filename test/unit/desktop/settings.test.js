import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SETTINGS, loadDesktopSettings, saveDesktopSettings, normalizeSettings } from '../../../desktop/lib/settings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desktop-'));

test('檔案不存在時回預設值，且不建立檔案', () => {
  const dir = tmp();
  assert.deepEqual(loadDesktopSettings(dir), DEFAULT_SETTINGS);
  assert.equal(fs.existsSync(path.join(dir, 'desktop-settings.json')), false);
});

test('預設值：區網連線開啟，自動啟動與防止睡眠關閉', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { autoLaunch: false, preventSleep: false, lanAccess: true, port: null });
});

test('儲存後可讀回，並以原子寫入（不留 tmp 檔）', () => {
  const dir = tmp();
  saveDesktopSettings(dir, { autoLaunch: true, preventSleep: true, lanAccess: false, port: 8800 });
  assert.deepEqual(loadDesktopSettings(dir), { autoLaunch: true, preventSleep: true, lanAccess: false, port: 8800 });
  assert.deepEqual(fs.readdirSync(dir), ['desktop-settings.json']);
});

test('損毀的檔案退回預設值並備份', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'desktop-settings.json'), '{ not json');
  assert.deepEqual(loadDesktopSettings(dir), DEFAULT_SETTINGS);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('desktop-settings.json.corrupt-')));
});

test('normalizeSettings：型別錯誤的欄位退回預設，未知欄位丟棄', () => {
  assert.deepEqual(
    normalizeSettings({ autoLaunch: 'yes', preventSleep: 1, lanAccess: false, port: 70000, extra: true }),
    { autoLaunch: false, preventSleep: false, lanAccess: false, port: null },
  );
  assert.equal(normalizeSettings({ port: 8800 }).port, 8800);
  assert.equal(normalizeSettings({ port: 0 }).port, 0);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
});

test('saveDesktopSettings 會先 normalize', () => {
  const dir = tmp();
  const saved = saveDesktopSettings(dir, { autoLaunch: 'x', lanAccess: false });
  assert.equal(saved.autoLaunch, false);
  assert.equal(saved.lanAccess, false);
});
