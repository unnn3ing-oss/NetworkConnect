// 測試用暫存資料夾：每次呼叫建立獨立資料夾，並在 cleanup() 時刪除。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set();

export function makeTmpDir(prefix = 'nc-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}

export function removeTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  created.delete(dir);
}

export function cleanupAllTmpDirs() {
  for (const dir of [...created]) removeTmpDir(dir);
}

/** 讀取 JSON 檔 */
export function readJsonFile(...parts) {
  return JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
}

/** 等待條件成立（輪詢），逾時丟錯 */
export async function waitFor(fn, { timeoutMs = 3000, intervalMs = 10, message = '等待逾時' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
