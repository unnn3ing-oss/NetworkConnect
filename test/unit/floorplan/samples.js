// 測試用的最小圖檔產生器（只有檔頭，足以讓尺寸解析器運作；不是可顯示的完整圖片）。
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR } from '../../../contracts/index.js';

export const realPng = () => fs.readFileSync(path.join(FIXTURES_DIR, 'plan.sample.png'));

export function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 2;
  return b;
}

/** SOI＋APP0＋SOF0＋EOI */
export function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunk) {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunk.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk]);
}

export function webpLossy(width, height) {
  const c = Buffer.alloc(8 + 10);
  c.write('VP8 ', 0, 'latin1');
  c.writeUInt32LE(10, 4);
  c.set([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], 8);
  c.writeUInt16LE(width, 14);
  c.writeUInt16LE(height, 16);
  return riff(c);
}

export function webpLossless(width, height) {
  const c = Buffer.alloc(8 + 5 + 4);
  c.write('VP8L', 0, 'latin1');
  c.writeUInt32LE(9, 4);
  c[8] = 0x2f;
  c.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 9);
  return riff(c);
}

export function webpExtended(width, height) {
  const c = Buffer.alloc(8 + 10);
  c.write('VP8X', 0, 'latin1');
  c.writeUInt32LE(10, 4);
  c.writeUIntLE(width - 1, 12, 3);
  c.writeUIntLE(height - 1, 15, 3);
  return riff(c);
}

export const svgViewBox = (w, h) => Buffer.from(`<?xml version="1.0"?>\n<!-- plan -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}"/></svg>`);
export const svgSized = (w, h) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}px" height='${h}'></svg>`);
export const htmlDoc = () => Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
