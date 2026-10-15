// 讀 monitor 模組的「預設偵測間隔」（<dataDir>/monitor.json）給新增設備時套用。
// 檔案由 monitor 模組擁有與寫入，這裡只讀；monitor 停用、檔案不存在或內容不合法時回 60。
import fs from 'node:fs';
import path from 'node:path';

export const FALLBACK_INTERVAL_SEC = 60;

/** @param {string} dataDir */
export function readDefaultIntervalSec(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, 'monitor.json'), 'utf8'))?.defaultIntervalSec;
    return Number.isInteger(v) && v >= 15 && v <= 86400 ? v : FALLBACK_INTERVAL_SEC;
  } catch {
    return FALLBACK_INTERVAL_SEC;
  }
}
