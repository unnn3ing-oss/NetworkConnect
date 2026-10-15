// E2E 共用：找 Chromium、啟動伺服器、監看頁面問題（pageerror／console error／CSP 違規／原生對話框）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { startServer } from '../../server/index.js';
import { createFakeGo2rtc } from '../helpers/fake-go2rtc.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../helpers/tmp.js';

export const PLAN_PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/fixtures/plan.sample.png');

/**
 * 擴充 test：提供 boot(opts) → { server, url, page, context, fake, api, problems }。
 * 測試結束時一律檢查 problems 必須為空（無 pageerror、無 console error、無 CSP 違規、無原生對話框、無 5xx）。
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  boot: async ({ browser }, use) => {
    const cleanups = [];
    const allProblems = [];

    /**
     * @param {object} [o]
     * @param {'empty'|'mock'} [o.mode]   empty＝全新資料庫；mock＝contracts/fixtures 的範例資料（假 prober、假 go2rtc）
     * @param {object} [o.config]         寫入 config.json（例：{modules:{nvr:false}}）
     * @param {{width:number,height:number}} [o.viewport]
     * @param {boolean} [o.mobile]        觸控裝置
     * @param {boolean} [o.onboardingSeen] 預先標記「已離開過導覽」，空資料庫時才不會自動進導覽
     */
    async function boot({ mode = 'empty', config, viewport = { width: 1280, height: 800 }, mobile = false, onboardingSeen = false } = {}) {
      const dataDir = makeTmpDir('nc-e2e-');
      if (config) fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
      let fake = null;
      let server;
      if (mode === 'mock') {
        server = await startServer({ dataDir, port: 0, host: '127.0.0.1', mock: true, env: {} });
      } else {
        fake = await createFakeGo2rtc();
        server = await startServer({ dataDir, port: 0, host: '127.0.0.1', env: {}, go2rtcUrl: fake.url });
      }
      const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, locale: 'zh-TW' });
      await context.addInitScript(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      if (onboardingSeen) await context.addInitScript(() => { try { localStorage.setItem('nc.onboarding.dismissed', '1'); } catch { /* 忽略 */ } });
      const page = await context.newPage();
      const problems = [];
      allProblems.push(problems);
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
        if (/Content Security Policy|Refused to (load|apply|execute|connect)/.test(m.text())) problems.push(`CSP: ${m.text()}`);
      });
      page.on('dialog', async (d) => {
        problems.push(`原生對話框 ${d.type()}: ${d.message()}`);
        await d.dismiss();
      });
      page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
      cleanups.push(async () => {
        await context.close();
        await server.stop();
        await fake?.close();
      });
      const api = async (p, init) => {
        const r = await fetch(`${server.url}${p}`, init);
        return r.status === 204 ? null : r.json();
      };
      const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const csp = () => page.evaluate(() => window.__csp ?? []);
      return { server, url: server.url, page, context, fake, api, json, problems, csp };
    }

    await use(boot);

    const extra = [];
    for (const fn of cleanups.reverse()) await fn().catch((e) => extra.push(`cleanup: ${e.message}`));
    cleanupAllTmpDirs();
    expect([...allProblems.flat(), ...extra], '頁面不應有 pageerror／console error／CSP 違規／原生對話框').toEqual([]);
  },
});

export { expect };

// ---------------------------------------------------------------- 共用操作

/** 在「新增設備」精靈（已開啟）逐步填寫並送出 */
export async function fillDeviceWizard(page, { category, name, ip = '', floor = '', room = '', uplink = '' }) {
  const wiz = page.locator('.nc-wizard');
  await wiz.waitFor();
  const next = () => wiz.locator('[data-action="next"]').click();
  await wiz.locator(`.dv-cat[data-id="${category}"]`).click();
  await next();
  await wiz.locator('.nc-field:has(.nc-field-label:text-is("名稱 *")) input').fill(name);
  if (ip) await wiz.locator('.nc-field:has(.nc-field-label:text-is("IP 位址")) input').fill(ip);
  await next();
  if (floor) {
    await wiz.locator('select[aria-label="樓層"]').selectOption({ label: floor });
    if (room) await wiz.locator('select[aria-label="房間"]').selectOption({ label: room });
  }
  await next();
  if (uplink) await wiz.locator('select[aria-label="上游設備"]').selectOption({ label: uplink });
  await next(); // 連線 → 偵測
  await next(); // 偵測 → 確認
  await expect(wiz.locator('.nc-kv')).toContainText(name);
  await next(); // 送出
  await wiz.waitFor({ state: 'detached' });
}

/** 開啟「新增設備」精靈（用網址參數，與總覽、導覽的按鈕相同） */
export async function openNewDevice(page) {
  await page.evaluate(() => { window.location.hash = '#/devices?new=1'; });
  await page.locator('.nc-wizard').waitFor();
}

/** 架構圖上的設備節點數（不含樓層外框） */
export const topologyNodeCount = (page) =>
  page.evaluate(() => document.querySelector('.tp-stage')?.__cy?.nodes().filter((n) => !n.data('isFloor')).length ?? -1);

/** 頁面沒有水平捲動 */
export const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
