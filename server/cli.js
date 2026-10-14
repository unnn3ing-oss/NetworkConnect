#!/usr/bin/env node
// 無介面模式入口：node server/cli.js [--data-dir] [--port] [--host] [--mock]
// Electron 的 utilityProcess 也 fork 這支檔案（環境變數 NC_DATA_DIR、NC_PORT、NC_HOST、NC_GO2RTC_PATH）。
import { startServer } from './index.js';
import { parseCliArgs, USAGE } from './core/cli-args.js';

let args;
try {
  args = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const { help, ...opts } = args;
const server = await startServer({
  ...opts,
  logger: { level: process.env.NC_LOG_LEVEL || 'warn' },
}).catch((err) => {
  console.error(`NetworkConnect 無法啟動：${err.message}`);
  process.exit(1);
});

console.log(`NetworkConnect listening on ${server.url}`);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.stop();
  } catch (err) {
    console.error(`關閉時發生錯誤：${err.message}`);
    code = 1;
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// 以 child_process.fork 啟動時（IPC 通道）也接受 {type:'shutdown'}，跨平台的優雅結束方式
process.on('message', (m) => {
  if (m && m.type === 'shutdown') shutdown(0);
});
