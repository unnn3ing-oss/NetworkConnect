// inventory 的純規則（不碰 store／HTTP，方便單元測試）：
// 上游迴圈偵測、下游計算、自然排序、設備篩選、補齊預設值。
const collator = new Intl.Collator(['zh-Hant', 'en'], { numeric: true, sensitivity: 'base' });

/** 自然排序比較：R2 < R10，不分大小寫 */
export const naturalCompare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

/**
 * 若把 `id` 的上游設為 `targetId`，會不會形成迴圈？
 * 會 → 回傳迴圈路徑（例：[A, C, B, A]：A 的上游是 C，C 的上游是 B，B 的上游又是 A）；不會 → null。
 * @param {Map<string, {id: string, uplink: {deviceId: string}|null}>} devicesById
 */
export function findUplinkCycle(devicesById, id, targetId) {
  if (!targetId) return null;
  if (targetId === id) return [id, id];
  const path = [id, targetId];
  const seen = new Set([id]);
  let cur = targetId;
  while (cur) {
    if (seen.has(cur)) return null; // 資料本身有別處的迴圈，與 id 無關：不在這裡處理
    seen.add(cur);
    const next = devicesById.get(cur)?.uplink?.deviceId ?? null;
    if (next === id) {
      path.push(id);
      return path;
    }
    if (next) path.push(next);
    cur = next;
  }
  return null;
}

/** 以 id 為上游的設備 id；directOnly=false 時包含所有後代 */
export function downstreamIds(devices, id, { directOnly = false } = {}) {
  const children = new Map();
  for (const d of devices) {
    const up = d.uplink?.deviceId;
    if (!up) continue;
    if (!children.has(up)) children.set(up, []);
    children.get(up).push(d.id);
  }
  if (directOnly) return [...(children.get(id) ?? [])];
  const out = [];
  const seen = new Set([id]);
  const queue = [...(children.get(id) ?? [])];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(children.get(cur) ?? []));
  }
  return out;
}

/** 有編號者依編號自然排序在前；沒有編號者依名稱排序在後 */
export function sortDevices(devices) {
  return [...devices].sort((a, b) => {
    const ac = a.code ? 0 : 1;
    const bc = b.code ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return ac === 0 ? naturalCompare(a.code, b.code) || naturalCompare(a.name, b.name) : naturalCompare(a.name, b.name);
  });
}

const SEARCH_FIELDS = ['code', 'name', 'ip', 'mac', 'hostname', 'vendor', 'model', 'notes'];
const stripMac = (s) => String(s ?? '').toLowerCase().replace(/[:-]/g, '');

/** GET /api/devices 的篩選：floorId、roomId、groupId、categoryId 為相等比對，q 為不分大小寫子字串（MAC 可省略分隔符號） */
export function filterDevices(devices, { floorId, roomId, groupId, categoryId, q } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  const macNeedle = stripMac(needle);
  return devices.filter((d) => {
    if (floorId && d.floorId !== floorId) return false;
    if (roomId && d.roomId !== roomId) return false;
    if (groupId && !(d.groupIds ?? []).includes(groupId)) return false;
    if (categoryId && d.categoryId !== categoryId) return false;
    if (needle) {
      const hit = SEARCH_FIELDS.some((k) => String(d[k] ?? '').toLowerCase().includes(needle));
      if (!hit && !(macNeedle.length >= 2 && stripMac(d.mac).includes(macNeedle))) return false;
    }
    return true;
  });
}

export const MONITOR_DEFAULTS = Object.freeze({ port: null, path: '/', intervalSec: 60, critical: false });
export const UPLINK_DEFAULTS = Object.freeze({ port: '', localPort: '', speed: '' });

/** 偵測設定補齊：method 缺省時取類別的 defaultMonitor；intervalSec 缺省時取設定頁的預設偵測間隔 */
export function fillMonitor(monitor, category, defaultIntervalSec = MONITOR_DEFAULTS.intervalSec) {
  return { method: category?.defaultMonitor ?? 'icmp', ...MONITOR_DEFAULTS, intervalSec: defaultIntervalSec, ...(monitor ?? {}) };
}

export function fillUplink(uplink) {
  return uplink ? { ...UPLINK_DEFAULTS, ...uplink } : null;
}

/** 由使用者輸入（DeviceCreate）建出完整的儲存紀錄 */
export function buildDevice(input, { id, category, now, defaultIntervalSec }) {
  return {
    id,
    code: input.code ?? '',
    name: input.name,
    categoryId: input.categoryId,
    floorId: input.floorId ?? null,
    roomId: input.roomId ?? null,
    groupIds: [...(input.groupIds ?? [])],
    ip: input.ip ?? '',
    mac: input.mac ?? '',
    hostname: input.hostname ?? '',
    vendor: input.vendor ?? '',
    model: input.model ?? '',
    uplink: fillUplink(input.uplink),
    monitor: fillMonitor(input.monitor, category, defaultIntervalSec),
    notes: input.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}
