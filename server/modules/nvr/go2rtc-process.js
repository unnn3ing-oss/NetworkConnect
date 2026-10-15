// go2rtc 行程管理（規格 §8.4 地雷 7、8）：
//  - 啟動前產生 go2rtc.yaml：API 只綁 127.0.0.1，RTSP／WebRTC／SRTP 對外監聽全部關閉
//  - pid 檔：啟動前清掉上次殘留的 go2rtc（只清「確認是 go2rtc」的行程，避免 pid 被別的程式重用而誤殺）
//  - 非預期結束時自動重啟（最多 3 次）；stop() 確實結束行程（Windows 用 taskkill /T /F）
import { spawn as nodeSpawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 從 go2rtcUrl 決定 API 監聽位址：一律綁 127.0.0.1，埠沿用 URL（預設 1984） */
export function apiListenFromUrl(url) {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 1984;
    return `127.0.0.1:${port}`;
  } catch {
    return '127.0.0.1:1984';
  }
}

/** go2rtc.yaml 內容：任何 listen 不是空字串就是 127.0.0.1 */
export function buildGo2rtcYaml({ apiListen = '127.0.0.1:1984' } = {}) {
  if (!/^127\.0\.0\.1:\d+$/.test(apiListen)) throw new Error(`go2rtc API 只能綁 127.0.0.1（收到 ${apiListen}）`);
  return [
    '# 由 NetworkConnect 自動產生，每次啟動都會覆寫，請勿手動修改。',
    'api:',
    `  listen: "${apiListen}"`,
    'rtsp:',
    '  listen: ""',
    'webrtc:',
    '  listen: ""',
    'srtp:',
    '  listen: ""',
    'log:',
    '  level: warn',
    '',
  ].join('\n');
}

const baseNameOf = (binPath) => path.basename(binPath).replace(/\.exe$/i, '').toLowerCase();

