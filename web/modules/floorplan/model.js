// 平面圖頁的資料整理（純函式，無 DOM）。
import { matchDevice } from '../../core/filters.js';

/** 本層「未放置」設備：屬於該樓層、符合全站篩選（樓層以目前顯示的樓層為準）、且沒有任何落點 */
export function unplacedDevices(devices, placements, floorId, filters = {}) {
  const placed = new Set(placements.map((p) => p.deviceId));
  return devices.filter((d) => !placed.has(d.id) && matchDevice(d, { ...filters, floorId }));
}

/** 該樓層的落點與對應設備（找不到設備的落點略過） */
export function placedOnFloor(devices, placements, floorId) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const out = [];
  for (const p of placements) {
    if (p.floorId !== floorId) continue;
    const device = byId.get(p.deviceId);
    if (device) out.push({ placement: p, device });
  }
  return out;
}

/** 無平面圖的格狀檢視：該樓層設備依房間分組（房間依樓層內 order、名稱；沒有房間的放最後） */
export function groupByRoom(devices, rooms, floorId, filters = {}) {
  const inFloor = rooms.filter((r) => r.floorId === floorId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  const list = devices.filter((d) => matchDevice(d, { ...filters, floorId }));
  const groups = inFloor.map((room) => ({ room, devices: list.filter((d) => d.roomId === room.id) }));
  const known = new Set(inFloor.map((r) => r.id));
  const loose = list.filter((d) => !d.roomId || !known.has(d.roomId));
  if (loose.length) groups.push({ room: null, devices: loose });
  return groups.filter((g) => g.devices.length > 0);
}

/** 目前要顯示的樓層：全站篩選的樓層優先，其次是第一層；篩選的樓層不存在時退回第一層 */
export function pickFloor(floors, filterFloorId) {
  if (filterFloorId && floors.some((f) => f.id === filterFloorId)) return filterFloorId;
  return floors[0]?.id ?? '';
}
