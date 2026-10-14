// 產生 contracts/fixtures 內的範例資料（db.sample.json、status.sample.json、plan.sample.png）。
// 執行：node contracts/tools/generate-fixtures.js
// 產出是確定性的（無亂數、無現在時間），可重複執行；fixtures 提交進版本庫，此腳本只是來源說明。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'fixtures');
const seedCategories = JSON.parse(fs.readFileSync(path.join(here, '..', 'seed', 'categories.json'), 'utf8'));

const T0 = '2026-10-01T08:00:00.000Z';
const NOW = '2026-10-14T08:30:00.000Z';

// ---------- 樓層、房間、組別 ----------
const floors = [
  { id: 'flr_1', name: '1F', order: 1, createdAt: T0, updatedAt: T0 },
  { id: 'flr_2', name: '2F', order: 2, createdAt: T0, updatedAt: T0 },
  { id: 'flr_3', name: '3F', order: 3, createdAt: T0, updatedAt: T0 },
];
const rooms = [
  { id: 'room_living', floorId: 'flr_1', name: '客廳', order: 1 },
  { id: 'room_utility', floorId: 'flr_1', name: '弱電箱', order: 2 },
  { id: 'room_kitchen', floorId: 'flr_1', name: '廚房', order: 3 },
  { id: 'room_master', floorId: 'flr_2', name: '主臥', order: 1 },
  { id: 'room_kids', floorId: 'flr_2', name: '小孩房', order: 2 },
  { id: 'room_study', floorId: 'flr_2', name: '書房', order: 3 },
  { id: 'room_game', floorId: 'flr_3', name: '遊戲室', order: 1 },
  { id: 'room_guest', floorId: 'flr_3', name: '客房', order: 2 },
  { id: 'room_balcony', floorId: 'flr_3', name: '陽台', order: 3 },
];
const groups = [
  { id: 'grp_family', name: '家用', color: '#3b82f6' },
  { id: 'grp_iot', name: '智慧家電', color: '#22c55e' },
  { id: 'grp_security', name: '監控', color: '#ef4444' },
];
const roomFloor = Object.fromEntries(rooms.map((r) => [r.id, r.floorId]));

// ---------- 設備 ----------
const mon = (method = 'icmp', extra = {}) => ({ method, port: null, path: '/', intervalSec: 60, critical: false, ...extra });
const up = (to, port, localPort, medium, speed) => ({ deviceId: `dev_${to}`, port, localPort, medium, speed });
let macSeq = 0;
const mac = () => `02:00:5E:10:00:${(++macSeq).toString(16).toUpperCase().padStart(2, '0')}`;

function dev(key, code, name, categoryId, roomId, groupIds, ip, vendor, model, uplink, monitor, notes = '') {
  return {
    id: `dev_${key}`, code, name, categoryId,
    floorId: roomFloor[roomId], roomId, groupIds,
    ip, mac: mac(), hostname: '', vendor, model,
    uplink, monitor, notes, createdAt: T0, updatedAt: T0,
  };
}

