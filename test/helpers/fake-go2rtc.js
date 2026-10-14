// 假 go2rtc：小型 HTTP／WebSocket 模擬伺服器（B5 可擴充）。
// 已實作：
//   GET    /api                      → {version, ...}
//   GET    /api/streams              → { <name>: {producers:[{url}]} }
//   PUT    /api/streams?name=&src=   → 註冊串流（缺 name 或 src 回 400）
//   DELETE /api/streams?src=<name>   → 移除串流
//   GET    /api/frame.jpeg           → 固定 JPEG（真的 go2rtc 單一執行檔沒有 ffmpeg，此路由僅供 mock 使用）
//   WS     /api/ws?src=<name>        → 先送 {"type":"mse","value":"video/mp4; codecs=\"avc1.640029\""}，再送一段二進位
import Fastify from 'fastify';
import websocket from '@fastify/websocket';

/** 1x1 JPEG */
export const FAKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export const FAKE_GO2RTC_VERSION = '1.9.14-fake';

export async function createFakeGo2rtc({ port = 0, host = '127.0.0.1' } = {}) {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  await app.register(websocket);
  /** @type {Map<string, string>} name -> src */
  const streams = new Map();
  const requests = [];
  const sockets = new Set();

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
    streams.set(name, src);
    return {};
  });

  app.delete('/api/streams', async (req) => {
    streams.delete(req.query.src);
    return {};
  });

  app.get('/api/frame.jpeg', async (req, reply) => reply.type('image/jpeg').send(FAKE_JPEG));

  app.get('/api/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    socket.send(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), { binary: true });
  });

  await app.listen({ port, host });
  const actualPort = app.server.address().port;
  let closed = false;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    streams,
    requests,
    app,
    async close() {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.terminate();
      await app.close();
    },
  };
}
