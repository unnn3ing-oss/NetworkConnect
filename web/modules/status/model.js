// 狀態頁的資料整理（純函式，無 DOM；單元測試直接 import）。
import { matchDevice } from '../../core/filters.js';

export const UPTIME_BUCKETS = 24;
const HOUR = 3600_000;
const NO_FLOOR = '__none__';

const stateOf = (device, item) => {
  if ((device.monitor?.method ?? 'none') === 'none') return 'disabled';
  return item?.state ?? 'unknown';
};

/**
 * 設備＋狀態配對成列，並套用全站篩選。
 * @returns {Array<{device: object, item: object|undefined, state: string, critical: boolean}>}
 */
export function buildRows(devices, items, filters) {
  const byId = new Map(items.map((i) => [i.deviceId, i]));
  return devices
    .filter((d) => matchDevice(d, filters))
    .map((device) => {
      const item = byId.get(device.id);
      return { device, item, state: stateOf(device, item), critical: Boolean(device.monitor?.critical) };
    });
}

/** 上方統計：上線／離線／未知／未偵測，另算出離線的關鍵設備數 */
export function summarize(rows) {
  const s = { up: 0, down: 0, unknown: 0, disabled: 0, criticalDown: 0, total: rows.length };
  for (const r of rows) {
    s[r.state] += 1;
    if (r.state === 'down' && r.critical) s.criticalDown += 1;
  }
  return s;
}

/** 排序權重：離線的關鍵設備 → 其他離線 → 未知 → 上線 → 未偵測 */
export function rankOf(row) {
  if (row.state === 'down') return row.device.monitor?.critical ? 0 : 1;
  if (row.state === 'unknown') return 2;
  if (row.state === 'up') return 3;
  return 4;
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const byLabel = (a, b) => collator.compare(a.device.code || a.device.name, b.device.code || b.device.name) || collator.compare(a.device.name, b.device.name);

/**
 * 依樓層分組（樓層依 order；沒有樓層或樓層不存在者歸「未指定樓層」排最後），組內離線的關鍵設備置頂。
 * @returns {Array<{id: string, name: string, rows: object[], summary: object}>}
 */
export function groupByFloor(rows, floors) {
  const known = new Set(floors.map((f) => f.id));
  const buckets = new Map();
  for (const r of rows) {
    const key = r.device.floorId && known.has(r.device.floorId) ? r.device.floorId : NO_FLOOR;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const make = (id, name) => {
    const list = buckets.get(id) ?? [];
    list.sort((a, b) => rankOf(a) - rankOf(b) || byLabel(a, b));
    return { id, name, rows: list, summary: summarize(list) };
  };
  const groups = floors.filter((f) => buckets.has(f.id)).map((f) => make(f.id, f.name));
  if (buckets.has(NO_FLOOR)) groups.push(make(NO_FLOOR, '未指定樓層'));
  return groups;
}

/**
 * 24 小時可用率：回傳 {pct, buckets}。buckets 共 24 個（由舊到新，每桶 1 小時，最後一桶是現在往前一小時）；
 * 桶的 state：up（全成功）、down（全失敗）、partial、none（沒資料）。
 */
export function uptimeSummary(samples, nowMs = Date.now()) {
  const acc = Array.from({ length: UPTIME_BUCKETS }, () => ({ up: 0, total: 0 }));
  let up = 0;
  let total = 0;
  for (const s of samples ?? []) {
    const age = nowMs - Date.parse(s.at);
    if (!(age >= 0) || age >= UPTIME_BUCKETS * HOUR) continue;
    const b = acc[UPTIME_BUCKETS - 1 - Math.floor(age / HOUR)];
    b.total += 1;
    total += 1;
    if (s.up) {
      b.up += 1;
      up += 1;
    }
  }
  const buckets = acc.map((b) => ({
    ...b,
    state: b.total === 0 ? 'none' : b.up === b.total ? 'up' : b.up === 0 ? 'down' : 'partial',
  }));
  return { pct: total === 0 ? null : Math.round((up / total) * 1000) / 10, buckets };
}
