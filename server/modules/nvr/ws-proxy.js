// GET(WS) /api/nvr/ws?stream=<name>：把瀏覽器的 MSE WebSocket 雙向轉送到 go2rtc 的 /api/ws?src=<name>。
// 安全：只轉送白名單內（本系統註冊過）的串流名稱；其他一律以 close code 4404 關閉。

/** 瀏覽器端送出緩衝超過這個量就視為跟不上，斷線讓前端重連（影片是即時串流，不能丟片段） */
const MAX_BUFFERED = 16 * 1024 * 1024;

export const CLOSE_NOT_FOUND = 4404;

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps
 * @param {(name: string) => Promise<boolean>} deps.isAllowed
 * @param {string} deps.go2rtcUrl   http://127.0.0.1:1984
 * @param {typeof WebSocket} [deps.WebSocketImpl]
 * @param {Set<object>} [deps.sockets]  追蹤中的連線（stop 時一併關閉）
 */
export function registerWsProxy(app, { isAllowed, go2rtcUrl, WebSocketImpl = globalThis.WebSocket, sockets = new Set(), log }) {
  const wsBase = String(go2rtcUrl).replace(/\/+$/, '').replace(/^http/i, 'ws');

  app.get('/api/nvr/ws', { websocket: true }, (socket, req) => {
    sockets.add(socket);
    const name = req.query?.stream;
    /** @type {Array<{data: Buffer, isBinary: boolean}>} 上游還沒連上前，瀏覽器先送來的訊息 */
    const pending = [];
    let upstream = null;
    let closed = false;

    const closeBoth = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close(code, reason);
      } catch {
        // 已關閉
      }
      try {
        if (upstream && upstream.readyState <= 1) upstream.close();
      } catch {
        // 已關閉
      }
    };

    // 訊息監聽必須同步掛上（白名單檢查是 async，之後才送來的訊息會遺失）
    socket.on('message', (data, isBinary) => {
      if (closed) return;
      if (upstream?.readyState === 1) upstream.send(isBinary ? data : data.toString());
      else pending.push({ data, isBinary });
    });
    socket.on('close', () => closeBoth());
    socket.on('error', () => closeBoth(1011));

    (async () => {
      if (typeof name !== 'string' || !(await isAllowed(name))) {
        closeBoth(CLOSE_NOT_FOUND, '找不到串流');
        return;
      }
      if (closed) return;
      try {
        upstream = new WebSocketImpl(`${wsBase}/api/ws?src=${encodeURIComponent(name)}`);
      } catch (err) {
        log?.warn?.(`連線 go2rtc 失敗：${err.message}`);
        closeBoth(1011, '串流服務無法使用');
        return;
      }
      upstream.binaryType = 'arraybuffer';
      upstream.addEventListener('open', () => {
        if (closed) {
          upstream.close();
          return;
        }
        for (const m of pending.splice(0)) upstream.send(m.isBinary ? m.data : m.data.toString());
      });
      upstream.addEventListener('message', (ev) => {
        if (closed || socket.readyState !== 1) return;
        if (socket.bufferedAmount > MAX_BUFFERED) {
          closeBoth(1013, '網路太慢，請重新連線');
          return;
        }
        if (typeof ev.data === 'string') socket.send(ev.data);
        else socket.send(Buffer.from(ev.data), { binary: true });
      });
      upstream.addEventListener('close', () => closeBoth());
      upstream.addEventListener('error', () => closeBoth(1011, '串流服務無法使用'));
    })().catch((err) => {
      log?.error?.({ err }, 'nvr ws 代理發生錯誤');
      closeBoth(1011);
    });
  });

  return {
    /** 關閉所有進行中的代理連線 */
    closeAll() {
      for (const s of [...sockets]) {
        try {
          s.close(1001, '伺服器關閉');
        } catch {
          // 已關閉
        }
      }
      sockets.clear();
    },
    get size() {
      return sockets.size;
    },
  };
}
