import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { encodePng } from '../../../scripts/lib/png.js';
import { encodeIco, encodeIcns } from '../../../scripts/lib/icon-formats.js';
import { renderAppIcon, renderTrayGlyph } from '../../../scripts/lib/icon-art.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPng(buf) {
  assert.deepEqual(buf.subarray(0, 8), SIG);
  let off = 8;
  const idat = [];
  let ihdr;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf.subarray(off + 4, off + 8 + len)), `${type} CRC`);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  return { ...ihdr, raw: zlib.inflateSync(Buffer.concat(idat)) };
}

test('encodePng：RGBA 8-bit，CRC 正確，可還原像素', () => {
  const px = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4]);
  const png = readPng(encodePng(2, 2, px));
  assert.equal(png.w, 2);
  assert.equal(png.h, 2);
  assert.equal(png.depth, 8);
  assert.equal(png.color, 6);
  assert.equal(png.raw.length, 2 * (1 + 8));
  assert.deepEqual([...png.raw.subarray(1, 9)], [255, 0, 0, 255, 0, 255, 0, 128]);
});

test('encodePng：像素資料長度不符時丟錯', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(4)), /長度/);
});

test('renderAppIcon：四角透明、中心有像素', () => {
  const { width, height, data } = renderAppIcon(128);
  assert.equal(width, 128);
  assert.equal(data.length, 128 * 128 * 4);
  assert.equal(data[3], 0, '左上角透明');
  const mid = (64 * 128 + 64) * 4;
  assert.equal(data[mid + 3], 255);
  assert.equal(height, 128);
});

test('renderTrayGlyph：template 版只用黑色加透明度；警示版與正常版不同', () => {
  const ok = renderTrayGlyph(44, { template: true, alert: false });
  const bad = renderTrayGlyph(44, { template: true, alert: true });
  for (let i = 0; i < ok.data.length; i += 4) {
    assert.equal(ok.data[i], 0);
    assert.equal(ok.data[i + 1], 0);
    assert.equal(ok.data[i + 2], 0);
  }
  assert.notDeepEqual(ok.data, bad.data);
  assert.ok(ok.data.some((v, i) => i % 4 === 3 && v > 0), '有可見像素');
});

test('encodeIco：標頭、項目數與 256px 以 PNG 儲存', () => {
  const imgs = [16, 32, 256].map((s) => ({ size: s, rgba: Buffer.alloc(s * s * 4, 200), png: encodePng(s, s, Buffer.alloc(s * s * 4, 200)) }));
  const ico = encodeIco(imgs);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  // 第三個項目：256 → 寬高欄位為 0
  assert.equal(ico[6 + 16 * 2], 0);
  const off = ico.readUInt32LE(6 + 16 * 2 + 12);
  assert.deepEqual(ico.subarray(off, off + 8), SIG);
  // 第一個項目為 BMP（DIB 標頭長度 40）
  const off0 = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readUInt32LE(off0), 40);
  assert.equal(ico.readUInt32LE(off0 + 8), 32, 'DIB 高度為 2 倍（含 AND 遮罩）');
});

test('encodeIcns：icns 魔術字、總長度與 PNG 區塊', () => {
  const p = (s) => ({ size: s, png: encodePng(s, s, Buffer.alloc(s * s * 4, 1)) });
  const icns = encodeIcns([p(256), p(512)]);
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.toString('latin1', 8, 12), 'ic08');
  assert.ok(icns.includes(Buffer.from('ic09')));
});

test('已提交的圖示檔存在且格式正確', () => {
  const dir = new URL('../../../desktop/icons/', import.meta.url);
  const png = readPng(fs.readFileSync(new URL('icon-1024.png', dir)));
  assert.equal(png.w, 1024);
  const icns = fs.readFileSync(new URL('icon.icns', dir));
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const ico = fs.readFileSync(new URL('icon.ico', dir));
  assert.equal(ico.readUInt16LE(2), 1);
  for (const f of ['trayTemplate.png', 'trayTemplate@2x.png', 'trayAlertTemplate.png', 'trayAlertTemplate@2x.png', 'tray.png', 'tray-alert.png']) {
    assert.ok(fs.statSync(new URL(f, dir)).size > 50, f);
  }
  assert.equal(readPng(fs.readFileSync(new URL('trayTemplate@2x.png', dir))).w, 44);
  assert.equal(readPng(fs.readFileSync(new URL('tray.png', dir))).w, 32);
});
