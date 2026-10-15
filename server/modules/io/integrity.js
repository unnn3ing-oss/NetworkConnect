// 匯入前的資料完整性檢查（schema 之外的規則）：id／編號重複、外鍵、房間與樓層一致、上游迴圈、平面圖檔案。
// 一次回報所有錯誤（instancePath 以 /collections/<名稱>/<索引>/<欄位> 表示），讓使用者一次修完。
import { readSeed } from '../../../contracts/index.js';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UNSAFE_FILE_NAMES = new Set(['.', '..']);

/** 補上缺少的內建類別（已存在的不改動），維持「內建類別一定存在」 */
export function mergeBuiltinCategories(categories) {
  const have = new Set(categories.map((c) => c.id));
  const missing = readSeed('categories.json').filter((c) => !have.has(c.id));
  return [...categories, ...missing];
}

/**
 * @param {{collections: Record<string, object[]>, planFiles?: Record<string, string>}} data 已通過 api-io#Export schema
 * @returns {Array<{instancePath: string, message: string}>}
 */
export function checkIntegrity({ collections: c, planFiles = {} }) {
  const errors = [];
  const err = (instancePath, message) => errors.push({ instancePath, message });
  const ids = (list, key = 'id') => new Set((list ?? []).map((x) => x[key]));

  // ---- 重複 ----
  const uniqueBy = { floors: 'id', rooms: 'id', groups: 'id', categories: 'id', devices: 'id', nvrs: 'id', plans: 'floorId', placements: 'deviceId', statusHistory: 'deviceId' };
  for (const [name, key] of Object.entries(uniqueBy)) {
    const seen = new Set();
    (c[name] ?? []).forEach((doc, i) => {
      if (seen.has(doc[key])) err(`/collections/${name}/${i}`, `${key} 重複：${doc[key]}`);
      seen.add(doc[key]);
    });
  }
  const codes = new Map();
  c.devices.forEach((d, i) => {
    if (!d.code) return;
    if (codes.has(d.code)) err(`/collections/devices/${i}/code`, `設備編號重複：${d.code}`);
    codes.set(d.code, i);
  });

  const floorIds = ids(c.floors);
  const roomById = new Map(c.rooms.map((r) => [r.id, r]));
  const groupIds = ids(c.groups);
  const categoryIds = ids(c.categories);
  const deviceIds = ids(c.devices);

  // ---- 房間 ----
  c.rooms.forEach((r, i) => {
    if (!floorIds.has(r.floorId)) err(`/collections/rooms/${i}/floorId`, `樓層不存在：${r.floorId}`);
  });

  // ---- 設備 ----
  c.devices.forEach((d, i) => {
    const at = `/collections/devices/${i}`;
    if (!categoryIds.has(d.categoryId)) err(`${at}/categoryId`, `類別不存在：${d.categoryId}`);
    if (d.floorId && !floorIds.has(d.floorId)) err(`${at}/floorId`, `樓層不存在：${d.floorId}`);
    if (d.roomId) {
      const room = roomById.get(d.roomId);
      if (!room) err(`${at}/roomId`, `房間不存在：${d.roomId}`);
      else if (room.floorId !== d.floorId) err(`${at}/roomId`, `房間 ${d.roomId} 不屬於設備的樓層 ${d.floorId ?? '（未指定）'}`);
    }
    d.groupIds.forEach((g, j) => {
      if (!groupIds.has(g)) err(`${at}/groupIds/${j}`, `組別不存在：${g}`);
    });
    if (d.uplink) {
      if (d.uplink.deviceId === d.id) err(`${at}/uplink/deviceId`, '上游設備不可以是自己');
      else if (!deviceIds.has(d.uplink.deviceId)) err(`${at}/uplink/deviceId`, `上游設備不存在：${d.uplink.deviceId}`);
    }
  });

  // ---- 上游迴圈（每個迴圈只報一次）----
  const indexOf = new Map(c.devices.map((d, i) => [d.id, i]));
  const upOf = new Map(c.devices.map((d) => [d.id, d.uplink?.deviceId ?? null]));
  const done = new Set();
  for (const d of c.devices) {
    if (done.has(d.id)) continue;
    const trail = [];
    const onTrail = new Map();
    let cur = d.id;
    while (cur && upOf.has(cur) && !done.has(cur)) {
      if (onTrail.has(cur)) {
        const loop = trail.slice(onTrail.get(cur));
        // 自己連自己已在上面報過
        if (loop.length > 1) err(`/collections/devices/${indexOf.get(loop[0])}/uplink/deviceId`, `上游設備形成迴圈：${[...loop, loop[0]].join(' → ')}`);
        break;
      }
      onTrail.set(cur, trail.length);
      trail.push(cur);
      cur = upOf.get(cur);
    }
    for (const id of trail) done.add(id);
  }

  // ---- 平面圖、落點 ----
  const seenFiles = new Map();
  c.plans.forEach((p, i) => {
    const at = `/collections/plans/${i}`;
    // 兩個樓層共用同一個檔名：搬檔會在 store 已寫入後失敗，刪一層的平面圖也會刪掉另一層的圖
    if (seenFiles.has(p.file)) err(`${at}/file`, `圖檔名稱與 /collections/plans/${seenFiles.get(p.file)} 重複：${p.file}`);
    else seenFiles.set(p.file, i);
    if (!floorIds.has(p.floorId)) err(`${at}/floorId`, `樓層不存在：${p.floorId}`);
    if (UNSAFE_FILE_NAMES.has(p.file)) err(`${at}/file`, `圖檔名稱不合法：${p.file}`);
    else if (!Object.prototype.hasOwnProperty.call(planFiles, p.file)) err(`${at}/file`, `planFiles 缺少圖檔：${p.file}`);
  });
  for (const [file, b64] of Object.entries(planFiles)) {
    if (!BASE64.test(b64)) err(`/planFiles/${file}`, '不是合法的 base64');
  }
  c.placements.forEach((p, i) => {
    if (!deviceIds.has(p.deviceId)) err(`/collections/placements/${i}/deviceId`, `設備不存在：${p.deviceId}`);
    if (!floorIds.has(p.floorId)) err(`/collections/placements/${i}/floorId`, `樓層不存在：${p.floorId}`);
  });

  // ---- NVR、狀態歷史 ----
  c.nvrs.forEach((n, i) => {
    if (n.deviceId && !deviceIds.has(n.deviceId)) err(`/collections/nvrs/${i}/deviceId`, `設備不存在：${n.deviceId}`);
    n.channels.forEach((ch, j) => {
      if (ch.deviceId && !deviceIds.has(ch.deviceId)) err(`/collections/nvrs/${i}/channels/${j}/deviceId`, `設備不存在：${ch.deviceId}`);
    });
  });
  (c.statusHistory ?? []).forEach((h, i) => {
    if (!deviceIds.has(h.deviceId)) err(`/collections/statusHistory/${i}/deviceId`, `設備不存在：${h.deviceId}`);
  });

  return errors;
}
