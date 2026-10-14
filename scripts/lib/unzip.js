// 從 zip 取出單一檔案（store／deflate，不支援 zip64、加密）。只用 node:zlib，不需要外部 unzip 指令，三平台行為一致。
import zlib from 'node:zlib';
import { crc32 } from './png.js';

/**
 * @param {Buffer} zip
 * @param {string} wantedName  壓縮檔內的完整檔名（必須完全相符，不接受含目錄的名稱）
 * @returns {Buffer}
 */
export function unzipSingle(zip, wantedName) {
  // 找 End Of Central Directory（簽章 PK\x05\x06），註解長度最多 65535
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 檔（找不到結尾記錄）');

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目錄損毀');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wantedName) continue;

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 本地標頭損毀');
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compSize);
    let out;
    if (method === 0) out = Buffer.from(raw);
    else if (method === 8) out = zlib.inflateRawSync(raw);
    else throw new Error(`zip 壓縮方式 ${method} 不支援`);
    if (out.length !== size) throw new Error(`zip 內 ${wantedName} 大小不符`);
    if (crc32(out) !== crc) throw new Error(`zip 內 ${wantedName} CRC 不符`);
    return out;
  }
  throw new Error(`zip 內找不到 ${wantedName}`);
}
