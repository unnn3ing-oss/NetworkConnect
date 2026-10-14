import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSecrets } from '../../../server/core/secrets.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

describe('secrets', () => {
  test('set／get／has／delete／all，並持久化到 secrets.json', async () => {
    const dataDir = makeTmpDir();
    const s = createSecrets(dataDir);
    assert.equal(s.get('nvr:nvr_1'), undefined);
    await s.set('nvr:nvr_1', 'p@ss:w/rd');
    assert.equal(s.get('nvr:nvr_1'), 'p@ss:w/rd');
    assert.equal(s.has('nvr:nvr_1'), true);
    assert.deepEqual(s.all(), { 'nvr:nvr_1': 'p@ss:w/rd' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')), { 'nvr:nvr_1': 'p@ss:w/rd' });

    const again = createSecrets(dataDir);
    assert.equal(again.get('nvr:nvr_1'), 'p@ss:w/rd');
    await again.delete('nvr:nvr_1');
    assert.equal(again.has('nvr:nvr_1'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')), {});
  });

  test('非 Windows 平台檔案權限是 600（即使 umask 很寬鬆）', { skip: process.platform === 'win32' }, async () => {
    const dataDir = makeTmpDir();
    const old = process.umask(0o000);
    try {
      const s = createSecrets(dataDir);
      await s.set('k', 'v');
      await s.set('k2', 'v2'); // 第二次寫入（rename 覆蓋）後權限仍是 600
    } finally {
      process.umask(old);
    }
    const mode = fs.statSync(path.join(dataDir, 'secrets.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('寫入後沒有殘留暫存檔', async () => {
    const dataDir = makeTmpDir();
    const s = createSecrets(dataDir);
    await s.set('k', 'v');
    assert.deepEqual(fs.readdirSync(dataDir), ['secrets.json']);
  });

  test('secrets.json 損毀時改名備份並以空內容啟動', async () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), 'not json');
    const s = createSecrets(dataDir);
    assert.deepEqual(s.all(), {});
    assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('secrets.json.corrupt-')));
  });

  test('值必須是字串', async () => {
    const s = createSecrets(makeTmpDir());
    await assert.rejects(() => s.set('k', 123), /字串/);
  });
});
