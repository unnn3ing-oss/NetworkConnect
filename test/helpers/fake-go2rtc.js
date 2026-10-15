// 假 go2rtc：小型 HTTP／WebSocket 模擬伺服器（B5 可擴充）。
// 已實作：
//   GET    /api                      → {version, ...}
//   GET    /api/streams              → { <name>: {producers:[{url}]} }
//   PUT    /api/streams?name=&src=   → 註冊串流（缺 name 或 src 回 400）
//   DELETE /api/streams?src=<name>   → 移除串流（不存在時回 400「yaml: path not exist」，與真正的 go2rtc 相同）
//   GET    /api/frame.jpeg           → 固定 JPEG（真的 go2rtc 單一執行檔沒有 ffmpeg，此路由僅供 mock 使用）
//   WS     /api/ws?src=<name>        → 收到 {"type":"mse"} 請求後回 {"type":"mse","value":"video/mp4; codecs=\"avc1.640029\""}，再送一段二進位
//                                      （與真的 go2rtc 一樣：串流未註冊 → {"type":"error"}；瀏覽器要等 sourceopen 後才送請求。
//                                       從不送請求的舊式用戶端，連上 150ms 後仍會收到同樣的兩則訊息——相容 test/unit/core/fakes.test.js）
// B5 擴充（測試用控制）：
//   fake.setCodec(name, 'hvc1.1.6.L153.B0')   該串流回報的 codecs（預設 avc1.640029）
//   fake.setDefaultCodec('flac')              所有串流的預設 codecs（Playwright 的 Chromium 沒有 H.264，瀏覽器測試改用它支援的 flac）
//   fake.setStreamError(name, '訊息'|null)     該串流改回 {"type":"error","value":訊息}（例：模擬 RTSP 401）
//   fake.setSilent(name, true|false)           該串流收到請求也不回應（模擬逾時）
//   fake.connectionCount([name])               目前開著的 WebSocket 數（可指定串流）
//   fake.wsLog                                 [{src, openedAt}] 每次 WebSocket 連線的紀錄
//   fake.received                              [{src, message}] 瀏覽器／後端送來的文字訊息
import Fastify from 'fastify';
import websocket from '@fastify/websocket';

/** 1x1 JPEG */
export const FAKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export const FAKE_GO2RTC_VERSION = '1.9.14-fake';

/** 舊式用戶端（連上後不送請求）等這麼久之後才會收到預設的 mse＋二進位訊息 */
const LEGACY_DELAY_MS = 150;

export async function createFakeGo2rtc({ port = 0, host = '127.0.0.1' } = {}) {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  await app.register(websocket);
  /** @type {Map<string, string>} name -> src */
  const streams = new Map();
  const requests = [];
  /** @type {Set<{socket: object, src: string}>} */
  const sockets = new Set();
  const wsLog = [];
  const received = [];
  const codecs = new Map();
  let defaultCodec = 'avc1.640029';
  const streamErrors = new Map();
  const silent = new Set();

  app.addHook('onRequest', async (req) => {
    requests.push({ method: req.method, url: req.url });
  });

  app.get('/api', async () => ({ version: FAKE_GO2RTC_VERSION, config_path: '', host: `${host}:${port}` }));

  app.get('/api/streams', async () =>
    Object.fromEntries([...streams].map(([name, src]) => [name, { producers: [{ url: src }], consumers: null }])),
  );

  app.put('/api/streams', async (req, reply) => {
    const { name, src } = req.query;
    if (!name || !src) return reply.code(400).send({ error: 'name 與 src 必填' });
    // 與真正的 go2rtc 1.9.14 相同：來源含空白回 400
    if (/\s/.test(src)) return reply.code(400).type('text/plain').send('streams: source with spaces may be insecure');
    streams.set(name, src);
    return {};
  });

  // 與真正的 go2rtc 1.9.14 相同：刪除不存在的串流回 400「yaml: path not exist」（不是 404）
  app.delete('/api/streams', async (req, reply) => {
    if (!streams.has(req.query.src)) return reply.code(400).type('text/plain').send('yaml: path not exist');
    streams.delete(req.query.src);
    return {};
  });

  app.get('/api/frame.jpeg', async (req, reply) => reply.type('image/jpeg').send(FAKE_JPEG));

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const src = req.query?.src ?? '';
    const entry = { socket, src };
    sockets.add(entry);
    wsLog.push({ src, openedAt: Date.now() });

    const sendMedia = () => {
      socket.send(JSON.stringify({ type: 'mse', value: `video/mp4; codecs="${codecs.get(src) ?? defaultCodec}"` }));
      // 刻意只送一個不完整的 ftyp 方塊：MSE 會等待後續資料而不報錯，連線可以維持
      socket.send(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), { binary: true });
    };

    // 相容 A0 原本的行為（連上就送）：只對「從不送請求」的舊式用戶端生效，等一小段時間都沒收到請求才送。
    // 瀏覽器（VideoRTC）與後端 probe 都會在連上後立刻送出 {"type":"mse"} 請求，不會走到這裡。
    let requested = false;
    const legacyTimer = setTimeout(() => {
      if (!requested && socket.readyState === 1 && !silent.has(src)) sendMedia();
    }, LEGACY_DELAY_MS);
    legacyTimer.unref?.();

    socket.on('close', () => {
      clearTimeout(legacyTimer);
      sockets.delete(entry);
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      received.push({ src, message: msg });
      if (msg.type !== 'mse') return;
      requested = true;
      if (silent.has(src)) return;
      if (streamErrors.has(src)) {
        socket.send(JSON.stringify({ type: 'error', value: streamErrors.get(src) }));
        return;
      }
      if (!streams.has(src)) {
        socket.send(JSON.stringify({ type: 'error', value: 'streams: stream not found' }));
        return;
      }
      sendMedia();
    });
  });

  await app.listen({ port, host });
  const actualPort = app.server.address().port;
  let closed = false;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    streams,
    requests,
    wsLog,
    received,
    setDefaultCodec: (value) => { defaultCodec = value || 'avc1.640029'; },
    setCodec: (name, value) => (value ? codecs.set(name, value) : codecs.delete(name)),
    setStreamError: (name, message) => (message ? streamErrors.set(name, message) : streamErrors.delete(name)),
    setSilent: (name, on = true) => (on ? silent.add(name) : silent.delete(name)),
    connectionCount: (name) => [...sockets].filter((s) => name === undefined || s.src === name).length,
    app,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.socket.terminate();
      await app.close();
    },
  };
}
