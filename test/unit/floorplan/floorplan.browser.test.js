// 平面圖前端的瀏覽器測試（B4 驗收 3）：dev:mock 下上傳、拖放 5 台設備、重新整理後位置不變、滾輪與雙指縮放。
// 需要 Chromium（/opt/pw-browsers 或 NC_CHROMIUM_PATH）；找不到時整檔 skip。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../../../server/index.js';
import { FIXTURES_DIR } from '../../../contracts/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../../helpers/tmp.js';

const PNG = path.join(FIXTURES_DIR, 'plan.sample.png');

describe('平面圖前端（Chromium）', async () => {
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

  async function open(hash, contextOpts = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOpts });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (!r.url().endsWith('/api/events')) problems.push(`requestfailed: ${r.url()}`); }); // 重新整理時 SSE 連線被中止是正常的
    page.on('response', (r) => { if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    await page.goto(`${server.url}/${hash}`);
    await page.waitForSelector('.nc-view[data-module="floorplan"] .nc-fp');
    return { page, problems, context };
  }
  const api = async (p) => (await fetch(`${server.url}${p}`)).json();
  const scaleOf = (page) => page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.nc-fp-stage').style.transform)[1]));
  const skip = !browser && '找不到 Chromium';

  test('1F：顯示既有平面圖與設備點、名稱標籤、狀態燈，沒有 console 錯誤', { skip }, async () => {
    const { page, problems, context } = await open('#/floorplan?floorId=flr_1');
    await page.waitForSelector('.nc-fp-img');
    await page.waitForFunction(() => document.querySelector('.nc-fp-img').complete && document.querySelectorAll('.nc-fp-dot').length === 13);
    assert.equal(await page.locator('.nc-fp-dot .nc-status').count(), 13);
    assert.equal(await page.locator('.nc-fp-dot .nc-fp-label').first().isVisible(), true);
    await page.waitForSelector('.nc-fp-dot[data-status="up"]'); // 假 prober 首輪偵測完成後燈號轉綠（status.snapshot／status.changed）
    assert.ok((await page.locator('.nc-fp-cam').count()) > 0, '攝影機有「看畫面」按鈕');
    assert.equal(await page.locator('[data-act="edit"]').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('2F 沒有平面圖：空狀態＋格狀檢視；上傳 → 拖放 5 台設備 → 重新整理後位置不變', { skip }, async () => {
    const { page, problems, context } = await open('#/floorplan?floorId=flr_2');
    await page.waitForSelector('.nc-empty');
    assert.ok((await page.locator('.nc-fp-card').count()) > 5, '格狀檢視列出本層設備');
    await page.setInputFiles('input.nc-fp-file', PNG);
    await page.waitForSelector('.nc-fp-viewport');
    await page.waitForFunction(() => document.querySelector('.nc-fp-img').complete);
    assert.equal((await api('/api/plans')).some((p) => p.floorId === 'flr_2' && p.width === 800 && p.height === 500), true);

    await page.click('[data-act="edit"]');
    await page.waitForSelector('.nc-fp-item');
    const vp = await page.locator('.nc-fp-viewport').boundingBox();
    for (let i = 0; i < 5; i++) {
      const item = await page.locator('.nc-fp-item').first().boundingBox();
      await page.mouse.move(item.x + 20, item.y + item.height / 2);
      await page.mouse.down();
      await page.mouse.move(item.x + 60, item.y + item.height / 2, { steps: 3 });
      await page.mouse.move(vp.x + 120 + i * 110, vp.y + 160 + (i % 2) * 120, { steps: 8 });
      await page.mouse.up();
      await waitFor(async () => (await api('/api/placements?floorId=flr_2')).length === i + 1, { message: `第 ${i + 1} 台未放置` });
      await page.waitForFunction((n) => document.querySelectorAll('.nc-fp-item').length === n && document.querySelectorAll('.nc-fp-dot').length === 10 - n, 9 - i);
    }
    assert.equal(await page.locator('.nc-fp-dot').count(), 5);
    const before = (await api('/api/placements?floorId=flr_2')).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    for (const p of before) assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    const ratios = () => page.evaluate(() => {
      const r = document.querySelector('.nc-fp-img').getBoundingClientRect();
      return [...document.querySelectorAll('.nc-fp-dot')].map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.device, (b.x + b.width / 2 - r.x) / r.width, (b.y + b.height / 2 - r.y) / r.height]; }).sort();
    });
    const boxesBefore = await ratios();

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.nc-fp-dot').length === 5 && document.querySelector('.nc-fp-img')?.complete);
    await page.waitForTimeout(100);
    const after = (await api('/api/placements?floorId=flr_2')).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    assert.deepEqual(after, before);
    const boxesAfter = await ratios();
    assert.equal(boxesAfter.length, boxesBefore.length);
    boxesAfter.forEach(([id, x, y], i) => {
      assert.equal(id, boxesBefore[i][0]);
      assert.ok(Math.abs(x - boxesBefore[i][1]) < 0.002 && Math.abs(y - boxesBefore[i][2]) < 0.002, `${id} 的位置（相對圖片）應不變`);
      const saved = before.find((p) => p.deviceId === id);
      assert.ok(Math.abs(x - saved.x) < 0.002 && Math.abs(y - saved.y) < 0.002, `${id} 顯示位置應等於儲存的比例座標`);
    });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('編輯模式：拖曳既有點移動、右鍵移除（confirm）；點選清單項目後點圖放置', { skip }, async () => {
    const { page, context } = await open('#/floorplan?floorId=flr_2');
    await page.waitForSelector('.nc-fp-img');
    await page.waitForFunction(() => document.querySelectorAll('.nc-fp-dot').length >= 5 && document.querySelector('.nc-fp-img').complete);
    await page.click('[data-act="edit"]');
    const dot = page.locator('.nc-fp-dot').first();
    const id = await dot.getAttribute('data-device');
    const b = await dot.boundingBox();
    const old = (await api('/api/placements?floorId=flr_2')).find((p) => p.deviceId === id);
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await page.mouse.move(b.x + 80, b.y + 60, { steps: 6 });
    await page.mouse.up();
    await waitFor(async () => { const n = (await api('/api/placements?floorId=flr_2')).find((p) => p.deviceId === id); return n.x !== old.x; }, { message: '位置未更新' });
    const moved = (await api('/api/placements?floorId=flr_2')).find((p) => p.deviceId === id);
    assert.ok(moved.x > old.x && moved.y > old.y);

    // 點選未放置項目 → 點圖
    const item = page.locator('.nc-fp-item').first();
    const itemId = await item.getAttribute('data-device');
    await item.click();
    assert.equal(await item.getAttribute('aria-pressed'), 'true');
    const vp = await page.locator('.nc-fp-viewport').boundingBox();
    await page.mouse.click(vp.x + 300, vp.y + 300);
    await waitFor(async () => (await api('/api/placements?floorId=flr_2')).some((p) => p.deviceId === itemId), { message: '點選放置失敗' });

    // 右鍵移除
    await page.locator(`.nc-fp-dot[data-device="${id}"]`).click({ button: 'right' });
    await page.locator('.nc-dialog .btn.danger, [role="dialog"] .btn.danger').first().click();
    await waitFor(async () => !(await api('/api/placements?floorId=flr_2')).some((p) => p.deviceId === id), { message: '移除失敗' });
    assert.equal((await api('/api/devices')).some((d) => d.id === id), true, '設備本身不會被刪除');
    await context.close();
  });

  test('滾輪以游標為中心縮放、範圍 0.2–8、拖曳平移、適合畫面', { skip }, async () => {
    const { page, context } = await open('#/floorplan?floorId=flr_1');
    await page.waitForFunction(() => document.querySelector('.nc-fp-img')?.complete);
    const vp = await page.locator('.nc-fp-viewport').boundingBox();
    const fitScale = await scaleOf(page);
    const cx = vp.x + 200;
    const cy = vp.y + 150;
    // 游標下方的圖片位置縮放前後不變
    const probe = () => page.evaluate(([x, y]) => {
      const r = document.querySelector('.nc-fp-img').getBoundingClientRect();
      return [(x - r.left) / r.width, (y - r.top) / r.height];
    }, [cx, cy]);
    const before = await probe();
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction((s) => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('.nc-fp-stage').style.transform)[1]) > s * 1.2, fitScale);
    const after = await probe();
    assert.ok(Math.abs(after[0] - before[0]) < 0.002 && Math.abs(after[1] - before[1]) < 0.002, '以游標為中心');
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 300);
    await page.waitForTimeout(100);
    assert.equal(await scaleOf(page), 0.2);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    assert.equal(await scaleOf(page), 8);
    assert.equal(await page.locator('.nc-fp-dots.is-lowzoom').count(), 0);

    // 平移
    const t0 = await page.evaluate(() => document.querySelector('.nc-fp-stage').style.transform);
    await page.mouse.move(vp.x + 50, vp.y + 50);
    await page.mouse.down();
    await page.mouse.move(vp.x + 120, vp.y + 90, { steps: 4 });
    await page.mouse.up();
    assert.notEqual(await page.evaluate(() => document.querySelector('.nc-fp-stage').style.transform), t0);

    await page.click('[data-act="fit"]');
    assert.ok(Math.abs((await scaleOf(page)) - fitScale) < 0.001);
    // 縮小很多後名稱標籤隱藏
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.nc-fp-dots.is-lowzoom'));
    await context.close();
  });

  test('觸控：雙指縮放與單指平移（CDP 模擬）', { skip }, async () => {
    const { page, context } = await open('#/floorplan?floorId=flr_1', { hasTouch: true, isMobile: false });
    await page.waitForFunction(() => document.querySelector('.nc-fp-img')?.complete);
    const vp = await page.locator('.nc-fp-viewport').boundingBox();
    const cdp = await context.newCDPSession(page);
    const mx = vp.x + vp.width / 2;
    const my = vp.y + vp.height / 2;
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p[0], y: p[1], id })) });
    const s0 = await scaleOf(page);
    await touch('touchStart', [[mx - 40, my], [mx + 40, my]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[mx - 40 - i * 10, my], [mx + 40 + i * 10, my]]);
    await touch('touchEnd', []);
    const s1 = await scaleOf(page);
    assert.ok(s1 > s0 * 2.5, `雙指放大：${s0} → ${s1}`);
    // 縮回
    await touch('touchStart', [[mx - 120, my], [mx + 120, my]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[mx - 120 + i * 12, my], [mx + 120 - i * 12, my]]);
    await touch('touchEnd', []);
    assert.ok((await scaleOf(page)) < s1);
    // 單指平移
    const t0 = await page.evaluate(() => document.querySelector('.nc-fp-stage').style.transform);
    await touch('touchStart', [[vp.x + 30, vp.y + 30]]);
    for (let i = 1; i <= 5; i++) await touch('touchMove', [[vp.x + 30 + i * 15, vp.y + 30 + i * 8]]);
    await touch('touchEnd', []);
    assert.notEqual(await page.evaluate(() => document.querySelector('.nc-fp-stage').style.transform), t0);
    await context.close();
  });

  test('攝影機的「看畫面」→ #/cameras?device=；設備點 → device.open；?place= 進入放置模式', { skip }, async () => {
    const { page, context } = await open('#/floorplan?floorId=flr_1');
    await page.waitForFunction(() => document.querySelectorAll('.nc-fp-dot').length === 13);
    await page.evaluate(() => { window.__opened = []; window.__NC__.bus.on('device.open', (p) => window.__opened.push(p.id)); });
    await page.locator('.nc-fp-dot[data-device="dev_router"] .nc-fp-dot-body').click();
    assert.deepEqual(await page.evaluate(() => window.__opened), ['dev_router']);
    await page.waitForSelector('.nc-drawer-overlay.is-open'); // devices 模組非同步開啟抽屜
    await page.keyboard.press('Escape'); // 關掉設備抽屜
    await page.waitForSelector('.nc-drawer-overlay.is-open', { state: 'detached' });
    const cam = page.locator('.nc-fp-dot:has(.nc-fp-cam)').first();
    const camId = await cam.getAttribute('data-device');
    await cam.locator('.nc-fp-cam').click();
    await page.waitForFunction((id) => location.hash.startsWith('#/cameras') && location.hash.includes(`device=${id}`), camId);
    await context.close();

    // 1F 有平面圖；挑一台 1F 尚未放置的設備，從別的樓層網址帶 place 進來 → 自動切到 1F 並選取
    const placed = new Set((await api('/api/placements')).map((p) => p.deviceId));
    const target = (await api('/api/devices')).find((d) => d.floorId === 'flr_1' && !placed.has(d.id));
    const p2 = await open(`#/floorplan?floorId=flr_3&place=${target.id}`);
    await p2.page.waitForSelector('.nc-fp-side');
    assert.equal(await p2.page.locator(`.nc-fp-item[data-device="${target.id}"]`).getAttribute('aria-pressed'), 'true');
    assert.match(await p2.page.evaluate(() => location.hash), /floorId=flr_1/);
    assert.equal(await p2.page.locator('[data-act="edit"]').getAttribute('aria-pressed'), 'true');
    await p2.context.close();
  });
});
