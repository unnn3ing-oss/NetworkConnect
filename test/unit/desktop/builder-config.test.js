import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); // Windows 可能以 CRLF 簽出
const yml = read('electron-builder.yml');
const pkg = JSON.parse(read('package.json'));

// 取出頂層區段（mac:、win:…）的文字，避免跨區段誤判
const section = (name) => {
  const m = new RegExp(`^${name}:\\n((?:[ \\t].*\\n|\\n)*)`, 'm').exec(yml);
  assert.ok(m, `electron-builder.yml 缺少 ${name}:`);
  return m[1];
};

test('App 名稱與 appId', () => {
  assert.match(yml, /^productName: NetworkConnect$/m);
  assert.match(yml, /^appId: io\.github\.unnn3ing-oss\.networkconnect$/m);
});

test('mac：只打 dmg／arm64，且只附 darwin-arm64 的 go2rtc', () => {
  const mac = section('mac');
  assert.match(mac, /target: dmg\s+arch: \[arm64\]/);
  assert.doesNotMatch(mac, /x64|universal/);
  assert.match(mac, /from: build\/go2rtc\/darwin-arm64/);
  assert.doesNotMatch(mac, /win32/);
});

test('mac：Info.plist 有區域網路說明（繁中），並使用 ad-hoc 簽章', () => {
  const mac = section('mac');
  assert.match(mac, /NSLocalNetworkUsageDescription: 用來偵測家中網路設備的連線狀態與讀取監視器畫面/);
  assert.match(mac, /identity: "-"/);
});

test('win：nsis／x64／不需系統管理員，只附 win32-x64 的 go2rtc', () => {
  const win = section('win');
  assert.match(win, /target: nsis\s+arch: \[x64\]/);
  assert.match(win, /from: build\/go2rtc\/win32-x64/);
  assert.doesNotMatch(win, /darwin/);
  const nsis = section('nsis');
  assert.match(nsis, /oneClick: true/);
  assert.match(nsis, /perMachine: false/);
});

test('package.json：main 指向主行程，Electron 與 electron-builder 鎖確切版本', () => {
  assert.equal(pkg.main, 'desktop/main.js');
  for (const name of ['electron', 'electron-builder']) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${name} 必須是確切版本`);
  }
});

test('Electron 內建的 Node 主要版本與 .nvmrc 相同（版本表來自實際執行 Electron 的 process.versions）', () => {
  const nvmMajor = Number(read('.nvmrc').trim().split('.')[0]);
  const electronNodeMajor = { '39.8.10': 22 }[pkg.devDependencies.electron];
  assert.ok(electronNodeMajor, `請在此補上 Electron ${pkg.devDependencies.electron} 內建的 Node 主要版本（用 ELECTRON_RUN_AS_NODE=1 electron -e "console.log(process.versions.node)" 查）`);
  assert.equal(electronNodeMajor, nvmMajor);
});
