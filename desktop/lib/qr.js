// QR Code → SVG 字串。使用 vendored 的 qrcode-generator（見 desktop/vendor/VERSIONS.md）。
import qrcode from '../vendor/qrcode-generator.mjs';

/** @returns {boolean[][]} true＝深色模組 */
export function qrMatrix(text, ecc = 'M') {
  const qr = qrcode(0, ecc); // typeNumber 0＝自動挑選最小版本
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * 單一 <path> 的 SVG（每個橫向連續的深色區段一條線段，檔案小）。白底、黑色模組、四周留 4 格靜區。
 * @param {string} text
 * @param {{ecc?: 'L'|'M'|'Q'|'H', margin?: number}} [opts]
 */
export function renderQrSvg(text, { ecc = 'M', margin = 4 } = {}) {
  const m = qrMatrix(text, ecc);
  const size = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < row.length && row[end]) end += 1;
      d += `M${c + margin} ${r + margin}h${end - c}v1h-${end - c}z`;
      c = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
