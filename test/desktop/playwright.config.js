// Electron 冒煙測試設定。不屬於 `npm test`（需要真的開視窗），只在 CI 的 package job 執行：npm run test:desktop
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
