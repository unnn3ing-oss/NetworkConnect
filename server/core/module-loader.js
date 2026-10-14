// 後端模組載入（規格 §5.1、故障隔離規則 §5 第 4 點）
// 逐一 import → check() → register()；任何一步失敗只把該模組標記為 failed，其他模組照常。
import { AppError } from './errors.js';
import { COLLECTIONS } from './store.js';

/** 載入順序（也是 /api/system/modules 的列出順序）；system 永遠第一個且不可停用 */
export const MODULE_NAMES = Object.freeze(['system', 'inventory', 'io', 'monitor', 'floorplan', 'nvr']);

const defaultImporter = (name) => import(new URL(`../modules/${name}/index.js`, import.meta.url).href);

const errMsg = (err) => (err && err.message ? String(err.message) : String(err));

function validateShape(name, mod) {
  if (!mod || typeof mod !== 'object') throw new Error('模組沒有 default export 物件');
  if (mod.name !== name) throw new Error(`模組 name「${mod.name}」與目錄名稱「${name}」不符`);
  if (!Array.isArray(mod.owns)) throw new Error('模組必須宣告 owns 陣列');
  if (typeof mod.register !== 'function') throw new Error('模組必須實作 register(app, ctx)');
  for (const c of mod.owns) {
    const m = COLLECTIONS[c];
    if (!m) throw new Error(`owns 含未知的 collection：${c}`);
    if (m.owner !== name) throw new Error(`collection ${c} 的擁有者是 ${m.owner}，${name} 不能宣告擁有`);
  }
}

/**
 * @param {object} opts
 * @param {import('fastify').FastifyInstance} opts.app
 * @param {{modules: Record<string, boolean>}} opts.config
 * @param {object} opts.store  createStore() 的結果
 * @param {object} opts.ctxBase 其餘 ctx 欄位（config、events、log、secrets、dataDir、mock、prober…）
 * @param {(name: string) => Promise<{default: object}>} [opts.importer]
 * @param {readonly string[]} [opts.names]
 */
export async function loadModules({ app, config, store, ctxBase, importer = defaultImporter, names = MODULE_NAMES }) {
  const log = ctxBase.log ?? { info() {}, warn() {}, error() {} };
  /** @type {Map<string, {name: string, state: 'ok'|'failed'|'disabled', error?: string, mod?: object, ctx?: object, started?: boolean}>} */
  const entries = new Map(names.map((n) => [n, { name: n, state: 'ok' }]));

  const list = () =>
    [...entries.values()].map((e) => {
      const item = { name: e.name, state: e.state };
      if (e.state === 'failed') item.error = e.error;
      if (e.note) item.note = e.note;
      return item;
    });

  const fail = (entry, err, phase) => {
    entry.state = 'failed';
    entry.error = errMsg(err);
    log.error({ err }, `模組 ${entry.name} 在 ${phase} 失敗：${entry.error}`);
  };

  for (const name of names) {
    const entry = entries.get(name);
    if (name !== 'system' && config.modules?.[name] === false) {
      entry.state = 'disabled';
      continue;
    }

    let mod;
    try {
      const imported = await importer(name);
      mod = imported.default;
      validateShape(name, mod);
    } catch (err) {
      fail(entry, err, 'import');
      continue;
    }

    const setNote = (text) => {
      if (text) entry.note = String(text);
      else delete entry.note;
    };
    const ctx = { ...ctxBase, store: store.forModule(name, mod.owns), modules: { list, setNote } };
    entry.mod = mod;
    entry.ctx = ctx;

    try {
      if (typeof mod.check === 'function') await mod.check(ctx);
    } catch (err) {
      fail(entry, err, 'check');
      continue;
    }

    // 每個模組一個封裝的 plugin：register 中途丟錯時，已註冊的路由改回 503，不影響其他模組
    await app.register(async (instance) => {
      instance.addHook('onRequest', async () => {
        if (entry.state === 'failed') {
          throw new AppError('UPSTREAM', `模組 ${name} 暫時無法使用`, { status: 503, details: { module: name } });
        }
      });
      try {
        await mod.register(instance, ctx);
      } catch (err) {
        fail(entry, err, 'register');
      }
    });
  }

  return {
    list,
    /** 全部 register 完成、伺服器開始監聽後呼叫 */
    async start() {
      for (const name of names) {
        const entry = entries.get(name);
        if (entry.state !== 'ok' || typeof entry.mod.start !== 'function') {
          if (entry.state === 'ok') entry.started = true;
          continue;
        }
        try {
          await entry.mod.start(entry.ctx);
          entry.started = true;
        } catch (err) {
          fail(entry, err, 'start');
        }
      }
    },
    /** 以相反順序停止；單一模組失敗不影響其他 */
    async stop() {
      for (const name of [...names].reverse()) {
        const entry = entries.get(name);
        if (!entry.started || typeof entry.mod.stop !== 'function') continue;
        entry.started = false;
        try {
          await entry.mod.stop();
        } catch (err) {
          log.error({ err }, `模組 ${name} stop 失敗：${errMsg(err)}`);
        }
      }
    },
  };
}
