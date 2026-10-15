// 總覽的資料整理（純函式，不碰 DOM）。

export const STATES = ['up', 'down', 'unknown', 'disabled'];

/** 設備的目前狀態；monitor 還沒回報時視為 unknown */
export const stateOf = (statusMap, deviceId) => statusMap.get(deviceId)?.state ?? 'unknown';

export function summarize(devices, statusMap) {
  const out = { total: devices.length, up: 0, down: 0, unknown: 0, disabled: 0, criticalDown: 0 };
  for (const d of devices) {
    const s = stateOf(statusMap, d.id);
    out[STATES.includes(s) ? s : 'unknown'] += 1;
    if (s === 'down' && d.monitor?.critical) out.criticalDown += 1;
  }
  return out;
}

/** 離線的關鍵設備，離線最久的在前 */
export function criticalOffline(devices, statusMap) {
  return devices
    .filter((d) => d.monitor?.critical && stateOf(statusMap, d.id) === 'down')
    .map((d) => ({ device: d, since: statusMap.get(d.id)?.lastChangeAt ?? null }))
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.device.name.localeCompare(b.device.name, 'zh-Hant'));
}

/**
 * 各樓層設備數與上線率。上線率＝上線 ÷（上線＋離線），未知（尚未檢查）與未偵測的不計；沒有任何判定結果時為 null。
 * 有設備沒指定樓層時，最後多一列「未指定樓層」（id 為空字串）。
 */
export function floorRows(floors, devices, statusMap) {
  const blank = (id, name) => ({ id, name, total: 0, up: 0, down: 0, unknown: 0, disabled: 0, rate: null });
  const rows = floors.map((f) => blank(f.id, f.name));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let loose = null;
  for (const d of devices) {
    let row = byId.get(d.floorId);
    if (!row) {
      loose ??= blank('', '未指定樓層');
      row = loose;
    }
    const s = stateOf(statusMap, d.id);
    row.total += 1;
    row[STATES.includes(s) ? s : 'unknown'] += 1;
  }
  if (loose) rows.push(loose);
  for (const r of rows) {
    const monitored = r.up + r.down;
    r.rate = monitored ? Math.round((r.up / monitored) * 100) : null;
  }
  return rows;
}

/** 資料庫是否為「全新」：沒有樓層、房間、設備、NVR */
export const isEmptyDb = ({ floors = [], rooms = [], devices = [], nvrs = [] }) =>
  floors.length + rooms.length + devices.length + nvrs.length === 0;

/** 模組狀態表 → (名稱) => 是否可用 */
export function moduleOk(modules) {
  const map = new Map((modules ?? []).map((m) => [m.name, m.state === 'ok']));
  return (name) => map.get(name) === true;
}

/** 首次導覽的完成度（依實際資料判斷）。回傳每步 {id, done}；停用模組對應的步驟不列入 */
export function setupProgress({ floors = [], rooms = [], devices = [], plans = [], nvrs = [], categories = [] }, ok) {
  const coreIds = new Set(categories.filter((c) => c.tier === 'core').map((c) => c.id));
  const core = devices.filter((d) => coreIds.has(d.categoryId));
  const steps = [{ id: 'floor', done: floors.length > 0 }];
  if (ok('floorplan')) steps.push({ id: 'plan', done: plans.length > 0 });
  steps.push({ id: 'room', done: rooms.length > 0 });
  steps.push({ id: 'core', done: core.length > 0 });
  steps.push({ id: 'devices', done: devices.length - core.length > 0 });
  if (ok('nvr')) steps.push({ id: 'nvr', done: nvrs.length > 0 });
  return steps;
}

/** 導覽「略過」的步驟不算未完成 */
export const OPTIONAL_STEPS = new Set(['plan', 'nvr']);
