// devices 模組的資料與共用動作（每個 ctx 只有一份）：
// 設備／分類／狀態的快取、設備抽屜、新增／編輯精靈、刪除流程、「放到平面圖」提示。
//
// 生命週期：頁面掛載或抽屜開啟時 retain()，才會訂閱 bus（inventory.changed、status.*）；全部 release() 後解除。
// 唯一常駐的訂閱是 `device.open`：其他分頁（架構圖、平面圖、狀態頁）發出它時，devices 頁不一定掛載，
// 抽屜必須仍然能開（事件契約：device.open → devices 模組開啟設備抽屜）。
import { h } from './dom.js';
import { descendantIds } from './logic.js';

const services = new WeakMap();

/** 取得（必要時建立）此 ctx 的 service；建立時就會常駐監聽 device.open */
export function getService(ctx) {
  let s = services.get(ctx);
  if (!s) {
    s = createService(ctx);
    services.set(ctx, s);
  }
  return s;
}

function createService(ctx) {
  const { api, bus } = ctx;
  const state = {
    floors: [], rooms: [], groups: [], categories: [], devices: [],
    status: new Map(),
    /** 偵測（monitor 模組）是否可用：取得過 /api/status 或收到 status.* 事件才為 true */
    monitorAvailable: false,
    loaded: false,
  };
  const listeners = new Set();
  const notify = (kind, detail) => {
    for (const fn of [...listeners]) {
      try {
        fn(kind, detail);
      } catch (err) {
        console.error('devices 訂閱者發生錯誤', err);
      }
    }
  };

  let uiPromise = null;
  const ui = () => (uiPromise ??= ctx.ui.load());
  const reportError = async (err) => {
    console.error(err);
    try {
      (await ui()).toast.error(err?.message ?? String(err));
    } catch {
      // 連提示都做不到就算了
    }
  };

  // ------------------------------------------------------------ 資料
  let monitorState = null; // 'ok' | 其他；retain 週期內只查一次
  async function monitorUsable() {
    if (monitorState === null) {
      try {
        const modules = await api.get('/api/system/modules');
        monitorState = modules.find((m) => m.name === 'monitor')?.state ?? 'missing';
      } catch {
        return false;
      }
    }
    return monitorState === 'ok';
  }

  let seq = 0;
  let lastSig = '';
  async function load() {
    const my = ++seq;
    const [floors, rooms, groups, categories, devices] = await Promise.all([
      api.get('/api/floors'), api.get('/api/rooms'), api.get('/api/groups'), api.get('/api/categories'), api.get('/api/devices'),
    ]);
    // monitor 停用或失敗時不要去打 /api/status（只會得到 404／503）：狀態一律顯示「—」
    let status = null;
    if (await monitorUsable()) {
      try {
        status = await api.get('/api/status');
      } catch {
        status = null;
      }
    }
    if (my !== seq) return; // 有更新的載入已經開始
    // 設備資料沒變就不重畫：自己的寫入會觸發一次載入，隨後 inventory.changed 又觸發一次，
    // 第二次若重畫畫面，使用者正在輸入的欄位會被清掉。狀態另外以 'status' 通知（只更新燈號）。
    const sig = JSON.stringify([floors, rooms, groups, categories, devices]);
    const available = status !== null;
    if (state.loaded && sig === lastSig && available === state.monitorAvailable) {
      if (status) {
        state.status = new Map(status.map((i) => [i.deviceId, i.state]));
        notify('status');
      }
      return;
    }
    lastSig = sig;
    Object.assign(state, { floors, rooms, groups, categories, devices, loaded: true, monitorAvailable: available });
    if (status) state.status = new Map(status.map((i) => [i.deviceId, i.state]));
    notify('data');
  }

  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load().catch(reportError), 80);
  };

  let refs = 0;
  let offs = [];
  function retain() {
    if (refs++ > 0) return;
    offs = [
      bus.on('inventory.changed', scheduleReload),
      bus.on('status.snapshot', (p) => {
        state.status = new Map((p?.items ?? []).map((i) => [i.deviceId, i.state]));
        state.monitorAvailable = true;
        notify('status');
      }),
      bus.on('status.changed', (p) => {
        if (!p?.deviceId) return;
        state.status.set(p.deviceId, p.to);
        state.monitorAvailable = true;
        notify('status', p.deviceId);
      }),
    ];
  }
  function release() {
    if (refs === 0 || --refs > 0) return;
    for (const off of offs) off();
    offs = [];
    monitorState = null;
    clearTimeout(reloadTimer);
  }

  // ------------------------------------------------------------ 抽屜、精靈
  let drawerCtl = null;
  async function openDrawer(id) {
    if (!drawerCtl) {
      const { createDeviceDrawer } = await import('./drawer.js');
      drawerCtl ??= await createDeviceDrawer(service);
    }
    if (!drawerCtl.isOpen()) await load();
    drawerCtl.open(id);
  }
  const closeDrawer = () => drawerCtl?.close();

  async function openWizard(opts = {}) {
    if (!state.loaded) await load();
    const { openDeviceWizard } = await import('./wizard.js');
    await openDeviceWizard(service, opts);
  }

  // ------------------------------------------------------------ 動作
  /** 刪除設備：確認對話框列出會被斷開的下游設備。成功回傳 true */
  async function deleteDevice(id) {
    const device = state.devices.find((d) => d.id === id);
    if (!device) return false;
    const { confirm, toast } = await ui();
    const downstream = state.devices.filter((d) => d.uplink?.deviceId === id);
    const names = downstream.map((d) => d.name);
    const shown = names.length > 8 ? `${names.slice(0, 8).join('、')} 等 ${names.length} 台` : names.join('、');
    const ok = await confirm({
      title: `刪除「${device.name}」？`,
      message: downstream.length
        ? `刪除後，下列 ${downstream.length} 台下游設備會失去上游連線（變成獨立節點）：${shown}。此操作無法復原。`
        : '此操作無法復原。',
      danger: true,
      okText: '刪除',
    });
    if (!ok) return false;
    try {
      await api.delete(`/api/devices/${id}`);
    } catch (err) {
      toast.error(err.message);
      return false;
    }
    toast.success(`已刪除「${device.name}」`);
    await load().catch(reportError);
    return true;
  }

  let snack = null;
  function dismissSnack() {
    if (!snack) return;
    clearTimeout(snack.timer);
    snack.offRoute();
    snack.el.remove();
    snack = null;
  }
  function placeOnPlan(id) {
    dismissSnack();
    closeDrawer();
    ctx.router.navigate(`#/floorplan?place=${encodeURIComponent(id)}`);
  }
  /** 儲存成功後的提示：訊息＋「放到平面圖」按鈕（ui 的 toast 沒有動作按鈕，所以自己畫一個同風格的） */
  function announceSaved(device, isNew) {
    dismissSnack();
    const el = h(
      'div',
      { class: 'dv-snack', role: 'status' },
      h('span', { class: 'dv-snack-text' }, `${isNew ? '已新增' : '已更新'}「${device.name}」`),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => placeOnPlan(device.id) }, '放到平面圖'),
      h('button', { type: 'button', class: 'btn small', 'aria-label': '關閉提示', onclick: dismissSnack }, '關閉'),
    );
    document.body.append(el);
    const offRoute = ctx.router.on(dismissSnack);
    snack = { el, offRoute, timer: setTimeout(dismissSnack, 10_000) };
  }

  // 其他分頁的點擊 → 開抽屜（常駐）
  bus.on('device.open', (p) => {
    if (p?.id) openDrawer(p.id).catch(reportError);
  });

  const service = {
    ctx,
    state,
    ui,
    load,
    retain,
    release,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    openDrawer,
    closeDrawer,
    openWizard,
    deleteDevice,
    placeOnPlan,
    announceSaved,
    dismissSnack,
    reportError,
    descendantIds: (id) => descendantIds(state.devices, id),
    /** 導向本模組的子頁 */
    goto(view) {
      ctx.router.setQuery({ view: view === 'devices' ? '' : view });
    },
  };
  return service;
}
