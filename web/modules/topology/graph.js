// 架構圖的純函式（不碰 DOM、不依賴 Cytoscape），可直接在 Node 測試。
// buildElements() 把設備清單轉成 Cytoscape elements；根節點判定、斷鏈警告、篩選淡化、樓層 compound 都在這裡。
import { matchDevice } from '../../core/filters.js';

export const UNASSIGNED_FLOOR = 'none';
export const floorNodeId = (floorId) => `floor:${floorId || UNASSIGNED_FLOOR}`;

/** 狀態 → class：離線且非關鍵＝灰（offline），離線且關鍵＝紅（down） */
export function statusClass(device, state) {
  const s = state ?? (device?.monitor?.method === 'none' ? 'disabled' : 'unknown');
  if (s === 'up') return 'st-up';
  if (s === 'down') return device?.monitor?.critical ? 'st-down' : 'st-offline';
  if (s === 'disabled') return 'st-disabled';
  return 'st-unknown';
}
export const STATUS_CLASSES = Object.freeze(['st-up', 'st-down', 'st-offline', 'st-unknown', 'st-disabled']);

const lookup = (map, id) => (map instanceof Map ? map.get(id) : map?.[id]);

/** 邊標籤：`port ↔ localPort`；兩邊都沒填就不顯示；PoE 前面加閃電 */
export function edgeLabel(uplink) {
  const port = (uplink.port ?? '').trim();
  const local = (uplink.localPort ?? '').trim();
  const text = port || local ? `${port || '–'} ↔ ${local || '–'}` : '';
  if (uplink.medium === 'poe') return text ? `⚡ ${text}` : '⚡';
  return text;
}

/** 不符合篩選的設備 id 集合（淡化用） */
export function fadedIds(devices, filters) {
  const out = new Set();
  if (!filters) return out;
  for (const d of devices) if (!matchDevice(d, filters)) out.add(d.id);
  return out;
}

/**
 * @param {object[]} devices
 * @param {object[]} categories
 * @param {object[]} floors
 * @param {Map<string,string>|Record<string,string>} statusMap deviceId → up|down|unknown|disabled
 * @param {{groupByFloor?: boolean, filters?: object}} [opts]
 * @returns {{elements: object[], roots: string[], warnings: {deviceId: string, type: 'missing-uplink'|'cycle', message: string}[]}}
 */
export function buildElements(devices, categories, floors, statusMap, { groupByFloor = false, filters } = {}) {
  const ids = new Set(devices.map((d) => d.id));
  const cats = new Map((categories ?? []).map((c) => [c.id, c]));
  const knownFloors = new Map((floors ?? []).map((f) => [f.id, f]));
  const faded = fadedIds(devices, filters);
  const warnings = [];

  // ---- 上游關係：有效的 uplink 才建邊；指向不存在設備（或自己）者視為根節點並警告 ----
  const parentOf = new Map(); // child → parent id
  const rootSet = new Set();
  for (const d of devices) {
    const up = d.uplink?.deviceId;
    if (!d.uplink || !up) {
      rootSet.add(d.id);
    } else if (up === d.id) {
      rootSet.add(d.id);
      warnings.push({ deviceId: d.id, type: 'cycle', message: `${d.name} 的上游是自己，已視為根節點` });
    } else if (!ids.has(up)) {
      rootSet.add(d.id);
      warnings.push({ deviceId: d.id, type: 'missing-uplink', message: `${d.name} 的上游設備不存在，已視為根節點` });
    } else {
      parentOf.set(d.id, up);
    }
  }
  // ---- 環（API 會擋，但匯入的舊資料可能有）：每個環挑第一台當根，避免整串設備消失在排版外 ----
  const reachable = new Set();
  const children = new Map();
  for (const [c, p] of parentOf) children.set(p, [...(children.get(p) ?? []), c]);
  const walk = (start) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      stack.push(...(children.get(id) ?? []));
    }
  };
  for (const r of rootSet) walk(r);
  for (const d of devices) {
    if (reachable.has(d.id)) continue;
    rootSet.add(d.id);
    parentOf.delete(d.id); // 斷開這一條，環就變成樹
    warnings.push({ deviceId: d.id, type: 'cycle', message: `${d.name} 位於上游迴圈中，已視為根節點` });
    walk(d.id);
  }
  const warned = new Set(warnings.map((w) => w.deviceId));

  // ---- 節點 ----
  const elements = [];
  if (groupByFloor) {
    const used = new Set(devices.map((d) => (knownFloors.has(d.floorId) ? d.floorId : UNASSIGNED_FLOOR)));
    const ordered = [...knownFloors.values()].filter((f) => used.has(f.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const f of ordered) elements.push({ group: 'nodes', data: { id: floorNodeId(f.id), label: f.name, floorId: f.id, isFloor: true }, classes: 'floor' });
    if (used.has(UNASSIGNED_FLOOR)) elements.push({ group: 'nodes', data: { id: floorNodeId(null), label: '未指定樓層', floorId: '', isFloor: true }, classes: 'floor' });
  }
  for (const d of devices) {
    const cat = cats.get(d.categoryId);
    const classes = [statusClass(d, lookup(statusMap, d.id)), `tier-${cat?.tier ?? 'endpoint'}`];
    if (rootSet.has(d.id)) classes.push('root');
    if (warned.has(d.id)) classes.push('orphan');
    if (faded.has(d.id)) classes.push('faded');
    const data = { id: d.id, label: d.name || d.code || d.id, code: d.code ?? '', categoryId: d.categoryId, icon: cat?.icon ?? 'other', tier: cat?.tier ?? 'endpoint', floorId: d.floorId ?? '' };
    if (groupByFloor) data.parent = floorNodeId(knownFloors.has(d.floorId) ? d.floorId : null);
    elements.push({ group: 'nodes', data, classes: classes.join(' ') });
  }
  // ---- 邊：source＝上游、target＝本機；順序與設備清單一致 ----
  for (const d of devices) {
    const up = parentOf.get(d.id);
    if (!up) continue;
    const medium = d.uplink.medium || 'other';
    const classes = [`m-${medium}`];
    if (faded.has(d.id) || faded.has(up)) classes.push('faded');
    elements.push({
      group: 'edges',
      data: { id: `e:${d.id}`, source: up, target: d.id, medium, label: edgeLabel(d.uplink), port: d.uplink.port ?? '', localPort: d.uplink.localPort ?? '', speed: d.uplink.speed ?? '' },
      classes: classes.join(' '),
    });
  }
  return { elements, roots: devices.filter((d) => rootSet.has(d.id)).map((d) => d.id), warnings };
}
