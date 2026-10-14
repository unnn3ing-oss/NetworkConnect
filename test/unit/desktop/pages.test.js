import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { renderQrSvg, qrMatrix } from '../../../desktop/lib/qr.js';
import { buildMobilePageHtml, buildErrorPageHtml } from '../../../desktop/lib/pages.js';

test('vendored QR 函式庫的 sha256 與 VERSIONS.md 一致', () => {
  // sha256 以 LF 換行計算（Windows 的 git 可能以 CRLF 簽出，先還原）
  const text = fs.readFileSync(new URL('../../../desktop/vendor/qrcode-generator.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const sha = createHash('sha256').update(text).digest('hex');
  const doc = fs.readFileSync(new URL('../../../desktop/vendor/VERSIONS.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(sha), 'VERSIONS.md 要記錄目前檔案的 sha256');
});

test('qrMatrix：網址長度內為方陣，且含三個定位圖樣', () => {
  const m = qrMatrix('http://192.168.1.20:8780');
  assert.ok(m.length >= 21);
  assert.ok(m.every((row) => row.length === m.length));
  // 左上定位圖樣：7x7 外框為深色
  for (let i = 0; i < 7; i++) assert.equal(m[0][i], true);
  assert.equal(m[1][1], false);
  assert.equal(m[3][3], true);
  // 右上與左下
  assert.equal(m[0][m.length - 1], true);
  assert.equal(m[m.length - 1][0], true);
});

test('renderQrSvg：輸出自足的 SVG（白底、無腳本、無外部連結）', () => {
  const svg = renderQrSvg('http://192.168.1.20:8780');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /<script|href=|on\w+=/i);
  assert.equal(renderQrSvg('http://192.168.1.20:8780'), svg, '相同輸入輸出相同');
  assert.notEqual(renderQrSvg('http://192.168.1.21:8780'), svg);
});

test('buildMobilePageHtml：顯示網址與 QR Code，CSP 禁止腳本', () => {
  const html = buildMobilePageHtml({ urls: ['http://192.168.1.20:8780', 'http://10.0.0.3:8780'], lanAccess: true });
  assert.match(html, /http:\/\/192\.168\.1\.20:8780/);
  assert.match(html, /http:\/\/10\.0\.0\.3:8780/);
  assert.match(html, /<svg /);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<html lang="zh-Hant">/);
});

test('buildMobilePageHtml：關閉區網連線時說明如何開啟，不顯示 QR Code', () => {
  const html = buildMobilePageHtml({ urls: [], lanAccess: false });
  assert.match(html, /區網/);
  assert.doesNotMatch(html, /<svg /);
});

test('buildMobilePageHtml：開啟區網但找不到網卡時給出提示', () => {
  const html = buildMobilePageHtml({ urls: [], lanAccess: true });
  assert.match(html, /找不到/);
});

test('頁面內容會做 HTML 跳脫', () => {
  const html = buildMobilePageHtml({ urls: ['http://1.2.3.4:80/<img src=x onerror=alert(1)>'], lanAccess: true });
  assert.doesNotMatch(html, /<img src=x/);
  const err = buildErrorPageHtml({ message: '<script>alert(1)</script>' });
  assert.doesNotMatch(err, /<script>alert/);
  assert.match(err, /&lt;script&gt;/);
});

test('buildErrorPageHtml：含重新啟動與「查看紀錄」動作連結', () => {
  const html = buildErrorPageHtml({ message: '伺服器啟動失敗：行程結束（代碼 1）' });
  assert.match(html, /nc-action:\/\/open-logs/);
  assert.match(html, /nc-action:\/\/restart/);
  assert.match(html, /查看紀錄/);
  assert.match(html, /代碼 1/);
  assert.doesNotMatch(html, /<script/i);
});
