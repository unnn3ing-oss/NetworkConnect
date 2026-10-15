// CSV 匯入（相容舊 Google Sheet「設備清單」）：解析器、類別關鍵字、連線方式，以及整體計畫 planCsvImport。
// 全部是純函式：輸入文字與現有資料，輸出「要新增的紀錄」與報告；寫入由 index.js 負責。
import { validation } from '../../core/errors.js';

// ---------------------------------------------------------------- 解析

/** RFC 4180 解析：BOM、CRLF／LF、引號欄位（含逗號、換行、"" 跳脫）。保留全空白列（列號才對得上）。 */
export function parseCsv(input) {
  let text = String(input ?? '');
  if (text.includes('\u0000')) throw validation('檔案不是文字格式的 CSV');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = [];
  let record = [];
  let field = '';
  let quoted = false; // 目前在引號內
  let fieldStart = true; // 目前位置是欄位開頭（引號只有在這裡才開始引號模式）
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = '';
    fieldStart = true;
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      pushRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      fieldStart = false;
      i++;
    }
  }
  if (quoted) throw validation('CSV 格式錯誤：有引號沒有結尾');
  if (field !== '' || record.length > 0) pushRecord();
  return records;
}

// ---------------------------------------------------------------- 類別與連線方式

// 依序比對，先符合者勝出（順序有意義：PoE 交換器要在交換器之前、Mesh 要在路由器之前）。
const CATEGORY_RULES = [
  [/poe.*(交換|switch|hub)|(交換|switch|hub).*poe/i, 'cat_poe_switch'],
  [/mesh/i, 'cat_mesh'],
  [/數據機|modem|(^|[^a-z0-9])ont([^a-z0-9]|$)|小烏龜|光纖機/i, 'cat_modem'],
  [/路由|router|gateway|閘道|防火牆|firewall|分享器/i, 'cat_router'],
  [/基地台|access\s*point|(^|[^a-z0-9])ap([^a-z0-9]|$)/i, 'cat_ap'],
  [/交換|switch|hub|集線/i, 'cat_switch'],
  [/nvr|dvr|錄影主機|錄影機|監控主機/i, 'cat_nvr'],
  [/攝影|攝像|camera|ip\s*cam|(^|[^a-z0-9])cam([^a-z0-9]|$)|監視|cctv/i, 'cat_camera'],
  [/(^|[^a-z0-9])nas([^a-z0-9]|$)|網路硬碟|儲存|synology|qnap/i, 'cat_nas'],
  [/印表|列印|printer|複合機|事務機/i, 'cat_printer'],
  [/電視|(^|[^a-z0-9])tv([^a-z0-9]|$)|機上盒|chromecast|apple\s*tv|投影/i, 'cat_tv'],
  [/手機|平板|phone|ipad|tablet|行動裝置/i, 'cat_mobile'],
  [/電腦|筆電|筆記型|桌機|桌上型|(^|[^a-z0-9])pc([^a-z0-9]|$)|laptop|desktop|notebook|macbook|imac|mac\s*mini|workstation|伺服器|server/i, 'cat_pc'],
  [/智慧|智能|iot|smart|燈|插座|音箱|音響|掃地|感應|sensor|冷氣|家電|alexa|homepod|google\s*home|門鈴/i, 'cat_iot'],
  [/^\s*poe\s*$/i, 'cat_poe_switch'],
];

/**
 * 類別欄文字 → 類別 id。先比對現有類別（含自訂）的名稱或 id，再套關鍵字規則，最後歸「其他」。
 * @returns {{categoryId: string, matched: boolean}} matched=false 表示對不到（歸入其他，要列入報告）
 */
export function matchCategory(text, categories) {
  const t = String(text ?? '').trim();
  if (!t) return { categoryId: 'cat_other', matched: false };
  const lower = t.toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === lower || c.id === lower);
  if (exact) return { categoryId: exact.id, matched: true };
  const ids = new Set(categories.map((c) => c.id));
  for (const [re, id] of CATEGORY_RULES) {
    if (ids.has(id) && re.test(t)) return { categoryId: id, matched: true };
  }
  return { categoryId: 'cat_other', matched: false };
}

