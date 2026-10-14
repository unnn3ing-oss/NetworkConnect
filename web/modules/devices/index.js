// devices 前端模組（B1）：設備列表、新增／編輯精靈、設備抽屜、分類管理、匯入匯出。
//
// 網址：
//   #/devices                  設備列表（吃全站篩選）
//   #/devices?view=manage      分類管理（樓層、房間、組別、類別）
//   #/devices?view=io          匯入／匯出（CSV 精靈、JSON 備份）
//   #/devices?new=1            開啟「新增設備」精靈（開完後自動移除此參數；給導覽、總覽的按鈕連結用）
import { h } from './dom.js';
import { getService } from './service.js';

const VIEWS = [
  { value: 'devices', label: '設備' },
  { value: 'manage', label: '分類管理' },
  { value: 'io', label: '匯入／匯出' },
];

const viewOf = (query) => (VIEWS.some((v) => v.value === query?.view) ? query.view : 'devices');

function ensureCss() {
  if (document.head.querySelector('link[data-nc-devices-css]')) return;
  const link = h('link', { rel: 'stylesheet', href: new URL('./devices.css', import.meta.url).href, 'data-nc-devices-css': '' });
  document.head.append(link);
}

/** 目前掛載中的狀態（unmount() 沒有參數，所以放在模組層） */
let active = null;

async function mount(el, ctx) {
  ensureCss();
  const service = getService(ctx);
  active = { service, offs: [], view: null, sub: null, token: 0, root: null };
  const me = active;
  service.retain();
  const { createSegmented } = await service.ui();
  await service.load();
  if (active !== me) return; // 載入期間已經離開

  const segmented = createSegmented({
    options: VIEWS.map(({ value, label }) => ({ value, label })),
    value: viewOf(ctx.router.current().query),
    ariaLabel: '設備子頁',
    role: 'tablist',
    onChange: (v) => service.goto(v),
  });
  const body = h('div', { class: 'dv-body' });
  me.root = h('div', { class: 'dv' }, h('header', { class: 'dv-head' }, h('h2', { class: 'dv-title' }, '設備'), segmented.el), body);
  el.replaceChildren(me.root);
  segmented.setValue(segmented.value); // 掛上 DOM 後重新量測圓塊位置

  async function show(view) {
    if (me.view === view) return;
    const token = ++me.token;
    me.sub?.destroy();
    me.sub = null;
    me.view = view;
    segmented.setValue(view);
    const host = h('div', { class: 'dv-view' });
    body.replaceChildren(host);
    const loaders = {
      devices: () => import('./list.js').then((m) => m.mountList),
      manage: () => import('./manage.js').then((m) => m.mountManage),
      io: () => import('./io.js').then((m) => m.mountIo),
    };
    const mountView = await loaders[view]();
    const sub = await mountView(host, service);
    if (me.token !== token || active !== me) sub.destroy();
    else me.sub = sub;
  }

  const apply = async () => {
    const { query } = ctx.router.current();
    await show(viewOf(query));
    if (query.new === '1') {
      ctx.router.setQuery({ new: '' });
      service.openWizard().catch(service.reportError);
    }
  };
  me.offs.push(ctx.router.on(() => apply().catch(service.reportError)));
  segmented.destroy && me.offs.push(() => segmented.destroy());
  await apply();
}

function unmount() {
  const me = active;
  if (!me) return;
  active = null;
  for (const off of me.offs) off();
  me.sub?.destroy();
  me.service.dismissSnack();
  me.service.release();
  me.root?.remove();
}

export default {
  id: 'devices',
  title: '設備',
  icon: 'devices',
  route: '#/devices',
  order: 20,
  requires: ['inventory'],
  mount,
  unmount,
};

// 其他分頁發出 device.open 時，devices 頁不一定掛載。App 啟動後 window.__NC__.ctx 才會出現，
// 這裡等它出現就建立常駐的 service（只訂閱 device.open）。若日後 shell 提供啟動掛勾，可改成 boot(ctx)。
export function boot(ctx) {
  getService(ctx);
}
if (typeof window !== 'undefined' && window.document) {
  let tries = 0;
  const timer = setInterval(() => {
    const ctx = window.__NC__?.ctx;
    if (ctx) {
      clearInterval(timer);
      boot(ctx);
    } else if (++tries > 200) {
      clearInterval(timer);
    }
  }, 50);
  timer.unref?.();
}
