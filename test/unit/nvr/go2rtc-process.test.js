// go2rtc 行程管理：go2rtc.yaml 不含對外監聽、pid 檔、殘留清理、自動重啟、stop() 確實結束行程。
// 用「假的長駐子行程」代替真的 go2rtc（一個檔名為 go2rtc 的 node 腳本）。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  apiListenFromUrl, buildGo2rtcYaml, createGo2rtcProcess, defaultIsOurProcess, killProcess,
} from '../../../server/modules/nvr/go2rtc-process.js';
import { makeTmpDir, cleanupAllTmpDirs, waitFor, sleep } from '../../helpers/tmp.js';

const posix = process.platform !== 'win32';
const skip = !posix && '假 go2rtc 腳本只在 Linux／macOS 執行';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** 在 dir 建一個名為 go2rtc 的可執行 node 腳本 */
function fakeBinary(dir, body = 'setInterval(() => {}, 1000);') {
  const file = path.join(dir, 'go2rtc');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

const spawned = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已結束
    }
  }
  cleanupAllTmpDirs();
});

describe('go2rtc.yaml', () => {
  test('每個 listen 不是空字串就是 127.0.0.1；rtsp、webrtc、srtp 全部關閉', () => {
    const yaml = buildGo2rtcYaml({ apiListen: '127.0.0.1:1984' });
    const listens = [...yaml.matchAll(/^\s*([a-z_]*listen):\s*"([^"]*)"\s*$/gm)].map((m) => [m[1], m[2]]);
    assert.ok(listens.length >= 4);
    for (const [key, value] of listens) {
      assert.ok(value === '' || value.startsWith('127.0.0.1:'), `${key}: "${value}" 不可對外監聽`);
    }
    for (const section of ['rtsp', 'webrtc', 'srtp']) {
      assert.match(yaml, new RegExp(`^${section}:\\n  listen: ""$`, 'm'), `${section} 必須關閉`);
    }
    assert.match(yaml, /^api:\n {2}listen: "127\.0\.0\.1:1984"$/m);
    assert.doesNotMatch(yaml, /0\.0\.0\.0|:8554|:8555|:8443|\[::\]/);
  });

  test('拒絕綁在 127.0.0.1 以外的位址', () => {
    for (const bad of ['0.0.0.0:1984', ':1984', '192.168.1.5:1984', '127.0.0.1']) {
      assert.throws(() => buildGo2rtcYaml({ apiListen: bad }), /127\.0\.0\.1/, bad);
    }
  });

  test('apiListenFromUrl：只取埠，主機一律 127.0.0.1', () => {
    assert.equal(apiListenFromUrl('http://127.0.0.1:1984'), '127.0.0.1:1984');
    assert.equal(apiListenFromUrl('http://192.168.1.9:2000'), '127.0.0.1:2000');
    assert.equal(apiListenFromUrl('http://localhost'), '127.0.0.1:1984');
    assert.equal(apiListenFromUrl('壞掉'), '127.0.0.1:1984');
  });

  test('start() 會把 go2rtc.yaml 寫到資料夾並以 -config 傳給 go2rtc', { skip }, async () => {
    const dir = makeTmpDir();
    const calls = [];
    const proc = createGo2rtcProcess({
      binPath: fakeBinary(dir),
      dir: path.join(dir, 'g'),
      spawnFn: (...a) => {
        calls.push(a);
        return spawn(...a);
      },
    });
    await proc.start();
    try {
      assert.equal(fs.readFileSync(proc.yamlPath, 'utf8'), buildGo2rtcYaml());
      assert.deepEqual(calls[0][1], ['-config', proc.yamlPath]);
      assert.equal(calls[0][2].windowsHide, true, 'Windows 需要 windowsHide');
      assert.equal(calls[0][2].cwd, path.join(dir, 'g'));
    } finally {
      await proc.stop();
    }
  });
});