/** 連線方式文字 → medium（有線→ethernet、Wi-Fi／無線→wifi、Mesh→mesh、PoE→poe、光纖→fiber，其餘 other） */
export function mediumFromText(text) {
  const t = String(text ?? '').trim();
  if (/poe/i.test(t)) return 'poe';
  if (/mesh/i.test(t)) return 'mesh';
  if (/光纖|fib(er|re)/i.test(t)) return 'fiber';
  if (/wi-?\s?fi|無線|wireless|wlan/i.test(t)) return 'wifi';
  if (/有線|ethernet|網路線|(^|[^a-z])lan([^a-z]|$)|rj-?45/i.test(t)) return 'ethernet';
  return 'other';
}

// ---------------------------------------------------------------- 計畫

const COLUMN_LABELS = {
  code: '編號',
  name: '名稱',
  category: '類別',
  uplinkCode: '上游編號',
  room: '位置',
  medium: '連線方式',
  ip: 'ip',
  mac: 'mac',
  speed: '速率',
  notes: '說明',
  floor: '分區',
  tier: '階層',
  locator: '定位編號',
  uplinkPort: '上游端口',
  localPort: '下游端口',
};
const normHeader = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function normalizeMac(raw) {
  const hex = raw.replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * @param {string} text CSV 文字
 * @param {{floors: object[], rooms: object[], devices: object[], categories: object[]}} existing 現有資料（唯讀）
 * @param {{now: string, newId: (prefix: string) => string}} opts
 * @returns {{report: {created: {devices, floors, rooms}, skipped, unmatchedCategories, warnings}, floors: object[], rooms: object[], devices: object[]}}
 *   floors／rooms／devices 是「要新增」的完整紀錄（已符合 schema）
 */
export function planCsvImport(text, existing, { now, newId, defaultIntervalSec = 60 }) {
  const records = parseCsv(text);
  if (records.length === 0) throw validation('檔案是空的');

  // 標題列 → 欄位索引
  const header = records[0].map(normHeader);
  const col = {};
  for (const [key, label] of Object.entries(COLUMN_LABELS)) {
    const idx = header.indexOf(normHeader(label));
    if (idx >= 0) col[key] = idx;
  }
  if (col.name === undefined) throw validation('CSV 缺少必要欄位：名稱（標題列必須存在）');
  const cell = (rec, key) => (col[key] === undefined ? '' : String(rec[col[key]] ?? '').trim());
  const cellRaw = (rec, key) => (col[key] === undefined ? '' : String(rec[col[key]] ?? ''));

  const skipped = [];
  const unmatchedCategories = [];
  const warnings = [];
  const newFloors = [];
  const newRooms = [];
  const accepted = []; // {row, device, uplinkCode}

  const allFloors = () => [...existing.floors, ...newFloors];
  const allRooms = () => [...existing.rooms, ...newRooms];
  const existingCodes = new Set(existing.devices.map((d) => d.code).filter(Boolean));
  const seenCodes = new Set();

  const findOrCreateFloor = (name) => {
    const found = allFloors().find((f) => sameName(f.name, name));
    if (found) return found;
    const order = allFloors().reduce((m, f) => Math.max(m, f.order), 0) + 1;
    const floor = { id: newId('flr'), name, order, createdAt: now, updatedAt: now };
    newFloors.push(floor);
    return floor;
  };
  const findOrCreateRoom = (floorId, name) => {
    const found = allRooms().find((r) => r.floorId === floorId && sameName(r.name, name));
    if (found) return found;
    const order = allRooms().filter((r) => r.floorId === floorId).reduce((m, r) => Math.max(m, r.order), 0) + 1;
    const room = { id: newId('room'), floorId, name, order };
    newRooms.push(room);
    return room;
  };

  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    const row = i + 1;
    if (rec.every((c) => String(c).trim() === '')) continue;

    const name = cell(rec, 'name');
    if (!name) {
      skipped.push({ row, reason: '缺少名稱' });
      continue;
    }
    const code = cell(rec, 'code');
    if (code && existingCodes.has(code)) {
      skipped.push({ row, reason: `編號 ${code} 已存在` });
      continue;
    }
    if (code && seenCodes.has(code)) {
      skipped.push({ row, reason: `編號 ${code} 在檔案中重複` });
      continue;
    }
    const ip = cell(rec, 'ip');
    if (ip && !IPV4.test(ip)) {
      skipped.push({ row, reason: `IP 格式不正確：${ip}` });
      continue;
    }
    const macRaw = cell(rec, 'mac');
    const mac = macRaw ? normalizeMac(macRaw) : '';
    if (mac === null) {
      skipped.push({ row, reason: `MAC 格式不正確：${macRaw}` });
      continue;
    }

    // ---- 這一列確定會匯入 ----
    if (code) seenCodes.add(code);
    const categoryText = cell(rec, 'category');
    const { categoryId, matched } = matchCategory(categoryText, existing.categories);
    if (!matched) unmatchedCategories.push({ row, name, category: categoryText });
    const category = existing.categories.find((c) => c.id === categoryId);

    let floorId = null;
    let roomId = null;
    const floorName = cell(rec, 'floor');
    const roomName = cell(rec, 'room');
    if (floorName) {
      const floor = findOrCreateFloor(floorName);
      floorId = floor.id;
      if (roomName) roomId = findOrCreateRoom(floor.id, roomName).id;
    } else if (roomName) {
      const candidates = allRooms().filter((r) => sameName(r.name, roomName));
      if (candidates.length === 1) {
        roomId = candidates[0].id;
        floorId = candidates[0].floorId;
      } else {
        warnings.push(`第 ${row} 列：沒有填分區，位置「${roomName}」無法判斷屬於哪個樓層，已略過位置`);
      }
    }

    let notes = cellRaw(rec, 'notes').trim();
    const locator = cell(rec, 'locator');
    if (locator) notes = notes ? `${notes}\n定位編號：${locator}` : `定位編號：${locator}`;

    accepted.push({
      row,
      uplinkCode: cell(rec, 'uplinkCode'),
      uplinkExtra: { port: cell(rec, 'uplinkPort'), localPort: cell(rec, 'localPort'), medium: mediumFromText(cell(rec, 'medium')), speed: cell(rec, 'speed') },
      device: {
        id: newId('dev'),
        code,
        name,
        categoryId,
        floorId,
        roomId,
        groupIds: [],
        ip,
        mac,
        hostname: '',
        vendor: '',
        model: '',
        uplink: null,
        monitor: { method: ip ? (category?.defaultMonitor ?? 'icmp') : 'none', port: null, path: '/', intervalSec: defaultIntervalSec, critical: false },
        notes: notes.slice(0, 2000),
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  // ---- 第二階段：解析上游（上游可能在後面的列，所以等全部建好再接）----
  const byId = new Map(existing.devices.map((d) => [d.id, d]));
  const byCode = new Map(existing.devices.filter((d) => d.code).map((d) => [d.code, d]));
  for (const a of accepted) {
    byId.set(a.device.id, a.device);
    if (a.device.code) byCode.set(a.device.code, a.device);
  }
  for (const { row, device, uplinkCode, uplinkExtra } of accepted) {
    if (!uplinkCode) continue;
    const up = byCode.get(uplinkCode);
    if (!up) {
      warnings.push(`第 ${row} 列：找不到上游編號「${uplinkCode}」，已設為根節點`);
      continue;
    }
    if (up.id === device.id) {
      warnings.push(`第 ${row} 列：上游編號「${uplinkCode}」是自己，已設為根節點`);
      continue;
    }
    if (wouldLoop(byId, device.id, up.id)) {
      warnings.push(`第 ${row} 列：上游編號「${uplinkCode}」會形成迴圈，已設為根節點`);
      continue;
    }
    device.uplink = { deviceId: up.id, ...uplinkExtra };
  }

  return {
    report: {
      created: { devices: accepted.length, floors: newFloors.length, rooms: newRooms.length },
      skipped,
      unmatchedCategories,
      warnings,
    },
    floors: newFloors,
    rooms: newRooms,
    devices: accepted.map((a) => a.device),
  };
}

/** 把 id 的上游設為 targetId 會不會繞回 id */
function wouldLoop(byId, id, targetId) {
  const seen = new Set();
  for (let cur = targetId; cur && !seen.has(cur); cur = byId.get(cur)?.uplink?.deviceId) {
    if (cur === id) return true;
    seen.add(cur);
  }
  return false;
}