const devices = [
  dev('modem', 'M01', '光纖數據機', 'cat_modem', 'room_utility', [], '192.168.100.1', '中華電信', 'ONT', null, mon('icmp', { critical: true }), 'ISP 提供'),
  dev('router', 'R01', '主路由器', 'cat_router', 'room_utility', ['grp_family'], '192.168.1.1', 'Zyxel', 'NBG7815', up('modem', 'LAN1', 'WAN', 'ethernet', '1G'), mon('icmp', { critical: true })),
  dev('swcore', 'S01', '核心交換器', 'cat_switch', 'room_utility', [], '192.168.1.2', 'TP-Link', 'TL-SG2210P', up('router', 'LAN2', 'P1', 'ethernet', '1G'), mon('icmp', { critical: true })),
  dev('poesw', 'S02', 'PoE 交換器', 'cat_poe_switch', 'room_utility', ['grp_security'], '192.168.1.3', 'TP-Link', 'TL-SG1210P', up('swcore', 'SFP1', 'SFP1', 'fiber', '10G'), mon('icmp', { critical: true }), '供電給 8 支攝影機與 2F 基地台'),
  dev('mesh1', 'W01', 'Mesh 主節點', 'cat_mesh', 'room_living', ['grp_family'], '192.168.1.4', 'Zyxel', 'WSQ60', up('router', 'LAN3', 'LAN1', 'ethernet', '1G'), mon('icmp', { critical: true })),
  dev('mesh2', 'W02', 'Mesh 節點 2F', 'cat_mesh', 'room_study', ['grp_family'], '192.168.1.5', 'Zyxel', 'WSQ60', up('mesh1', '', '', 'mesh', '866M'), mon()),
  dev('mesh3', 'W03', 'Mesh 節點 3F', 'cat_mesh', 'room_game', ['grp_family'], '192.168.1.6', 'Zyxel', 'WSQ60', up('mesh2', '', '', 'mesh', '866M'), mon()),
  dev('ap2', 'W04', '2F 無線基地台', 'cat_ap', 'room_master', ['grp_family'], '192.168.1.7', 'Ubiquiti', 'U6-Lite', up('poesw', 'P2', 'LAN', 'poe', '1G'), mon()),
  dev('nas', 'N01', '家用 NAS', 'cat_nas', 'room_utility', ['grp_family'], '192.168.1.10', 'Synology', 'DS224+', up('swcore', 'P3', 'LAN1', 'ethernet', '2.5G'), mon('tcp', { port: 5000 })),
  dev('nvr', 'V01', 'NVR 錄影主機', 'cat_nvr', 'room_utility', ['grp_security'], '192.168.1.20', 'Hikvision', 'DS-7608NI', up('swcore', 'P4', 'LAN', 'ethernet', '1G'), mon('http', { port: 80, critical: true })),
  dev('cam1', 'C01', '前門攝影機', 'cat_camera', 'room_living', ['grp_security'], '192.168.1.31', 'Hikvision', 'DS-2CD', up('poesw', 'P3', 'LAN', 'poe', '100M'), mon()),
  dev('cam2', 'C02', '後門攝影機', 'cat_camera', 'room_kitchen', ['grp_security'], '192.168.1.32', 'Hikvision', 'DS-2CD', up('poesw', 'P4', 'LAN', 'poe', '100M'), mon()),
  dev('cam3', 'C03', '車道攝影機', 'cat_camera', 'room_utility', ['grp_security'], '192.168.1.33', 'Hikvision', 'DS-2CD', up('poesw', 'P5', 'LAN', 'poe', '100M'), mon()),
  dev('cam4', 'C04', '客廳攝影機', 'cat_camera', 'room_living', ['grp_security'], '192.168.1.34', 'Hikvision', 'DS-2CD', up('poesw', 'P6', 'LAN', 'poe', '100M'), mon()),
  dev('cam5', 'C05', '2F 走廊攝影機', 'cat_camera', 'room_study', ['grp_security'], '192.168.1.35', 'Hikvision', 'DS-2CD', up('poesw', 'P7', 'LAN', 'poe', '100M'), mon()),
  dev('cam6', 'C06', '樓梯攝影機', 'cat_camera', 'room_kids', ['grp_security'], '192.168.1.36', 'Hikvision', 'DS-2CD', up('poesw', 'P8', 'LAN', 'poe', '100M'), mon()),
  dev('cam7', 'C07', '陽台攝影機', 'cat_camera', 'room_balcony', ['grp_security'], '192.168.1.37', 'Hikvision', 'DS-2CD', up('poesw', 'P9', 'LAN', 'poe', '100M'), mon()),
  dev('cam8', 'C08', '3F 走廊攝影機', 'cat_camera', 'room_game', ['grp_security'], '192.168.1.38', 'Hikvision', 'DS-2CD', up('poesw', 'P10', 'LAN', 'poe', '100M'), mon()),
  dev('tv1', 'T01', '客廳電視', 'cat_tv', 'room_living', ['grp_family'], '192.168.1.41', 'Sony', 'KD-55X80L', up('mesh1', '', '', 'wifi', '5G'), mon()),
  dev('pc1', 'P01', '書房電腦', 'cat_pc', 'room_study', ['grp_family'], '192.168.1.42', 'Apple', 'Mac mini', up('swcore', 'P5', 'LAN', 'ethernet', '1G'), mon()),
  dev('printer', 'PR1', '雷射印表機', 'cat_printer', 'room_study', ['grp_family'], '192.168.1.43', 'Brother', 'HL-L2375DW', up('mesh2', '', '', 'wifi', '2.4G'), mon('tcp', { port: 9100 })),
  dev('phone1', 'H01', '爸爸手機', 'cat_mobile', 'room_living', ['grp_family'], '', 'Apple', 'iPhone', up('mesh1', '', '', 'wifi', '5G'), mon('none')),
  dev('phone2', 'H02', '媽媽手機', 'cat_mobile', 'room_master', ['grp_family'], '', 'Samsung', 'Galaxy', up('ap2', '', '', 'wifi', '5G'), mon('none')),
  dev('tablet', 'H03', '小孩平板', 'cat_mobile', 'room_kids', ['grp_family'], '', 'Apple', 'iPad', up('ap2', '', '', 'wifi', '5G'), mon('none')),
  dev('speaker', 'I01', '智慧音箱', 'cat_iot', 'room_kitchen', ['grp_iot'], '192.168.1.61', 'Google', 'Nest Audio', up('mesh1', '', '', 'wifi', '2.4G'), mon()),
  dev('vacuum', 'I02', '掃地機器人', 'cat_iot', 'room_living', ['grp_iot'], '192.168.1.62', 'Roborock', 'S8', up('mesh1', '', '', 'wifi', '2.4G'), mon()),
  dev('plug', 'I03', '智慧插座', 'cat_iot', 'room_master', ['grp_iot'], '192.168.1.63', 'TP-Link', 'Tapo P110', up('ap2', '', '', 'wifi', '2.4G'), mon(), '剛加入，尚未偵測'),
  dev('console', 'G01', '遊戲主機', 'cat_other', 'room_game', ['grp_family'], '192.168.1.64', 'Nintendo', 'Switch', up('mesh3', 'LAN1', 'LAN', 'ethernet', '1G'), mon()),
  dev('stb', 'T02', '主臥機上盒', 'cat_tv', 'room_master', ['grp_family'], '192.168.1.44', 'Google', 'Chromecast', up('ap2', '', '', 'wifi', '5G'), mon()),
  dev('laptop', 'P02', '客房筆電', 'cat_pc', 'room_guest', [], '192.168.1.45', 'Lenovo', 'ThinkPad', up('mesh3', '', '', 'wifi', '5G'), mon()),
];

