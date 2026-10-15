// 平面圖檔案辨識（B4）：以檔頭 magic bytes 判斷類型並讀出寬高，不依賴副檔名或 Content-Type，也不引入影像套件。
// SVG 以「文字開頭是否為 <svg 根元素」判斷（容許 BOM、<?xml?>、註解、DOCTYPE）。

/** @typedef {{mime: string, ext: string, width: number, height: number}} ImageInfo */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

function parsePng(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new ImageError('PNG 檔頭損毀');
  return { mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJpeg(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // 填充位元組
      continue;
    }
    // 沒有長度欄位的標記：TEM、RSTn、SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI／SOS 之後不會再有 SOF
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buf.length) break;
      return { mime: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new ImageError('讀不到 JPEG 的尺寸');
}

function parseWebp(buf) {
  if (buf.length < 25) throw new ImageError('WebP 檔頭損毀');
  const kind = buf.toString('latin1', 12, 16);
  let width;
  let height;
  if (kind === 'VP8 ') {
    if (buf.length < 30) throw new ImageError('WebP 檔頭損毀');
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) throw new ImageError('WebP（VP8）檔頭損毀');
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (buf[20] !== 0x2f) throw new ImageError('WebP（VP8L）檔頭損毀');
    const bits = buf.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (kind === 'VP8X') {
    if (buf.length < 30) throw new ImageError('WebP 檔頭損毀');
    width = buf.readUIntLE(24, 3) + 1;
    height = buf.readUIntLE(27, 3) + 1;
  } else {
    throw new ImageError('不支援的 WebP 格式');
  }
  return { mime: 'image/webp', ext: 'webp', width, height };
}

const SVG_HEAD =
  /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(<svg(?=[\s>/])[^>]*>)/i;

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2]) : null;
};
const toPx = (s) => {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(s ?? '');
  if (!m) return null;
  const unit = (m[2] ?? 'px').toLowerCase();
  const factor = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[unit];
  return Number(m[1]) * factor;
};

function parseSvg(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64 * 1024));
  const m = SVG_HEAD.exec(head);
  if (!m) return null;
  const tag = m[1];
  let width = null;
  let height = null;
  const vb = attr(tag, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    [, , width, height] = vb;
  } else {
    width = toPx(attr(tag, 'width'));
    height = toPx(attr(tag, 'height'));
  }
  if (!(width > 0) || !(height > 0)) throw new ImageError('SVG 缺少 viewBox 或 width／height，無法取得尺寸');
  return { mime: 'image/svg+xml', ext: 'svg', width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * @param {Buffer} buf
 * @returns {ImageInfo}
 * @throws {ImageError} 不是支援的圖檔，或讀不出尺寸
 */
export function detectImage(buf) {
  let info = null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) info = parsePng(buf);
  else if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) info = parseJpeg(buf);
  else if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') info = parseWebp(buf);
  else info = parseSvg(buf);
  if (!info) throw new ImageError('檔案內容不是 PNG、JPEG、WebP 或 SVG 圖檔');
  if (!(info.width >= 1) || !(info.height >= 1)) throw new ImageError('圖片尺寸不合法');
  return info;
}

/** 副檔名（不含點、小寫）是否與偵測到的類型相符；jpg／jpeg 視為同一種。沒有副檔名時以內容為準 */
export function extMatches(filename, info) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? '');
  if (!m) return true;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return ext === info.ext;
}
