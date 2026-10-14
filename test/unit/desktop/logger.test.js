import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileLogger } from '../../../desktop/lib/logger.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-log-'));

test('寫入帶時間戳記與層級的行', () => {
  const dir = tmp();
  const log = createFileLogger({ file: path.join(dir, 'logs', 'desktop.log'), now: () => new Date('2026-10-14T08:30:00.000Z') });
  log.info('啟動');
  log.error('失敗');
  log.close();
  const lines = fs.readFileSync(path.join(dir, 'logs', 'desktop.log'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['2026-10-14T08:30:00.000Z INFO 啟動', '2026-10-14T08:30:00.000Z ERROR 失敗']);
});

test('write(chunk) 原樣附加（轉存伺服器 stdout／stderr）', () => {
  const dir = tmp();
  const file = path.join(dir, 'server.log');
  const log = createFileLogger({ file });
  log.write(Buffer.from('hello\n'));
  log.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
});

test('開啟時若檔案超過上限，輪替為 .1（只保留一份舊檔）', () => {
  const dir = tmp();
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'x'.repeat(100));
  fs.writeFileSync(`${file}.1`, 'old');
  const log = createFileLogger({ file, maxBytes: 50 });
  log.write('new\n');
  log.close();
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(100));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
});

test('無法寫入時不丟例外', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  const log = createFileLogger({ file: path.join(dir, 'blocker', 'x.log') });
  assert.doesNotThrow(() => log.info('x'));
  log.close();
});
