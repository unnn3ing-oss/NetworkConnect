// E2E 設定：npm run test:e2e
// Chromium 位置：NC_CHROMIUM_PATH，其次 PLAYWRIGHT_BROWSERS_PATH／opt/pw-browsers 下的 chromium-*（不執行 playwright install）。
// 每個測試自己啟動一個真實的 NetworkConnect 伺服器（隨機埠、暫存資料夾），所以可以放心循序執行。
import { defineConfig } from '@playwright/test';
import { findChromium } from './chromium.js';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results',
  use: {
    launchOptions: { executablePath: findChromium(), args: ['--no-sandbox'] },
    viewport: { width: 1280, height: 800 },
    locale: 'zh-TW',
  },
});
