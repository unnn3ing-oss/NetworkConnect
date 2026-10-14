// monitor 服務：把排程器、狀態機、歷史、prober 接起來。所有外部依賴（時間、prober、store、events）皆注入，
// 因此單元測試可以用假時鐘＋假 prober 完整驗證，不需要真實網路。
import { notFound } from '../../core/errors.js';
import { createScheduler } from './scheduler.js';
import { createStateTracker, probeKey } from './state.js';
import { createHistory } from './history.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

export const LOCAL_NETWORK_HINT =
  '所有以 ping 偵測的設備同時失敗，但本機迴路（127.0.0.1）正常。這可能是 macOS 尚未允許「區域網路」權限：請到「系統設定 → 隱私權與安全性 → 區域網路」開啟 NetworkConnect，然後重新啟動 App。';
const HINT_MIN_DEVICES = 3;
const LOOPBACK_CACHE_MS = 30_000;
const STOP_WAIT_MS = 2000;

/**
 * @param {object} deps
 * @param {{list(): Promise<object[]>}} deps.devices                  唯讀的 devices collection
 * @param {{list, upsert, remove}} deps.historyRepo                   statusHistory collection
 * @param {object} deps.events                                        ctx.events
 * @param {{probe(req): Promise<{up: boolean, rttMs: number|null}>}} deps.prober
 * @param {{get(): object, update(patch: object): Promise<object>}} deps.settings
 * @param {{available: boolean, reason?: string}} [deps.ping]         本機 ping 是否可用（check() 偵測的結果）
 * @param {string} [deps.platform]
 */
