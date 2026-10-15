import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readDefaultIntervalSec } from '../../../server/core/monitor-defaults.js';
import { fillMonitor } from '../../../server/modules/inventory/rules.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

test('readDefaultIntervalSec：讀 monitor.json；不存在、損毀、超出範圍時回 60', (t) => {
  t.after(cleanupAllTmpDirs);
  const dir = makeTmpDir();
  assert.equal(readDefaultIntervalSec(dir), 60);
  const file = path.join(dir, 'monitor.json');
  fs.writeFileSync(file, JSON.stringify({ defaultIntervalSec: 300 }));
  assert.equal(readDefaultIntervalSec(dir), 300);
  fs.writeFileSync(file, '{oops');
  assert.equal(readDefaultIntervalSec(dir), 60);
  fs.writeFileSync(file, JSON.stringify({ defaultIntervalSec: 5 }));
  assert.equal(readDefaultIntervalSec(dir), 60);
});

test('fillMonitor：沒帶 intervalSec 用預設間隔，有帶就用自己的', () => {
  assert.equal(fillMonitor({ method: 'icmp' }, null, 300).intervalSec, 300);
  assert.equal(fillMonitor({ method: 'icmp', intervalSec: 30 }, null, 300).intervalSec, 30);
  assert.equal(fillMonitor(undefined, null).intervalSec, 60);
});
