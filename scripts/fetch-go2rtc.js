#!/usr/bin/env node
// 下載打包用的 go2rtc 執行檔：node scripts/fetch-go2rtc.js [--dry-run] [--force] [--target darwin-arm64|win32-x64]... [--out <資料夾>]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchGo2rtc, readGo2rtcVersion, CHECKSUMS_FILE, DEFAULT_OUT_DIR } from './lib/go2rtc.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    target: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

try {
  await fetchGo2rtc({
    version: readGo2rtcVersion(),
    checksums: JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf8')),
    outDir: values.out ?? DEFAULT_OUT_DIR,
    dryRun: values['dry-run'],
    force: values.force,
    targets: values.target,
  });
} catch (err) {
  console.error(`fetch-go2rtc 失敗：${err.message}`);
  process.exit(1);
}
