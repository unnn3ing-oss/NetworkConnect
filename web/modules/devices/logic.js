// devices 模組的純邏輯（不碰 DOM、不碰網路，方便單元測試）：
// 排序、上游候選、格式檢查、精靈狀態與 payload、各步驗證、樓層排序。

const collator = new Intl.Collator(['zh-Hant', 'en'], { numeric: true, sensitivity: 'base' });
const natural = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

// ---------------------------------------------------------------- 格式檢查

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
export const isIpv4 = (s) => IPV4.test(String(s ?? ''));
export const isMac = (s) => MAC.test(String(s ?? ''));

// ---------------------------------------------------------------- 狀態與排序

/** 顯示用狀態：偵測不可用（monitor 停用或失敗）→ {na:true}（畫面顯示「—」） */
export function statusFor(device, statusMap, available) {
  if (!available) return { na: true };
  const critical = Boolean(device.monitor?.critical);
  if (device.monitor?.method === 'none') return { na: false, state: 'disabled', critical };
  return { na: false, state: statusMap.get(device.id) ?? 'unknown', critical };
}

const STATE_RANK = { down: 1, unknown: 2, up: 3, disabled: 4 };
const statusRank = (s) => (s.state === 'down' && s.critical ? 0 : (STATE_RANK[s.state] ?? 2));

function ipKey(ip) {
  if (!isIpv4(ip)) return NaN;
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
}

/**
 * @param {object[]} devices
 * @param {'name'|'code'|'ip'|'status'} key
 * @param {'asc'|'desc'} dir
 * @param {{status?: Map<string, string>, available?: boolean}} [ctx]
 */
export function sortDevices(devices, key, dir = 'asc', { status = new Map(), available = false } = {}) {
  const sign = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => natural(a.name, b.name);
  // 空值（沒編號、沒 IP）不論升降冪都排最後
  const emptyLast = (va, vb, cmp) => {
    const ea = va === '' || Number.isNaN(va);
    const eb = vb === '' || Number.isNaN(vb);
    if (ea || eb) return ea === eb ? byName : ea ? () => 1 : () => -1;
    return cmp;
  };
  return [...devices].sort((a, b) => {
    switch (key) {
      case 'code': {
        const va = a.code ?? '';
        const vb = b.code ?? '';
        const f = emptyLast(va, vb, () => sign * natural(va, vb));
        return f(a, b) || byName(a, b);
      }
      case 'ip': {
        const va = ipKey(a.ip);
        const vb = ipKey(b.ip);
        const f = emptyLast(va, vb, () => sign * (va - vb));
        return f(a, b) || byName(a, b);
      }
      case 'status': {
        if (!available) return byName(a, b);
        const ra = statusRank(statusFor(a, status, true));
        const rb = statusRank(statusFor(b, status, true));
        return sign * (ra - rb) || byName(a, b);
      }
      default:
        return sign * natural(a.name, b.name);
    }
  });
}

// ---------------------------------------------------------------- 上游

