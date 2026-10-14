// 伺服器行程監督：啟動、等 ready、非預期結束時自動重啟（最多 3 次）、優雅關閉（5 秒後強制）。
// fork 由呼叫端注入（正式環境是 utilityProcess.fork），因此可以用假行程在 Linux 容器內測試。
//
// child 介面（UtilityProcess 相容）：postMessage(msg)、kill()、on('message', msg)、on('exit', code)。

/**
 * @param {object} opts
 * @param {() => import('node:events').EventEmitter & {postMessage: Function, kill: Function}} opts.fork
 * @param {number} [opts.maxRestarts]       連續非預期結束的重啟上限
 * @param {number} [opts.restartDelayMs]
 * @param {number} [opts.readyTimeoutMs]    等 {type:'ready'} 的上限
 * @param {number} [opts.shutdownTimeoutMs] 送 shutdown 後等待結束的上限，逾時強制結束
 * @param {number} [opts.stableMs]          跑滿這麼久才算穩定，崩潰時重啟次數歸零
 * @param {() => number} [opts.now]
 * @param {(name: string, payload: unknown) => void} [opts.onEvent]  伺服器轉送的事件
 * @param {(info: {port: number, restarted: boolean}) => void} [opts.onReady]  每次就緒（含重啟後）
 * @param {(count: number) => void} [opts.onRestart]
 * @param {(info: {restarts: number, exitCode: number|null, reason: string}) => void} [opts.onGaveUp]
 * @param {(state: string) => void} [opts.onStateChange]
 * @param {{info: Function, warn: Function, error: Function}} [opts.log]
 */
export function createSupervisor({
  fork,
  maxRestarts = 3,
  restartDelayMs = 1000,
  readyTimeoutMs = 30_000,
  shutdownTimeoutMs = 5000,
  stableMs = 60_000,
  now = Date.now,
  onEvent,
  onReady,
  onRestart,
  onGaveUp,
  onStateChange,
  log = { info() {}, warn() {}, error() {} },
}) {
  let state = 'idle';
  let port = null;
  let restarts = 0;
  let current = null; // {child, readyAt, exited, readyTimer}
  let restartTimer = null;
  let waiter = null; // start() 的 promise 控制器
  let stopRequested = false;
  let lastFailure = '';
  let everReady = false;

  const setState = (s) => {
    if (state === s) return;
    state = s;
    onStateChange?.(s);
  };

  function settleStart(err, value) {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    if (err) w.reject(err);
    else w.resolve(value);
  }

  function spawn() {
    restartTimer = null;
    if (stopRequested) return;
    const child = fork();
    const rec = { child, readyAt: null, exited: false, readyTimer: null };
    current = rec;
    port = null;

    rec.readyTimer = setTimeout(() => {
      if (rec.readyAt !== null || rec.exited) return;
      lastFailure = '啟動逾時';
      log.error(`伺服器 ${readyTimeoutMs} ms 內沒有回報就緒，強制結束`);
      try {
        child.kill();
      } catch {
        // 行程可能已經不在了
      }
    }, readyTimeoutMs);

    child.on('message', (msg) => {
      if (rec !== current || !msg || typeof msg !== 'object') return;
      if (msg.type === 'ready' && rec.readyAt === null) {
        clearTimeout(rec.readyTimer);
        rec.readyAt = now();
        port = msg.port;
        setState('running');
        settleStart(null, { port });
        onReady?.({ port, restarted: everReady });
        everReady = true;
      } else if (msg.type === 'event' && typeof msg.name === 'string') {
        onEvent?.(msg.name, msg.payload);
      }
    });

    child.on('exit', (code) => {
      if (rec.exited) return;
      rec.exited = true;
      clearTimeout(rec.readyTimer);
      rec.onExit?.(code);
      if (rec !== current || stopRequested) return;
      handleUnexpectedExit(rec, code);
    });
  }

  function handleUnexpectedExit(rec, code) {
    if (!lastFailure || rec.readyAt !== null) lastFailure = `行程結束（代碼 ${code}）`;
    if (rec.readyAt !== null && now() - rec.readyAt >= stableMs) restarts = 0;
    port = null;
    if (restarts >= maxRestarts) {
      setState('failed');
      log.error(`伺服器已重啟 ${restarts} 次仍失敗，放棄：${lastFailure}`);
      const info = { restarts, exitCode: code ?? null, reason: lastFailure };
      onGaveUp?.(info);
      settleStart(new Error(`伺服器啟動失敗：${lastFailure}`));
      return;
    }
    restarts += 1;
    setState('restarting');
    log.warn(`伺服器非預期結束（${lastFailure}），${restartDelayMs} ms 後第 ${restarts} 次重啟`);
    onRestart?.(restarts);
    lastFailure = '';
    restartTimer = setTimeout(spawn, restartDelayMs);
  }

  let startPromise = null;

  function start() {
    if (state === 'running') return Promise.resolve({ port });
    if (startPromise) return startPromise;
    stopRequested = false;
    restarts = 0;
    lastFailure = '';
    setState('starting');
    startPromise = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
    });
    startPromise.then(clearStart, clearStart);
    spawn();
    return startPromise;
  }

  function clearStart() {
    startPromise = null;
  }

  async function stop() {
    stopRequested = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    const rec = current;
    if (!rec || rec.exited) {
      setState('stopped');
      settleStart(new Error('伺服器已停止'));
      return { forced: false };
    }
    setState('stopping');
    settleStart(new Error('伺服器已停止'));
    let forced = false;
    await new Promise((resolve) => {
      let timer = setTimeout(() => {
        forced = true;
        log.warn(`伺服器 ${shutdownTimeoutMs} ms 內沒有結束，強制結束`);
        try {
          rec.child.kill();
        } catch {
          // 已經結束
        }
        timer = setTimeout(resolve, 2000); // kill 之後最多再等 2 秒
      }, shutdownTimeoutMs);
      rec.onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        rec.child.postMessage({ type: 'shutdown' });
      } catch {
        // 通道已關閉：視同需要強制結束
      }
    });
    port = null;
    setState('stopped');
    return { forced };
  }

  async function restart() {
    await stop();
    return start();
  }

  return {
    start,
    stop,
    restart,
    get state() {
      return state;
    },
    get port() {
      return port;
    },
    get restarts() {
      return restarts;
    },
  };
}
