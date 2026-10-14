// server/cli.js 的參數解析（獨立出來以便測試）
import { parseArgs } from 'node:util';

export const USAGE = `用法：node server/cli.js [選項]

  --data-dir <路徑>   資料夾（預設環境變數 NC_DATA_DIR，再預設 ./data）
  --port <埠>         監聽埠（預設 config.json 的 port，8780；0＝由系統分配）
  --host <位址>       綁定位址（預設依 config.lanAccess：0.0.0.0 或 127.0.0.1）
  --mock              mock 模式：載入 contracts/fixtures 到 data-mock/，使用假 prober 與假 go2rtc
  -h, --help          顯示說明`;

/** @returns {{dataDir?: string, port?: number, host?: string, mock?: boolean, help: boolean}} 沒給的參數不會出現在結果中 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        'data-dir': { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        mock: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (err) {
    throw new Error(`參數錯誤：${err.message}`);
  }
  const out = { help: Boolean(parsed.help) };
  if (parsed['data-dir'] !== undefined) out.dataDir = parsed['data-dir'];
  if (parsed.host !== undefined) out.host = parsed.host;
  if (parsed.mock !== undefined) out.mock = parsed.mock;
  if (parsed.port !== undefined) {
    const n = Number(parsed.port);
    if (!/^\d+$/.test(parsed.port) || n < 0 || n > 65535) throw new Error(`參數錯誤：--port 必須是 0–65535 的整數（收到 ${parsed.port}）`);
    out.port = n;
  }
  return out;
}
