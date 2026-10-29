// 架構圖的瀏覽器測試（Chromium + mock 模式）。找不到 Chromium 時整檔 skip。
// 設定環境變數 NC_SHOTS=<資料夾> 會把截圖存到該資料夾（驗收截圖用）。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../../../server/index.js';
import { launchBrowser } from '../../helpers/browser.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

describe('架構圖（Chromium）', async () => {
  const browser = await launchBrowser();
  const skip = !browser && '找不到 Chromium';
  const opened = [];
  const shotDir = process.env.NC_SHOTS;

  after(async () => {
    for (const fn of opened.splice(0)) await fn();
    await browser?.close();
    cleanupAllTmpDirs();
  });

  async function boot({ hash = '#/topology', width = 1280, height = 800, scheme = 'light', emptyDevices = false, fakeStatus = false } = {}) {
    const server = await startServer({ dataDir: makeTmpDir(), port: 0, host: '127.0.0.1', mock: true, env: {} });
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, acceptDownloads: true });
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()} @ ${JSON.stringify(m.location())}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    if (emptyDevices) await page.route('**/api/devices', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
    if (fakeStatus) {
      // 固定的狀態：大多數正常、一台關鍵設備離線（紅）、兩台一般設備離線（灰）
      const down = new Set(['dev_nvr', 'dev_phone1', 'dev_tablet']);
      await page.route('**/api/status', async (route) => {
        const devices = await fetch(`${server.url}/api/devices`).then((r) => r.json());
        const items = devices.map((d) => ({ deviceId: d.id, state: d.monitor?.method === 'none' ? 'disabled' : down.has(d.id) ? 'down' : 'up', rttMs: 1, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0 }));
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(items) });
      });
    }
    // 計算「目前仍掛著的事件監聽數」：以 (target, type, listener) 去重，供洩漏測試比較
    await page.addInitScript(() => {
      const live = new Map(); // target → Map("type|capture" → Set<listener>)
      const add = EventTarget.prototype.addEventListener;
      const rm = EventTarget.prototype.removeEventListener;
      const key = (type, opts) => `${type}|${typeof opts === 'boolean' ? opts : Boolean(opts?.capture)}`;
      EventTarget.prototype.addEventListener = function (type, fn, opts) {
        if (fn) {
          if (!live.has(this)) live.set(this, new Map());
          const m = live.get(this);
          const k = key(type, opts);
          if (!m.has(k)) m.set(k, new Set());
          m.get(k).add(fn);
        }
        return add.call(this, type, fn, opts);
      };
      EventTarget.prototype.removeEventListener = function (type, fn, opts) {
        live.get(this)?.get(key(type, opts))?.delete(fn);
        return rm.call(this, type, fn, opts);
      };
      window.__listenerCount = () => {
        let n = 0;
        // 已經從文件移除的 DOM 節點會被垃圾回收，其監聽不算洩漏；只計算 window／document／bus 等長壽命目標與仍在文件中的節點
        for (const [target, m] of live) {
          if (target instanceof Node && !target.isConnected) continue;
          for (const set of m.values()) n += set.size;
        }
        return n;
      };
    });
    await page.goto(`${server.url}/${hash}`);
    opened.push(async () => {
      await context.close();
      await server.stop();
    });
    return { server, page, problems, api: (p) => fetch(`${server.url}${p}`).then((r) => r.json()) };
  }

  const ready = (page) => page.waitForFunction(() => document.querySelector('.tp-stage')?.__cy?.nodes().length > 0);
  const shot = async (page, name) => {
    if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
  };
  /** 節點之間、節點與邊標籤之間不得重疊：只檢查設備節點的外框 */
  const overlaps = (page) =>
    page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      const boxes = cy.nodes().filter((n) => !n.data('isFloor')).map((n) => ({ id: n.id(), b: n.boundingBox({ includeLabels: false }) }));
      const bad = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].b;
          const b = boxes[j].b;
          if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) bad.push([boxes[i].id, boxes[j].id]);
        }
      }
      return bad;
    });

  test('fixtures 全部畫出：節點數＝設備數、邊數＝設備數-1、單一根、無錯誤', { skip }, async () => {
    const { page, problems, api } = await boot({ fakeStatus: true });
    await ready(page);
    const devices = await api('/api/devices');
    const info = await page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      return { nodes: cy.nodes().length, edges: cy.edges().length, roots: cy.nodes('.root').length, faded: cy.elements('.faded').length, canvases: document.querySelectorAll('.tp-stage canvas').length };
    });
    assert.equal(info.nodes, devices.length);
    assert.equal(info.edges, devices.length - devices.filter((d) => !d.uplink).length);
    assert.equal(info.roots, devices.filter((d) => !d.uplink).length);
    assert.equal(info.faded, 0);
    assert.ok(info.canvases >= 1);
    assert.deepEqual(await overlaps(page), []);
    await shot(page, 'topology.png');
    assert.deepEqual(problems, []);
  });

  test('點節點 → device.open；點樓層外框不會', { skip }, async () => {
    const { page } = await boot();
    await ready(page);
    await page.evaluate(() => {
      window.__opened = [];
      window.__NC__.bus.on('device.open', (p) => window.__opened.push(p.id));
    });
    const pos = await page.evaluate(() => {
      const stage = document.querySelector('.tp-stage');
      const n = stage.__cy.getElementById('dev_router');
      const r = stage.getBoundingClientRect();
      const p = n.renderedPosition();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(pos.x, pos.y);
    await page.waitForFunction(() => window.__opened.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__opened), ['dev_router']);
  });

  test('status.changed 只更新該節點 class（離線＋關鍵＝紅、非關鍵＝灰）', { skip }, async () => {
    const { page, api } = await boot();
    await ready(page);
    const devices = await api('/api/devices');
    const crit = devices.find((d) => d.monitor?.critical);
    const norm = devices.find((d) => !d.monitor?.critical && d.monitor?.method !== 'none');
    const cls = (id) => page.evaluate((i) => document.querySelector('.tp-stage').__cy.getElementById(i).classes().filter((c) => c.startsWith('st-')), id);
    const before = await cls(norm.id);
    await page.evaluate(({ a, b }) => {
      const { bus } = window.__NC__;
      bus.emit('status.changed', { deviceId: a, from: 'up', to: 'down', rttMs: null, at: new Date().toISOString() });
      bus.emit('status.changed', { deviceId: b, from: 'up', to: 'down', rttMs: null, at: new Date().toISOString() });
    }, { a: crit.id, b: norm.id });
    assert.deepEqual(await cls(crit.id), ['st-down']);
    assert.deepEqual(await cls(norm.id), ['st-offline']);
    assert.notDeepEqual(before, ['st-offline']);
    await page.evaluate((id) => window.__NC__.bus.emit('status.changed', { deviceId: id, from: 'down', to: 'up', rttMs: 1, at: '' }), crit.id);
    assert.deepEqual(await cls(crit.id), ['st-up']);
  });

  test('全站篩選：不符合者淡化但仍在圖上；清除後恢復', { skip }, async () => {
    const { page, api } = await boot();
    await ready(page);
    const devices = await api('/api/devices');
    await page.evaluate(() => window.__NC__.filters.set({ floorId: 'flr_2' }));
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.faded').length > 0);
    const r = await page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      return { total: cy.nodes().length, faded: cy.nodes('.faded').length };
    });
    assert.equal(r.total, devices.length);
    assert.equal(r.faded, devices.filter((d) => d.floorId !== 'flr_2').length);
    await page.evaluate(() => window.__NC__.filters.clear());
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.elements('.faded').length === 0);
  });

  test('依樓層分群：出現 3 個 compound 外框，設備在其中；排版不重疊', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    await page.click('.tp-group');
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.floor').length > 0);
    const r = await page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      return { floors: cy.nodes('.floor').length, children: cy.nodes('.floor').map((f) => f.children().length), pressed: document.querySelector('.tp-group').getAttribute('aria-pressed') };
    });
    assert.equal(r.floors, 3);
    assert.ok(r.children.every((n) => n > 0));
    assert.equal(r.pressed, 'true');
    assert.deepEqual(await overlaps(page), []);
    await shot(page, 'topology-grouped.png');
    await page.click('.tp-group');
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.floor').length === 0);
    assert.deepEqual(problems, []);
  });

  test('工具列：重新排版、適合畫面、匯出 PNG 下載檔案', { skip }, async () => {
    const { page } = await boot();
    await ready(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("匯出 PNG")')]);
    assert.match(dl.suggestedFilename(), /^topology-\d{4}-\d{2}-\d{2}\.png$/);
    await page.click('button:has-text("重新排版")');
    await page.click('button:has-text("適合畫面")');
    const z = await page.evaluate(() => document.querySelector('.tp-stage').__cy.zoom());
    assert.ok(z > 0);
  });

  test('重新排版：按幾次都一樣（不會越排越大、畫面越縮越小），分群模式也一樣', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    const measure = () => page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      const bb = cy.nodes().boundingBox();
      return { zoom: Number(cy.zoom().toFixed(4)), w: Math.round(bb.w), h: Math.round(bb.h) };
    });
    for (const grouped of [false, true]) {
      if (grouped) {
        await page.click('.tp-group');
        await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.floor').length > 0);
      }
      const first = await measure();
      for (let i = 0; i < 4; i++) await page.click('button:has-text("重新排版")');
      assert.deepEqual(await measure(), first, grouped ? '分群' : '不分群');
      assert.deepEqual(await overlaps(page), []);
    }
    assert.deepEqual(problems, []);
  });

  test('連線樣式：直線／直角切換，記住設定，重新整理後仍是直角', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    const curve = () => page.evaluate(() => document.querySelector('.tp-stage').__cy.edges()[0].style('curve-style'));
    assert.equal(await curve(), 'bezier');
    await page.getByRole('radio', { name: '直角' }).click();
    assert.equal(await curve(), 'taxi');
    await shot(page, 'topology-orthogonal.png');
    await page.reload();
    await ready(page);
    assert.equal(await curve(), 'taxi');
    assert.equal(await page.getByRole('radio', { name: '直角' }).getAttribute('aria-checked'), 'true');
    await page.getByRole('radio', { name: '直線' }).click();
    assert.equal(await curve(), 'bezier');
    assert.deepEqual(problems, []);
  });

  test('直角＋分群：跨樓層連線經轉接點、每台設備仍只有一條可見進線', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    await page.getByRole('radio', { name: '直角' }).click();
    const info = () => page.evaluate(() => {
      const cy = document.querySelector('.tp-stage').__cy;
      const shown = cy.edges().filter((e) => !e.hasClass('routed') && !e.target().data('isVia'));
      const into = {};
      shown.forEach((e) => { into[e.target().id()] = (into[e.target().id()] ?? 0) + 1; });
      const devices = cy.nodes().filter((n) => !n.data('isFloor') && !n.data('isVia'));
      return {
        vias: cy.nodes('.via').length,
        devices: devices.length,
        roots: devices.filter((n) => !into[n.id()]).length,
        multi: Object.values(into).filter((n) => n > 1).length,
      };
    });
    const flat = await info();
    assert.equal(flat.vias, 0);
    assert.equal(flat.roots, 1);
    await page.click('.tp-group');
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.floor').length > 0);
    const g = await info();
    assert.ok(g.vias > 0, '有跨樓層連線就要有轉接點');
    assert.equal(g.devices, flat.devices);
    assert.equal(g.roots, 1);
    assert.equal(g.multi, 0);
    await page.click('.tp-group');
    await page.waitForFunction(() => document.querySelector('.tp-stage').__cy.nodes('.floor').length === 0);
    assert.equal((await info()).vias, 0);
    assert.deepEqual(problems, []);
  });

  test('深色主題：切換 data-theme 後樣式重套（邊標籤底色跟著 --surface）', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    const bg = () => page.evaluate(() => document.querySelector('.tp-stage').__cy.edges()[0].style('text-background-color'));
    const light = await bg();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForFunction((old) => document.querySelector('.tp-stage').__cy.edges()[0].style('text-background-color') !== old, light);
    await shot(page, 'topology-dark.png');
    assert.deepEqual(problems, []);
  });

  test('沒有設備：顯示空狀態卡，按鈕導向 #/devices', { skip }, async () => {
    const { page, problems } = await boot({ emptyDevices: true });
    await page.waitForSelector('.tp-empty .nc-empty');
    assert.equal(await page.locator('.tp-stage').isVisible(), false);
    await page.click('.tp-empty button');
    await page.waitForFunction(() => location.hash.startsWith('#/devices'));
    assert.deepEqual(problems, []);
  });

  test('手機寬度：沒有橫向捲動', { skip }, async () => {
    const { page } = await boot({ width: 390, height: 844 });
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'topology-mobile.png');
  });

  test('來回切換分頁 10 次：事件監聽數不增加、離開後沒有殘留 canvas', { skip }, async () => {
    const { page, problems } = await boot();
    await ready(page);
    const cycle = async () => {
      await page.evaluate(() => { location.hash = '#/devices'; });
      await page.waitForSelector('.dv');
      assert.equal(await page.locator('.tp-stage').count(), 0);
      assert.equal(await page.evaluate(() => document.querySelectorAll('canvas').length), 0);
      await page.evaluate(() => { location.hash = '#/topology'; });
      await ready(page);
    };
    await cycle(); // 暖機：第一次會載入 devices 模組、CSS 等一次性資源
    const baseline = await page.evaluate(() => window.__listenerCount());
    for (let i = 0; i < 10; i++) await cycle();
    const after = await page.evaluate(() => window.__listenerCount());
    assert.ok(after <= baseline, `監聽數增加：${baseline} → ${after}`);
    assert.deepEqual(problems, []);
  });
});
