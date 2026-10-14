import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routes, splitInline, RELEASES_URL } from '../../../docs/install/steps.js';

const text = (route) => JSON.stringify(route);

test('兩條路線：Mac 5 步、Windows 4 步', () => {
  assert.equal(routes.mac.steps.length, 5);
  assert.equal(routes.win.steps.length, 4);
});

test('Mac 路線涵蓋：下載、放行、區域網路、防火牆、QR Code', () => {
  const labels = routes.mac.steps.map((s) => s.label).join('|');
  for (const k of ['下載', '放行', '區域網路', '防火牆', 'QR']) assert.match(labels, new RegExp(k));
  assert.match(text(routes.mac), /xattr -cr \/Applications\/NetworkConnect\.app/);
  assert.match(text(routes.mac), /Apple 晶片/);
  assert.match(text(routes.mac), /隱私權與安全性/);
});

test('Windows 路線涵蓋：下載、SmartScreen、防火牆、QR Code，且不提 macOS 專屬的區域網路步驟', () => {
  const labels = routes.win.steps.map((s) => s.label).join('|');
  for (const k of ['下載', 'SmartScreen', '防火牆', 'QR']) assert.match(labels, new RegExp(k));
  assert.doesNotMatch(labels, /區域網路/);
  assert.match(text(routes.win), /其他資訊/);
  assert.match(text(routes.win), /仍要執行/);
});

test('每一步都有標籤、說明與示意 SVG', () => {
  for (const route of Object.values(routes)) {
    for (const s of route.steps) {
      assert.ok(s.label, '標籤');
      assert.ok(s.body.items?.length || s.body.intro, `${s.label} 需要說明`);
      assert.match(s.art, /^<svg viewBox="0 0 480 300"/, `${s.label} 需要示意圖`);
    }
  }
});

test('示意 SVG 會通過 guide 的淨化：沒有 script／style／on*／外部連結／foreignObject，也沒有行內 style 屬性', () => {
  for (const route of Object.values(routes)) {
    for (const s of route.steps) {
      assert.doesNotMatch(s.art, /<script|<style|<foreignObject|\son\w+=|\sstyle=|href=|javascript:/i, s.label);
      // 括號與標籤要平衡
      assert.equal((s.art.match(/<svg/g) ?? []).length, 1);
      assert.equal((s.art.match(/<\/svg>/g) ?? []).length, 1);
    }
  }
});

test('示意 SVG 的 class 只使用 guide.css 提供的色彩 class', () => {
  const css = fs.readFileSync(new URL('../../../web/ui/guide.css', import.meta.url), 'utf8');
  const allowed = new Set([...css.matchAll(/\.nc-guide-art \.(sv-[a-z]+)/g)].map((m) => m[1]));
  assert.ok(allowed.has('sv-acc') && allowed.has('sv-t'));
  for (const route of Object.values(routes)) {
    for (const s of route.steps) {
      for (const m of s.art.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (c.startsWith('sv-')) assert.ok(allowed.has(c), `${s.label} 使用了未定義的 class：${c}`);
          else assert.ok(['m', 'w'].includes(c), `${s.label} 未預期的 class：${c}`);
        }
      }
    }
  }
});

test('splitInline：反引號內視為程式碼，其餘為純文字', () => {
  assert.deepEqual(splitInline('執行 `xattr -cr x` 後重開'), [
    { text: '執行 ', code: false },
    { text: 'xattr -cr x', code: true },
    { text: ' 後重開', code: false },
  ]);
  assert.deepEqual(splitInline('沒有程式碼'), [{ text: '沒有程式碼', code: false }]);
  assert.deepEqual(splitInline('<b>不會被當成 HTML</b>'), [{ text: '<b>不會被當成 HTML</b>', code: false }]);
});

test('Releases 連結指向本專案', () => {
  assert.equal(RELEASES_URL, 'https://github.com/unnn3ing-oss/NetworkConnect/releases');
});