/** 所有後代（直接與間接下游）的 id */
export function descendantIds(devices, id) {
  const children = new Map();
  for (const d of devices) {
    const up = d.uplink?.deviceId;
    if (!up) continue;
    if (!children.has(up)) children.set(up, []);
    children.get(up).push(d.id);
  }
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

/** 可選為上游的設備：排除自己與自己的所有後代（否則會形成迴圈，後端會回 422） */
export function uplinkCandidates(devices, selfId) {
  if (!selfId) return [...devices];
  const banned = new Set([selfId, ...descendantIds(devices, selfId)]);
  return devices.filter((d) => !banned.has(d.id));
}

// ---------------------------------------------------------------- 類別

const ICON_ALIASES = { pc: 'computer', mobile: 'phone', iot: 'smart-home' };

/** 類別的 icon（種子用 pc／mobile／iot）→ web/ui icons.js 的圖示名稱；未知退回 other */
export function categoryIconName(category, iconNames) {
  const raw = category?.icon;
  const name = ICON_ALIASES[raw] ?? raw;
  return iconNames.includes(name) ? name : 'other';
}

/** 依類別帶出偵測預設：方法取類別 defaultMonitor；核心層（數據機、路由器）預設為關鍵設備 */
export function monitorDefaults(category) {
  return { method: category?.defaultMonitor ?? 'icmp', critical: category?.tier === 'core' };
}

export function locationLabel(device, floors, rooms) {
  const floor = floors.find((f) => f.id === device.floorId);
  const room = rooms.find((r) => r.id === device.roomId);
  return [floor?.name, room?.name].filter(Boolean).join('／');
}

// ---------------------------------------------------------------- 精靈

export const WIZARD_STEP_IDS = Object.freeze(['category', 'basic', 'location', 'link', 'monitor', 'confirm']);

/** 新增設備的初始狀態（表單欄位一律是字串，送出時才轉型） */
export function newWizardState({ categories = [], categoryId = '', floorId = '', roomId = '' } = {}) {
  const category = categories.find((c) => c.id === categoryId);
  const m = monitorDefaults(category);
  return {
    id: null,
    categoryId,
    name: '', code: '', ip: '', mac: '', vendor: '', model: '', hostname: '', notes: '',
    floorId, roomId, groupIds: [],
    uplinkId: '', uplinkPort: '', localPort: '', medium: 'ethernet', speed: '',
    monitorMethod: m.method, monitorPort: '', monitorPath: '/', intervalSec: '60', critical: m.critical,
    monitorTouched: false,
  };
}

export function stateFromDevice(d) {
  return {
    id: d.id,
    categoryId: d.categoryId,
    name: d.name, code: d.code, ip: d.ip, mac: d.mac, vendor: d.vendor, model: d.model, hostname: d.hostname, notes: d.notes,
    floorId: d.floorId ?? '', roomId: d.roomId ?? '', groupIds: [...d.groupIds],
    uplinkId: d.uplink?.deviceId ?? '', uplinkPort: d.uplink?.port ?? '', localPort: d.uplink?.localPort ?? '',
    medium: d.uplink?.medium ?? 'ethernet', speed: d.uplink?.speed ?? '',
    monitorMethod: d.monitor.method,
    monitorPort: d.monitor.port == null ? '' : String(d.monitor.port),
    monitorPath: d.monitor.path,
    intervalSec: String(d.monitor.intervalSec),
    critical: d.monitor.critical,
    monitorTouched: true,
  };
}

/** 精靈狀態 → POST／PATCH 的設備欄位（api-inventory#DeviceCreate／DevicePatch） */
export function buildPayload(s) {
  const method = s.monitorMethod;
  const port = String(s.monitorPort ?? '').trim();
  return {
    code: s.code.trim(),
    name: s.name.trim(),
    categoryId: s.categoryId,
    floorId: s.floorId || null,
    roomId: s.roomId || null,
    groupIds: [...s.groupIds],
    ip: s.ip.trim(),
    mac: s.mac.trim(),
    hostname: s.hostname.trim(),
    vendor: s.vendor.trim(),
    model: s.model.trim(),
    uplink: s.uplinkId
      ? { deviceId: s.uplinkId, port: s.uplinkPort.trim(), localPort: s.localPort.trim(), medium: s.medium, speed: s.speed.trim() }
      : null,
    monitor: {
      method,
      port: (method === 'tcp' || method === 'http') && port ? Number(port) : null,
      path: method === 'http' ? s.monitorPath.trim() || '/' : '/',
      intervalSec: Number(s.intervalSec),
      critical: Boolean(s.critical),
    },
    notes: s.notes.trim(),
  };
}

const validPort = (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

/** 回傳錯誤訊息（字串）或 null */
export function validateStep(stepId, s) {
  switch (stepId) {
    case 'category':
      return s.categoryId ? null : '請選擇設備類別';
    case 'basic':
      if (!s.name.trim()) return '請輸入設備名稱';
      if (s.ip.trim() && !isIpv4(s.ip.trim())) return 'IP 位址格式不正確（例：192.168.1.10）';
      if (s.mac.trim() && !isMac(s.mac.trim())) return 'MAC 位址格式不正確（例：AA:BB:CC:DD:EE:FF）';
      return null;
    case 'location':
      return s.roomId && !s.floorId ? '選擇房間前請先選擇樓層' : null;
    case 'monitor': {
      const port = String(s.monitorPort ?? '').trim();
      if (s.monitorMethod === 'tcp' && !validPort(port)) return 'TCP 偵測必須填寫偵測埠（1–65535）';
      if (s.monitorMethod === 'http' && port && !validPort(port)) return '偵測埠必須是 1–65535 的整數';
      const interval = String(s.intervalSec).trim();
      if (!/^\d+$/.test(interval) || Number(interval) < 15 || Number(interval) > 86400) return '偵測間隔至少 15 秒（最多 86400 秒）';
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 樓層排序

/** 把 id 往前（-1）或往後（+1）移一格，回傳需要 PATCH 的 [{id, order}]（重新編號 1..n，只列有變動者，被移動者在前） */
export function reorderOrders(items, id, delta) {
  const sorted = items.map((x, i) => ({ ...x, i })).sort((a, b) => a.order - b.order || a.i - b.i);
  const from = sorted.findIndex((x) => x.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sorted.length) return [];
  const [moved] = sorted.splice(from, 1);
  sorted.splice(to, 0, moved);
  const changes = sorted.map((x, idx) => ({ id: x.id, order: idx + 1, was: x.order })).filter((x) => x.order !== x.was);
  changes.sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : a.order - b.order));
  return changes.map(({ id: cid, order }) => ({ id: cid, order }));
}
