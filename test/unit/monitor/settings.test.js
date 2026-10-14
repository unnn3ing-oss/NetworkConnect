import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createValidator } from '../../../contracts/index.js';
import { createSettings, DEFAULT_SETTINGS } from '../../../server/modules/monitor/settings.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);
const v = createValidator();
const validate = (ref, data) => {
  const r = v.validate(ref, data);
  if (!r.valid) throw new Error('invalid');
  return data;
};

describe('monitor settings', () => {
  test('預設值符合契約：間隔 60、並發 16、逾時 1500、未暫停', () => {
    assert.deepEqual(DEFAULT_SETTINGS, { defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null });
    v.assert('api-monitor#MonitorSettings', DEFAULT_SETTINGS);
  });

  test('沒有檔案 → 預設值；update 部分更新並寫檔，重新載入後仍在', async () => {
    const file = path.join(makeTmpDir(), 'monitor.json');
    const s = createSettings({ file, validate });
    s.load();
    assert.deepEqual(s.get(), DEFAULT_SETTINGS);
    const next = await s.update({ concurrency: 4, pausedUntil: '2026-10-14T09:00:00.000Z' });
    assert.equal(next.concurrency, 4);
    assert.equal(next.timeoutMs, 1500);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next);
    const again = createSettings({ file, validate });
    again.load();
    assert.deepEqual(again.get(), next);
  });

  test('檔案損毀或內容不合契約 → 回到預設值而不是讓模組停用', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'monitor.json');
    fs.writeFileSync(file, '{not json');
    const a = createSettings({ file, validate });
    a.load();
    assert.deepEqual(a.get(), DEFAULT_SETTINGS);
    fs.writeFileSync(file, JSON.stringify({ defaultIntervalSec: 1, concurrency: 999 }));
    const b = createSettings({ file, validate });
    b.load();
    assert.deepEqual(b.get(), DEFAULT_SETTINGS);
  });

  test('get() 回傳副本，外部修改不影響內部狀態', () => {
    const s = createSettings({ file: path.join(makeTmpDir(), 'm.json'), validate });
    s.load();
    s.get().concurrency = 1;
    assert.equal(s.get().concurrency, 16);
  });
});
