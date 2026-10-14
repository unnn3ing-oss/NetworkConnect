import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from '../../../scripts/lib/png.js';
import { unzipSingle } from '../../../scripts/lib/unzip.js';
import { go2rtcAssets, fetchGo2rtc, readGo2rtcVersion } from '../../../scripts/lib/go2rtc.js';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-go2rtc-'));

/** 產生只有一個檔案的 zip（deflate 或 store） */
function makeZip(name, content, { deflate = true } = {}) {
  const nameBuf = Buffer.from(name);
  const data = deflate ? zlib.deflateRawSync(content) : content;
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(deflate ? 8 : 0, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, cd, nameBuf, eocd]);
}

test('unzipSingle：deflate 與 store 都能解開', () => {
  const content = Buffer.from('hello go2rtc '.repeat(100));
  assert.deepEqual(unzipSingle(makeZip('go2rtc', content), 'go2rtc'), content);
  assert.deepEqual(unzipSingle(makeZip('go2rtc', content, { deflate: false }), 'go2rtc'), content);
});

test('unzipSingle：找不到指定檔案、CRC 不符、非 zip 都丟錯', () => {
  const content = Buffer.from('abc');
  assert.throws(() => unzipSingle(makeZip('other.exe', content), 'go2rtc.exe'), /go2rtc\.exe/);
  const bad = makeZip('go2rtc', content, { deflate: false });
  bad[bad.indexOf(Buffer.from('abc'))] = 0x78;
  assert.throws(() => unzipSingle(bad, 'go2rtc'), /CRC/);
  assert.throws(() => unzipSingle(Buffer.from('not a zip at all'), 'go2rtc'), /zip/);
});

test('unzipSingle：拒絕含路徑分隔的項目名稱以外的惡意名稱（只比對完整名稱）', () => {
  assert.throws(() => unzipSingle(makeZip('../evil/go2rtc', Buffer.from('x')), 'go2rtc'), /go2rtc/);
});

test('go2rtcAssets：兩個平台的檔名與網址', () => {
  const a = go2rtcAssets('1.9.14');
  assert.deepEqual(a.map((x) => x.target), ['darwin-arm64', 'win32-x64']);
  assert.equal(a[0].asset, 'go2rtc_mac_arm64.zip');
  assert.equal(a[0].url, 'https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_mac_arm64.zip');
  assert.equal(a[0].binary, 'go2rtc');
  assert.equal(a[1].asset, 'go2rtc_win64.zip');
  assert.equal(a[1].binary, 'go2rtc.exe');
});

test('readGo2rtcVersion：從 package.json 的 config.go2rtcVersion 讀取', () => {
  assert.match(readGo2rtcVersion(), /^\d+\.\d+\.\d+$/);
});

test('已提交的 checksums 涵蓋 package.json 指定版本的兩個檔案', () => {
  const sums = JSON.parse(fs.readFileSync(new URL('../../../scripts/go2rtc-checksums.json', import.meta.url), 'utf8'));
  const v = readGo2rtcVersion();
  for (const a of go2rtcAssets(v)) assert.match(sums[v]?.[a.asset] ?? '', /^[0-9a-f]{64}$/, a.asset);
});

function setup() {
  const darwinBin = Buffer.from('MACHO-fake-darwin');
  const winBin = Buffer.from('MZ-fake-windows');
  const zips = { 'go2rtc_mac_arm64.zip': makeZip('go2rtc', darwinBin), 'go2rtc_win64.zip': makeZip('go2rtc.exe', winBin) };
  const checksums = { '1.2.3': Object.fromEntries(Object.entries(zips).map(([k, v]) => [k, sha256(v)])) };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const name = url.split('/').pop();
    if (!zips[name]) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const z = zips[name];
    return { ok: true, status: 200, arrayBuffer: async () => z.buffer.slice(z.byteOffset, z.byteOffset + z.length) };
  };
  return { darwinBin, winBin, zips, checksums, calls, fetch, out: path.join(tmp(), 'go2rtc') };
}

test('fetchGo2rtc：下載、驗證 sha256、解壓到 <平台>-<架構>/，Mac 版可執行', async () => {
  const s = setup();
  const logs = [];
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log: (m) => logs.push(m) });
  const mac = path.join(s.out, 'darwin-arm64', 'go2rtc');
  const win = path.join(s.out, 'win32-x64', 'go2rtc.exe');
  assert.deepEqual(fs.readFileSync(mac), s.darwinBin);
  assert.deepEqual(fs.readFileSync(win), s.winBin);
  if (process.platform !== 'win32') assert.ok(fs.statSync(mac).mode & 0o100, '擁有者可執行'); // Windows 沒有 Unix 權限位元
  assert.equal(s.calls.length, 2);
});

test('fetchGo2rtc：輸出資料夾自帶 .gitignore，執行檔不會進 git', async () => {
  const s = setup();
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log() {} });
  assert.equal(fs.readFileSync(path.join(s.out, '.gitignore'), 'utf8').trim(), '*');
});

test('fetchGo2rtc：sha256 不符就失敗，且不留下執行檔', async () => {
  const s = setup();
  s.checksums['1.2.3']['go2rtc_win64.zip'] = '0'.repeat(64);
  await assert.rejects(fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log() {} }), /sha256/);
  assert.equal(fs.existsSync(path.join(s.out, 'win32-x64', 'go2rtc.exe')), false);
});

test('fetchGo2rtc：checksums 沒有該版本時失敗，並說明如何補', async () => {
  const s = setup();
  await assert.rejects(fetchGo2rtc({ version: '9.9.9', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log() {} }), /go2rtc-checksums\.json/);
});

test('fetchGo2rtc：已下載且標記相符就略過；--force 重新下載', async () => {
  const s = setup();
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log() {} });
  s.calls.length = 0;
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, log() {} });
  assert.equal(s.calls.length, 0);
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, force: true, log() {} });
  assert.equal(s.calls.length, 2);
});

test('fetchGo2rtc：HTTP 錯誤時失敗並顯示網址', async () => {
  const s = setup();
  await assert.rejects(fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: async () => ({ ok: false, status: 503 }), log() {} }), /503/);
});

test('fetchGo2rtc：--dry-run 只列出網址與目的地，不下載', async () => {
  const s = setup();
  const logs = [];
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, dryRun: true, log: (m) => logs.push(m) });
  assert.equal(s.calls.length, 0);
  assert.ok(logs.some((l) => l.includes('go2rtc_mac_arm64.zip') && l.includes('darwin-arm64')));
  assert.ok(logs.some((l) => l.includes('go2rtc_win64.zip')));
  assert.equal(fs.existsSync(s.out), false);
});

test('fetchGo2rtc：可只下載指定平台', async () => {
  const s = setup();
  await fetchGo2rtc({ version: '1.2.3', checksums: s.checksums, outDir: s.out, fetch: s.fetch, targets: ['win32-x64'], log() {} });
  assert.deepEqual(s.calls.map((u) => u.split('/').pop()), ['go2rtc_win64.zip']);
});
