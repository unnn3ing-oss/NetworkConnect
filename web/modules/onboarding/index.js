// onboarding 前端模組（C1）：首次導覽（規格 §8.5）。
//   六步：建立樓層 → 上傳平面圖（可略過）→ 建立房間 → 新增核心設備 → 新增其他設備或匯入 CSV → 設定 NVR（可略過）
//   每步左側是靜態 SVG 示意（art.js），右側說明與動作；完成狀態依實際資料判斷。
//   樓層、房間直接在導覽內建立（呼叫 inventory API）；其餘動作導向對應模組（導覽先關閉，之後從總覽的「繼續導覽」回來）。
//   對應模組停用時，該步驟不出現。
// 網址：#/onboarding　　#/onboarding?step=3（直接跳到第 3 步）
import { ART } from './art.js';

const CSS_HREF = '/modules/onboarding/onboarding.css';
const DISMISS_KEY = 'nc.onboarding.dismissed';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return el;
}

function ensureCss() {
  if (document.head.querySelector(`link[href="${CSS_HREF}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF }));
}

const store = {
  set(v) {
    try {
      if (v) localStorage.setItem(DISMISS_KEY, '1');
      else localStorage.removeItem(DISMISS_KEY);
    } catch {
      // 無痕模式等：不記住也沒關係
    }
  },
};

/** 目前掛載中的狀態（unmount() 沒有參數，所以放在模組層） */
let active = null;

async function mount(el, ctx) {
  ensureCss();
  const { api, router } = ctx;
  const ui = await ctx.ui.load();
  const { createGuide, icon, toast } = ui;
  const me = { guide: null, gone: false, pendingNav: null };
  active = me;

  const data = { modules: [], floors: [], rooms: [], devices: [], categories: [], plans: [], nvrs: [] };
  const ok = (name) => data.modules.some((m) => m.name === name && m.state === 'ok');
  const fetchOr = async (path, fallback) => {
    try {
      return await api.get(path);
    } catch {
      return fallback;
    }
  };

  async function load() {
    data.modules = await fetchOr('/api/system/modules', []);
    const [floors, rooms, devices, categories, plans, nvrs] = await Promise.all([
      ok('inventory') ? fetchOr('/api/floors', []) : [],
      ok('inventory') ? fetchOr('/api/rooms', []) : [],
      ok('inventory') ? fetchOr('/api/devices', []) : [],
      ok('inventory') ? fetchOr('/api/categories', []) : [],
      ok('floorplan') ? fetchOr('/api/plans', []) : [],
      ok('nvr') ? fetchOr('/api/nvrs', []) : [],
    ]);
    Object.assign(data, { floors, rooms, devices, categories, plans, nvrs });
  }

  await load();
  if (active !== me) return;

  // 背景頁（導覽關閉後、或導覽尚未開啟時露出）
  const openBtn = h('button', { type: 'button', class: 'btn primary', dataset: { action: 'open-guide' }, text: '開始導覽' });
  el.replaceChildren(h('div', { class: 'ob-page' }, h('h2', { text: '首次導覽' }), h('p', { text: '用幾個步驟建立樓層、房間和第一批設備。' }), openBtn));

  if (!ok('inventory')) {
    el.replaceChildren(h('div', { class: 'card' }, h('h2', { class: 'nc-card-title', text: '首次導覽' }), h('p', { class: 'nc-card-text', text: '設備管理（inventory）模組已停用，沒有可以設定的項目。可到「設定」重新啟用。' })));
    return;
  }

  // ---------------------------------------------------------------- 步驟定義
  const coreIds = () => new Set(data.categories.filter((c) => c.tier === 'core').map((c) => c.id));
  const coreCount = () => data.devices.filter((d) => coreIds().has(d.categoryId)).length;

  const statusLine = (done, text) =>
    h('p', { class: `ob-status${done ? ' done' : ''}`, dataset: { done: String(done) } }, h('span', { class: 'ob-mark' }, done ? icon('check', { size: 14 }) : null), text);

  /** 關掉導覽並導向某個模組；導覽的 onClose 會處理實際跳轉 */
  const leaveTo = (hash) => {
    me.pendingNav = hash;
    me.guide.close();
  };
  const goBtn = (label, hash, { primary = true, action = '' } = {}) =>
    h('button', { type: 'button', class: `btn${primary ? ' primary' : ''}`, dataset: { action }, on: { click: () => leaveTo(hash) } }, label);

  async function createThen(path, body, okText) {
    try {
      await api.post(path, body);
      toast?.success?.(okText);
      await load();
      refresh();
      return true;
    } catch (err) {
      toast?.error?.(err?.message ?? String(err));
      return false;
    }
  }

  function inlineForm({ fields, submitLabel, action, onSubmit }) {
    const form = h('form', { class: 'ob-form', novalidate: true, on: { submit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await onSubmit();
      } finally {
        btn.disabled = false;
      }
    } } }, ...fields, h('button', { type: 'submit', class: 'btn primary', dataset: { action }, text: submitLabel }));
    return form;
  }

  function nameField(label, placeholder, name) {
    const input = h('input', { class: 'input', name, type: 'text', maxlength: '100', autocomplete: 'off', placeholder, 'aria-label': label });
    return { input, el: h('label', { class: 'nc-field' }, h('span', { class: 'nc-field-label', text: label }), input) };
  }

  const defs = [
    {
      id: 'floor',
      label: '建立樓層',
      art: ART.floor,
      render() {
        const f = nameField('樓層名稱', '例：1F', 'floorName');
        return [
          h('p', { text: '先建立你家有幾層樓。設備、房間和平面圖都會歸在樓層底下；只有一層也要建一個。' }),
          statusLine(data.floors.length > 0, data.floors.length ? `已建立 ${data.floors.length} 層：${data.floors.map((x) => x.name).join('、')}` : '還沒有任何樓層'),
          inlineForm({
            fields: [f.el], submitLabel: '建立樓層', action: 'create-floor',
            async onSubmit() {
              const name = f.input.value.trim();
              if (!name) { toast?.warn?.('請輸入樓層名稱'); f.input.focus(); return; }
              await createThen('/api/floors', { name, order: data.floors.length + 1 }, `已建立樓層 ${name}`);
            },
          }),
        ];
      },
    },
    ok('floorplan') && {
      id: 'plan',
      label: '上傳平面圖',
      art: ART.plan,
      render() {
        return [
          h('p', { text: '把房子的平面圖（PNG、JPG、SVG，10 MB 以內）上傳到對應樓層，之後可以把設備拖到圖上標示位置。' }),
          statusLine(data.plans.length > 0, data.plans.length ? `已有 ${data.plans.length} 張平面圖` : '還沒有平面圖'),
          h('div', { class: 'ob-actions' }, goBtn('前往平面圖', '#/floorplan', { action: 'go-floorplan' })),
          h('p', { class: 'nc-tip', text: '這一步可以略過。沒有平面圖時，平面圖頁會用格狀方式顯示各房間的設備。' }),
        ];
      },
    },
    {
      id: 'room',
      label: '建立房間',
      art: ART.room,
      render() {
        const f = nameField('房間名稱', '例：客廳', 'roomName');
        const select = h('select', { class: 'input', name: 'roomFloor', 'aria-label': '所在樓層' }, data.floors.map((fl) => h('option', { value: fl.id, text: fl.name })));
        const floorField = h('label', { class: 'nc-field' }, h('span', { class: 'nc-field-label', text: '所在樓層' }), select);
        return [
          h('p', { text: '房間用來描述設備放在哪裡，之後可以依房間篩選。先建一兩間就好，其他的隨時可以補。' }),
          statusLine(data.rooms.length > 0, data.rooms.length ? `已建立 ${data.rooms.length} 個房間` : '還沒有房間'),
          data.floors.length
            ? inlineForm({
                fields: [floorField, f.el], submitLabel: '建立房間', action: 'create-room',
                async onSubmit() {
                  const name = f.input.value.trim();
                  if (!name) { toast?.warn?.('請輸入房間名稱'); f.input.focus(); return; }
                  await createThen('/api/rooms', { floorId: select.value, name }, `已建立房間 ${name}`);
                },
              })
            : h('p', { class: 'nc-tip', text: '請先回到第 1 步建立樓層。' }),
        ];
      },
    },
    {
      id: 'core',
      label: '新增核心設備',
      art: ART.core,
      render() {
        const n = coreCount();
        return [
          h('ol', { class: 'nc-do' }, [
            h('li', { text: '按下方按鈕開啟「新增設備」精靈。' }),
            h('li', { text: '類別選「數據機」或「路由器」，填入名稱與 IP（通常是 192.168.1.1）。' }),
            h('li', { text: '「連線」步驟的上游設備：數據機不用選；路由器選剛才的數據機。' }),
          ]),
          statusLine(n > 0, n ? `已登錄 ${n} 台核心設備` : '還沒有數據機或路由器'),
          h('div', { class: 'ob-actions' }, goBtn('新增核心設備', '#/devices?new=1', { action: 'add-core' })),
          h('p', { class: 'nc-tip', text: '完成精靈後，從總覽的「繼續導覽」可以回到這裡。' }),
        ];
      },
    },
    {
      id: 'devices',
      label: '新增其他設備',
      art: ART.devices,
      render() {
        const others = data.devices.length - coreCount();
        return [
          h('p', { text: '把交換器、基地台、NAS、電腦、手機等設備一台台加進來，並指定它接在哪台上游設備底下，架構圖就會自動長出來。' }),
          statusLine(others > 0, others ? `已登錄 ${others} 台其他設備` : '還沒有其他設備'),
          h('div', { class: 'ob-actions' }, [
            goBtn('新增設備', '#/devices?new=1', { action: 'add-device' }),
            ok('io') && goBtn('匯入 CSV', '#/devices?view=io', { primary: false, action: 'import-csv' }),
          ]),
          ok('io') && h('p', { class: 'nc-tip', text: '已經有 Google Sheet 的舊設備清單？匯出成 CSV 就能一次匯入。' }),
        ];
      },
    },
    ok('nvr') && {
      id: 'nvr',
      label: '設定 NVR',
      art: ART.nvr,
      render() {
        return [
          h('p', { text: '有網路攝影機錄影主機（NVR）的話，可以在這裡同時查看多路即時畫面。精靈會幫你測試連線。' }),
          statusLine(data.nvrs.length > 0, data.nvrs.length ? `已設定 ${data.nvrs.length} 台 NVR` : '還沒有 NVR'),
          h('div', { class: 'ob-actions' }, goBtn('設定 NVR', '#/cameras', { action: 'setup-nvr' })),
          h('p', { class: 'nc-tip', text: '這一步可以略過。建議把 NVR 的子碼流設成 H.264，瀏覽器才能順暢播放。' }),
        ];
      },
    },
  ].filter(Boolean);

  // ---------------------------------------------------------------- 導覽本體
  const bodies = defs.map(() => h('div', { class: 'ob-body' }));
  function refresh() {
    defs.forEach((def, i) => bodies[i].replaceChildren(...def.render().filter(Boolean)));
  }
  refresh();

  const wanted = Number.parseInt(router.current().query.step ?? '', 10);
  const startAt = Number.isInteger(wanted) && wanted >= 1 && wanted <= defs.length ? wanted - 1 : 0;

  const guide = createGuide({
    title: '開始使用 NetworkConnect',
    subtitle: `約 ${Math.max(3, defs.length)} 分鐘，跟著步驟建立你的網路地圖`,
    steps: defs.map((def, i) => ({ label: def.label, art: def.art, body: bodies[i], onEnter: () => refresh() })),
    onClose({ completed }) {
      if (me.gone) return;
      store.set(true); // 離開過導覽就不再自動轉進來；設定頁的「重新開啟導覽」仍可隨時進入
      const next = me.pendingNav ?? '#/dashboard';
      me.pendingNav = null;
      me.guide = null;
      if (completed) toast?.success?.('導覽完成，開始使用吧');
      router.navigate(next);
    },
  });
  me.guide = guide;
  openBtn.addEventListener('click', () => {
    if (!me.guide) { me.guide = guide; }
    guide.open();
  });
  guide.open();
  if (startAt > 0) guide.goTo(startAt);
}

function unmount() {
  const me = active;
  if (!me) return;
  active = null;
  me.gone = true;
  me.guide?.close();
}

export default {
  id: 'onboarding',
  title: '首次導覽',
  icon: 'onboarding',
  route: '#/onboarding',
  order: 99,
  nav: false,
  showFilters: false,
  requires: [],
  mount,
  unmount,
};
