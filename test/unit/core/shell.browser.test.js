// 前端 shell 的瀏覽器測試（驗收 5）：載入無 console 錯誤；單一模組 mount 失敗只影響該分頁。
// 需要 Chromium（/opt/pw-browsers 或 NC_CHROMIUM_PATH）；找不到時整檔 skip。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../../server/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../../helpers/tmp.js';

const MODULE_IDS = ['dashboard', 'devices', 'topology', 'floorplan', 'cameras', 'status', 'settings'];

describe('前端 shell（Chromium）', async () => {
  const browser = await launchBrowser();
  let server;

  before(async () => {
    server = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', mock: true, env: {} });
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
    cleanupAllTmpDirs();
  });

  /** 開新頁面並收集 console 錯誤、pageerror、CSP 違規、失敗的請求 */
  async function open(hash = '', { routes } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    await routes?.(page);
    await page.goto(`${server.url}/${hash}`);
    await page.waitForSelector('.nc-view');
    return { page, problems, context };
  }

  test('載入 shell：頂欄、主導覽、篩選列、預設進入總覽，且沒有任何 console 錯誤', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open();
    assert.equal(await page.title(), '總覽 · NetworkConnect');
    assert.equal(await page.locator('.nc-topbar').count(), 1);
    const labels = await page.locator('#nc-nav a').allTextContents();
    assert.deepEqual(labels, ['總覽', '設備', '架構圖', '平面圖', '監視器', '狀態', '設定']);
    assert.match(page.url(), /#\/dashboard$/);
    await page.waitForSelector('#nc-conn[data-state="connected"]');
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('每個模組分頁都顯示 stub 卡片（建置中）', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open();
    for (const id of MODULE_IDS) {
      await page.click(`#nc-nav a[data-module="${id}"]`);
      await page.waitForSelector(`.nc-view[data-module="${id}"] .nc-stub`);
      assert.equal(await page.locator('.nc-view').count(), 1, '同時只會有一個模組容器');
      assert.equal(await page.locator(`#nc-nav a[data-module="${id}"]`).getAttribute('aria-current'), 'page');
    }
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('全站篩選列：選項來自 API，選擇後同步到網址並跨分頁保留', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open('#/devices');
    await page.waitForFunction(() => document.querySelectorAll('select[data-filter="floorId"] option').length > 3);
    assert.equal(await page.locator('select[data-filter="floorId"] option').count(), 4); // 全部 + 3 層樓
    await page.selectOption('select[data-filter="floorId"]', 'flr_2');
    await page.waitForFunction(() => location.hash.includes('floorId=flr_2'));
    // 房間只剩 2F 的 3 間
    assert.equal(await page.locator('select[data-filter="roomId"] option').count(), 4);
    await page.click('#nc-nav a[data-module="topology"]');
    await page.waitForSelector('.nc-view[data-module="topology"]');
    assert.match(page.url(), /#\/topology\?floorId=flr_2$/);
    assert.equal(await page.locator('select[data-filter="floorId"]').inputValue(), 'flr_2');
    await page.fill('input[data-filter="q"]', 'mesh');
    await page.waitForFunction(() => location.hash.includes('q=mesh'));
    await page.click('.nc-clear');
    await page.waitForFunction(() => !location.hash.includes('floorId'));
    assert.match(page.url(), /#\/topology$/);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('帶篩選的網址直接開啟時，篩選列與狀態同步', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, context } = await open('#/status?floorId=flr_3&q=cam');
    await page.waitForFunction(() => document.querySelectorAll('select[data-filter="floorId"] option').length > 3);
    assert.equal(await page.locator('select[data-filter="floorId"]').inputValue(), 'flr_3');
    assert.equal(await page.locator('input[data-filter="q"]').inputValue(), 'cam');
    assert.deepEqual(await page.evaluate(() => window.__NC__.filters.get()), { floorId: 'flr_3', roomId: '', groupId: '', categoryId: '', q: 'cam' });
    await context.close();
  });

  test('某前端模組 mount() 丟錯：只有該分頁顯示錯誤卡，其他分頁照常（驗收 5）', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open('#/dashboard', {
      routes: (p) => p.route('**/modules/devices/index.js', (route) => route.fulfill({
        contentType: 'text/javascript',
        body: `export default { id: 'devices', title: '設備', icon: 'devices', route: '#/devices', order: 20,
                 async mount() { throw new Error('模擬 mount 失敗'); }, unmount() {} };`,
      })),
    });
    await page.click('#nc-nav a[data-module="devices"]');
    await page.waitForSelector('.nc-view[data-module="devices"] .nc-error-card');
    assert.match(await page.locator('.nc-error-card').innerText(), /此功能暫時無法載入[\s\S]*模擬 mount 失敗/);
    // 其他分頁完全不受影響
    await page.click('#nc-nav a[data-module="status"]');
    await page.waitForSelector('.nc-view[data-module="status"] .nc-stub');
    assert.equal(await page.locator('.nc-error-card').count(), 0);
    // 回到壞掉的分頁，錯誤卡仍在；導覽仍可用
    await page.click('#nc-nav a[data-module="devices"]');
    await page.waitForSelector('.nc-error-card');
    assert.ok(problems.every((p) => /模擬 mount 失敗/.test(p)), `只能出現預期的錯誤：${problems.join('\n')}`);
    assert.ok(problems.length >= 1);
    await context.close();
  });

  test('某前端模組檔案載入失敗（語法錯誤）：導覽仍有該項目，點進去是錯誤卡，其他分頁正常', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, context } = await open('#/dashboard', {
      routes: (p) => p.route('**/modules/topology/index.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export default {{{' })),
    });
    const labels = await page.locator('#nc-nav a').allTextContents();
    assert.ok(labels.some((l) => l.startsWith('架構圖')), '失敗的模組仍在導覽列');
    await page.click('#nc-nav a[data-module="topology"]');
    await page.waitForSelector('.nc-error-card');
    await page.click('#nc-nav a[data-module="floorplan"]');
    await page.waitForSelector('.nc-view[data-module="floorplan"] .nc-stub');
    await context.close();
  });

  test('後端模組 failed 時，依賴它的前端分頁顯示原因，其他分頁不受影響', { skip: !browser && '找不到 Chromium' }, async () => {
    const real = (name) => import(new URL(`../../../server/modules/${name}/index.js`, import.meta.url).href);
    const broken = await startServer({
      dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', mock: true, env: {},
      moduleImporter: async (name) => {
        const mod = await real(name);
        return name === 'nvr' ? { default: { ...mod.default, async check() { throw new Error('go2rtc 不存在') } } } : mod;
      },
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${broken.url}/#/cameras`);
      await page.waitForSelector('.nc-error-card');
      assert.match(await page.locator('.nc-error-card').innerText(), /nvr[\s\S]*go2rtc 不存在/);
      await page.click('#nc-nav a[data-module="status"]');
      await page.waitForSelector('.nc-view[data-module="status"] .nc-stub');
      await context.close();
    } finally {
      await broken.stop();
    }
  });

  test('設了存取密碼：先顯示登入畫面，登入後進入 shell', { skip: !browser && '找不到 Chromium' }, async () => {
    const locked = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', env: {} });
    try {
      const res = await fetch(`${locked.url}/api/auth/password`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-1234' }),
      });
      assert.equal(res.status, 200);
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${locked.url}/`);
      await page.waitForSelector('.nc-login');
      assert.equal(await page.locator('.nc-view').count(), 0);
      await page.fill('.nc-login input', 'wrong');
      await page.click('.nc-login button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('.nc-login-error')?.textContent);
      await page.fill('.nc-login input', 'pw-1234');
      await page.click('.nc-login button[type="submit"]');
      await page.waitForSelector('.nc-view');
      assert.equal(await page.locator('.nc-login').count(), 0);
      await context.close();
    } finally {
      await locked.stop();
    }
  });

  test('ctx.ui.load() 取得 web/ui 的匯出，元件可在 CSP 下正常運作', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, problems, context } = await open('#/dashboard');
    const names = await page.evaluate(async () => {
      const { ctx } = window.__NC__;
      const all = await ctx.ui.load();
      const toastOnly = await ctx.ui.load('toast');
      all.toast('測試訊息', { duration: 0 });
      const ok = await ctx.ui.load('status-dot');
      return { exports: Object.keys(all).sort(), sameToast: toastOnly.toast === all.toast, hasDot: typeof ok.createStatusDot };
    });
    for (const n of ['toast', 'confirm', 'createWizard', 'createGuide', 'createDrawer', 'createSegmented', 'createChips', 'createStatusDot', 'createEmpty', 'icon']) {
      assert.ok(names.exports.includes(n), `ui/index.js 缺 ${n}`);
    }
    assert.equal(names.sameToast, true);
    assert.equal(names.hasDot, 'function');
    await page.waitForSelector('text=測試訊息');
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('手機寬度（390px）沒有水平捲動', { skip: !browser && '找不到 Chromium' }, async () => {
    const { page, context } = await open('#/devices');
    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `水平溢出 ${overflow}px`);
    await context.close();
  });
});