export function createMonitor({
  devices,
  historyRepo,
  events,
  prober,
  settings,
  ping = { available: true },
  platform = process.platform,
  now = Date.now,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer = (t) => clearTimeout(t),
  random = Math.random,
  log = noopLog,
}) {
  const tracker = createStateTracker({ now });
  const history = createHistory({ repo: historyRepo, now, setTimer, clearTimer, log });
  /** @type {Map<string, object>} */
  let byId = new Map();
  let order = [];
  let started = false;
  let syncChain = Promise.resolve();
  const inflight = new Set();
  let offInventory = null;
  let offSse = null;
  let loopback = { at: -Infinity, up: false };

  const iso = () => new Date(now()).toISOString();
  const emitChange = (change) => {
    if (change) events.emit('status.changed', change);
  };

  // ---- 偵測一台 ----
  async function runProbe(id) {
    const dev = byId.get(id);
    if (!dev || (dev.monitor?.method ?? 'none') === 'none') return;
    const method = dev.monitor.method;
    const key = probeKey(dev);
    const task = (async () => {
      let result;
      if (!dev.ip) {
        result = { error: '尚未設定 IP' };
      } else if (method === 'icmp' && !ping.available) {
        result = { error: ping.reason ?? '找不到 ping 指令，無法使用 ICMP 偵測' };
      } else {
        try {
          const r = await prober.probe({
            method,
            host: dev.ip,
            port: dev.monitor.port ?? null,
            path: dev.monitor.path ?? '/',
            timeoutMs: settings.get().timeoutMs,
          });
          result = r.up ? { up: true, rttMs: r.rttMs ?? null } : { up: false, rttMs: null };
        } catch (err) {
          result = { error: err?.message ? String(err.message) : '偵測失敗' };
        }
      }
      // 偵測期間設備被刪除或改了偵測對象：結果作廢
      const current = byId.get(id);
      if (!current || probeKey(current) !== key) return;
      const rec = tracker.record(id, result);
      if (!rec) return;
      if (result.error === undefined) history.add(id, { at: rec.item.lastCheckAt, up: result.up, rttMs: result.rttMs });
      emitChange(rec.change);
    })();
    inflight.add(task);
    try {
      await task;
    } finally {
      inflight.delete(task);
    }
  }

  const scheduler = createScheduler({
    now,
    setTimer,
    clearTimer,
    random,
    run: runProbe,
    getConcurrency: () => settings.get().concurrency,
    onSleep: () => {
      log.info('偵測到電腦曾睡眠：清除失敗計數並立即重測全部設備');
      tracker.resetFailures();
    },
    onResume: () => tracker.resetFailures(),
    onError: (err, id) => log.error({ err }, `偵測 ${id} 時發生未預期的錯誤：${err.message}`),
  });

  // ---- 與 devices collection 同步 ----
  async function doSync() {
    const list = await devices.list();
    const next = new Map(list.map((d) => [d.id, d]));
    for (const id of [...byId.keys()]) {
      if (next.has(id)) continue;
      tracker.remove(id);
      history.remove(id).catch((err) => log.error({ err }, `刪除偵測歷史失敗（${id}）：${err.message}`));
    }
    byId = next;
    order = list.map((d) => d.id);
    for (const d of list) emitChange(tracker.ensure(d).change);
    const defaultInterval = settings.get().defaultIntervalSec;
    scheduler.sync(
      list
        .filter((d) => (d.monitor?.method ?? 'none') !== 'none')
        .map((d) => ({ id: d.id, intervalSec: d.monitor.intervalSec ?? defaultInterval, key: probeKey(d) })),
    );
    return list;
  }
  function sync() {
    const p = syncChain.then(doSync);
    syncChain = p.catch((err) => log.error({ err }, `同步設備清單失敗：${err.message}`));
    return p;
  }

  const items = () => order.map((id) => tracker.get(id)).filter(Boolean);

  async function requireDevice(id) {
    await sync();
    const dev = byId.get(id);
    if (!dev) throw notFound('找不到設備');
    return dev;
  }

  // ---- macOS 區域網路權限提示 ----
  async function computeHint() {
    if (platform !== 'darwin' || !ping.available) return null;
    const icmp = [...byId.values()].filter((d) => d.monitor?.method === 'icmp' && d.ip);
    if (icmp.length < HINT_MIN_DEVICES) return null;
    const allFailing = icmp.every((d) => {
      const it = tracker.get(d.id);
      return it && it.lastCheckAt !== null && (it.consecutiveFailures > 0 || it.state === 'down');
    });
    if (!allFailing) return null;
    if (now() - loopback.at > LOOPBACK_CACHE_MS) {
      let up = false;
      try {
        up = (await prober.probe({ method: 'icmp', host: '127.0.0.1', timeoutMs: settings.get().timeoutMs })).up;
      } catch {
        up = false;
      }
      loopback = { at: now(), up };
    }
    return loopback.up ? LOCAL_NETWORK_HINT : null;
  }

  function currentSettings() {
    const s = settings.get();
    const until = s.pausedUntil ? Date.parse(s.pausedUntil) : NaN;
    return { ...s, pausedUntil: until > now() ? s.pausedUntil : null };
  }

  const service = {
    async start() {
      if (started) return;
      started = true;
      await history.load();
      const list = await sync();
      await history.prune(new Set(list.map((d) => d.id)));
      const until = currentSettings().pausedUntil;
      scheduler.setPausedUntil(until ? Date.parse(until) : null);
      offInventory = events.on('inventory.changed', (p) => {
        if (p?.collection === 'devices') sync().catch(() => {});
      });
      offSse = events.onSseConnect((send) => send('status.snapshot', { items: items() }));
      scheduler.start();
    },

    async stop() {
      started = false;
      offInventory?.();
      offSse?.();
      offInventory = offSse = null;
      scheduler.stop();
      await syncChain;
      if (inflight.size) {
        let t;
        await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => (t = setTimeout(r, STOP_WAIT_MS)))]);
        clearTimeout(t);
      }
      await history.stop();
    },

    /** 等待進行中的設備同步完成（測試與 inventory.changed 之後使用） */
    idle: () => syncChain,
    sync,
    flush: () => history.flush(),

    async listStatus() {
      await sync();
      return items();
    },
    async getStatus(id) {
      await sync();
      return tracker.get(id);
    },

    async history(id, hours = 24) {
      await requireDevice(id);
      return { deviceId: id, hours, samples: history.get(id, hours) };
    },

    /** 立即檢查一次。method=none 或暫停中：不偵測，回目前狀態 */
    async checkNow(id) {
      const dev = await requireDevice(id);
      if ((dev.monitor?.method ?? 'none') === 'none' || scheduler.isPaused()) return tracker.get(id);
      await scheduler.runNow(id);
      return tracker.get(id);
    },

    async getSettings() {
      const s = currentSettings();
      const hint = await computeHint();
      return hint ? { ...s, hint } : s;
    },

    async updateSettings(patch) {
      const next = { ...patch };
      if ('pausedUntil' in patch) {
        const ms = patch.pausedUntil ? Date.parse(patch.pausedUntil) : NaN;
        next.pausedUntil = ms > now() ? new Date(ms).toISOString() : null;
      }
      await settings.update(next);
      if ('pausedUntil' in next) scheduler.setPausedUntil(next.pausedUntil ? Date.parse(next.pausedUntil) : null);
      return service.getSettings();
    },

    tracker,
    scheduler,
  };
  void iso;
  return service;
}
