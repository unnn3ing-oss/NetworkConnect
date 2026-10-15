import test from 'node:test';
import assert from 'node:assert/strict';
import { go2rtcTarget, go2rtcBinaryName, resolveGo2rtcPath, resolveDataDir, buildServerEnv } from '../../../desktop/lib/paths.js';

test('go2rtcTarget：只支援 darwin-arm64 與 win32-x64', () => {
  assert.equal(go2rtcTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(go2rtcTarget('win32', 'x64'), 'win32-x64');
  assert.equal(go2rtcTarget('darwin', 'x64'), null); // 不支援 Intel Mac
  assert.equal(go2rtcTarget('win32', 'arm64'), null);
  assert.equal(go2rtcTarget('linux', 'x64'), null);
});

test('go2rtcBinaryName', () => {
  assert.equal(go2rtcBinaryName('win32'), 'go2rtc.exe');
  assert.equal(go2rtcBinaryName('darwin'), 'go2rtc');
});

test('打包後（macOS arm64）：指向 resources/go2rtc/go2rtc', () => {
  const p = resolveGo2rtcPath({ platform: 'darwin', arch: 'arm64', isPackaged: true, resourcesPath: '/Applications/NetworkConnect.app/Contents/Resources', appRoot: '/x' });
  assert.equal(p, '/Applications/NetworkConnect.app/Contents/Resources/go2rtc/go2rtc');
});

test('打包後（Windows x64）：使用反斜線與 .exe', () => {
  const p = resolveGo2rtcPath({ platform: 'win32', arch: 'x64', isPackaged: true, resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\NetworkConnect\\resources', appRoot: 'C:\\x' });
  assert.equal(p, 'C:\\Users\\me\\AppData\\Local\\Programs\\NetworkConnect\\resources\\go2rtc\\go2rtc.exe');
});

test('打包後但平台不支援：回 null（讓 nvr 模組走 go2rtcUrl）', () => {
  assert.equal(resolveGo2rtcPath({ platform: 'darwin', arch: 'x64', isPackaged: true, resourcesPath: '/r', appRoot: '/x' }), null);
});

test('開發時：指向 build/go2rtc/<平台>-<架構>/，檔案存在才回傳', () => {
  const seen = [];
  const exists = (f) => { seen.push(f); return true; };
  const p = resolveGo2rtcPath({ platform: 'darwin', arch: 'arm64', isPackaged: false, resourcesPath: '/r', appRoot: '/repo', exists });
  assert.equal(p, '/repo/build/go2rtc/darwin-arm64/go2rtc');
  assert.deepEqual(seen, ['/repo/build/go2rtc/darwin-arm64/go2rtc']);
  assert.equal(resolveGo2rtcPath({ platform: 'win32', arch: 'x64', isPackaged: false, resourcesPath: '/r', appRoot: 'C:\\repo', exists: () => false }), null);
  assert.equal(resolveGo2rtcPath({ platform: 'win32', arch: 'x64', isPackaged: false, resourcesPath: '/r', appRoot: 'C:\\repo', exists: () => true }), 'C:\\repo\\build\\go2rtc\\win32-x64\\go2rtc.exe');
});

test('resolveDataDir：userData/data（依平台分隔符）', () => {
  assert.equal(resolveDataDir('/Users/me/Library/Application Support/NetworkConnect', 'darwin'), '/Users/me/Library/Application Support/NetworkConnect/data');
  assert.equal(resolveDataDir('C:\\Users\\me\\AppData\\Roaming\\NetworkConnect', 'win32'), 'C:\\Users\\me\\AppData\\Roaming\\NetworkConnect\\data');
});

test('buildServerEnv：傳遞 NC_DATA_DIR、NC_HOST、NC_GO2RTC_PATH；沒指定埠時不傳 NC_PORT', () => {
  const env = buildServerEnv({ baseEnv: { PATH: '/bin', NC_MOCK: '1' }, dataDir: '/d', lanAccess: true, go2rtcPath: '/g/go2rtc', port: null });
  assert.equal(env.NC_DATA_DIR, '/d');
  assert.equal(env.NC_HOST, '0.0.0.0');
  assert.equal(env.NC_GO2RTC_PATH, '/g/go2rtc');
  assert.equal(env.NC_PORT, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.NC_MOCK, '1');
});

test('buildServerEnv：關閉區網連線只綁 127.0.0.1；指定埠時傳 NC_PORT；沒有 go2rtc 時 NC_GO2RTC_PATH 為空字串', () => {
  const env = buildServerEnv({ baseEnv: {}, dataDir: '/d', lanAccess: false, go2rtcPath: null, port: 9000 });
  assert.equal(env.NC_HOST, '127.0.0.1');
  assert.equal(env.NC_PORT, '9000');
  assert.equal(env.NC_GO2RTC_PATH, '');
});

test('buildServerEnv：外部已設定 NC_PORT（例如冒煙測試用 0）時保留', () => {
  const env = buildServerEnv({ baseEnv: { NC_PORT: '0' }, dataDir: '/d', lanAccess: true, go2rtcPath: null, port: null });
  assert.equal(env.NC_PORT, '0');
});

test('buildServerEnv：有 desktopToken 時傳 NC_DESKTOP_TOKEN，沒有時不傳', () => {
  assert.equal(buildServerEnv({ baseEnv: {}, dataDir: '/d', lanAccess: true, go2rtcPath: null, port: null, desktopToken: 'x'.repeat(64) }).NC_DESKTOP_TOKEN, 'x'.repeat(64));
  assert.equal(buildServerEnv({ baseEnv: {}, dataDir: '/d', lanAccess: true, go2rtcPath: null, port: null }).NC_DESKTOP_TOKEN, undefined);
});
