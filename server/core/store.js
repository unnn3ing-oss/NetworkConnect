// Repository：記憶體 + JSON 檔。
// 每個 collection 一個檔案（<dataDir>/db/<name>.json，內容為陣列），只寫有異動的檔案，
// 寫入採「寫暫存檔 → rename」並 debounce。寫入前檢查呼叫模組是否為該 collection 的擁有者。
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { conflict, notFound, validation } from './errors.js';

/** 規格 §7：collection 的擁有者、主鍵與 id 前綴 */
export const COLLECTIONS = Object.freeze({
  floors: { owner: 'inventory', key: 'id', prefix: 'flr' },
  rooms: { owner: 'inventory', key: 'id', prefix: 'room' },
  groups: { owner: 'inventory', key: 'id', prefix: 'grp' },
  categories: { owner: 'inventory', key: 'id', prefix: 'cat' },
  devices: { owner: 'inventory', key: 'id', prefix: 'dev' },
  plans: { owner: 'floorplan', key: 'floorId' },
  placements: { owner: 'floorplan', key: 'deviceId' },
  statusHistory: { owner: 'monitor', key: 'deviceId' },
  nvrs: { owner: 'nvr', key: 'id', prefix: 'nvr' },
});

export class NotOwnerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotOwnerError';
    this.code = 'NOT_OWNER';
  }
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const clone = (v) => structuredClone(v);

function matches(doc, filter) {
  if (filter == null) return true;
  if (typeof filter === 'function') return Boolean(filter(doc));
  return Object.entries(filter).every(([k, v]) => {
    const actual = doc[k];
    return Array.isArray(actual) ? actual.includes(v) : actual === v;
  });
}

function meta(name) {
  const m = COLLECTIONS[name];
  if (!m) throw new Error(`未知的 collection：${name}`);
  return m;
}