describe('go2rtc 輸出', () => {
  test('go2rtc 的警告／錯誤逐行寫進日誌（warn），RTSP 帳密被遮掉', { skip }, async () => {
    const dir = makeTmpDir();
    const warns = [];
    const proc = createGo2rtcProcess({
      binPath: fakeBinary(dir),
      dir: path.join(dir, 'g'),
      log: { info() {}, warn: (m) => warns.push(m), error() {}, debug() {} },
      spawnFn: (cmd, args, opts) =>
        spawn(process.execPath, ['-e', 'process.stderr.write("12:00:01 WRN [rtsp] url=rtsp://admin:hunter2@10.0.0.9/x error=EOF\\n12:00:02 ERR second line\\n"); setInterval(() => {}, 1000)'], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }),
    });
    await proc.start();
    try {
      await waitFor(() => warns.length >= 2, { message: '沒有寫進日誌' });
      assert.match(warns[0], /^go2rtc: 12:00:01 WRN \[rtsp\] url=rtsp:\/\/\*\*\*@10\.0\.0\.9\/x error=EOF$/);
      assert.match(warns[1], /ERR second line/);
      assert.ok(warns.every((w) => !w.includes('hunter2')));
    } finally {
      await proc.stop();
    }
  });
});

describe('生命週期', () => {
  test('start() 寫 pid 檔；stop() 後子行程確實結束且 pid 檔移除', { skip }, async () => {
    const dir = makeTmpDir();
    const proc = createGo2rtcProcess({ binPath: fakeBinary(dir), dir: path.join(dir, 'g') });
    await proc.start();
    const pid = proc.pid;
    assert.ok(pid > 0);
    assert.equal(proc.state, 'running');
    assert.equal(fs.readFileSync(proc.pidPath, 'utf8').trim(), String(pid));
    assert.ok(alive(pid));

    await proc.stop();
    await waitFor(() => !alive(pid), { message: 'stop() 後 go2rtc 行程仍在' });
    assert.equal(proc.state, 'stopped');
    assert.equal(fs.existsSync(proc.pidPath), false);
    await sleep(150);
    assert.equal(proc.state, 'stopped', 'stop() 之後不可再自動重啟');
  });

  test('忽略 SIGTERM 的行程：超過寬限時間改用 SIGKILL', { skip }, async () => {
    const dir = makeTmpDir();
    const bin = fakeBinary(dir, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const proc = createGo2rtcProcess({ binPath: bin, dir: path.join(dir, 'g'), killGraceMs: 200 });
    await proc.start();
    const pid = proc.pid;
    await sleep(150); // 讓腳本先掛上 SIGTERM 處理
    await proc.stop();
    await waitFor(() => !alive(pid), { message: 'SIGKILL 後行程仍在' });
  });

  test('啟動前清掉上次殘留的 go2rtc（pid 檔指向的行程）', { skip }, async () => {
    const dir = makeTmpDir();
    const bin = fakeBinary(dir);
    const g = path.join(dir, 'g');
    fs.mkdirSync(g);
    const stale = spawn(bin, ['-config', 'x.yaml'], { stdio: 'ignore' });
    spawned.push(stale.pid);
    fs.writeFileSync(path.join(g, 'go2rtc.pid'), `${stale.pid}\n`);

    const proc = createGo2rtcProcess({ binPath: bin, dir: g });
    await proc.start();
    try {
      await waitFor(() => !alive(stale.pid), { message: '上次殘留的 go2rtc 沒有被結束' });
      assert.notEqual(proc.pid, stale.pid);
      assert.equal(fs.readFileSync(proc.pidPath, 'utf8').trim(), String(proc.pid));
    } finally {
      await proc.stop();
    }
  });

  test('pid 檔指向的不是 go2rtc（pid 被別的程式重用）：不誤殺，只清掉 pid 檔', { skip }, async () => {
    const dir = makeTmpDir();
    const g = path.join(dir, 'g');
    fs.mkdirSync(g);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    spawned.push(other.pid);
    fs.writeFileSync(path.join(g, 'go2rtc.pid'), `${other.pid}\n`);

    const proc = createGo2rtcProcess({ binPath: fakeBinary(dir), dir: g });
    await proc.start();
    try {
      await sleep(100);
      assert.ok(alive(other.pid), '不是 go2rtc 的行程不可被結束');
    } finally {
      await proc.stop();
    }
  });

  test('pid 檔損毀或行程已不存在時不會丟錯', { skip }, async () => {
    const dir = makeTmpDir();
    const g = path.join(dir, 'g');
    fs.mkdirSync(g);
    fs.writeFileSync(path.join(g, 'go2rtc.pid'), 'not-a-number');
    const proc = createGo2rtcProcess({ binPath: fakeBinary(dir), dir: g });
    await proc.start();
    await proc.stop();
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'go2rtc.pid'), '999999\n');
    await proc.start();
    await proc.stop();
  });
});

