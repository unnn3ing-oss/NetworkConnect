// 伺服器一直無法啟動時：主行程重試 3 次後，視窗顯示錯誤頁（含「重新啟動」與「查看紀錄」）。
// 以不合法的 NC_PORT 讓伺服器必然啟動失敗。需要真的開視窗，只在 CI／手動執行（見 smoke.spec.js 的說明）。
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = process.env.NC_SMOKE_EXECUTABLE ? path.resolve(process.env.NC_SMOKE_EXECUTABLE) : undefined;
const extraArgs = (process.env.NC_SMOKE_ARGS ?? '').split(/\s+/).filter(Boolean);

test('伺服器無法啟動時顯示錯誤頁，並記錄在 logs', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-smoke-err-'));
  const env = { ...process.env, NC_DESKTOP_USER_DATA: userData, NC_PORT: '99999' };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: extraArgs } : { args: [repoRoot, ...extraArgs] }),
    cwd: repoRoot,
    env,
    timeout: 60_000,
  });
  try {
    const win = await app.firstWindow();
    await expect(win.getByRole('heading', { name: '伺服器無法啟動' })).toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('link', { name: '重新啟動' })).toBeVisible();
    await expect(win.getByRole('link', { name: '查看紀錄' })).toBeVisible();
    expect(win.url().startsWith('data:text/html')).toBe(true);
  } finally {
    await app.close();
  }

  const log = fs.readFileSync(path.join(userData, 'logs', 'desktop.log'), 'utf8');
  expect(log).toMatch(/第 3 次自動重啟/);
  expect(log).toMatch(/伺服器啟動失敗/);
});
