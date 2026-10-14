// 簡單的檔案紀錄器：桌面主行程與伺服器行程的輸出都寫到 <userData>/logs/，供錯誤頁「查看紀錄」開啟。
// 開啟時若檔案超過 maxBytes 就輪替成 .1（只保留一份舊檔）。任何 I/O 失敗都不丟例外。
import fs from 'node:fs';
import path from 'node:path';

export function createFileLogger({ file, maxBytes = 2 * 1024 * 1024, now = () => new Date() }) {
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {
      // 檔案不存在或無法輪替：照常附加
    }
    fd = fs.openSync(file, 'a');
  } catch {
    fd = null;
  }

  const write = (chunk) => {
    if (fd === null) return;
    try {
      fs.writeSync(fd, chunk);
    } catch {
      // 磁碟已滿或已關閉：放棄這一筆
    }
  };
  const line = (level) => (msg) => write(`${now().toISOString()} ${level} ${msg}\n`);

  return {
    write,
    info: line('INFO'),
    warn: line('WARN'),
    error: line('ERROR'),
    close() {
      if (fd === null) return;
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    },
  };
}
