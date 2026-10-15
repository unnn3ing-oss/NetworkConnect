// devices 前端純邏輯：排序、上游候選、精靈狀態與 payload、各步驗證、樓層排序
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortDevices,
  descendantIds,
  uplinkCandidates,
  isIpv4,
  isMac,
  parseIpWithPort,
  applyIpWithPort,
  categoryIconName,
  monitorDefaults,
  newWizardState,
  stateFromDevice,
  buildPayload,
  validateStep,
  locationLabel,
  statusFor,
  reorderOrders,
  WIZARD_STEP_IDS,
} from '../../../web/modules/devices/logic.js';

const dev = (id, extra = {}) => ({ id, code: '', name: id, ip: '', uplink: null, ...extra });
const up = (deviceId) => ({ deviceId, port: '', localPort: '', medium: 'ethernet', speed: '' });

describe('sortDevices', () => {
  const list = [
    dev('d1', { name: '路由器', code: 'R10', ip: '192.168.1.10' }),
    dev('d2', { name: '交換器', code: 'R2', ip: '192.168.1.9' }),
    dev('d3', { name: '攝影機', code: '', ip: '' }),
    dev('d4', { name: '印表機', code: 'R3', ip: '10.0.0.5' }),
  ];
  const ids = (a) => a.map((d) => d.id);

  test('編號：自然排序，沒有編號的排最後（升冪降冪皆然）', () => {
    assert.deepEqual(ids(sortDevices(list, 'code', 'asc')), ['d2', 'd4', 'd1', 'd3']);
    assert.deepEqual(ids(sortDevices(list, 'code', 'desc')), ['d1', 'd4', 'd2', 'd3']);
  });

  test('IP：依數值排序（9 < 10），沒有 IP 排最後', () => {
    assert.deepEqual(ids(sortDevices(list, 'ip', 'asc')), ['d4', 'd2', 'd1', 'd3']);
    assert.deepEqual(ids(sortDevices(list, 'ip', 'desc')), ['d1', 'd2', 'd4', 'd3']);
  });

  test('名稱：不改動原陣列', () => {
    const copy = [...list];
    const sorted = sortDevices(list, 'name', 'asc');
    assert.deepEqual(list, copy);
    assert.equal(sorted.length, 4);
  });

  test('狀態：關鍵離線 < 離線 < 未知 < 正常 < 未偵測；同狀態依名稱', () => {
    const items = [
      dev('a', { name: 'a', monitor: { critical: false } }),
      dev('b', { name: 'b', monitor: { critical: true } }),
      dev('c', { name: 'c', monitor: { critical: false } }),
      dev('d', { name: 'd', monitor: { critical: false } }),
      dev('e', { name: 'e', monitor: { critical: false } }),
    ];
    const status = new Map([['a', 'up'], ['b', 'down'], ['c', 'down'], ['d', 'unknown'], ['e', 'disabled']]);
    const s = { status, available: true };
    assert.deepEqual(ids(sortDevices(items, 'status', 'asc', s)), ['b', 'c', 'd', 'a', 'e']);
    assert.deepEqual(ids(sortDevices(items, 'status', 'desc', s)), ['e', 'a', 'd', 'c', 'b']);
  });

  test('偵測不可用時，狀態排序退回名稱排序', () => {
    const items = [dev('b', { name: 'b' }), dev('a', { name: 'a' })];
    assert.deepEqual(ids(sortDevices(items, 'status', 'asc', { status: new Map(), available: false })), ['a', 'b']);
  });
});

describe('上游候選', () => {
  const list = [dev('root'), dev('sw', { uplink: up('root') }), dev('ap', { uplink: up('sw') }), dev('other')];
  test('descendantIds：所有後代', () => {
    assert.deepEqual(descendantIds(list, 'root').sort(), ['ap', 'sw']);
    assert.deepEqual(descendantIds(list, 'ap'), []);
  });
  test('uplinkCandidates：排除自己與所有後代（避免迴圈）', () => {
    assert.deepEqual(uplinkCandidates(list, 'sw').map((d) => d.id).sort(), ['other', 'root']);
    assert.deepEqual(uplinkCandidates(list, null).map((d) => d.id).sort(), ['ap', 'other', 'root', 'sw']);
  });
  test('資料已有迴圈時不會無窮迴圈', () => {
    const loop = [dev('x', { uplink: up('y') }), dev('y', { uplink: up('x') })];
    assert.deepEqual(descendantIds(loop, 'x').sort(), ['y']);
  });
});

