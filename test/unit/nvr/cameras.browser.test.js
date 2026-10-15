// cameras 頁的瀏覽器測試（Chromium＋假 go2rtc）：分割、上限、切換分頁／隱藏／全螢幕時串流確實關閉（以假 go2rtc 的連線數驗證）、
// 網址直達、串流服務未啟動提示、設定精靈（測試 H.264／H.265／失敗、取消會刪除草稿）、手機版。
// 需要 Chromium（/opt/pw-browsers 或 NC_CHROMIUM_PATH）；找不到時整檔 skip。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startServer } from '../../../server/index.js';
import { readFixture } from '../../../contracts/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { createFakeGo2rtc } from '../../helpers/fake-go2rtc.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor, sleep } from '../../helpers/tmp.js';

describe('cameras 頁（Chromium）', async () => {
  const browser = await launchBrowser();
  const skip = !browser && '找不到 Chromium';
  const opened = [];

  after(async () => {
    for (const fn of opened.splice(0).reverse()) await fn();
    await browser?.close();
    cleanupAllTmpDirs();
  });

  /** 把 fixtures 寫成資料夾內容（不用 mock 模式，這樣才拿得到假 go2rtc 的控制代碼）。 */
  function seedDataDir({ withNvr = true } = {}) {
    const dataDir = makeTmpDir();
    const db = readFixture('db.sample.json');
    fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
    for (const [name, docs] of Object.entries(db)) {
      if (['statusHistory', 'plans', 'placements'].includes(name)) continue;
      fs.writeFileSync(path.join(dataDir, 'db', `${name}.json`), JSON.stringify(name === 'nvrs' && !withNvr ? [] : docs));
    }
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify(withNvr ? { 'nvr:nvr_main': 'mock-password' } : {}));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ modules: { monitor: false, floorplan: false, io: false } }));
    return dataDir;
  }

  async function boot({ hash = '#/cameras', width = 1280, withNvr = true, deadGo2rtc = false, codec = 'flac' } = {}) {
    const fake = await createFakeGo2rtc();
    // Playwright 的 Chromium 沒有 H.264 解碼器；畫面牆測試改回報它支援的 flac，精靈測試才用 avc1 驗證 H.264 判斷
    fake.setDefaultCodec(codec);
    let go2rtcUrl = fake.url;
    if (deadGo2rtc) {
      const s = net.createServer();
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      go2rtcUrl = `http://127.0.0.1:${s.address().port}`;
      await new Promise((r) => s.close(r));
    }
    const server = await startServer({ dataDir: seedDataDir({ withNvr }), port: 0, host: '127.0.0.1', env: {}, go2rtcUrl });
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 } });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${server.url}/${hash}`);
    const close = async () => {
      await context.close();
      await server.stop();
      await fake.close();
    };
    opened.push(close);
    return {
      server, fake, page, problems, close,
      api: (p, init) => fetch(`${server.url}${p}`, init).then((r) => (r.status === 204 ? null : r.json())),
      tiles: () => page.locator('.cam-tile[data-key]'),
      names: () => page.locator('.cam-tile[data-key] .cam-tile-name').allTextContents(),
      conns: () => fake.connectionCount(),
      waitConns: (n, message) => waitFor(() => fake.connectionCount() === n, { timeoutMs: 6000, message: message ?? `連線數沒有變成 ${n}（目前 ${fake.connectionCount()}）` }),
    };
  }

  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  test('預設 4 分割：4 個格子、連 4 路「子碼流」、頻道名稱浮標', { skip }, async () => {
    const t = await boot();
    await t.page.waitForSelector('.cam-tile[data-key]');
    assert.equal(await t.tiles().count(), 4);
    assert.deepEqual(await t.names(), ['前門', '後門', '車道', '客廳']);
    await t.waitConns(4);
    const srcs = t.fake.wsLog.map((x) => x.src).sort();
    assert.deepEqual(srcs, [1, 2, 3, 4].map((n) => `nvr_nvr_main_${n}_sub`));
    // 後端把瀏覽器的 MSE 請求轉給了 go2rtc
    await waitFor(() => t.fake.received.filter((m) => m.message.type === 'mse').length === 4);
    // 收到資料後格子進入「live」
    await t.page.waitForSelector('.cam-tile[data-state="live"]');
    assert.deepEqual(t.problems, []);
  });

  test('切換 9／16 分割：同時串流上限 9，超過的格子顯示「已達上限」且不連線；上限可調', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.click('.nc-seg button:has-text("9 格")');
    await t.waitConns(8); // fixture 只有 8 路
    assert.equal(await t.tiles().count(), 8);
    // 擴充成 12 路：16 格只會有 9 路連線
    await t.api('/api/nvrs/nvr_main', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelCount: 12 }) });
    await t.page.click('.nc-seg button:has-text("16 格")');
    await waitFor(async () => (await t.tiles().count()) === 12, { message: '16 格應顯示 12 個頻道' });
    await t.waitConns(9);
    assert.equal(await t.page.locator('.cam-tile[data-state="limited"]').count(), 3);
    assert.match(await t.page.locator('.cam-tile[data-state="limited"]').first().innerText(), /已達同時串流上限（9 路）/);
    assert.equal(await t.page.locator('.cam-tile[data-state="limited"] .cam-player').count(), 0, '超過上限的格子不可建立播放器');
    // 調低上限到 3
    await t.page.fill('.cam-limit-input', '3');
    await t.page.dispatchEvent('.cam-limit-input', 'change');
    await t.waitConns(3);
    assert.equal(await t.page.locator('.cam-tile[data-state="limited"]').count(), 9);
    assert.deepEqual(t.problems, []);
  });

  test('超過分割數時分頁；勾選頻道只顯示勾選的', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    assert.equal(await t.page.locator('.cam-pager').isVisible(), true);
    assert.match(await t.page.locator('.cam-pager-text').innerText(), /第 1 \/ 2 頁/);
    await t.page.click('.cam-pager button:has-text("下一頁")');
    await waitFor(async () => (await t.names()).join() === '2F 走廊,樓梯,陽台,3F 走廊');
    await t.waitConns(4);
    // 取消勾選「車道」「客廳」「2F 走廊」…只留 2 個
    for (const key of ['nvr_main:3', 'nvr_main:4', 'nvr_main:5', 'nvr_main:6', 'nvr_main:7', 'nvr_main:8']) await t.page.uncheck(`.cam-side input[data-key="${key}"]`);
    await waitFor(async () => (await t.tiles().count()) === 2);
    assert.deepEqual(await t.names(), ['前門', '後門']);
    await t.waitConns(2);
    assert.equal(await t.page.locator('.cam-pager').isVisible(), false);
  });

  test('切換分頁（離開監視器頁）後串流全部關閉，回來再開', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.evaluate(() => { window.location.hash = '#/devices'; });
    await t.waitConns(0, '離開監視器頁後仍有串流連線');
    assert.equal(await t.page.locator('.cam-tile').count(), 0);
    await t.page.evaluate(() => { window.location.hash = '#/cameras'; });
    await t.waitConns(4);
    assert.deepEqual(t.problems, []);
  });

  test('visibilitychange 隱藏時關閉全部串流，回到可見再開', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    const setHidden = (hidden) => t.page.evaluate((hid) => {
      Object.defineProperty(document, 'hidden', { value: hid, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await setHidden(true);
    await t.waitConns(0, '分頁隱藏後仍有串流連線');
    assert.equal(await t.page.locator('.cam-tile[data-state="paused"]').count(), 4);
    await setHidden(false);
    await t.waitConns(4);
  });

  test('雙擊格子：該頻道主碼流全螢幕（格子暫停，只剩一路）；關閉後切回子碼流', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.dblclick('.cam-tile[data-key="nvr_main:3"]');
    await t.page.waitForSelector('.cam-full');
    await t.waitConns(1);
    assert.equal(t.fake.wsLog.at(-1).src, 'nvr_nvr_main_3_main');
    assert.equal(await t.page.locator('.cam-full').getAttribute('data-stream'), 'nvr_nvr_main_3_main');
    assert.match(await t.page.locator('.cam-full-title').innerText(), /車道/);

    await t.page.keyboard.press('Escape');
    await t.page.waitForSelector('.cam-full', { state: 'detached' });
    await t.waitConns(4);
    assert.ok(!t.fake.wsLog.slice(-4).some((x) => x.src.endsWith('_main')), '關閉全螢幕後只剩子碼流');
    assert.deepEqual([...Array(4)].map((_, i) => `nvr_nvr_main_${i + 1}_sub`), t.fake.wsLog.slice(-4).map((x) => x.src).sort());

    // 全螢幕開著時離開頁面 → 全部關閉
    await t.page.click('.cam-tile[data-key="nvr_main:1"] .cam-icon-btn');
    await t.waitConns(1);
    await t.page.evaluate(() => { window.location.hash = '#/devices'; });
    await t.waitConns(0);
    assert.equal(await t.page.locator('.cam-full').count(), 0);
  });

  test('畫質切換：畫面牆改用主碼流（記住設定）；全螢幕可在主／子碼流之間切換', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.click('.cam-quality .nc-seg-btn[data-value="main"]');
    await waitFor(() => t.fake.wsLog.slice(-4).every((x) => x.src.endsWith('_main')) && t.fake.connectionCount() === 4, { message: '畫面牆沒有改連主碼流' });
    assert.deepEqual((await t.page.locator('.cam-tile[data-key]').evaluateAll((els) => els.map((e) => e.dataset.stream))).sort(),
      [1, 2, 3, 4].map((n) => `nvr_nvr_main_${n}_main`));

    // 重新整理後仍是主碼流
    await t.page.reload();
    await t.waitConns(4);
    assert.ok(t.fake.wsLog.slice(-4).every((x) => x.src.endsWith('_main')));
    assert.equal(await t.page.locator('.cam-quality .nc-seg-btn[data-value="main"]').getAttribute('aria-checked'), 'true');

    // 全螢幕預設主碼流 → 切成子碼流 → 再切回主碼流；始終只有一路
    await t.page.dblclick('.cam-tile[data-key="nvr_main:2"]');
    await t.page.waitForSelector('.cam-full');
    await t.waitConns(1);
    assert.equal(await t.page.locator('.cam-full').getAttribute('data-stream'), 'nvr_nvr_main_2_main');
    assert.match(await t.page.locator('.cam-full-bar').innerText(), /主碼流/);
    await t.page.click('.cam-full [data-action="toggle-quality"]');
    await waitFor(() => t.fake.wsLog.at(-1).src === 'nvr_nvr_main_2_sub' && t.fake.connectionCount() === 1, { message: '全螢幕沒有切到子碼流' });
    assert.equal(await t.page.locator('.cam-full').getAttribute('data-stream'), 'nvr_nvr_main_2_sub');
    assert.match(await t.page.locator('[data-action="toggle-quality"]').innerText(), /切換為主碼流/);
    await t.page.click('.cam-full [data-action="toggle-quality"]');
    await waitFor(() => t.fake.wsLog.at(-1).src === 'nvr_nvr_main_2_main' && t.fake.connectionCount() === 1, { message: '全螢幕沒有切回主碼流' });

    // 關閉全螢幕：畫面牆回到使用者選的主碼流；切回子碼流也生效
    await t.page.keyboard.press('Escape');
    await t.waitConns(4);
    assert.ok(t.fake.wsLog.slice(-4).every((x) => x.src.endsWith('_main')));
    await t.page.click('.cam-quality .nc-seg-btn[data-value="sub"]');
    await waitFor(() => t.fake.wsLog.slice(-4).every((x) => x.src.endsWith('_sub')) && t.fake.connectionCount() === 4, { message: '畫面牆沒有切回子碼流' });
    assert.deepEqual(t.problems, []);
  });

  test('#/cameras?device=<deviceId> 直接開單一畫面', { skip }, async () => {
    const t = await boot({ hash: '#/cameras?device=dev_cam3' });
    await t.page.waitForSelector('.cam-tile[data-key]');
    assert.equal(await t.tiles().count(), 1);
    assert.deepEqual(await t.names(), ['車道']);
    await t.waitConns(1);
    assert.equal(t.fake.wsLog[0].src, 'nvr_nvr_main_3_sub');
    assert.match(await t.page.locator('[data-notice="single"]').innerText(), /車道/);
    // 「查看全部」回到畫面牆
    await t.page.click('[data-notice="single"] button');
    await waitFor(async () => (await t.tiles().count()) === 4);
    await t.waitConns(4);
  });

  test('#/cameras?ch=<nvrId>:<ch> 直接開單一畫面；不存在時顯示說明', { skip }, async () => {
    const t = await boot({ hash: '#/cameras?ch=nvr_main:5' });
    await t.page.waitForSelector('.cam-tile[data-key]');
    assert.deepEqual(await t.names(), ['2F 走廊']);
    await t.waitConns(1);
    // 在同一頁改成不存在的頻道
    await t.page.evaluate(() => { window.location.hash = '#/cameras?ch=nvr_main:99'; });
    await t.page.waitForSelector('[data-notice="missing"]');
    await t.waitConns(0);
    assert.match(await t.page.locator('[data-notice="missing"]').innerText(), /找不到頻道/);
    await t.page.evaluate(() => { window.location.hash = '#/cameras?device=dev_router'; });
    await waitFor(async () => /尚未連結/.test(await t.page.locator('[data-notice="missing"]').innerText()));
  });

  test('NVR 被刪除／頻道改名（nvr.changed）時畫面自動更新', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.api('/api/nvrs/nvr_main', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channels: [{ ch: 1, name: '大門', enabled: true }, { ch: 2, name: '後門', enabled: false }] }) });
    await waitFor(async () => (await t.names()).join() === '大門', { message: '頻道改名沒有反映到畫面' });
    await t.waitConns(1);
    await t.api('/api/nvrs/nvr_main', { method: 'DELETE' });
    await t.page.waitForSelector('.nc-empty');
    assert.match(await t.page.locator('.nc-empty').innerText(), /尚未設定 NVR/);
    await t.waitConns(0);
  });

  test('串流服務未啟動：顯示提示，畫面不報錯；/api/system/modules 的 note 一致', { skip }, async () => {
    const t = await boot({ deadGo2rtc: true });
    await t.page.waitForSelector('[data-notice="down"]');
    assert.match(await t.page.locator('[data-notice="down"]').innerText(), /串流服務未啟動/);
    const mods = await t.api('/api/system/modules');
    assert.equal(mods.find((m) => m.name === 'nvr').note, '串流服務未啟動');
    assert.equal(await t.tiles().count(), 4, '仍顯示格子，並讓使用者重試');
    await t.page.waitForSelector('.cam-tile[data-state="error"]');
    assert.equal(await t.page.locator('.cam-tile[data-state="error"] .cam-retry:visible').count() > 0, true);
  });

  test('#/cameras?new=1 直接開「新增 NVR」精靈，並移除網址參數', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029', hash: '#/cameras?new=1' });
    await t.page.waitForSelector('.nc-wizard');
    assert.match(await t.page.locator('.nc-wizard-title').innerText(), /新增 NVR/);
    await waitFor(async () => !(await t.page.evaluate(() => location.hash)).includes('new=1'));
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
  });

  test('沒有 NVR：空狀態，按鈕開啟設定精靈；取消不留下任何資料', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    await t.page.waitForSelector('.nc-empty');
    await t.page.click('.nc-empty button:has-text("新增 NVR")');
    await t.page.waitForSelector('.nc-wizard');
    assert.match(await t.page.locator('.nc-wizard-title').innerText(), /新增 NVR/);
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
    assert.deepEqual(await t.api('/api/nvrs'), []);
  });

  test('精靈：先選昇銳再改選自訂，自訂 RTSP 網址與碼流代號帶入昇銳的預設', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    await t.page.waitForSelector('.nc-empty');
    await t.page.click('.nc-empty button:has-text("新增 NVR")');
    await t.page.waitForSelector('.nc-wizard');
    await t.page.click('.nc-op:has-text("昇銳")');
    await t.page.click('.nc-op:has-text("自訂")');
    await t.page.click('.nc-wizard [data-action="next"]');
    const field = (label) => t.page.locator(`.nc-field:has(.nc-field-label:text-is("${label}")) input`).first();
    assert.equal(await field('自訂 RTSP 網址').inputValue(), 'rtsp://{u}:{p}@{host}:{port}/chID={ch}&streamType={s}&linkType=tcp');
    assert.equal(await field('主碼流代號（{s}）').inputValue(), 'main');
    assert.equal(await field('子碼流代號（{s}）').inputValue(), 'sub');
    assert.equal(await field('RTSP 埠').inputValue(), '554');
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
  });

  /** 逐步走精靈到「測試」步驟 */
  async function fillWizardToTest(t, { brand = 'Hikvision', password = 'p@ss:w/rd' } = {}) {
    await t.page.click('button:has-text("新增 NVR")');
    await t.page.waitForSelector('.nc-wizard');
    await t.page.click(`.nc-op:has-text("${brand}")`);
    await t.page.click('.nc-wizard [data-action="next"]');
    const field = (label) => t.page.locator(`.nc-field:has(.nc-field-label:text-is("${label}")) input`).first();
    await field('主機位址').fill('192.168.1.20');
    await field('帳號').fill('admin');
    await field('密碼').fill(password);
    await field('頻道數').fill('2');
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.cam-test');
  }

  test('精靈：品牌 → 連線 → 測試（H.264 成功）→ 頻道 → 確認 → 送出，密碼不外洩', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    await fillWizardToTest(t);
    await t.page.waitForSelector('.cam-test-status.ok');
    assert.match(await t.page.locator('.cam-test-status').innerText(), /連線成功/);
    assert.match(await t.page.locator('.cam-test-status').innerText(), /H\.264/);
    const [draft] = await t.api('/api/nvrs');
    assert.equal(draft.host, '192.168.1.20');
    assert.equal(draft.hasPassword, true);
    // 成功時直接播放第 1 頻道子碼流
    await waitFor(() => t.fake.wsLog.some((x) => x.src === `nvr_${draft.id}_1_sub`), { message: '測試成功後沒有播放第 1 頻道子碼流' });
    // 等預覽 3 秒結束，連線關閉
    await t.waitConns(0);
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.cam-table');
    await t.page.fill('input[aria-label="CH1 名稱"]', '前門');
    await t.page.fill('input[aria-label="CH2 名稱"]', '後門');
    await t.page.uncheck('input[aria-label="啟用 CH2"]');
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.nc-kv');
    const summary = await t.page.locator('.nc-kv').innerText();
    assert.match(summary, /192\.168\.1\.20:554/);
    assert.match(summary, /顯示 1 個：前門/);
    t.fake.setDefaultCodec('flac'); // 送出後畫面牆要真的連線，改回這個 Chromium 能播放的編碼
    await t.page.click('.nc-wizard [data-action="next"]'); // 送出
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
    const list = await t.api('/api/nvrs');
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].channels.map((c) => [c.ch, c.name, c.enabled]), [[1, '前門', true], [2, '後門', false]]);
    assert.equal(JSON.stringify(list).includes('p@ss'), false);
    // 監視器頁立刻出現新 NVR 的畫面
    await waitFor(async () => (await t.names()).join() === '前門', { message: '精靈完成後畫面牆沒有更新' });
    await t.waitConns(1);
    assert.deepEqual(t.problems, []);
  });

  test('精靈：H.265 偵測到時顯示警告（請將子碼流改為 H.264），仍可繼續', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    // 先建立一次讓假 go2rtc 知道串流名稱後再設定 codec：精靈建立的 NVR id 是隨機的，所以預先對所有 sub 串流回報 H.265
    const origSet = t.fake.streams.set.bind(t.fake.streams);
    t.fake.streams.set = (name, src) => { if (name.endsWith('_1_sub')) t.fake.setCodec(name, 'hvc1.1.6.L153.B0'); return origSet(name, src); };
    await fillWizardToTest(t);
    await t.page.waitForSelector('.cam-test-status.warn');
    const text = await t.page.locator('.cam-test-status').innerText();
    assert.match(text, /H\.265/);
    assert.match(text, /請將 NVR 的子碼流改為 H\.264/);
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.cam-table'); // 警告不擋下一步
  });

  test('精靈：測試失敗顯示原因（帳密錯誤）並擋住下一步；可略過；取消會刪除草稿', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    const origSet = t.fake.streams.set.bind(t.fake.streams);
    t.fake.streams.set = (name, src) => { if (name.endsWith('_1_sub')) t.fake.setStreamError(name, 'streams: wrong user/pass'); return origSet(name, src); };
    await fillWizardToTest(t);
    await t.page.waitForSelector('.cam-test-status.error');
    assert.match(await t.page.locator('.cam-test-status').innerText(), /帳號或密碼錯誤/);
    assert.equal((await t.api('/api/nvrs')).length, 1, '測試時建立了草稿 NVR');
    // 下一步被擋
    await t.page.click('.nc-wizard [data-action="next"]');
    assert.match(await t.page.locator('.nc-wizard-error').innerText(), /連線測試未通過/);
    assert.equal(await t.page.locator('.cam-table').count(), 0);
    // 略過後可前進
    await t.page.check('.cam-test-skip input');
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.cam-table');
    // 取消 → 草稿 NVR 被刪除
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
    await waitFor(async () => (await t.api('/api/nvrs')).length === 0, { message: '取消精靈後草稿 NVR 沒有被刪除' });
    assert.equal(t.fake.streams.size, 0);
  });

  test('精靈：連不到主機的訊息；改了連線設定必須重測', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    const origSet = t.fake.streams.set.bind(t.fake.streams);
    t.fake.streams.set = (name, src) => { if (name.endsWith('_1_sub')) t.fake.setStreamError(name, 'streams: dial tcp 192.168.1.20:554: i/o timeout'); return origSet(name, src); };
    await fillWizardToTest(t);
    await t.page.waitForSelector('.cam-test-status.error');
    assert.match(await t.page.locator('.cam-test-status').innerText(), /連不到主機 192\.168\.1\.20:554/);
    // 回上一步改主機 → 再進測試步驟會自動重測（草稿以 PATCH 更新，不會多建一台）
    await t.page.click('.nc-wizard [data-action="prev"]');
    await t.page.locator('.nc-field:has(.nc-field-label:text-is("主機位址")) input').fill('192.168.1.21');
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.waitForSelector('.cam-test-status.error');
    const list = await t.api('/api/nvrs');
    assert.equal(list.length, 1);
    assert.equal(list[0].host, '192.168.1.21');
    await t.page.click('.nc-wizard [data-action="cancel"]');
  });

  test('精靈：連線欄位驗證；「怎麼找 RTSP 設定」全螢幕說明', { skip }, async () => {
    const t = await boot({ withNvr: false, codec: 'avc1.640029' });
    await t.page.click('button:has-text("新增 NVR")');
    await t.page.click('.nc-wizard [data-action="next"]');
    await t.page.click('.nc-wizard [data-action="next"]');
    assert.match(await t.page.locator('.nc-wizard-error').innerText(), /IP 位址/);
    await t.page.locator('.nc-field:has(.nc-field-label:text-is("主機位址")) input').fill('rtsp://1.2.3.4/x');
    await t.page.click('.nc-wizard [data-action="next"]');
    assert.match(await t.page.locator('.nc-wizard-error').innerText(), /格式不正確/);
    await t.page.click('[data-action="rtsp-guide"]');
    await t.page.waitForSelector('.nc-guide');
    assert.match(await t.page.locator('.nc-guide-title').innerText(), /怎麼找 RTSP 設定/);
    assert.match(await t.page.locator('.nc-guide').innerText(), /553|554/);
    await t.page.click('.nc-guide [data-action="next"]');
    assert.match(await t.page.locator('.nc-guide-pane:not([hidden])').innerText(), /開啟 RTSP/);
    await t.page.click('.nc-guide [data-action="close"]');
    await t.page.click('.nc-dialog [data-action="ok"], .nc-dialog button.primary, .nc-dialog button.danger').catch(() => {});
  });

  test('NVR 管理：編輯開啟精靈（密碼留空不變）、刪除會移除串流', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.click('[data-action="manage"]');
    await t.page.waitForSelector('.cam-mgr-item');
    assert.match(await t.page.locator('.cam-mgr-item').innerText(), /192\.168\.1\.20:554/);
    await t.page.click('[data-action="mgr-edit"]');
    await t.page.waitForSelector('.nc-wizard');
    assert.match(await t.page.locator('.nc-wizard-title').innerText(), /編輯 NVR/);
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
    assert.equal((await t.api('/api/nvrs')).length, 1, '取消編輯不可刪除既有 NVR');

    await t.page.click('[data-action="manage"]');
    await t.page.click('[data-action="mgr-delete"]');
    await t.page.click('.nc-dialog button.danger');
    await waitFor(async () => (await t.api('/api/nvrs')).length === 0);
    assert.equal(t.fake.streams.size, 0);
  });

  test('編輯既有 NVR：連線設定沒變就不必重測；密碼留空沿用；只改頻道名稱', { skip }, async () => {
    const t = await boot();
    await t.waitConns(4);
    await t.page.click('[data-action="manage"]');
    await t.page.click('[data-action="mgr-edit"]');
    await t.page.waitForSelector('.nc-wizard');
    const next = () => t.page.click('.nc-wizard [data-action="next"]');
    await next(); // 品牌
    await next(); // 連線（密碼留空）
    await t.page.waitForSelector('.cam-test');
    assert.match(await t.page.locator('.cam-test-status').innerText(), /沿用已儲存的設定/);
    await next(); // 測試（不必重測）
    await t.page.waitForSelector('.cam-table');
    await t.page.fill('input[aria-label="CH1 名稱"]', '正門');
    await next();
    await t.page.waitForSelector('.nc-kv');
    assert.match(await t.page.locator('.nc-kv').innerText(), /未重新測試/);
    await next(); // 送出
    await t.page.waitForSelector('.nc-wizard', { state: 'detached' });
    const [nvr] = await t.api('/api/nvrs');
    assert.equal(nvr.channels[0].name, '正門');
    assert.equal(nvr.hasPassword, true);
    assert.equal(t.server.ctx.secrets.get('nvr:nvr_main'), 'mock-password', '密碼留空代表不變');
    await waitFor(async () => (await t.names())[0] === '正門', { message: '畫面牆沒有反映頻道改名' });
  });

  test('手機寬度：沒有水平捲動，可切換頻道清單', { skip }, async () => {
    const t = await boot({ width: 390 });
    await t.page.waitForSelector('.cam-tile[data-key]');
    await t.waitConns(4);
    assert.equal(await noOverflow(t.page), true);
    assert.equal(await t.page.locator('.cam-side').isVisible(), false, '手機預設收合頻道清單');
    await t.page.click('.cam-side-toggle');
    assert.equal(await t.page.locator('.cam-side').isVisible(), true);
    assert.equal(await noOverflow(t.page), true);
    await t.page.click('[data-action="add-nvr"]');
    await t.page.waitForSelector('.nc-wizard');
    assert.equal(await noOverflow(t.page), true);
    await t.page.click('.nc-wizard [data-action="cancel"]');
  });

  test('深色主題與 CSP：沒有 CSP 違規訊息', { skip }, async () => {
    const t = await boot();
    const violations = [];
    t.page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text()); });
    await t.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await t.waitConns(4);
    await t.page.click('button:has-text("新增 NVR")');
    await t.page.waitForSelector('.nc-wizard');
    await t.page.click('.nc-wizard [data-action="cancel"]');
    await sleep(200);
    assert.deepEqual(violations, []);
    assert.deepEqual(t.problems, []);
  });
});
