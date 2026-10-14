// monitor 設定（GET/PUT /api/monitor/settings）：預設間隔、並發數、逾時、pausedUntil。
// monitor 只擁有 statusHistory，不能寫 config.json，所以設定存在自己的檔案 <dataDir>/monitor.json。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({ defaultIntervalSec: 60, concurrency: 16, timeoutMs: 1500, pausedUntil: null });

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {{file: string, validate: (ref: string, data: object) => object, log?: object}} deps
 */
export function createSettings({ file, validate, log = noopLog }) {
  let current = { ...DEFAULT_SETTINGS };
  let writing = Promise.resolve();

  return {
    /** 同步讀檔；檔案不存在、損毀或內容不合契約時使用預設值（不丟錯，避免模組因設定檔壞掉而停用） */
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        current = { ...validate('api-monitor#MonitorSettings', { ...DEFAULT_SETTINGS, ...raw }) };
      } catch (err) {
        if (err?.code !== 'ENOENT') log.warn?.({ err }, 'monitor 設定檔無法使用，改用預設值');
        current = { ...DEFAULT_SETTINGS };
      }
      return { ...current };
    },

    get: () => ({ ...current }),

    /** 部分更新並寫檔；回傳完整設定 */
    async update(patch) {
      current = { ...current, ...patch };
      const snapshot = JSON.stringify(current, null, 2);
      const tmp = `${file}.${process.pid}.tmp`;
      writing = writing
        .then(async () => {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          await fs.promises.writeFile(tmp, snapshot);
          await fs.promises.rename(tmp, file);
        })
        .catch((err) => log.error?.({ err }, `寫入 monitor 設定失敗：${err.message}`));
      await writing;
      return { ...current };
    },
  };
}