describe('格式檢查', () => {
  test('isIpv4', () => {
    for (const ok of ['192.168.1.1', '0.0.0.0', '255.255.255.255']) assert.equal(isIpv4(ok), true, ok);
    for (const bad of ['', '1.2.3', '256.1.1.1', 'a.b.c.d', '1.2.3.4.5', ' 1.2.3.4']) assert.equal(isIpv4(bad), false, bad);
  });
  test('isMac：冒號或連字號', () => {
    assert.equal(isMac('AA:BB:CC:DD:EE:FF'), true);
    assert.equal(isMac('aa-bb-cc-dd-ee-ff'), true);
    assert.equal(isMac('AABBCCDDEEFF'), false);
    assert.equal(isMac('AA:BB:CC'), false);
  });
});

describe('類別圖示與偵測預設', () => {
  const names = ['modem', 'router', 'computer', 'phone', 'smart-home', 'other', 'camera'];
  test('種子的圖示名稱對應到 UI 的圖示名稱；未知退回 other', () => {
    assert.equal(categoryIconName({ icon: 'pc' }, names), 'computer');
    assert.equal(categoryIconName({ icon: 'mobile' }, names), 'phone');
    assert.equal(categoryIconName({ icon: 'iot' }, names), 'smart-home');
    assert.equal(categoryIconName({ icon: 'camera' }, names), 'camera');
    assert.equal(categoryIconName({ icon: 'nonsense' }, names), 'other');
    assert.equal(categoryIconName(undefined, names), 'other');
  });
  test('monitorDefaults：方法取類別預設；核心層（數據機、路由器）預設為關鍵設備', () => {
    assert.deepEqual(monitorDefaults({ defaultMonitor: 'none', tier: 'endpoint' }), { method: 'none', critical: false });
    assert.deepEqual(monitorDefaults({ defaultMonitor: 'icmp', tier: 'core' }), { method: 'icmp', critical: true });
    assert.deepEqual(monitorDefaults(undefined), { method: 'icmp', critical: false });
  });
});

describe('精靈狀態與 payload', () => {
  const router = { id: 'cat_router', defaultMonitor: 'icmp', tier: 'core' };

  test('newWizardState：預設值', () => {
    const s = newWizardState({ categories: [router], floorId: 'flr_1' });
    assert.equal(s.categoryId, '');
    assert.equal(s.floorId, 'flr_1');
    assert.equal(s.medium, 'ethernet');
    assert.equal(s.intervalSec, '60');
    assert.equal(s.monitorMethod, 'icmp');
  });

  test('stateFromDevice → buildPayload 往返不失真', () => {
    const device = {
      id: 'dev_1', code: 'R01', name: '主路由器', categoryId: 'cat_router', floorId: 'flr_1', roomId: 'room_a', groupIds: ['grp_x'],
      ip: '192.168.1.1', mac: 'AA:BB:CC:DD:EE:FF', hostname: 'gw', vendor: 'Zyxel', model: 'X1', notes: '備註',
      uplink: { deviceId: 'dev_m', port: 'LAN1', localPort: 'WAN', medium: 'fiber', speed: '1G' },
      monitor: { method: 'http', port: 8080, path: '/status', intervalSec: 30, critical: true },
      createdAt: 'x', updatedAt: 'x',
    };
    const payload = buildPayload(stateFromDevice(device));
    const { id, createdAt, updatedAt, ...editable } = device;
    assert.deepEqual(payload, editable);
  });

  test('buildPayload：沒有上游 → uplink null；icmp 不帶 port；字串數字轉數字；空白修剪', () => {
    const s = newWizardState({ categories: [router] });
    Object.assign(s, { categoryId: 'cat_router', name: '  新設備 ', ip: ' 192.168.1.2 ', monitorMethod: 'icmp', monitorPort: '80', intervalSec: '45' });
    const p = buildPayload(s);
    assert.equal(p.name, '新設備');
    assert.equal(p.ip, '192.168.1.2');
    assert.equal(p.uplink, null);
    assert.deepEqual(p.monitor, { method: 'icmp', port: null, path: '/', intervalSec: 45, critical: s.critical });
    assert.equal(p.floorId, null);
    assert.equal(p.roomId, null);
  });

  test('buildPayload：tcp 帶埠；http 埠可留空（null）', () => {
    const s = newWizardState({ categories: [router] });
    Object.assign(s, { categoryId: 'cat_router', name: 'x', monitorMethod: 'tcp', monitorPort: '22' });
    assert.equal(buildPayload(s).monitor.port, 22);
    Object.assign(s, { monitorMethod: 'http', monitorPort: '', monitorPath: '' });
    assert.deepEqual({ port: buildPayload(s).monitor.port, path: buildPayload(s).monitor.path }, { port: null, path: '/' });
  });
});