/** 預設的行程身分檢查：pid 對應的指令列是否含 go2rtc 執行檔名稱。查不到一律當作「不是」。 */
export function defaultIsOurProcess(pid, binPath, platform = process.platform) {
  const name = baseNameOf(binPath);
  try {
    let text = '';
    if (platform === 'linux') text = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    else if (platform === 'win32') text = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    else text = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return text.toLowerCase().includes(name);
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 結束行程（含子行程）。Windows：taskkill /pid <pid> /T /F；其他：SIGTERM 或 SIGKILL */
export function killProcess(pid, { force = false, platform = process.platform, execFileImpl = execFile } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === 'win32') {
    return new Promise((resolve) => {
      execFileImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // 已經不存在
  }
  return Promise.resolve();
}

/**
 * @param {object} opts
 * @param {string} opts.binPath  go2rtc 執行檔
 * @param {string} opts.dir      放 go2rtc.yaml、go2rtc.pid 的資料夾
 * @param {string} [opts.apiListen]
 * @param {object} [opts.log]
 * @param {Function} [opts.spawnFn]   測試用
 * @param {Function} [opts.isOurProcess] (pid) => boolean，測試用
 * @param {number} [opts.maxRestarts=3]
 * @param {number} [opts.restartDelayMs=1000]
 * @param {number} [opts.stableMs=30000] 連續執行超過這麼久就把重啟計數歸零
 * @param {number} [opts.killGraceMs=3000] SIGTERM 之後多久改用 SIGKILL
 * @param {Function} [opts.onRestart]  自動重啟後呼叫（nvr 模組據此重新註冊串流）
 * @param {Function} [opts.onGiveUp]
 */
export function createGo2rtcProcess({
  binPath,
  dir,
  apiListen = '127.0.0.1:1984',
  log = { info() {}, warn() {}, error() {}, debug() {} },
  spawnFn = nodeSpawn,
  platform = process.platform,
  isOurProcess = (pid) => defaultIsOurProcess(pid, binPath, platform),
  maxRestarts = 3,
  restartDelayMs = 1000,
  stableMs = 30_000,
  killGraceMs = 3000,
  onRestart,
  onGiveUp,
} = {}) {
  const yamlPath = path.join(dir, 'go2rtc.yaml');
  const pidPath = path.join(dir, 'go2rtc.pid');

  /** @type {'stopped'|'running'|'restarting'|'failed'} */
  let state = 'stopped';
  let current = null; // { child, exited: Promise, startedAt }
  let restarts = 0;
  let stopping = false;
  let restartTimer = null;
  let lastError = null;

  const readPid = () => {
    try {
      const n = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const removePid = (onlyIfPid) => {
    if (onlyIfPid !== undefined && readPid() !== onlyIfPid) return;
    fs.rmSync(pidPath, { force: true });
  };

  /** 上次殘留的 go2rtc（程式當掉、Windows 父行程結束不帶走子行程）：確認是 go2rtc 才結束 */
  async function killStale() {
    const pid = readPid();
    if (pid === null) return false;
    let killed = false;
    if (pid !== process.pid && isAlive(pid) && isOurProcess(pid)) {
      log.warn(`發現上次殘留的 go2rtc（pid ${pid}），結束它`);
      await killProcess(pid, { platform });
      for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
      if (isAlive(pid)) {
        await killProcess(pid, { force: true, platform });
        for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
      }
      killed = true;
    }
    removePid();
    return killed;
  }

  function launch() {
    const child = spawnFn(binPath, ['-config', yamlPath], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    let resolveExit;
    const exited = new Promise((r) => (resolveExit = r));
    const rec = { child, exited, startedAt: Date.now() };
    current = rec;
    state = 'running';

    const drain = (stream) => stream?.on?.('data', (d) => log.debug?.(`go2rtc: ${String(d).trimEnd().slice(0, 500)}`));
    drain(child.stdout);
    drain(child.stderr);

    const finish = (info) => {
      if (done) return;
      done = true;
      resolveExit(info);
      onExit(rec, info);
    };
    child.once('error', (err) => {
      lastError = err;
      log.error(`go2rtc 無法啟動：${err.message}`);
      finish({ error: err });
    });
    child.once('exit', (code, signal) => finish({ code, signal }));

    if (child.pid) fs.writeFileSync(pidPath, `${child.pid}\n`);
    return rec;
  }

  function onExit(rec, info) {
    if (current !== rec) return;
    current = null;
    if (rec.child.pid) removePid(rec.child.pid);
    if (stopping) {
      state = 'stopped';
      return;
    }
    if (info.error && ['ENOENT', 'EACCES', 'EPERM'].includes(info.error.code)) {
      state = 'failed'; // 執行檔不存在或不能執行：重啟沒有意義
      onGiveUp?.(info.error);
      return;
    }
    log.warn(`go2rtc 非預期結束（code=${info.code ?? '-'} signal=${info.signal ?? '-'}）`);
    if (Date.now() - rec.startedAt > stableMs) restarts = 0;
    if (restarts >= maxRestarts) {
      state = 'failed';
      log.error(`go2rtc 已連續重啟 ${maxRestarts} 次仍失敗，不再重試`);
      onGiveUp?.(info.error);
      return;
    }
    restarts++;
    state = 'restarting';
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopping) return;
      launch();
      onRestart?.();
    }, restartDelayMs);
    restartTimer.unref?.();
  }

  return {
    yamlPath,
    pidPath,
    get pid() {
      return current?.child.pid ?? null;
    },
    get state() {
      return state;
    },
    get restartCount() {
      return restarts;
    },
    get lastError() {
      return lastError;
    },

    async start() {
      if (current) return;
      stopping = false;
      restarts = 0;
      lastError = null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(yamlPath, buildGo2rtcYaml({ apiListen }));
      await killStale();
      launch();
    },

    /** 結束 go2rtc 並等它真的消失；沒有在執行也可以安全呼叫 */
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      restartTimer = null;
      const rec = current;
      if (!rec) {
        state = 'stopped';
        return;
      }
      const pid = rec.child.pid;
      if (pid) {
        await killProcess(pid, { platform });
        const first = await Promise.race([rec.exited.then(() => 'exited'), sleep(killGraceMs).then(() => 'timeout')]);
        if (first === 'timeout') {
          await killProcess(pid, { force: true, platform });
          await Promise.race([rec.exited, sleep(2000)]);
        }
      }
      if (pid) removePid(pid);
      current = null;
      state = 'stopped';
    },
  };
}
