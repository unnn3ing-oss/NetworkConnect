// 端到端流程（真實伺服器＋真實 Chromium）。每個測試結束時 support.js 會檢查：
// 沒有 pageerror、沒有 console error、沒有 CSP 違規、沒有原生對話框、沒有 5xx。
import { test, expect, PLAN_PNG, fillDeviceWizard, openNewDevice, topologyNodeCount, noOverflow } from './support.js';

const guideStep = (page) => page.locator('.nc-guide-pane:not([hidden])');
const nextBtn = (page) => page.locator('.nc-guide [data-action="next"]');

test('空資料庫：導覽自動出現 → 建樓層、房間 → 新增路由器與 3 台下游設備 → 架構圖 4 個節點', async ({ boot }) => {
  const { page, url, api } = await boot();
  await page.goto(url);

  // 1. 導覽自動開啟（總覽偵測到資料庫為空）
  await expect(page.locator('.nc-guide')).toBeVisible();
  await expect(page).toHaveURL(/#\/onboarding/);
  await expect(page.locator('.nc-guide-step')).toHaveCount(6);
  await expect(guideStep(page)).toContainText('建立樓層');
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'false');

  // 2. 建樓層（導覽內直接建立，完成後打勾）
  await guideStep(page).locator('input[name="floorName"]').fill('1F');
  await guideStep(page).locator('[data-action="create-floor"]').click();
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'true');
  await expect(guideStep(page).locator('.ob-status')).toContainText('1F');
  expect((await api('/api/floors')).map((f) => f.name)).toEqual(['1F']);

  // 3. 平面圖（可略過）→ 建房間
  await nextBtn(page).click();
  await expect(guideStep(page)).toContainText('上傳平面圖');
  await expect(guideStep(page).locator('.nc-tip')).toContainText('可以略過');
  await nextBtn(page).click();
  await expect(guideStep(page)).toContainText('建立房間');
  await guideStep(page).locator('input[name="roomName"]').fill('客廳');
  await guideStep(page).locator('[data-action="create-room"]').click();
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'true');
  expect((await api('/api/rooms')).map((r) => r.name)).toEqual(['客廳']);

  // 4. 新增核心設備 → 導向設備頁並自動開啟精靈
  await nextBtn(page).click();
  await expect(guideStep(page)).toContainText('新增核心設備');
  await guideStep(page).locator('[data-action="add-core"]').click();
  await expect(page.locator('.nc-guide')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/devices/);
  await fillDeviceWizard(page, { category: 'cat_router', name: '主路由器', ip: '192.168.1.1', floor: '1F', room: '客廳' });
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(1);

  // 5. 3 台下游設備（上游選路由器）
  const downstream = [
    ['cat_switch', '客廳交換器', '192.168.1.2'],
    ['cat_ap', '書房基地台', '192.168.1.3'],
    ['cat_nas', '家用 NAS', '192.168.1.4'],
  ];
  for (const [category, name, ip] of downstream) {
    await openNewDevice(page);
    await fillDeviceWizard(page, { category, name, ip, floor: '1F', room: '客廳', uplink: '主路由器（192.168.1.1）' });
  }
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(4);
  const devices = await api('/api/devices');
  const router = devices.find((d) => d.name === '主路由器');
  expect(devices.filter((d) => d.uplink?.deviceId === router.id)).toHaveLength(3);

  // 6. 架構圖 4 個節點
  await page.locator('.nc-nav-link', { hasText: '架構圖' }).click();
  await expect.poll(() => topologyNodeCount(page)).toBe(4);

  // 7. 導覽回得去：總覽的「繼續導覽」指向第一個未完成的必要步驟；全部完成後不再顯示
  await page.locator('.nc-nav-link', { hasText: '總覽' }).click();
  await expect(page.locator('[data-card="stats"] [data-kind="total"] .dsh-stat-num')).toHaveText('4');
  await expect(page.locator('[data-card="setup"]')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/dashboard/); // 離開過導覽後，空資料庫以外的情況不會再被轉走
});

