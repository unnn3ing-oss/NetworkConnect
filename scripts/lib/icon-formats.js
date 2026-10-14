// .ico 與 .icns 容器編碼（純 JS，不依賴外部工具）。

/**
 * Windows ICO。≤ 64px 以 32-bit BMP（DIB）儲存，相容 NSIS／rcedit；256px 以 PNG 儲存（Vista 之後的標準做法）。
 * @param {Array<{size: number, rgba: Buffer, png: Buffer}>} images  size 為正方形邊長
 */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const blobs = images.map(({ size, rgba, png }) => {
    if (size >= 256) return png;
    const andStride = Math.ceil(size / 32) * 4;
    const dibHeader = Buffer.alloc(40);
    dibHeader.writeUInt32LE(40, 0);
    dibHeader.writeInt32LE(size, 4);
    dibHeader.writeInt32LE(size * 2, 8); // 高度含 AND 遮罩
    dibHeader.writeUInt16LE(1, 12);
    dibHeader.writeUInt16LE(32, 14);
    dibHeader.writeUInt32LE(size * size * 4 + andStride * size, 20);
    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4; // BMP 由下往上
        const d = (y * size + x) * 4;
        xor[d] = rgba[s + 2];
        xor[d + 1] = rgba[s + 1];
        xor[d + 2] = rgba[s];
        xor[d + 3] = rgba[s + 3];
      }
    }
    return Buffer.concat([dibHeader, xor, Buffer.alloc(andStride * size)]);
  });

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size }, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(blobs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += blobs[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...blobs]);
}

const ICNS_TYPES = { 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

/**
 * macOS ICNS（PNG 區塊）。
 * @param {Array<{size: number, png: Buffer}>} images  size 需為 128／256／512／1024
 */
export function encodeIcns(images) {
  const blocks = images.map(({ size, png }) => {
    const type = ICNS_TYPES[size];
    if (!type) throw new Error(`icns 不支援 ${size}px`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + blocks.reduce((n, b) => n + b.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...blocks]);
}
