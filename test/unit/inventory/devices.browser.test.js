import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// devices 頁的瀏覽器測試（Chromium + mock 模式）：列表、狀態燈、新增精靈、編輯、刪除、抽屜、分類管理、匯入匯出、手機版。
// 需要 Chromium（/opt/pw-browsers 或 NC_CHROMIUM_PATH）；找不到時整檔 skip。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../server/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor } from '../../helpers/tmp.js';

const CSV = fileURLToPath(new URL('../io/fixtures/legacy-devices.csv', import.meta.url));

describe('devices 頁（Chromium）', async () => {
  const browser = await launchBrowser();
  const skip = !browser && '找不到 Chromium';
  const opened = [];

  after(async () => {
    for (const fn of opened.splice(0)) await fn();
    await browser?.close();
    cleanupAllTmpDirs();
  });

  /**
   * 每個測試一個全新的 mock 伺服器（資料每次重置）與頁面。
   * 預設以假的 /api/status 回應固定燈號（status:'fake'）；status:'none' 模擬 monitor 不可用（404）。
   */
  async function boot({ hash = '#/devices', width = 1280, status = 'fake' } = {}) {
    const dataDir = makeTmpDir();
    // status:'none'：真的停用 monitor 模組（沒有 /api/status，也不會有 SSE 狀態事件）
    if (status === 'none') writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ modules: { monitor: false } }));
    const server = await startServer({ dataDir, port: 0, host: '127.0.0.1', mock: true, env: {} });
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, acceptDownloads: true });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    if (status === 'fake') {
      const item = (deviceId, state) => ({ deviceId, state, rttMs: state === 'up' ? 1 : null, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: state === 'down' ? 3 : 0 });
      await page.route('**/api/status', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify([item('dev_router', 'up'), item('dev_modem', 'up'), item('dev_printer', 'down')]) }),
      );
    }
    await page.goto(`${server.url}/${hash}`);
    const close = async () => {
      await context.close();
      await server.stop();
    };
    opened.push(close);
    return { server, page, context, problems, close, api: (p) => fetch(`${server.url}${p}`).then((r) => r.json()) };
  }

  const nextStep = (page) => page.click('button:has-text("下一步")');
  const fieldInput = (page, label) => page.locator(`.nc-field:has(.nc-field-label:text-is("${label}")) input, .nc-field:has(.nc-field-label:text-is("${label}")) textarea`).first();
  const fieldSelect = (page, label) => page.locator(`.nc-field:has(.nc-field-label:text-is("${label}")) select`).first();
  const cardNames = (page) => page.locator('.dv-card .dv-card-name').allTextContents();
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  test('列表：預設卡片、依全站篩選、排序、切換表格並記住檢視', { skip }, async () => {
    const { page, problems, api } = await boot();
    await page.waitForSelector('.dv-card');
    const all = await api('/api/devices');
    assert.equal(await page.locator('.dv-card').count(), all.length);
    assert.match(await page.locator('.dv-count').innerText(), new RegExp(`共 ${all.length} 台`));

    // 依 IP 排序：第一張卡的 IP 是最小的（沒有 IP 的排最後）
    await page.selectOption('select.dv-sort', 'ip');
    const withIp = all.filter((d) => d.ip).map((d) => d.ip).sort((a, b) => a.split('.').reduce((n, p) => n * 256 + +p, 0) - b.split('.').reduce((n, p) => n * 256 + +p, 0));
    assert.equal((await page.locator('.dv-card').first().locator('.dv-card-meta').first().innerText()), withIp[0]);
    await page.click('.dv-dir');
    assert.equal((await page.locator('.dv-card').first().locator('.dv-card-meta').first().innerText()), withIp.at(-1));

    // 全站篩選（網址）：樓層
    await page.evaluate(() => window.__NC__.filters.set({ floorId: 'flr_2' }));
    await page.waitForFunction((n) => document.querySelectorAll('.dv-card').length < n, all.length);
    const floor2 = all.filter((d) => d.floorId === 'flr_2');
    assert.equal(await page.locator('.dv-card').count(), floor2.length);
    // 關鍵字
    await page.evaluate(() => window.__NC__.filters.set({ floorId: '', q: '攝影機' }));
    const fields = ['code', 'name', 'ip', 'mac', 'hostname', 'vendor', 'model', 'notes'];
    const expected = all.filter((d) => fields.some((k) => String(d[k]).includes('攝影機'))).length;
    assert.ok(expected > 0);
    await page.waitForFunction((n) => document.querySelectorAll('.dv-card').length === n, expected);
    // 篩到沒有 → 空狀態＋清除篩選
    await page.evaluate(() => window.__NC__.filters.set({ q: 'zzzz-not-found' }));
    await page.waitForSelector('text=沒有符合條件的設備');
    await page.click('button:has-text("清除篩選")');
    await page.waitForFunction((n) => document.querySelectorAll('.dv-card').length === n, all.length);

    // 表格檢視，重新整理後仍是表格
    await page.click('label:has-text("表格"), button:has-text("表格")');
    await page.waitForSelector('.dv-table');
    assert.equal(await page.locator('.dv-row').count(), all.length);
    await page.reload();
    await page.waitForSelector('.dv-table');
    assert.deepEqual(problems, []);
  });

  test('狀態燈：依 /api/status 顯示、收到 status.changed 即時更新；偵測不可用時顯示「—」', { skip }, async () => {
    const { page, problems } = await boot();
    await page.waitForSelector('.dv-card');
    const dot = (id) => page.locator(`.dv-card[data-id="${id}"] .nc-status`);
    assert.equal(await dot('dev_router').getAttribute('data-state'), 'up');
    assert.equal(await dot('dev_printer').getAttribute('data-state'), 'offline'); // 非關鍵設備離線：灰色「離線」
    assert.equal(await dot('dev_swcore').getAttribute('data-state'), 'unknown'); // 沒有資料 → 未知

    await page.evaluate(() => window.__NC__.bus.emit('status.changed', { deviceId: 'dev_router', from: 'up', to: 'down', rttMs: null, at: '2026-10-14T08:30:00.000Z' }));
    await page.waitForFunction(() => document.querySelector('.dv-card[data-id="dev_router"] .nc-status')?.dataset.state === 'down'); // 關鍵設備離線：紅色
    // status.snapshot 重建全部
    await page.evaluate(() => window.__NC__.bus.emit('status.snapshot', { items: [{ deviceId: 'dev_router', state: 'up', rttMs: 1, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0 }] }));
    await page.waitForFunction(() => document.querySelector('.dv-card[data-id="dev_router"] .nc-status')?.dataset.state === 'up');
    assert.deepEqual(problems, []);

    // 偵測不可用：/api/status 404（monitor 停用或不可用）
    const b = await boot({ status: 'none' });
    await b.page.waitForSelector('.dv-card');
    assert.equal(await b.page.locator('.dv-card .nc-status').count(), 0);
    assert.equal(await b.page.locator('.dv-card .dv-na').count(), (await b.api('/api/devices')).length);
    assert.equal(await b.page.locator('.dv-card .dv-na').first().innerText(), '—');
  });

  test('新增精靈：6 步走完 → 設備建立 → 提示出現「放到平面圖」並導向 #/floorplan?place=', { skip }, async () => {
    const { page, problems, api } = await boot();
    await page.waitForSelector('.dv-card');
    const before = (await api('/api/devices')).length;

    await page.click('button:has-text("新增設備")');
    await page.waitForSelector('.dv-cat');
    // 沒選類別按下一步 → 擋住並顯示訊息
    await nextStep(page);
    await page.waitForSelector('text=請選擇設備類別');
    await page.click('.dv-cat[data-id="cat_ap"]');
    await nextStep(page);

    // 基本資料：名稱必填、IP 格式
    await nextStep(page);
    await page.waitForSelector('text=請輸入設備名稱');
    await fieldInput(page, '名稱 *').fill('走廊 AP');
    await fieldInput(page, '編號').fill('W99');
    await fieldInput(page, 'IP 位址').fill('192.168.1.250x');
    await nextStep(page);
    await page.waitForSelector('text=IP 位址格式不正確');
    await fieldInput(page, 'IP 位址').fill('192.168.1.250');
    await fieldInput(page, 'MAC 位址').fill('AA:BB:CC:DD:EE:99');
    await fieldInput(page, '廠牌').fill('Zyxel');
    await fieldInput(page, '型號').fill('WAX');
    await fieldInput(page, '說明').fill('測試用');
    await nextStep(page);

    // 位置：房間依樓層連動
    assert.equal(await page.locator('select[aria-label="房間"]').isDisabled(), true);
    await page.selectOption('select[aria-label="樓層"]', 'flr_1');
    assert.equal(await page.locator('select[aria-label="房間"]').isDisabled(), false);
    await page.selectOption('select[aria-label="房間"]', 'room_living');
    await page.click('.nc-field:has-text("組別") button:has-text("家用")');
    await nextStep(page);

    // 連線：可搜尋的上游下拉
    await page.fill('input[aria-label="搜尋上游設備"]', '核心交換器');
    assert.equal(await page.locator('select.dv-uplink-list option').count(), 2); // 根節點選項＋1 筆
    await page.selectOption('select.dv-uplink-list', 'dev_swcore');
    await fieldInput(page, '上游設備的埠').fill('LAN9');
    await fieldInput(page, '本機的埠').fill('LAN');
    await fieldSelect(page, '連線媒介').selectOption('poe');
    await fieldInput(page, '速率').fill('1G');
    await nextStep(page);

    // 偵測：依類別帶預設（無線基地台 → icmp）；改成 TCP 必須填埠
    assert.equal(await fieldSelect(page, '偵測方式').inputValue(), 'icmp');
    await fieldSelect(page, '偵測方式').selectOption('tcp');
    await nextStep(page);
    await page.waitForSelector('text=必須填寫偵測埠');
    await fieldInput(page, '偵測埠').fill('22');
    await page.locator('.dv-check input').check();
    await nextStep(page);

    // 確認頁
    await page.waitForSelector('dl:has-text("走廊 AP")');
    const summary = await page.locator('.nc-wizard-pane dl').innerText();
    for (const want of ['無線基地台', 'W99', '192.168.1.250', '1F', '客廳', '家用', '核心交換器', 'LAN9', 'PoE', 'TCP 埠 22']) assert.ok(summary.includes(want), `確認頁缺少「${want}」：${summary}`);
    await page.click('button:has-text("送出")');

    await page.waitForSelector('.dv-snack');
    const devices = await api('/api/devices');
    assert.equal(devices.length, before + 1);
    const created = devices.find((d) => d.code === 'W99');
    assert.ok(created);
    assert.deepEqual(
      { name: created.name, categoryId: created.categoryId, ip: created.ip, mac: created.mac, vendor: created.vendor, model: created.model, notes: created.notes, floorId: created.floorId, roomId: created.roomId, groupIds: created.groupIds },
      { name: '走廊 AP', categoryId: 'cat_ap', ip: '192.168.1.250', mac: 'AA:BB:CC:DD:EE:99', vendor: 'Zyxel', model: 'WAX', notes: '測試用', floorId: 'flr_1', roomId: 'room_living', groupIds: ['grp_family'] },
    );
    assert.deepEqual(created.uplink, { deviceId: 'dev_swcore', port: 'LAN9', localPort: 'LAN', medium: 'poe', speed: '1G' });
    assert.deepEqual(created.monitor, { method: 'tcp', port: 22, path: '/', intervalSec: 60, critical: true });

    // 列表即時出現新設備；提示按鈕導向平面圖放置模式
    await page.waitForSelector(`.dv-card[data-id="${created.id}"]`);
    await page.click('.dv-snack button:has-text("放到平面圖")');
    await page.waitForFunction((id) => location.hash.startsWith(`#/floorplan?`) && location.hash.includes(`place=${id}`), created.id);
    assert.equal(await page.locator('.dv-snack').count(), 0);
    assert.deepEqual(problems, []);
  });

  test('新增精靈：編號重複 → 後端 409 訊息顯示在精靈內且不關閉', { skip }, async () => {
    const { page, api } = await boot();
    await page.waitForSelector('.dv-card');
    const before = (await api('/api/devices')).length;
    await page.click('button:has-text("新增設備")');
    await page.click('.dv-cat[data-id="cat_pc"]');
    await nextStep(page);
    await fieldInput(page, '名稱 *').fill('重複編號');
    await fieldInput(page, '編號').fill('R01'); // mock 資料已有 R01
    for (let i = 0; i < 4; i++) await nextStep(page);
    await page.click('button:has-text("送出")');
    await page.waitForSelector('text=已被');
    assert.equal(await page.locator('.dv-cat, .nc-wizard-pane').count() > 0, true);
    assert.equal((await api('/api/devices')).length, before);
  });

  test('抽屜與編輯：點卡片開抽屜（上下游連結）→ 編輯精靈（上游候選排除自己與後代）→ 儲存更新', { skip }, async () => {
    const { page, problems, api } = await boot();
    await page.waitForSelector('.dv-card');
    await page.click('.dv-card[data-id="dev_swcore"]');
    await page.waitForSelector('.dv-drawer');
    assert.match(await page.locator('.dv-drawer').innerText(), /S01/);
    assert.match(await page.locator('.dv-d-links').first().innerText(), /主路由器/);
    // 下游連結：點下游設備 → 抽屜換成該設備
    const down = page.locator('.dv-d-links').nth(1).locator('.dv-link').first();
    const downCode = (await down.locator('.dv-link-name').innerText()).split(/\s+/)[0];
    assert.ok(downCode);
    await down.click();
    await page.waitForFunction((code) => document.querySelector('.dv-kv')?.innerText.includes(code), downCode);
    // 回到核心交換器並編輯
    await page.locator('.dv-d-links').first().locator('.dv-link').click();
    await page.waitForFunction(() => document.querySelector('.dv-d-head')?.innerText.includes('交換器'));
    await page.click('.dv-drawer button:has-text("編輯")');
    await page.waitForSelector('.dv-cat');
    await nextStep(page);
    assert.equal(await fieldInput(page, '名稱 *').inputValue(), '核心交換器');
    await fieldInput(page, '名稱 *').fill('核心交換器（改）');
    await fieldInput(page, 'IP 位址').fill('192.168.1.22');
    await nextStep(page);
    await nextStep(page);
    // 上游候選：不含自己與所有後代
    const options = await page.locator('select.dv-uplink-list option').evaluateAll((os) => os.map((o) => o.value));
    const devices = await api('/api/devices');
    const banned = new Set(['dev_swcore']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of devices) if (d.uplink && banned.has(d.uplink.deviceId) && !banned.has(d.id)) { banned.add(d.id); grew = true; }
    }
    assert.ok(banned.size > 1);
    for (const id of banned) assert.ok(!options.includes(id), `${id} 不應出現在上游候選`);
    assert.ok(options.includes('dev_router'));
    await nextStep(page);
    await nextStep(page);
    await page.click('button:has-text("送出")');
    await page.waitForSelector('.dv-snack:has-text("已更新")');
    const updated = await api('/api/devices/dev_swcore');
    assert.equal(updated.name, '核心交換器（改）');
    assert.equal(updated.ip, '192.168.1.22');
    assert.equal(updated.uplink.deviceId, 'dev_router'); // 沒動到上游
    await page.waitForFunction(() => [...document.querySelectorAll('.dv-card-name')].some((e) => e.textContent === '核心交換器（改）'));
    assert.deepEqual(problems, []);
  });

  test('刪除：確認對話框列出會被斷開的下游設備；取消不刪；確認後下游變根節點', { skip }, async () => {
    const { page, problems, api } = await boot();
    await page.waitForSelector('.dv-card');
    const before = await api('/api/devices');
    const downstream = before.filter((d) => d.uplink?.deviceId === 'dev_swcore');
    assert.ok(downstream.length > 0);

    await page.click('.dv-card[data-id="dev_swcore"]');
    await page.waitForSelector('.dv-drawer');
    await page.click('.dv-drawer button:has-text("刪除")');
    const dialog = page.locator('[role="alertdialog"], [role="dialog"]:has-text("刪除")').last();
    await dialog.waitFor();
    const text = await dialog.innerText();
    for (const d of downstream) assert.ok(text.includes(d.name), `對話框應列出下游「${d.name}」：${text}`);
    await dialog.locator('button:has-text("取消")').click();
    assert.equal((await api('/api/devices')).length, before.length);

    await page.click('.dv-drawer button:has-text("刪除")');
    await page.locator('[role="alertdialog"] button:has-text("刪除"), [role="dialog"] button.danger:has-text("刪除")').last().click();
    await page.waitForFunction((id) => !document.querySelector(`.dv-card[data-id="${id}"]`), 'dev_swcore');
    const after = await api('/api/devices');
    assert.equal(after.length, before.length - 1);
    for (const d of downstream) assert.equal(after.find((x) => x.id === d.id).uplink, null);
    assert.equal(await page.locator('.dv-drawer').count(), 0, '刪除後抽屜關閉');
    assert.deepEqual(problems, []);
  });

  test('device.open：在其他分頁（devices 頁未掛載）發出事件也能開抽屜', { skip }, async () => {
    const { page, problems } = await boot({ hash: '#/status' });
    await page.waitForSelector('.nc-view[data-module="status"]');
    assert.equal(await page.locator('.dv-card').count(), 0);
    await page.waitForFunction(() => window.__NC__ && window.__NC__.ctx);
    await page.waitForTimeout(200); // 等 devices 模組的常駐監聽建立
    await page.evaluate(() => window.__NC__.bus.emit('device.open', { id: 'dev_router' }));
    await page.waitForSelector('.dv-drawer');
    assert.match(await page.locator('.dv-drawer').innerText(), /主路由器|R01/);
    assert.equal(await page.locator('.nc-view[data-module="status"]').count(), 1, '仍停留在原分頁');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dv-drawer'));
    assert.deepEqual(problems, []);
  });

  test('分類管理：樓層（排序、改名、刪除受 409 保護）、房間、組別、類別', { skip }, async () => {
    const { page, problems, api } = await boot({ hash: '#/devices?view=manage' });
    await page.waitForSelector('.dv-manage');
    const section = (title) => page.locator(`.dv-sec:has(.dv-sec-title:text-is("${title}"))`);

    // 新增樓層、房間、組別、類別
    await section('樓層').locator('input').fill('4F');
    await section('樓層').locator('button:has-text("新增樓層")').click();
    await page.waitForSelector('.dv-sec:has-text("樓層") .dv-item-name:text-is("4F")');
    const floors = await api('/api/floors');
    const f4 = floors.find((f) => f.name === '4F');
    assert.ok(f4);
    assert.equal(f4.order, Math.max(...floors.map((f) => f.order)));

    await section('房間').locator('select').selectOption(f4.id);
    await section('房間').locator('input').fill('閣樓');
    await section('房間').locator('button:has-text("新增房間")').click();
    await page.waitForSelector('.dv-sec .dv-item-name:text-is("閣樓")');

    await section('組別').locator('input[type="text"]').fill('訪客');
    await section('組別').locator('button:has-text("新增組別")').click();
    await page.waitForSelector('.dv-sec .dv-item-name:text-is("訪客")');
    assert.ok((await api('/api/groups')).some((g) => g.name === '訪客'));

    await section('設備類別').locator('input[type="text"]').fill('門鈴');
    await section('設備類別').locator('button:has-text("新增類別")').click();
    await page.waitForSelector('.dv-sec .dv-item-name:text-is("門鈴")');
    const bell = (await api('/api/categories')).find((c) => c.name === '門鈴');
    assert.equal(bell.builtin, false);

    // 內建類別沒有刪除按鈕；自訂類別有
    assert.equal(await page.locator('.dv-item:has(.dv-item-name:text-is("路由器")) button:has-text("刪除")').count(), 0);
    assert.equal(await page.locator('.dv-item:has(.dv-item-name:text-is("門鈴")) button:has-text("刪除")').count(), 1);

    // 樓層上移：4F 與 3F 交換順序
    await page.locator('.dv-item:has(.dv-item-name:text-is("4F")) button[aria-label="4F 上移"]').click();
    await page.waitForFunction(async () => (await (await fetch('/api/floors')).json()).map((f) => f.name).join() === '1F,2F,4F,3F');

    // 改名
    await page.locator('.dv-item:has(.dv-item-name:text-is("4F")) button:has-text("編輯")').click();
    await page.locator('.dv-inline input').first().fill('四樓');
    await page.locator('.dv-inline button:has-text("儲存")').click();
    await page.waitForSelector('.dv-item-name:text-is("四樓")');

    // 刪除有房間的樓層 → 409 的訊息以提示顯示，資料還在
    await page.locator('.dv-item:has(.dv-item-name:text-is("四樓")) button:has-text("刪除")').click();
    await page.locator('[role="alertdialog"] button:has-text("刪除"), [role="dialog"] button.danger:has-text("刪除")').last().click();
    await page.waitForSelector('text=無法刪除');
    assert.ok((await api('/api/floors')).some((f) => f.name === '四樓'));

    // 刪除使用中的組別：會從設備移除
    const family = (await api('/api/groups')).find((g) => g.id === 'grp_family');
    const usersBefore = (await api('/api/devices')).filter((d) => d.groupIds.includes(family.id)).length;
    assert.ok(usersBefore > 0);
    await page.locator(`.dv-item:has(.dv-item-name:text-is("${family.name}")) button:has-text("刪除")`).click();
    const dlg = page.locator('[role="alertdialog"], [role="dialog"]').last();
    assert.match(await dlg.innerText(), new RegExp(`${usersBefore} 台設備`));
    await dlg.locator('button:has-text("刪除")').last().click();
    await page.waitForFunction(async () => (await (await fetch('/api/groups')).json()).every((g) => g.id !== 'grp_family'));
    assert.equal((await api('/api/devices')).filter((d) => d.groupIds.includes('grp_family')).length, 0);
    assert.ok(problems.every((p) => /409/.test(p)), `只允許預期的 409：${problems.join('\n')}`);
  });

  test('匯入／匯出：CSV 精靈（上傳→預覽→確認）、備份下載連結、JSON 還原失敗不寫入', { skip }, async () => {
    const { page, problems, api } = await boot({ hash: '#/devices?view=io' });
    await page.waitForSelector('.dv-manage');
    const before = await api('/api/devices');

    await page.click('button:has-text("開始 CSV 匯入")');
    await nextStep(page);
    await page.waitForSelector('text=請選擇要匯入的 CSV 檔');
    await page.setInputFiles('.nc-wizard-pane input[type="file"]', CSV);
    await nextStep(page);
    await page.waitForSelector('.dv-report');
    const report = await page.locator('.dv-report').innerText();
    assert.match(report, /將新增 \d+ 台設備/);
    assert.match(report, /略過/);
    assert.match(report, /不明裝置/); // 類別對不到的列
    assert.equal((await api('/api/devices')).length, before.length, '預覽不寫入');
    await nextStep(page);
    await page.click('button:has-text("送出")');
    await page.waitForSelector('.dv-result .dv-report');
    const after = await api('/api/devices');
    assert.ok(after.length > before.length);
    assert.ok(after.some((d) => d.name === '前門攝影機' || d.name === '神秘盒子'));
    assert.match(await page.locator('.dv-result').innerText(), /已新增 \d+ 台設備/);

    // 備份連結
    const href = await page.locator('a:has-text("下載備份")').getAttribute('href');
    assert.equal(href, '/api/export?secrets=0');
    await page.locator('.dv-check input').check();
    assert.equal(await page.locator('a:has-text("下載備份")').getAttribute('href'), '/api/export?secrets=1');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("下載備份")')]);
    assert.match(download.suggestedFilename(), /^networkconnect-\d{8}\.json$/);

    // JSON 還原：壞檔 → 顯示所有錯誤、資料不變
    const bad = path.join(makeTmpDir(), 'bad.json');
    const exported = await api('/api/export');
    exported.collections.devices[0].categoryId = 'cat_nope';
    fs.writeFileSync(bad, JSON.stringify(exported));
    await page.setInputFiles('input[aria-label="選擇備份檔"]', bad);
    await page.click('button:has-text("還原備份")');
    await page.locator('[role="alertdialog"] button:has-text("取代並匯入"), [role="dialog"] button:has-text("取代並匯入")').last().click();
    await page.waitForSelector('text=匯入失敗，沒有寫入任何資料');
    assert.match(await page.locator('.dv-result').innerText(), /cat_nope/);
    assert.equal((await api('/api/devices')).length, after.length);

    // 好檔 → 還原成功
    const good = path.join(makeTmpDir(), 'good.json');
    const snapshot = await api('/api/export');
    fs.writeFileSync(good, JSON.stringify(snapshot));
    await page.setInputFiles('input[aria-label="選擇備份檔"]', good);
    await page.click('button:has-text("還原備份")');
    await page.locator('[role="alertdialog"] button:has-text("取代並匯入"), [role="dialog"] button:has-text("取代並匯入")').last().click();
    await page.waitForSelector('text=備份已匯入');
    assert.ok(problems.every((p) => /400/.test(p)), `只允許預期的 400：${problems.join('\n')}`);
  });

  test('網址 ?new=1 直接開新增精靈；?view= 切換子頁；離開頁面後清理乾淨', { skip }, async () => {
    const { page, problems } = await boot({ hash: '#/devices?new=1' });
    await page.waitForSelector('.dv-cat');
    assert.ok(!page.url().includes('new=1'), '開啟後移除 new 參數');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.nc-wizard-pane'));

    await page.click('.dv-head [role="tab"]:has-text("分類管理")');
    await page.waitForSelector('.dv-manage');
    assert.match(page.url(), /view=manage/);
    await page.click('.dv-head [role="tab"]:has-text("設備")');
    await page.waitForSelector('.dv-card');
    assert.ok(!page.url().includes('view='));

    // 離開 devices：多餘的 DOM 與計時器都清掉，之後的事件不會出錯
    await page.click('#nc-nav a[data-module="status"]');
    await page.waitForSelector('.nc-view[data-module="status"]');
    assert.equal(await page.locator('.dv-card, .dv-snack, .dv').count(), 0);
    await page.evaluate(() => {
      window.__NC__.bus.emit('status.changed', { deviceId: 'dev_router', from: 'up', to: 'down', rttMs: null, at: '2026-10-14T08:30:00.000Z' });
      window.__NC__.bus.emit('inventory.changed', { collection: 'devices', op: 'update', id: 'dev_router' });
    });
    await page.waitForTimeout(300);
    assert.deepEqual(problems, []);
  });

  test('手機 390px：列表、抽屜、精靈、分類管理都沒有橫向捲動', { skip }, async () => {
    const { page, problems } = await boot({ width: 390 });
    await page.waitForSelector('.dv-card');
    assert.equal(await noOverflow(page), true, '列表');
    await page.click('button:has-text("表格")');
    await page.waitForSelector('.dv-table');
    assert.equal(await noOverflow(page), true, '表格（容器內捲動）');
    await page.click('button:has-text("卡片")');
    await page.click('.dv-card[data-id="dev_router"]');
    await page.waitForSelector('.dv-drawer');
    await page.waitForTimeout(450);
    assert.equal(await noOverflow(page), true, '抽屜');
    const drawerBox = await page.locator('.dv-drawer').boundingBox();
    assert.ok(drawerBox.width <= 390);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dv-drawer'));
    await page.click('button:has-text("新增設備")');
    await page.waitForSelector('.dv-cat');
    for (const id of ['cat_router']) await page.click(`.dv-cat[data-id="${id}"]`);
    for (let i = 0; i < 5; i++) {
      if (i === 1) await fieldInput(page, '名稱 *').fill('手機版測試');
      await page.waitForTimeout(450);
      assert.equal(await noOverflow(page), true, `精靈第 ${i + 1} 步`);
      await nextStep(page);
    }
    const submit = page.locator('button:has-text("送出")');
    assert.equal(await submit.isVisible(), true);
    const box = await submit.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, '送出按鈕在畫面內');
    await page.keyboard.press('Escape');
    await page.goto(`${page.url().split('#')[0]}#/devices?view=manage`);
    await page.waitForSelector('.dv-manage');
    assert.equal(await noOverflow(page), true, '分類管理');
    await page.goto(`${page.url().split('#')[0]}#/devices?view=io`);
    await page.waitForSelector('.dv-manage');
    assert.equal(await noOverflow(page), true, '匯入匯出');
    assert.deepEqual(problems, []);
  });
});
