// App 內更新：下載驗證、能否自行安裝的判斷、安裝指令；Mac 安裝腳本以假的 hdiutil／ditto／open 實際跑一次。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildInstallCommand, downloadInstaller, macAppBundle, MAC_INSTALL_SCRIPT, selfInstallSupport } from '../../../desktop/lib/updater.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fetchOf = (buf, { status = 200 } = {}) => {
  const fn = async (url) => {
    fn.calls.push(url);
    return { ok: status === 200, status, body: new Blob([buf]).stream() };
  };
  fn.calls = [];
  return fn;
};

describe('downloadInstaller', () => {
  const payload = Buffer.from('installer-bytes'.repeat(1000));
  const asset = { name: 'NetworkConnect-0.1.20-win-x64.exe', url: 'https://github.com/o/r/releases/download/v0.1.20/x.exe', size: payload.length, sha256: sha(payload) };

  test('下載、驗證通過後改名，回報進度，並清掉舊的安裝檔', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'NetworkConnect-0.1.10-win-x64.exe'), 'old');
    const progress = [];
    const file = await downloadInstaller({ asset, dir, fetch: fetchOf(payload), onProgress: (r) => progress.push(r) });
    assert.equal(file, path.join(dir, asset.name));
    assert.deepEqual(fs.readFileSync(file), payload);
    assert.deepEqual(fs.readdirSync(dir), [asset.name]);
    assert.equal(progress.at(-1), 1);
  });

  test('已下載過且 sha256 相符就不再下載', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, asset.name), payload);
    const f = fetchOf(payload);
    await downloadInstaller({ asset, dir, fetch: f });
    assert.equal(f.calls.length, 0);
  });

  test('sha256 不符、大小不符、HTTP 錯誤 → 丟錯且不留下檔案', async () => {
    const dir = tmp();
    await assert.rejects(downloadInstaller({ asset: { ...asset, sha256: 'b'.repeat(64) }, dir, fetch: fetchOf(payload) }), /sha256/);
    await assert.rejects(downloadInstaller({ asset: { ...asset, size: payload.length + 5 }, dir, fetch: fetchOf(payload) }), /不完整/);
    await assert.rejects(downloadInstaller({ asset: { ...asset, size: 10 }, dir, fetch: fetchOf(payload) }), /比預期大/);
    await assert.rejects(downloadInstaller({ asset, dir, fetch: fetchOf(payload, { status: 404 }) }), /HTTP 404/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('檔名帶路徑一律拒絕', async () => {
    await assert.rejects(downloadInstaller({ asset: { ...asset, name: '../evil.exe' }, dir: tmp(), fetch: fetchOf(payload) }), /不合法/);
  });
});

describe('selfInstallSupport／macAppBundle', () => {
  const exe = '/Applications/NetworkConnect.app/Contents/MacOS/NetworkConnect';
  const writable = () => true;

  test('macAppBundle', () => {
    assert.equal(macAppBundle(exe), '/Applications/NetworkConnect.app');
    assert.equal(macAppBundle('/usr/local/bin/electron'), null);
  });

  test('Windows 一律可以；Linux 不支援', () => {
    assert.equal(selfInstallSupport({ platform: 'win32', exePath: 'C:\\x.exe', isWritable: writable }).ok, true);
    assert.equal(selfInstallSupport({ platform: 'linux', exePath: '/x', isWritable: writable }).ok, false);
  });

  test('Mac：在「應用程式」資料夾可以；從 dmg、隔離位置執行或沒有寫入權限都不行', () => {
    assert.deepEqual(selfInstallSupport({ platform: 'darwin', exePath: exe, isWritable: writable }), { ok: true, appPath: '/Applications/NetworkConnect.app' });
    assert.match(selfInstallSupport({ platform: 'darwin', exePath: `/Volumes/NetworkConnect 0.1.0/NetworkConnect.app/Contents/MacOS/NetworkConnect`, isWritable: writable }).reason, /應用程式/);
    assert.match(selfInstallSupport({ platform: 'darwin', exePath: `/private/var/folders/x/AppTranslocation/ABC/d/NetworkConnect.app/Contents/MacOS/NetworkConnect`, isWritable: writable }).reason, /應用程式/);
    assert.match(selfInstallSupport({ platform: 'darwin', exePath: exe, isWritable: () => false }).reason, /權限/);
  });
});

describe('buildInstallCommand', () => {
  test('Windows：NSIS 靜默安裝後自動開啟', () => {
    assert.deepEqual(buildInstallCommand({ platform: 'win32', installer: 'C:\\u\\x.exe' }), { command: 'C:\\u\\x.exe', args: ['--updated', '/S', '--force-run'] });
  });

  test('Mac：bash 腳本，路徑用位置參數傳入', () => {
    const c = buildInstallCommand({ platform: 'darwin', installer: '/u/a b.dmg', appPath: '/Applications/NetworkConnect.app', pid: 42, logFile: '/l/update.log', scriptFile: '/u/install.sh' });
    assert.equal(c.command, '/bin/bash');
    assert.deepEqual(c.args, ['/u/install.sh', '42', '/u/a b.dmg', '/Applications/NetworkConnect.app', '/l/update.log']);
    assert.equal(c.script, MAC_INSTALL_SCRIPT);
  });
});

// 用假的 hdiutil（把 dmg 當成資料夾「掛載」）、ditto（cp -R）、open（留下紀錄）實際執行安裝腳本
describe('Mac 安裝腳本（假工具）', { skip: process.platform === 'win32' && '需要 bash' }, () => {
  function setup({ dmgHasApp = true } = {}) {
    const root = tmp();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    // hdiutil attach ... -mountpoint MNT DMG → 把 <DMG>.contents 資料夾複製到 MNT 當作掛載內容；detach 什麼都不做
    tool('hdiutil', 'if [ "$1" = attach ]; then MNT="${@: -2:1}"; DMG="${@: -1}"; [ -f "$DMG" ] || exit 1; cp -R "$DMG.contents"/. "$MNT"/; fi; exit 0');
    tool('ditto', 'cp -R "$1" "$2"');
    tool('open', `echo "$1" >> "${root}/opened"`);
    const dmg = path.join(root, 'NetworkConnect-0.1.20-mac-arm64.dmg');
    fs.writeFileSync(dmg, 'dmg');
    fs.mkdirSync(`${dmg}.contents`);
    if (dmgHasApp) {
      fs.mkdirSync(path.join(`${dmg}.contents`, 'NetworkConnect.app'));
      fs.writeFileSync(path.join(`${dmg}.contents`, 'NetworkConnect.app', 'version'), 'new');
    }
    const apps = path.join(root, 'Applications');
    const app = path.join(apps, 'NetworkConnect.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'version'), 'old');
    const script = path.join(root, 'install.sh');
    fs.writeFileSync(script, MAC_INSTALL_SCRIPT);
    const run = () =>
      spawnSync('/bin/bash', [script, '999999', dmg, app, path.join(root, 'update.log')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
        encoding: 'utf8',
      });
    return { root, dmg, app, apps, run };
  }

  test('成功：舊版被新版取代、刪掉 dmg、重新開啟 App、不留暫存', () => {
    const s = setup();
    assert.equal(s.run().status, 0, fs.readFileSync(path.join(s.root, 'update.log'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(s.app, 'version'), 'utf8'), 'new');
    assert.equal(fs.existsSync(s.dmg), false);
    assert.deepEqual(fs.readdirSync(s.apps), ['NetworkConnect.app']);
    assert.equal(fs.readFileSync(path.join(s.root, 'opened'), 'utf8').trim(), s.app);
  });

  test('dmg 裡沒有 App：保留舊版並重新開啟', () => {
    const s = setup({ dmgHasApp: false });
    assert.equal(s.run().status, 1);
    assert.equal(fs.readFileSync(path.join(s.app, 'version'), 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(s.apps), ['NetworkConnect.app']);
    assert.equal(fs.readFileSync(path.join(s.root, 'opened'), 'utf8').trim(), s.app);
    assert.match(fs.readFileSync(path.join(s.root, 'update.log'), 'utf8'), /找不到 App/);
  });
});
