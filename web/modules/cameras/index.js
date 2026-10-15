// cameras 前端模組（B5）：監視器畫面牆＋NVR 設定精靈。
//
// 網址：
//   #/cameras                         畫面牆（1／4／9／16 分割，預設 4）
//   #/cameras?device=<deviceId>       直接開該攝影機設備連結的頻道（單一畫面）
//   #/cameras?ch=<nvrId>:<ch>         直接開指定 NVR 的指定頻道（單一畫面）
//
// 串流（WebSocket）只在頁面掛載、分頁可見時存在；unmount()、分頁隱藏時全部關閉。
// go2rtc 前端元件已 vendored 在 /vendor/video-rtc.js（本模組繼承 VideoRTC，原因見 player.js 與 web/vendor/VERSIONS.md）。

const CSS_ATTR = 'data-nc-cameras-css';

function ensureCss() {
  if (document.head.querySelector(`link[${CSS_ATTR}]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./cameras.css', import.meta.url).href;
  link.setAttribute(CSS_ATTR, '');
  document.head.append(link);
}

/** 目前掛載中的狀態（unmount() 沒有參數，所以放在模組層） */
let active = null;

async function mount(el, ctx) {
  ensureCss();
  const me = { viewer: null, wizard: null, drawer: null, el };
  active = me;
  const uiLib = await ctx.ui.load();
  const { createViewer } = await import('./viewer.js');
  if (active !== me) return; // 載入期間已經離開

  const report = (err) => {
    console.error(err);
    uiLib.toast?.error?.(err?.message ?? String(err));
  };

  const closeWizard = () => {
    me.wizard = null;
    me.viewer?.setWizardOpen(false);
  };
  const openWizard = async (nvr = null) => {
    if (me.wizard) return;
    me.viewer.setWizardOpen(true);
    try {
      const { openNvrWizard } = await import('./wizard.js');
      me.wizard = await openNvrWizard(ctx, uiLib, {
        nvr,
        onDone: () => closeWizard(),
        onClose: () => closeWizard(),
      });
      if (active !== me) me.wizard?.dispose();
    } catch (err) {
      closeWizard();
      report(err);
    }
  };
  const openManage = async () => {
    try {
      const { openManager } = await import('./manage.js');
      me.drawer = await openManager(ctx, uiLib, {
        onEdit: (nvr) => openWizard(nvr),
        onAdd: () => openWizard(null),
        onChanged: () => me.viewer?.reload().catch(report),
      });
    } catch (err) {
      report(err);
    }
  };

  me.viewer = createViewer(el, ctx, { uiLib, onAddNvr: () => openWizard(null), onManage: openManage });
  try {
    await me.viewer.start();
  } catch (err) {
    if (active === me) report(err);
  }
}

function unmount() {
  const me = active;
  if (!me) return;
  active = null;
  me.wizard?.dispose();
  me.drawer?.close?.();
  me.viewer?.destroy(); // 關閉所有串流
}

export default {
  id: 'cameras',
  title: '監視器',
  icon: 'cameras',
  route: '#/cameras',
  order: 50,
  requires: ['nvr'],
  showFilters: false,
  mount,
  unmount,
};
