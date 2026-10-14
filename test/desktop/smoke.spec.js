// Electron 冒煙測試（規格 §3、D1 任務書第 9 項）：
// App 啟動 → 視窗載入完成 → /api/system/health 回 ok → 結束 → 沒有殘留的 go2rtc 行程。
//
// 執行方式：
//   開發（未打包）：  npm run test:desktop                         （用 node_modules 的 electron 開啟原始碼）
//   打包後（CI）：    NC_SMOKE_EXECUTABLE=<安裝後的執行檔> npm run test:desktop
//   無桌面的 Linux：  NC_SMOKE_ARGS="--no-sandbox --disable-gpu" xvfb-run -a npm run test:desktop
import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = process.env.NC_SMOKE_EXECUTABLE ? path.resolve(process.env.NC_SMOKE_EXECUTABLE) : undefined;
const extraArgs = (process.env.NC_SMOKE_ARGS ?? '').split(/\s+/).filter(Boolean);

/** 目前系統上所有 go2rtc 行程的描述（沒有則為空陣列） */
function listGo2rtcProcesses() {
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq go2rtc.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => /go2rtc\.exe/i.test(l));
  }
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => /(^|[\\/\s])go2rtc(\s|$)/.test(l) && !/\bps\b/.test(l));
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('App 啟動、載入主控台、health 正常、結束後沒有殘留 go2rtc', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-smoke-'));
  const env = { ...process.env, NC_DESKTOP_USER_DATA: userData, NC_PORT: '0', ELECTRON_ENABLE_LOGGING: '1' };
  delete env.NODE_OPTIONS; // 打包後的 Electron 不接受大部分 NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE;

  const before = listGo2rtcProcesses();

  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: extraArgs } : { args: [repoRoot, ...extraArgs] }),
    cwd: repoRoot,
    env,
    timeout: 60_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 }); // 等伺服器就緒後載入主控台
    await win.waitForLoadState('load');
    const origin = new URL(win.url()).origin;

    // 1) 伺服器 health
    const res = await fetch(`${origin}/api/system/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.ok).toBe(true);

    // 2) 視窗確實載入了 App 殼層（不是錯誤頁）
    await expect(win.locator('body')).not.toBeEmpty();
    expect(await win.title()).not.toBe('');

    // 3) 安全設定：沒有 Node 能力、preload 只暴露 ncDesktop.{version, platform, openExternal}
    const exposed = await win.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      keys: Object.keys(window.ncDesktop ?? {}).sort(),
      platform: window.ncDesktop?.platform,
      version: window.ncDesktop?.version,
    }));
    expect(exposed.require).toBe('undefined');
    expect(exposed.process).toBe('undefined');
    expect(exposed.keys).toEqual(['openExternal', 'platform', 'version']);
    expect(exposed.platform).toBe(process.platform);
    expect(exposed.version).toMatch(/^\d+\.\d+\.\d+/);

    // 4) 外部網址不會在視窗內導覽
    await win.evaluate(() => window.open('https://example.com/'));
    await new Promise((r) => setTimeout(r, 500));
    expect(new URL(win.url()).origin).toBe(origin);
    expect(app.windows().length).toBe(1);
  } finally {
    await app.close();
  }

  // 結束後不可殘留 go2rtc（Windows 結束父行程不會自動結束子行程，見規格 §8.4 地雷 8）
  const leftover = await waitFor(async () => {
    const now = listGo2rtcProcesses().filter((l) => !before.includes(l));
    return now.length === 0 ? true : false;
  });
  expect(leftover, `殘留的 go2rtc 行程：\n${listGo2rtcProcesses().join('\n')}`).toBe(true);

  // 伺服器 log 在 userData/logs（錯誤頁「查看紀錄」開啟的資料夾）
  expect(fs.existsSync(path.join(userData, 'logs', 'desktop.log'))).toBe(true);
});