// ---------- NVR（8 頻道，對應 8 支攝影機） ----------
const nvrs = [{
  id: 'nvr_main', deviceId: 'dev_nvr', name: '家用 NVR', brand: 'hikvision',
  host: '192.168.1.20', port: 554, username: 'admin', channelCount: 8,
  streamMain: '1', streamSub: '2', urlTemplate: null,
  channels: Array.from({ length: 8 }, (_, i) => ({
    ch: i + 1, name: devices.find((d) => d.id === `dev_cam${i + 1}`).name.replace('攝影機', ''), deviceId: `dev_cam${i + 1}`, enabled: true,
  })),
}];

// ---------- 平面圖與落點（只有 1F 有圖） ----------
const plans = [{ floorId: 'flr_1', file: 'flr_1.png', mime: 'image/png', width: 800, height: 500, updatedAt: T0 }];
const place = (key, x, y) => ({ deviceId: `dev_${key}`, floorId: 'flr_1', x, y });
const placements = [
  place('modem', 0.08, 0.86), place('router', 0.14, 0.86), place('swcore', 0.2, 0.86), place('poesw', 0.26, 0.86),
  place('nas', 0.12, 0.74), place('nvr', 0.22, 0.74), place('mesh1', 0.3, 0.45), place('tv1', 0.1, 0.2),
  place('cam1', 0.45, 0.08), place('cam2', 0.92, 0.1), place('cam4', 0.38, 0.35),
  place('speaker', 0.65, 0.2), place('vacuum', 0.25, 0.3),
];

