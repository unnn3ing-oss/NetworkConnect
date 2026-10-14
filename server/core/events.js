// 事件：行程內發布／訂閱 + GET /api/events（SSE，每 25 秒心跳）
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

export function createEvents({ heartbeatMs = 25_000, log = noopLog } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  const anyHandlers = new Set();
  const connectHandlers = new Set();
  /** @type {Set<{send: Function, close: Function}>} */
  const clients = new Set();

  const safe = (fn, ...args) => {
    try {
      fn(...args);
    } catch (err) {
      log.error({ err }, `事件訂閱者丟出例外：${err.message}`);
    }
  };

  const frame = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;

  const events = {
    emit(name, payload) {
      for (const fn of [...(handlers.get(name) ?? [])]) safe(fn, payload);
      for (const fn of [...anyHandlers]) safe(fn, name, payload);
      const text = frame(name, payload);
      for (const c of clients) c.write(text);
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    onAny(fn) {
      anyHandlers.add(fn);
      return () => anyHandlers.delete(fn);
    },
    /** SSE 連線建立時呼叫 fn(send)；send(name, payload) 只送給這一條連線 */
    onSseConnect(fn) {
      connectHandlers.add(fn);
      return () => connectHandlers.delete(fn);
    },
    clientCount: () => clients.size,

    registerRoutes(app) {
      app.get('/api/events', (req, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const client = {
          write(text) {
            try {
              res.write(text);
            } catch {
              client.close();
            }
          },
          close() {
            clearInterval(timer);
            clients.delete(client);
            if (!res.writableEnded) res.end();
          },
        };
        const timer = setInterval(() => client.write(': ping\n\n'), heartbeatMs);
        timer.unref?.();
        res.write('retry: 3000\n\n');
        clients.add(client);
        const onGone = () => {
          clearInterval(timer);
          clients.delete(client);
        };
        req.raw.on('close', onGone);
        res.on('close', onGone);
        const send = (name, payload) => client.write(frame(name, payload));
        for (const fn of [...connectHandlers]) safe(fn, send);
      });
    },

    /** 伺服器關閉時結束所有 SSE 連線（否則 app.close() 會一直等） */
    closeAll() {
      for (const c of [...clients]) c.close();
    },
  };
  return events;
}