async function renameWithRetry(from, to) {
  // Windows 上目標檔偶爾被防毒軟體短暫鎖住（EPERM／EBUSY），重試幾次
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/**
 * @param {{dataDir: string, debounceMs?: number, validate?: (name: string, doc: object) => void, log?: object}} opts
 */
export async function createStore({ dataDir, debounceMs = 200, validate = null, log = noopLog }) {
  const dbDir = path.join(dataDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });

  /** @type {Map<string, Map<string, object>>} */
  const data = new Map();
  const dirty = new Set();
  const timers = new Map();
  const chains = new Map(); // name -> Promise（同一個檔案的寫入串行）
  let writes = 0;
  let closed = false;

  const fileOf = (name) => path.join(dbDir, `${name}.json`);

  // ---- 載入 ----
  for (const [name, m] of Object.entries(COLLECTIONS)) {
    const map = new Map();
    data.set(name, map);
    const file = fileOf(name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error('內容不是陣列');
      for (const doc of arr) map.set(String(doc[m.key]), doc);
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      map.clear();
      log.warn(`${name}.json 損毀（${err.message}），已改名為 ${path.basename(backup)}，以空資料啟動`);
    }
  }
  // 清掉上次當機殘留的暫存檔
  for (const f of fs.readdirSync(dbDir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dbDir, f), { force: true });

  // ---- 寫入 ----
  function persist(name) {
    const json = JSON.stringify([...data.get(name).values()]);
    const prev = chains.get(name) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const file = fileOf(name);
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, json);
        await renameWithRetry(tmp, file);
        writes++;
      });
    chains.set(name, next);
    return next;
  }

  function markDirty(name) {
    if (closed) throw new Error('store 已關閉');
    dirty.add(name);
    if (timers.has(name)) return;
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        if (!dirty.delete(name)) return;
        persist(name).catch((err) => log.error(`寫入 ${name}.json 失敗：${err.message}`));
      }, debounceMs),
    );
  }

  async function flush() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const names = [...dirty];
    dirty.clear();
    for (const name of names) persist(name);
    await Promise.all([...chains.values()]);
  }

  // ---- Repository ----
  function repo(name, { canWrite }) {
    const m = meta(name);
    const map = data.get(name);
    const guard = () => {
      if (closed) throw new Error('store 已關閉');
      canWrite(name);
    };
    const check = (doc) => {
      if (validate) validate(name, doc);
    };
    const keyOf = (doc) => {
      if (doc[m.key] === undefined || doc[m.key] === null || doc[m.key] === '') {
        throw validation(`缺少主鍵欄位 ${m.key}`);
      }
      return String(doc[m.key]);
    };
    return {
      async list(filter) {
        return [...map.values()].filter((d) => matches(d, filter)).map(clone);
      },
      async get(id) {
        const d = map.get(String(id));
        return d ? clone(d) : undefined;
      },
      async insert(input) {
        guard();
        const doc = clone(input);
        if ((doc[m.key] === undefined || doc[m.key] === null) && m.key === 'id' && m.prefix) {
          doc.id = `${m.prefix}_${nanoid(10)}`;
        }
        const key = keyOf(doc);
        if (map.has(key)) throw conflict(`${name} 已存在 ${key}`);
        check(doc);
        map.set(key, doc);
        markDirty(name);
        return clone(doc);
      },
      async update(id, patch) {
        guard();
        const existing = map.get(String(id));
        if (!existing) throw notFound(`找不到 ${name}/${id}`);
        if (patch[m.key] !== undefined && String(patch[m.key]) !== String(id)) {
          throw validation(`不可修改主鍵 ${m.key}`);
        }
        const merged = { ...existing, ...clone(patch) };
        check(merged);
        map.set(String(id), merged);
        markDirty(name);
        return clone(merged);
      },
      async upsert(input) {
        guard();
        const doc = clone(input);
        const key = keyOf(doc);
        check(doc);
        map.set(key, doc);
        markDirty(name);
        return clone(doc);
      },
      async remove(id) {
        guard();
        const had = map.delete(String(id));
        if (had) markDirty(name);
        return had;
      },
    };
  }

  function restoreAll(snapshot) {
    if (closed) throw new Error('store 已關閉');
    const next = new Map();
    for (const name of Object.keys(COLLECTIONS)) next.set(name, new Map());
    // 先全部驗證
    for (const [name, docs] of Object.entries(snapshot ?? {})) {
      const m = COLLECTIONS[name];
      if (!m) throw validation(`未知的 collection：${name}`);
      if (!Array.isArray(docs)) throw validation(`${name} 必須是陣列`);
      for (const raw of docs) {
        const doc = clone(raw);
        if (!doc || typeof doc !== 'object' || doc[m.key] === undefined || doc[m.key] === null || doc[m.key] === '') {
          throw validation(`${name} 有紀錄缺少主鍵欄位 ${m.key}`);
        }
        const key = String(doc[m.key]);
        if (next.get(name).has(key)) throw validation(`${name} 的 ${key} 重複`);
        if (validate) validate(name, doc);
        next.get(name).set(key, doc);
      }
    }
    // 再一次寫入（記憶體整批替換 + 全部標記為待寫）
    for (const [name, map] of next) {
      const target = data.get(name); // repo 持有同一個 Map 物件，所以就地替換內容
      target.clear();
      for (const [k, v] of map) target.set(k, v);
      markDirty(name);
    }
  }

  const privileged = { canWrite: () => {} };

  const store = {
    /** 核心專用（不檢查擁有者）；模組請用 forModule() 取得的視圖 */
    collection(name) {
      return repo(name, privileged);
    },
    /** 模組專用視圖：只有 owns 內的 collection 可寫 */
    forModule(moduleName, owns = []) {
      for (const c of owns) {
        const m = meta(c);
        if (m.owner !== moduleName) {
          throw new Error(`collection ${c} 的擁有者是 ${m.owner}，${moduleName} 不能宣告擁有`);
        }
      }
      const canWrite = (name) => {
        if (!owns.includes(name)) {
          throw new NotOwnerError(`模組 ${moduleName} 不是 collection ${name} 的擁有者，不能寫入`);
        }
      };
      return {
        collection: (name) => repo(name, { canWrite }),
        // 規格 §7 唯一例外：只有 io 模組可整批覆寫
        async restore(snapshot) {
          if (moduleName !== 'io') {
            throw new NotOwnerError(`模組 ${moduleName} 不能呼叫 restore（只有 io 模組可以）`);
          }
          restoreAll(snapshot);
        },
        async snapshot() {
          return store.snapshot();
        },
        flush,
      };
    },
    /** 核心專用（mock 載入 fixtures） */
    async restore(snapshot) {
      restoreAll(snapshot);
    },
    snapshot() {
      return Object.fromEntries([...data].map(([name, map]) => [name, [...map.values()].map(clone)]));
    },
    flush,
    stats: () => ({ writes }),
    async close() {
      if (closed) return;
      await flush();
      closed = true;
    },
  };
  return store;
}