test('離開導覽後不再自動彈出；設定頁可重新開啟；導覽可用 ?step= 直達並依實際資料打勾', async ({ boot }) => {
  const { page, url, api, json } = await boot();
  await page.goto(url);
  await expect(page.locator('.nc-guide')).toBeVisible();
  await page.locator('.nc-guide [data-action="close"]').click();
  await page.locator('.nc-dialog [data-action="ok"], .nc-dialog .btn.primary, .nc-dialog .btn.danger').first().click();
  await expect(page.locator('.nc-guide')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.locator('[data-card="setup"]')).toBeVisible(); // 還有必要步驟沒完成

  await page.reload();
  await expect(page.locator('.dsh')).toBeVisible();
  await expect(page.locator('.nc-guide')).toHaveCount(0);

  // 先用 API 補資料，再用「繼續導覽」回到導覽：已完成的步驟顯示打勾
  const floor = await api('/api/floors', json('POST', { name: '2F', order: 1 }));
  await api('/api/rooms', json('POST', { floorId: floor.id, name: '主臥' }));
  await page.reload();
  await page.locator('[data-action="resume-onboarding"]').click();
  await expect(page).toHaveURL(/#\/onboarding\?step=4/); // 樓層、房間都有了，第一個未完成的是「核心設備」
  await expect(guideStep(page)).toContainText('新增核心設備');
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'false');
  await page.locator('.nc-guide-step', { hasText: '建立房間' }).locator('button').click();
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'true');

  await page.locator('.nc-guide [data-action="close"]').click();
  await page.locator('.nc-dialog .btn.primary, .nc-dialog .btn.danger').first().click();
  await expect(page.locator('.nc-guide')).toHaveCount(0);
  await page.locator('.nc-nav-link', { hasText: '設定' }).click();
  await page.locator('[data-action="reopen-onboarding"]').click();
  await expect(page.locator('.nc-guide')).toBeVisible();
});

test('平面圖：上傳 → 點清單再點圖放置 → 重新整理位置不變', async ({ boot }) => {
  const { page, url, api } = await boot({ mode: 'mock' });
  await page.goto(`${url}/#/floorplan?floorId=flr_2`);
  await expect(page.locator('.nc-empty')).toBeVisible(); // 2F 沒有平面圖
  await page.setInputFiles('input.nc-fp-file', PLAN_PNG);
  await page.locator('.nc-fp-viewport').waitFor();
  await page.waitForFunction(() => document.querySelector('.nc-fp-img')?.complete);
  expect((await api('/api/plans')).some((p) => p.floorId === 'flr_2')).toBe(true);

  await page.locator('[data-act="edit"]').click();
  await expect(page.locator('.nc-fp-item').first()).toBeVisible();
  const vp = await page.locator('.nc-fp-viewport').boundingBox();
  const spots = [[0.3, 0.35], [0.65, 0.6]];
  for (let i = 0; i < spots.length; i++) {
    await page.locator('.nc-fp-item').first().click();
    await page.mouse.click(vp.x + vp.width * spots[i][0], vp.y + vp.height * spots[i][1]);
    await expect.poll(async () => (await api('/api/placements?floorId=flr_2')).length).toBe(i + 1);
  }
  const before = (await api('/api/placements?floorId=flr_2')).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  for (const p of before) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
  }
  const ratios = () =>
    page.evaluate(() => {
      const r = document.querySelector('.nc-fp-img').getBoundingClientRect();
      return [...document.querySelectorAll('.nc-fp-dot')]
        .map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.device, (b.x + b.width / 2 - r.x) / r.width, (b.y + b.height / 2 - r.y) / r.height]; })
        .sort((a, b) => a[0].localeCompare(b[0]));
    });
  await expect(page.locator('.nc-fp-dot')).toHaveCount(2);
  const shownBefore = await ratios();

  await page.reload();
  await expect(page.locator('.nc-fp-dot')).toHaveCount(2);
  await page.waitForFunction(() => document.querySelector('.nc-fp-img')?.complete);
  await page.waitForTimeout(150);
  expect((await api('/api/placements?floorId=flr_2')).sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual(before);
  const shownAfter = await ratios();
  shownAfter.forEach(([id, x, y], i) => {
    expect(id).toBe(shownBefore[i][0]);
    expect(Math.abs(x - shownBefore[i][1])).toBeLessThan(0.003);
    expect(Math.abs(y - shownBefore[i][2])).toBeLessThan(0.003);
  });
});