// ---------- 偵測歷史（只放兩台當範例） ----------
const mkSamples = (list) => list.map(([min, upv, rtt]) => ({ at: `2026-10-14T08:${String(min).padStart(2, '0')}:00.000Z`, up: upv, rttMs: rtt }));
const statusHistory = [
  { deviceId: 'dev_router', samples: mkSamples([[26, true, 1.2], [27, true, 1.1], [28, true, 1.4], [29, true, 1.0], [30, true, 1.3]]) },
  { deviceId: 'dev_printer', samples: mkSamples([[26, true, 12.5], [27, false, null], [28, false, null], [29, false, null], [30, false, null]]) },
];

const db = { floors, rooms, groups, categories: seedCategories, devices, plans, placements, statusHistory, nvrs };

// ---------- 狀態範例 ----------
const downSet = new Set(['dev_printer', 'dev_cam6']);
const unknownSet = new Set(['dev_plug', 'dev_console']);
const status = devices.map((d, i) => {
  if (d.monitor.method === 'none') {
    return { deviceId: d.id, state: 'disabled', rttMs: null, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0 };
  }
  if (d.id === 'dev_plug') {
    return { deviceId: d.id, state: 'unknown', rttMs: null, lastCheckAt: null, lastChangeAt: null, consecutiveFailures: 0 };
  }
  if (unknownSet.has(d.id)) {
    return { deviceId: d.id, state: 'unknown', rttMs: null, lastCheckAt: NOW, lastChangeAt: NOW, consecutiveFailures: 0, error: '偵測時發生錯誤（ping 指令無法執行）' };
  }
  if (downSet.has(d.id)) {
    return { deviceId: d.id, state: 'down', rttMs: null, lastCheckAt: NOW, lastChangeAt: '2026-10-14T08:27:00.000Z', consecutiveFailures: 4 };
  }
  return { deviceId: d.id, state: 'up', rttMs: Math.round((1 + (i % 7) * 2.3) * 10) / 10, lastCheckAt: NOW, lastChangeAt: T0, consecutiveFailures: 0 };
});

// ---------- 平面圖 PNG（不依賴任何套件） ----------
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const setPx = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
  };
  paint(setPx);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const fillRect = (set, x0, y0, x1, y1, col) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, col); };
const wall = (set, x0, y0, x1, y1) => fillRect(set, x0, y0, x1, y1, [70, 78, 92]);
const png = makePng(800, 500, (set) => {
  fillRect(set, 0, 0, 800, 500, [246, 248, 251]);
  fillRect(set, 40, 40, 420, 300, [232, 240, 252]); // 客廳
  fillRect(set, 420, 40, 760, 300, [236, 247, 238]); // 廚房
  fillRect(set, 40, 300, 300, 460, [250, 240, 228]); // 弱電箱
  fillRect(set, 300, 300, 760, 460, [242, 242, 246]); // 走道／其他
  // 外牆
  wall(set, 38, 38, 762, 42); wall(set, 38, 458, 762, 462); wall(set, 38, 38, 42, 462); wall(set, 758, 38, 762, 462);
  // 內牆（留出門口）
  wall(set, 418, 42, 422, 140); wall(set, 418, 190, 422, 300);
  wall(set, 42, 298, 160, 302); wall(set, 210, 298, 758, 302);
  wall(set, 298, 302, 302, 458);
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'db.sample.json'), JSON.stringify(db, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'status.sample.json'), JSON.stringify(status, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'plan.sample.png'), png);
console.log(`devices=${devices.length} png=${png.length}B`);