describe('自動重啟', () => {
  test('非預期結束時最多重啟 3 次，之後放棄', { skip }, async () => {
    const dir = makeTmpDir();
    const bin = fakeBinary(dir, 'setTimeout(() => process.exit(1), 30);');
    let spawnCount = 0;
    let restarts = 0;
    let gaveUp = 0;
    const proc = createGo2rtcProcess({
      binPath: bin,
      dir: path.join(dir, 'g'),
      restartDelayMs: 10,
      spawnFn: (...a) => {
        spawnCount++;
        return spawn(...a);
      },
      onRestart: () => restarts++,
      onGiveUp: () => gaveUp++,
    });
    await proc.start();
    await waitFor(() => proc.state === 'failed', { timeoutMs: 5000, message: '沒有進入 failed' });
    assert.equal(spawnCount, 4, '1 次啟動 + 3 次重啟');
    assert.equal(restarts, 3);
    assert.equal(gaveUp, 1);
    assert.equal(proc.restartCount, 3);
    await proc.stop();
  });

  test('重啟後 pid 檔更新為新的 pid；stop() 結束新行程', { skip }, async () => {
    const dir = makeTmpDir();
    const proc = createGo2rtcProcess({ binPath: fakeBinary(dir), dir: path.join(dir, 'g'), restartDelayMs: 10 });
    await proc.start();
    const first = proc.pid;
    process.kill(first, 'SIGKILL'); // 模擬 go2rtc 當掉
    await waitFor(() => proc.pid && proc.pid !== first, { message: '沒有自動重啟' });
    const second = proc.pid;
    assert.equal(fs.readFileSync(proc.pidPath, 'utf8').trim(), String(second));
    await proc.stop();
    await waitFor(() => !alive(second));
  });

  test('執行檔不存在（ENOENT）：直接 failed，不重啟', async () => {
    const dir = makeTmpDir();
    let spawnCount = 0;
    let gaveUp = 0;
    const proc = createGo2rtcProcess({
      binPath: path.join(dir, 'no-such-go2rtc'),
      dir: path.join(dir, 'g'),
      restartDelayMs: 10,
      spawnFn: (...a) => {
        spawnCount++;
        return spawn(...a);
      },
      onGiveUp: () => gaveUp++,
    });
    await proc.start();
    await waitFor(() => proc.state === 'failed');
    await sleep(100);
    assert.equal(spawnCount, 1);
    assert.equal(gaveUp, 1);
    assert.equal(fs.existsSync(proc.pidPath), false);
    await proc.stop(); // 不可丟錯
  });
});

describe('平台差異', () => {
  test('Windows 用 taskkill /pid <pid> /T /F', async () => {
    const calls = [];
    await killProcess(4321, {
      platform: 'win32',
      execFileImpl: (cmd, args, opts, cb) => {
        calls.push({ cmd, args, opts });
        cb(null);
      },
    });
    assert.deepEqual(calls, [{ cmd: 'taskkill', args: ['/pid', '4321', '/T', '/F'], opts: { windowsHide: true } }]);
  });

  test('非法 pid 不執行任何指令', async () => {
    let called = false;
    for (const pid of [0, -1, NaN, undefined, '12']) await killProcess(pid, { platform: 'win32', execFileImpl: () => (called = true) });
    assert.equal(called, false);
  });

  test('defaultIsOurProcess：行程不存在、或指令列不含執行檔名稱一律 false', () => {
    assert.equal(defaultIsOurProcess(999999, '/x/go2rtc'), false);
    assert.equal(defaultIsOurProcess(process.pid, '/x/not-this-binary-name'), false);
  });

  test('defaultIsOurProcess：指令列含執行檔名稱為 true', { skip }, () => {
    const dir = makeTmpDir();
    const child = spawn(fakeBinary(dir), [], { stdio: 'ignore' });
    spawned.push(child.pid);
    assert.equal(defaultIsOurProcess(child.pid, '/any/where/go2rtc'), true);
  });
});