test('篩選樓層後，設備列表、架構圖、平面圖三處一致', async ({ boot }) => {
  const { page, url, api } = await boot({ mode: 'mock' });
  const all = await api('/api/devices');
  const placed = await api('/api/placements?floorId=flr_1');
  const onFloor = (id) => all.filter((d) => d.floorId === id).length;
  expect(onFloor('flr_1')).toBeGreaterThan(placed.length); // fixture：1F 有設備尚未放置，可驗證「未放置」的算法

  await page.goto(`${url}/#/devices`);
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(all.length);
  await page.locator('select[data-filter="floorId"]').selectOption('flr_1');
  await expect(page).toHaveURL(/floorId=flr_1/);
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(onFloor('flr_1'));

  // 架構圖：切換分頁後篩選保留；不屬於 1F 的節點被淡化
  await page.locator('.nc-nav-link', { hasText: '架構圖' }).click();
  await expect(page).toHaveURL(/floorId=flr_1/);
  await page.waitForFunction(() => document.querySelector('.tp-stage')?.__cy?.nodes('.faded').length > 0);
  const topo = await page.evaluate(() => {
    const cy = document.querySelector('.tp-stage').__cy;
    return { total: cy.nodes().length, faded: cy.nodes('.faded').length };
  });
  expect(topo.total - topo.faded).toBe(onFloor('flr_1'));

  // 平面圖：已放置的點＋編輯模式下「未放置」清單 ＝ 本層設備
  await page.locator('.nc-nav-link', { hasText: '平面圖' }).click();
  await expect(page.locator('.nc-fp-dot')).toHaveCount(placed.length);
  await page.locator('[data-act="edit"]').click();
  await expect(page.locator('.nc-fp-item')).toHaveCount(onFloor('flr_1') - placed.length);

  // 換成 2F：沒有平面圖 → 格狀檢視列出的設備數也一致
  await page.locator('select[data-filter="floorId"]').selectOption('flr_2');
  await expect(page.locator('.nc-fp-card')).toHaveCount(onFloor('flr_2'));
  await page.locator('.nc-nav-link', { hasText: '設備' }).click();
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(onFloor('flr_2'));
});

