// 平面圖檔案辨識與寬高解析（B4 驗收 1）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectImage, extMatches, ImageError } from '../../../server/modules/floorplan/image.js';
import { png, jpeg, webpLossy, webpLossless, webpExtended, svgViewBox, svgSized, htmlDoc, realPng } from './samples.js';

describe('detectImage', () => {
  test('PNG', () => assert.deepEqual(detectImage(png(1234, 567)), { mime: 'image/png', ext: 'png', width: 1234, height: 567 }));
  test('PNG fixture 為 800x500', () => assert.deepEqual(detectImage(realPng()), { mime: 'image/png', ext: 'png', width: 800, height: 500 }));
  test('JPEG（跳過 APP0 找 SOF）', () => assert.deepEqual(detectImage(jpeg(1600, 900)), { mime: 'image/jpeg', ext: 'jpg', width: 1600, height: 900 }));
  test('WebP 三種編碼', () => {
    assert.deepEqual(detectImage(webpLossy(640, 480)), { mime: 'image/webp', ext: 'webp', width: 640, height: 480 });
    assert.deepEqual(detectImage(webpLossless(321, 123)), { mime: 'image/webp', ext: 'webp', width: 321, height: 123 });
    assert.deepEqual(detectImage(webpExtended(2000, 1000)), { mime: 'image/webp', ext: 'webp', width: 2000, height: 1000 });
  });
  test('SVG：viewBox 優先；沒有 viewBox 時讀 width／height', () => {
    assert.deepEqual(detectImage(svgViewBox(1000, 600)), { mime: 'image/svg+xml', ext: 'svg', width: 1000, height: 600 });
    assert.deepEqual(detectImage(svgSized(300, 200)), { mime: 'image/svg+xml', ext: 'svg', width: 300, height: 200 });
  });
  test('SVG：容許 BOM 與 DOCTYPE', () => {
    const buf = Buffer.from('﻿<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg viewBox="0 0 10 20"/>');
    assert.equal(detectImage(buf).height, 20);
  });
  test('SVG 沒有任何尺寸資訊 → 拒絕', () => assert.throws(() => detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), ImageError));
  test('HTML、純文字、空檔、被截斷的檔頭 → 拒絕', () => {
    assert.throws(() => detectImage(htmlDoc()), ImageError);
    assert.throws(() => detectImage(Buffer.from('hello')), ImageError);
    assert.throws(() => detectImage(Buffer.alloc(0)), ImageError);
    assert.throws(() => detectImage(png(1, 1).subarray(0, 12)), ImageError);
    assert.throws(() => detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])), ImageError);
  });
  test('<svg> 出現在 HTML 內不算 SVG', () => assert.throws(() => detectImage(Buffer.from('<html><svg viewBox="0 0 1 1"></svg></html>')), ImageError));
});

describe('extMatches', () => {
  const info = { ext: 'jpg' };
  test('jpg／jpeg 通用、大小寫不拘；不符則 false；沒有副檔名則放行', () => {
    assert.equal(extMatches('a.JPEG', info), true);
    assert.equal(extMatches('a.jpg', info), true);
    assert.equal(extMatches('a.png', info), false);
    assert.equal(extMatches('a.html', info), false);
    assert.equal(extMatches('plan', info), true);
  });
});
