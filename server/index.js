// 伺服器入口：startServer({dataDir, port, host, go2rtcPath, go2rtcUrl, mock}) → {port, url, stop}
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { COLLECTION_SCHEMAS } from '../contracts/index.js';
import { loadConfig, saveConfig, resolveDataDir } from './core/config.js';
import { createStore } from './core/store.js';
import { createSecrets } from './core/secrets.js';
import { createEvents } from './core/events.js';
import { createAuth } from './core/auth.js';
import { installErrorHandler, toErrorResponse } from './core/errors.js';
import { loadModules } from './core/module-loader.js';
import { createValidatorFn } from './core/validate.js';
import { seedMock, startMockServices } from './core/mock.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** 規格 §11 */
export const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; connect-src 'self'";

const MAX_PORT_TRIES = 20;
const truthy = (v) => v === '1' || v === 'true';

async function listenWithFallback(app, host, port) {
  if (port === 0) {
    await app.listen({ port: 0, host });
    return app.server.address().port;
  }
  for (let i = 0; i <= MAX_PORT_TRIES && port + i <= 65535; i++) {
    try {
      await app.listen({ port: port + i, host });
      return port + i;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`找不到可用的埠（已嘗試 ${port}–${Math.min(port + MAX_PORT_TRIES, 65535)}）`);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]     資料夾（預設 NC_DATA_DIR，再預設 ./data；mock 為 ./data-mock）
 * @param {number} [opts.port]        0＝由系統分配；被佔用時往後找（最多 20 個）
 * @param {string} [opts.host]        預設依 config.lanAccess：true→0.0.0.0，false→127.0.0.1
 * @param {string} [opts.go2rtcPath]
 * @param {string} [opts.go2rtcUrl]
 * @param {boolean} [opts.mock]       NC_MOCK=1
 * 測試用：env、logger、parentPort、exit、moduleImporter
 * @returns {Promise<{port: number, url: string, stop: () => Promise<void>, app: object, ctx: object, store: object, events: object}>}
 */
export async function startServer(opts = {}) {
  const env = opts.env ?? process.env;
  const mock = opts.mock ?? truthy(env.NC_MOCK);
  const dataDir = resolveDataDir({ dataDir: opts.dataDir, env, mock });

  const diskConfig = loadConfig(dataDir);
  const config = structuredClone(diskConfig);
  const envPort = env.NC_PORT !== undefined && env.NC_PORT !== '' ? Number(env.NC_PORT) : undefined;
  const explicitPort = opts.port ?? envPort;
  const requestedPort = explicitPort ?? config.port;
  config.port = requestedPort;
  const host = opts.host ?? (env.NC_HOST || (config.lanAccess ? '0.0.0.0' : '127.0.0.1'));
  config.go2rtcPath = opts.go2rtcPath ?? (env.NC_GO2RTC_PATH || config.go2rtcPath);
  config.go2rtcUrl = opts.go2rtcUrl ?? config.go2rtcUrl;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 128 * 1024 * 1024, // 匯入 JSON 內含 base64 平面圖
    forceCloseConnections: true,
  });
  const log = app.log;

  const validate = createValidatorFn();
  const secrets = createSecrets(dataDir);
  const store = await createStore({
    dataDir,
    log,
    validate: (name, doc) => validate(COLLECTION_SCHEMAS[name], doc),
  });
  const events = createEvents({ log });
  const auth = createAuth({ secrets, validate });

  let mockServices = null;
  if (mock) {
    const db = await seedMock({ store, secrets, dataDir });
    mockServices = await startMockServices(db);
    config.go2rtcPath = null;
    config.go2rtcUrl = mockServices.go2rtc.url;
  }

  // ---- 核心 plugins ----
  installErrorHandler(app);
  app.setNotFoundHandler((req, reply) => {
    const path_ = req.url.split('?')[0];
    // A1 的 web/ui/*.css 可能尚未存在：回空樣式表，避免 shell 出現 404 console 錯誤
    if (req.method === 'GET' && /^\/ui\/[\w.-]+\.css$/.test(path_)) {
      return reply.type('text/css; charset=utf-8').send('/* web/ui 尚未提供此檔案 */\n');
    }
    const { status, body } = toErrorResponse({ statusCode: 404 });
    body.error.message = '找不到資源';
    reply.code(status).send(body);
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', CSP);
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await auth.register(app);
  events.registerRoutes(app);

  // ---- 功能模組 ----
  const startedAt = Date.now();
  const loader = await loadModules({
    app,
    config,
    store,
    importer: opts.moduleImporter,
    ctxBase: { config, events, log, secrets, dataDir, mock, prober: mockServices?.prober, validate, startedAt },
  });
  const ctx = { config, events, log, secrets, dataDir, mock, prober: mockServices?.prober, validate, startedAt, modules: { list: loader.list } };

  // ---- 靜態檔案（放最後；/api/* 的路由較具體，不受影響）----
  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/', index: ['index.html'] });

  // ---- 啟動 ----
  let port;
  try {
    port = await listenWithFallback(app, host, requestedPort);
  } catch (err) {
    await loader.stop();
    await app.close().catch(() => {});
    await store.close();
    await mockServices?.go2rtc.close();
    throw err;
  }
  config.port = port;
  if (explicitPort === undefined && port !== requestedPort) saveConfig(dataDir, { ...diskConfig, port });
  await loader.start();

  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${urlHost}:${port}`;

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      await loader.stop();
      events.closeAll();
      await app.close();
      await store.close();
      await mockServices?.go2rtc.close();
    })();
    return stopping;
  }

  // ---- Electron utilityProcess ----
  const parentPort = opts.parentPort !== undefined ? opts.parentPort : process.parentPort;
  if (parentPort) {
    const exit = opts.exit ?? ((code) => process.exit(code));
    events.on('status.changed', (payload) => parentPort.postMessage({ type: 'event', name: 'status.changed', payload }));
    parentPort.on('message', (e) => {
      const msg = e && typeof e === 'object' && 'data' in e ? e.data : e;
      if (msg && msg.type === 'shutdown') {
        stop().then(
          () => exit(0),
          (err) => {
            log.error({ err }, '關閉伺服器失敗');
            exit(1);
          },
        );
      }
    });
    parentPort.postMessage({ type: 'ready', port });
  }

  return { port, host, url, stop, app, ctx, store, events, modules: loader };
}