test('偵測狀態變化：列表、架構圖、平面圖、總覽同步變色', async ({ boot }) => {
  const { page, url, server, api } = await boot({ mode: 'mock' });
  const router = (await api('/api/devices')).find((d) => d.id === 'dev_router');
  expect(router.monitor.critical).toBe(true);
  const check = () => api(`/api/status/${router.id}/check`, { method: 'POST' });
  const setDown = async (down) => {
    server.ctx.prober.setDown(router.ip, down);
    for (let i = 0; i < 3; i++) await check(); // 連續 3 次失敗才判定離線
    await expect.poll(async () => (await api('/api/status')).find((s) => s.deviceId === router.id).state).toBe(down ? 'down' : 'up');
  };
  const topoClass = () => page.evaluate((id) => document.querySelector('.tp-stage').__cy.getElementById(id).classes().filter((c) => c.startsWith('st-')), router.id);

  await page.goto(`${url}/#/devices`);
  const listDot = page.locator(`.dv-body [data-id="${router.id}"] .nc-status`).first();
  await expect(listDot).toHaveAttribute('data-state', 'up');
  await setDown(true);
  await expect(listDot).toHaveAttribute('data-state', 'down'); // 即時（SSE），不需重新整理

  await page.locator('.nc-nav-link', { hasText: '架構圖' }).click();
  await page.waitForFunction(() => document.querySelector('.tp-stage')?.__cy?.nodes().length > 0);
  await expect.poll(topoClass).toEqual(['st-down']);

  await page.locator('.nc-nav-link', { hasText: '平面圖' }).click();
  const dot = page.locator(`.nc-fp-dot[data-device="${router.id}"]`);
  await expect(dot).toHaveAttribute('data-status', 'down');

  await page.locator('.nc-nav-link', { hasText: '總覽' }).click();
  await expect(page.locator(`[data-card="critical"] [data-device-id="${router.id}"]`)).toBeVisible();
  await expect(page.locator('[data-card="stats"] [data-kind="down"] .dsh-stat-num')).not.toHaveText('0');

  // 恢復：停留在架構圖頁，燈號即時轉綠
  await page.locator('.nc-nav-link', { hasText: '架構圖' }).click();
  await page.waitForFunction(() => document.querySelector('.tp-stage')?.__cy?.nodes().length > 0);
  await setDown(false);
  await expect.poll(topoClass).toEqual(['st-up']);
  await page.locator('.nc-nav-link', { hasText: '總覽' }).click();
  await expect(page.locator(`[data-card="critical"] [data-device-id="${router.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-card="critical"]')).toContainText('所有關鍵設備都在線上');
});

test('總覽：統計、各樓層上線率、快速入口；點樓層帶著篩選進設備頁', async ({ boot }) => {
  const { page, url, api } = await boot({ mode: 'mock' });
  const devices = await api('/api/devices');
  await page.goto(url);
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.locator('[data-kind="total"] .dsh-stat-num')).toHaveText(String(devices.length));
  await expect(page.locator('.dsh-floor')).toHaveCount(3);
  await expect(page.locator('[data-action="add-device"]')).toBeVisible();
  await expect(page.locator('[data-action="open-cameras"]')).toBeVisible();
  await page.locator('.dsh-floor[data-floor-id="flr_3"]').click();
  await expect(page).toHaveURL(/#\/devices\?.*floorId=flr_3/);
  await expect(page.locator('.dv-body [data-id]')).toHaveCount(devices.filter((d) => d.floorId === 'flr_3').length);
  await page.locator('.nc-nav-link', { hasText: '總覽' }).click();
  await page.locator('[data-action="add-device"]').click();
  await expect(page.locator('.nc-wizard')).toBeVisible();
  await page.locator('.nc-wizard [data-action="cancel"]').click();
});

test('NVR：精靈（假 go2rtc）→ 監視器 4 分割 → 離開頁面串流全部關閉', async ({ boot }) => {
  const { page, url, fake, api } = await boot({ onboardingSeen: true });
  fake.setDefaultCodec('avc1.640029'); // 精靈的測試步驟要看到 H.264
  await page.goto(`${url}/#/cameras`);
  await expect(page.locator('.nc-empty')).toContainText('尚未設定 NVR');
  await page.locator('button:has-text("新增 NVR")').first().click();
  const wiz = page.locator('.nc-wizard');
  await wiz.waitFor();
  await wiz.locator('.nc-op:has-text("Hikvision")').click();
  await wiz.locator('[data-action="next"]').click();
  const field = (label) => wiz.locator(`.nc-field:has(.nc-field-label:text-is("${label}")) input`).first();
  await field('主機位址').fill('192.168.1.20');
  await field('帳號').fill('admin');
  await field('密碼').fill('p@ss:w/rd');
  await field('頻道數').fill('4');
  await wiz.locator('[data-action="next"]').click();
  await expect(page.locator('.cam-test-status.ok')).toContainText('H.264');
  await expect.poll(() => fake.connectionCount()).toBe(0); // 預覽播放數秒後自動關閉
  await wiz.locator('[data-action="next"]').click(); // 測試 → 頻道
  await wiz.locator('[data-action="next"]').click(); // 頻道 → 確認
  await expect(wiz.locator('.nc-kv')).toContainText('192.168.1.20:554');
  fake.setDefaultCodec('flac'); // Playwright 的 Chromium 沒有 H.264 解碼器；送出後畫面牆改播它能播的編碼
  await wiz.locator('[data-action="next"]').click(); // 送出
  await wiz.waitFor({ state: 'detached' });
  expect(JSON.stringify(await api('/api/nvrs'))).not.toContain('p@ss');

  await expect(page.locator('.cam-tile[data-key]')).toHaveCount(4);
  await expect.poll(() => fake.connectionCount(), { timeout: 15_000 }).toBe(4);
  await expect(page.locator('.cam-tile[data-state="live"]').first()).toBeVisible();

  await page.locator('.nc-nav-link', { hasText: '設定' }).click(); // 離開監視器頁
  await expect.poll(() => fake.connectionCount()).toBe(0);
});

test('停用 nvr 模組後，其他頁面全部正常；只有監視器頁顯示錯誤卡，總覽與導覽隱藏 NVR 相關項目', async ({ boot }) => {
  const { page, url } = await boot({ mode: 'mock', config: { modules: { nvr: false } } });
  await page.goto(url);
  await expect(page.locator('.dsh')).toBeVisible();
  await expect(page.locator('[data-action="open-cameras"]')).toHaveCount(0);
  await expect(page.locator('[data-card="stats"]')).toBeVisible();
  for (const [title, ready] of [['設備', '.dv'], ['架構圖', '.tp-stage'], ['平面圖', '.nc-fp'], ['狀態', '.nc-status-page'], ['設定', '.st']]) {
    await page.locator('.nc-nav-link', { hasText: title }).click();
    await expect(page.locator(ready).first(), `${title}頁`).toBeVisible();
    await expect(page.locator('.nc-error-card')).toHaveCount(0);
  }
  await expect(page.locator('.st-module[data-module="nvr"]')).toHaveAttribute('data-state', 'disabled');
  await page.locator('.nc-nav-link', { hasText: '監視器' }).click();
  await expect(page.locator('.nc-error-card')).toContainText('已停用');
  await page.locator('.nc-nav-link', { hasText: '總覽' }).click();
  await expect(page.locator('.dsh')).toBeVisible();

  // 導覽少了 NVR 步驟
  await page.evaluate(() => { window.location.hash = '#/onboarding'; });
  await expect(page.locator('.nc-guide-step')).toHaveCount(5);
  await expect(page.locator('.nc-guide')).not.toContainText('設定 NVR');
});

test('設定頁：存取密碼設定與移除、模組開關（需重新啟動提示）、偵測預設值', async ({ boot }) => {
  const { page, url, api } = await boot({ mode: 'mock' });
  await page.goto(`${url}/#/settings`);
  await expect(page.locator('[data-card="auth"]')).toContainText('未設定');
  await expect(page.locator('[data-card="auth"] .st-warn')).toContainText('強烈建議'); // mock 資料有 NVR

  // 存取密碼
  const auth = page.locator('[data-card="auth"]');
  await auth.locator('input[name="password"]').fill('pw1234');
  await auth.locator('input[name="again"]').fill('pw1234');
  await auth.locator('[data-action="save-password"]').click();
  await expect(auth).toContainText('已啟用');
  expect((await api('/api/auth/status')).enabled).toBe(true);
  expect((await fetch(`${url}/api/devices`)).status).toBe(401); // 沒有 cookie 的請求被擋
  await auth.locator('input[name="current"]').fill('pw1234');
  await auth.locator('[data-action="remove-password"]').click();
  await page.locator('.nc-dialog .btn.danger').click();
  await expect(auth).toContainText('未設定');
  expect((await fetch(`${url}/api/devices`)).status).toBe(200);

  // 模組開關
  const mods = page.locator('[data-card="modules"]');
  await expect(mods.locator('.st-module')).toHaveCount(6);
  await expect(mods.locator('.st-module[data-module="monitor"]')).toHaveAttribute('data-state', 'ok');
  await mods.locator('input[data-module="io"]').uncheck();
  await mods.locator('[data-action="save-modules"]').click();
  await expect(mods.locator('[data-role="restart"]')).toBeVisible();
  expect((await api('/api/system/settings')).modules.io).toBe(false);
  await mods.locator('input[data-module="io"]').check();
  await mods.locator('[data-action="save-modules"]').click();
  await expect(mods.locator('[data-role="restart"]')).toBeHidden();

  // 偵測預設值
  const mon = page.locator('[data-card="monitor"]');
  await mon.locator('input[name="defaultIntervalSec"]').fill('120');
  await mon.locator('[data-action="save-monitor"]').click();
  await expect.poll(async () => (await api('/api/monitor/settings')).defaultIntervalSec).toBe(120);

  // 備份入口與版本資訊
  await page.locator('[data-action="open-backup"]').click();
  await expect(page).toHaveURL(/#\/devices\?view=io/);
  await page.locator('.nc-nav-link', { hasText: '設定' }).click();
  await expect(page.locator('[data-card="about"]')).toContainText('v0.1.0');
});

test('手機 390×844：導覽建立樓層與房間、總覽、設備、設定都能操作且不會橫向捲動', async ({ boot }) => {
  const { page, url, api } = await boot({ viewport: { width: 390, height: 844 }, mobile: true });
  await page.goto(url);
  await expect(page.locator('.nc-guide')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await guideStep(page).locator('input[name="floorName"]').fill('1F');
  await guideStep(page).locator('[data-action="create-floor"]').tap();
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'true');
  await nextBtn(page).tap();
  await nextBtn(page).tap();
  await guideStep(page).locator('input[name="roomName"]').fill('客廳');
  await guideStep(page).locator('[data-action="create-room"]').tap();
  await expect(guideStep(page).locator('.ob-status')).toHaveAttribute('data-done', 'true');
  expect(await noOverflow(page)).toBe(true);
  await nextBtn(page).tap();
  await guideStep(page).locator('[data-action="add-core"]').tap();
  await expect(page.locator('.nc-wizard')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await fillDeviceWizard(page, { category: 'cat_router', name: '主路由器', ip: '192.168.1.1', floor: '1F', room: '客廳' });
  expect((await api('/api/devices')).length).toBe(1);

  for (const title of ['總覽', '設備', '架構圖', '平面圖', '狀態', '設定']) {
    await page.locator('.nc-nav-link', { hasText: title }).tap();
    await expect(page.locator('.nc-view')).toBeVisible();
    await page.waitForTimeout(150);
    expect(await noOverflow(page), `${title}頁橫向捲動`).toBe(true);
  }
});