describe('validateStep', () => {
  const base = () => ({ categoryId: 'cat_router', name: '設備', ip: '', mac: '', floorId: '', roomId: '', uplinkId: '', monitorMethod: 'icmp', monitorPort: '', intervalSec: '60' });
  test('步驟順序', () => {
    assert.deepEqual(WIZARD_STEP_IDS, ['category', 'basic', 'location', 'link', 'monitor', 'confirm']);
  });
  test('類別必選', () => {
    assert.match(validateStep('category', { ...base(), categoryId: '' }), /類別/);
    assert.equal(validateStep('category', base()), null);
  });
  test('基本資料：名稱必填、IP 與 MAC 格式', () => {
    assert.match(validateStep('basic', { ...base(), name: '  ' }), /名稱/);
    assert.match(validateStep('basic', { ...base(), ip: '1.2.3' }), /IP/);
    assert.match(validateStep('basic', { ...base(), mac: 'zz' }), /MAC/);
    assert.equal(validateStep('basic', { ...base(), ip: '192.168.1.1', mac: 'AA:BB:CC:DD:EE:FF' }), null);
  });
  test('位置：選了房間必須有樓層', () => {
    assert.match(validateStep('location', { ...base(), roomId: 'room_a' }), /樓層/);
    assert.equal(validateStep('location', { ...base(), floorId: 'flr_1', roomId: 'room_a' }), null);
  });
  test('偵測：tcp 必須有埠；間隔至少 15 秒', () => {
    assert.match(validateStep('monitor', { ...base(), monitorMethod: 'tcp' }), /埠/);
    assert.match(validateStep('monitor', { ...base(), monitorMethod: 'tcp', monitorPort: '70000' }), /埠/);
    assert.match(validateStep('monitor', { ...base(), intervalSec: '10' }), /15/);
    assert.match(validateStep('monitor', { ...base(), intervalSec: 'abc' }), /15/);
    assert.equal(validateStep('monitor', { ...base(), monitorMethod: 'none', intervalSec: '60' }), null);
    assert.equal(validateStep('monitor', { ...base(), monitorMethod: 'tcp', monitorPort: '22' }), null);
  });
  test('連線、確認步驟不擋', () => {
    assert.equal(validateStep('link', base()), null);
    assert.equal(validateStep('confirm', base()), null);
  });
});

describe('顯示用輔助', () => {
  test('locationLabel：樓層／房間', () => {
    const floors = [{ id: 'flr_1', name: '1F' }];
    const rooms = [{ id: 'room_a', name: '客廳', floorId: 'flr_1' }];
    assert.equal(locationLabel({ floorId: 'flr_1', roomId: 'room_a' }, floors, rooms), '1F／客廳');
    assert.equal(locationLabel({ floorId: 'flr_1', roomId: null }, floors, rooms), '1F');
    assert.equal(locationLabel({ floorId: null, roomId: null }, floors, rooms), '');
  });

  test('statusFor：偵測不可用 → na；沒有資料 → unknown；method none → disabled', () => {
    const d = { id: 'dev_1', monitor: { method: 'icmp', critical: true } };
    assert.deepEqual(statusFor(d, new Map(), false), { na: true });
    assert.deepEqual(statusFor(d, new Map(), true), { na: false, state: 'unknown', critical: true });
    assert.deepEqual(statusFor(d, new Map([['dev_1', 'down']]), true), { na: false, state: 'down', critical: true });
    assert.deepEqual(statusFor({ ...d, monitor: { method: 'none', critical: false } }, new Map(), true), { na: false, state: 'disabled', critical: false });
  });
});

