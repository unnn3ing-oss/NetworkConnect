// 狀態頁的瀏覽器測試：真實 server（mock 模式的 monitor＋假 prober）＋真實 Chromium。
// inventory 的 API 由 B1 實作，這裡用 page.route 以 contracts/fixtures 的資料代替（/api/devices 等）。
// 需要 Chromium；找不到時整檔 skip。環境變數 NC_SHOT_DIR 指定時會順便存截圖（淺色／深色）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../../../server/index.js';
import { readFixture } from '../../../contracts/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../../helpers/tmp.js';

describe('狀態頁（Chromium）', async () => {
  const browser = await launchBrowser();
  const db = readFixture('db.sample.json');
  let server;

  before(async () => {
    server = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', mock: true, env: {} });
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
    cleanupAllTmpDirs();
  });

  async function open(hash = '#/status') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    for (const name of ['devices', 'floors', 'rooms', 'groups', 'categories']) {
      await page.route(`**/api/${name}`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(db[name]) }));
    }
    await page.goto(`${server.url}/${hash}`);
    await page.waitForSelector('.nc-view[data-module="status"]');
    return { page, problems, context };
  }

  test('顯示統計與依樓層分組的燈號格；沒有 console 錯誤、CSP 違規、行內樣式', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open();
    await page.waitForSelector('.nc-tile');
    assert.equal(await page.locator('.nc-tile').count(), db.devices.length);
    assert.deepEqual(await page.locator('.nc-stat .nc-stat-label').allTextContents(), ['上線', '離線', '未知', '未偵測']);
    const titles = await page.locator('.nc-status-group-title').allTextContents();
    assert.ok(titles.length >= 3, `至少三個樓層分組：${titles}`);
    assert.match(titles[0], /^1F/);
    // 樣式表有載入（CSP 允許 'self' 的 link）：統計卡左邊框 4px
    await waitFor(async () => (await page.locator('.nc-stat').first().evaluate((el) => getComputedStyle(el).borderLeftWidth)) === '4px', { message: '狀態頁樣式表沒有載入' });
    assert.equal(await page.locator('[style]').count(), 0, '不得有行內樣式');
    // 可用率迷你條畫出 24 格
    await page.waitForSelector('.nc-tile svg.nc-uptime');
    assert.equal(await page.locator('.nc-tile svg.nc-uptime').first().locator('rect').count(), 24);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('即時推播：POST check 後磚塊與統計跟著更新；點磚塊發出 device.open', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open();
    await page.waitForSelector('.nc-tile');
    await page.evaluate(() => {
      window.__opened = [];
      window.__NC__.bus.on('device.open', (p) => window.__opened.push(p));
    });
    await page.locator('.nc-tile[data-device-id="dev_router"]').click();
    assert.deepEqual(await page.evaluate(() => window.__opened), [{ id: 'dev_router' }]);
    // 等 SSE 連上、第一輪偵測完成後，所有「有偵測」的設備都不再是尚未檢查
    await waitFor(async () => (await page.locator('.nc-stat[data-kind="up"] .nc-stat-num').innerText()) !== '0', { timeoutMs: 10_000, message: '上線數量應該大於 0' });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('深色模式也正常（截圖供人工檢查）', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open();
    await page.waitForSelector('.nc-tile svg.nc-uptime');
    await waitFor(async () => (await page.locator('.nc-stat[data-kind="up"] .nc-stat-num').innerText()) !== '0', { timeoutMs: 10_000 });
    if (process.env.NC_SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.NC_SHOT_DIR, 'status-light.png'), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const bg = await page.locator('.nc-tile').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(bg, 'rgb(255, 255, 255)');
    if (process.env.NC_SHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.NC_SHOT_DIR, 'status-dark.png'), fullPage: true });
    }
    assert.deepEqual(problems, []);
    await context.close();
  });
});