describe('reorderOrders：樓層上下移', () => {
  const floors = [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'c', order: 3 }];
  test('下移：回傳需要更新的 {id, order}（重新編號 1..n，只列有變的）', () => {
    assert.deepEqual(reorderOrders(floors, 'a', 1), [{ id: 'a', order: 2 }, { id: 'b', order: 1 }]);
    assert.deepEqual(reorderOrders(floors, 'c', -1), [{ id: 'c', order: 2 }, { id: 'b', order: 3 }]);
  });
  test('已在邊界 → 不變', () => {
    assert.deepEqual(reorderOrders(floors, 'a', -1), []);
    assert.deepEqual(reorderOrders(floors, 'c', 1), []);
  });
  test('order 有重複或跳號時也會正規化', () => {
    const messy = [{ id: 'a', order: 0 }, { id: 'b', order: 0 }, { id: 'c', order: 7 }];
    const changes = reorderOrders(messy, 'b', -1);
    const final = Object.fromEntries(messy.map((f) => [f.id, f.order]));
    for (const c of changes) final[c.id] = c.order;
    assert.ok(final.b < final.a && final.a < final.c);
  });
});

describe('parseIpWithPort／applyIpWithPort：貼上「IP:埠」自動拆開', () => {
  test('IP:埠 → TCP 偵測該埠', () => {
    assert.deepEqual(parseIpWithPort(' 192.168.10.10:2345 '), { ip: '192.168.10.10', port: '2345', method: 'tcp', path: '/' });
  });

  test('從瀏覽器複製的網址：http → HTTP 偵測（含路徑，沒寫埠＝80）；https → TCP', () => {
    assert.deepEqual(parseIpWithPort('http://192.168.10.10:2345/login.html'), { ip: '192.168.10.10', port: '2345', method: 'http', path: '/login.html' });
    assert.deepEqual(parseIpWithPort('http://192.168.10.10/'), { ip: '192.168.10.10', port: '80', method: 'http', path: '/' });
    assert.deepEqual(parseIpWithPort('HTTPS://192.168.10.10:8443'), { ip: '192.168.10.10', port: '8443', method: 'tcp', path: '/' });
    assert.deepEqual(parseIpWithPort('https://192.168.10.10'), { ip: '192.168.10.10', port: '443', method: 'tcp', path: '/' });
  });

  test('純 IP、埠超出範圍、IP 不合法、主機名稱 → null（維持原本的驗證）', () => {
    for (const t of ['192.168.10.10', '192.168.10.10:0', '192.168.10.10:70000', '192.168.10.300:80', 'nvr.local:2345', '192.168.10.10:2345/x', '', null]) {
      assert.equal(parseIpWithPort(t), null, String(t));
    }
  });

  test('套用到精靈狀態：IP 欄只留 IP，偵測方式與埠帶到偵測步驟，之後換類別不會被蓋掉', () => {
    const s = { ip: '192.168.10.10:2345', monitorMethod: 'icmp', monitorPort: '', monitorPath: '/', monitorTouched: false, intervalSec: '60', critical: false };
    assert.ok(applyIpWithPort(s, s.ip));
    assert.deepEqual([s.ip, s.monitorMethod, s.monitorPort, s.monitorTouched], ['192.168.10.10', 'tcp', '2345', true]);
    assert.equal(validateStep('basic', { ...s, name: 'NVR', mac: '' }), null);
    assert.equal(validateStep('monitor', s), null);
    const plain = { ip: '192.168.1.1', monitorMethod: 'icmp' };
    assert.equal(applyIpWithPort(plain, plain.ip), null);
    assert.equal(plain.monitorMethod, 'icmp', '純 IP 不改偵測方式');
  });
});
