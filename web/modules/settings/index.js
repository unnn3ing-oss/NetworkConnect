// settings 前端模組（C1）：存取密碼、功能模組開關與狀態、偵測預設值、重新開啟導覽、備份入口、版本資訊。
// 每一區是獨立的卡片：該區依賴的後端模組停用時只隱藏那一區，其他區照常。所有文字一律以 textContent 插入。
const CSS_HREF = '/modules/settings/settings.css';
const DISMISS_KEY = 'nc.onboarding.dismissed';

const MODULE_LABELS = {
  system: ['系統核心', '設定、密碼、即時事件（不可停用）'],
  inventory: ['設備管理', '樓層、房間、設備、架構圖的資料來源'],
  io: ['匯入／匯出', 'CSV 匯入、JSON 備份與還原'],
  monitor: ['連線偵測', '設備上線／離線狀態與系統通知'],
  floorplan: ['平面圖', '樓層平面圖與設備位置'],
  nvr: ['監視器（NVR）', '攝影機即時畫面（go2rtc）'],
};
const TOGGLEABLE = ['inventory', 'io', 'monitor', 'floorplan', 'nvr'];
const STATE_LABELS = { ok: '運作中', failed: '載入失敗', disabled: '已停用' };

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

const fmtUptime = (sec) => {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return d ? `${d} 天 ${hh} 小時` : hh ? `${hh} 小時 ${mm} 分` : `${mm} 分鐘`;
};

/** 欄位（label＋input＋提示） */
function field(label, input, hint) {
  return h('label', { class: 'nc-field' }, h('span', { class: 'nc-field-label', text: label }), input, hint ? h('small', { class: 'nc-field-hint', text: hint }) : null);
}

/** 目前掛載中的狀態（unmount() 沒有參數，所以放在模組層） */
let active = null;

async function mount(el, ctx) {
  ensureCss();
  const { api, router } = ctx;
  const ui = await ctx.ui.load();
  const { toast, confirm } = ui;
  const me = { gone: false };
  active = me;

  const fetchOr = async (path, fallback) => {
    try {
      return await api.get(path);
    } catch {
      return fallback;
    }
  };
  const fail = (err) => toast?.error?.(err?.message ?? String(err));

  const S = { auth: { enabled: false, authenticated: true }, modules: [], settings: null, monitor: null, health: null, nvrs: [], nvrStatus: null };
  const ok = (name) => S.modules.some((m) => m.name === name && m.state === 'ok');

  async function load() {
    const [auth, modules, settings, health] = await Promise.all([
      fetchOr('/api/auth/status', S.auth),
      fetchOr('/api/system/modules', []),
      fetchOr('/api/system/settings', null),
      fetchOr('/api/system/health', null),
    ]);
    Object.assign(S, { auth, modules, settings, health });
    const has = (n) => modules.some((m) => m.name === n && m.state === 'ok');
    S.monitor = has('monitor') ? await fetchOr('/api/monitor/settings', null) : null;
    S.nvrs = has('nvr') ? await fetchOr('/api/nvrs', []) : [];
    S.nvrStatus = has('nvr') ? await fetchOr('/api/nvr/status', null) : null;
  }

  await load();
  if (active !== me) return;

  const root = h('div', { class: 'st' });
  el.replaceChildren(root);

  // ---------------------------------------------------------------- 存取密碼
  function authCard() {
    const enabled = S.auth.enabled;
    const card = h('section', { class: 'card', dataset: { card: 'auth' } });
    card.append(
      h('h3', { class: 'st-title' }, '存取密碼', h('span', { class: `st-badge${enabled ? ' on' : ''}`, text: enabled ? '已啟用' : '未設定' })),
      h('p', { class: 'st-muted', text: enabled ? '同一個網路的人要輸入密碼才能開啟這個網頁。' : '目前同一個網路的人都能直接開啟。設定密碼後，手機與其他電腦需要先登入。' }),
    );
    if (!enabled && S.nvrs.length) card.append(h('p', { class: 'st-warn', role: 'note', text: '你已經設定了 NVR（含攝影機畫面），強烈建議開啟存取密碼。' }));

    const current = h('input', { class: 'input', type: 'password', name: 'current', autocomplete: 'current-password', maxlength: '128' });
    const next = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'new-password', minlength: '4', maxlength: '128' });
    const again = h('input', { class: 'input', type: 'password', name: 'again', autocomplete: 'new-password', maxlength: '128' });
    const submit = h('button', { type: 'submit', class: 'btn primary', dataset: { action: 'save-password' }, text: enabled ? '變更密碼' : '設定密碼' });
    const remove = enabled ? h('button', { type: 'button', class: 'btn danger', dataset: { action: 'remove-password' }, text: '移除密碼' }) : null;

    async function put(password) {
      try {
        await api.put('/api/auth/password', { password, ...(enabled ? { current: current.value } : {}) });
        toast?.success?.(password === null ? '已移除存取密碼' : enabled ? '已變更密碼' : '已設定存取密碼');
        S.auth = await fetchOr('/api/auth/status', S.auth);
        render();
      } catch (err) {
        fail(err);
      }
    }
    const form = h(
      'form',
      {
        class: 'st-form', novalidate: true,
        on: {
          submit: async (e) => {
            e.preventDefault();
            if (next.value.length < 4) { toast?.warn?.('密碼至少 4 個字元'); next.focus(); return; }
            if (next.value !== again.value) { toast?.warn?.('兩次輸入的密碼不一致'); again.focus(); return; }
            submit.disabled = true;
            await put(next.value);
            submit.disabled = false;
          },
        },
      },
      enabled ? field('目前的密碼', current) : null,
      field(enabled ? '新密碼' : '密碼', next, '4–128 個字元'),
      field('再輸入一次', again),
      h('div', { class: 'st-actions' }, submit, remove),
    );
    remove?.addEventListener('click', async () => {
      if (!current.value) { toast?.warn?.('請先輸入目前的密碼'); current.focus(); return; }
      if (!(await confirm({ title: '移除存取密碼？', message: '移除後，同一個網路的人不需要密碼就能開啟。', danger: true, okText: '移除' }))) return;
      await put(null);
    });
    card.append(form);
    return card;
  }

  // ---------------------------------------------------------------- 模組開關
  function modulesCard() {
    const card = h('section', { class: 'card', dataset: { card: 'modules' } });
    card.append(h('h3', { class: 'st-title', text: '功能模組' }), h('p', { class: 'st-muted', text: '關掉用不到的功能，其他功能不受影響。變更後要重新啟動程式才會生效。' }));
    const saved = S.settings;
    const list = h('ul', { class: 'st-modules' });
    const boxes = new Map();
    for (const m of S.modules) {
      const [label, desc] = MODULE_LABELS[m.name] ?? [m.name, ''];
      const toggle = TOGGLEABLE.includes(m.name);
      const box = toggle ? h('input', { type: 'checkbox', checked: saved ? saved.modules?.[m.name] !== false : m.state !== 'disabled', dataset: { module: m.name }, 'aria-label': `啟用${label}` }) : null;
      if (box) boxes.set(m.name, box);
      list.append(
        h(
          'li',
          { class: 'st-module', dataset: { module: m.name, state: m.state } },
          box ?? h('span', { class: 'st-lock', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'st-module-main' },
            h('span', { class: 'st-module-name', text: label }),
            h('span', { class: 'st-module-desc', text: m.error ? `${desc}｜${m.error}` : m.note ? `${desc}｜${m.note}` : desc }),
          ),
          h('span', { class: `st-badge ${m.state}`, text: STATE_LABELS[m.state] ?? m.state }),
        ),
      );
    }
    card.append(list);

    if (saved) {
      const lan = h('input', { type: 'checkbox', checked: Boolean(saved.lanAccess), dataset: { setting: 'lanAccess' } });
      const port = h('input', { class: 'input', type: 'number', min: '1', max: '65535', value: String(saved.port), name: 'port', inputmode: 'numeric' });
      const note = h('p', { class: 'st-warn', role: 'status', hidden: !saved.restartRequired, dataset: { role: 'restart' }, text: '設定已儲存，重新啟動程式後才會生效（桌面版請從選單結束後再開啟）。' });
      const save = h('button', {
        type: 'button', class: 'btn primary', dataset: { action: 'save-modules' }, text: '儲存',
        on: {
          click: async () => {
            const modules = Object.fromEntries([...boxes].map(([k, b]) => [k, b.checked]));
            if (Object.values(modules).every((v) => v === false)) { toast?.warn?.('至少要保留一個功能模組'); return; }
            const p = Number.parseInt(port.value, 10);
            if (!Number.isInteger(p) || p < 1 || p > 65535) { toast?.warn?.('埠號必須是 1–65535'); port.focus(); return; }
            save.disabled = true;
            try {
              const body = { modules, port: p };
              if (!saved.lanAccessManaged) body.lanAccess = lan.checked;
              S.settings = await api.put('/api/system/settings', body);
              toast?.success?.(S.settings.restartRequired ? '已儲存，重新啟動後生效' : '已儲存');
              note.hidden = !S.settings.restartRequired;
            } catch (err) {
              fail(err);
            } finally {
              save.disabled = false;
            }
          },
        },
      });
      card.append(
        saved.lanAccessManaged
          ? h('p', { class: 'st-hint', dataset: { role: 'lan-managed' }, text: '區網連線由桌面 App 控制：請從選單列（Mac）或系統匣（Windows）的 NetworkConnect 圖示切換「允許手機在區網連線」。' })
          : h('label', { class: 'st-check' }, lan, h('span', { text: '允許區網內的手機與其他電腦連線（關閉後只有這台電腦能開啟）' })),
        h('div', { class: 'st-form' }, field('網頁埠號', port, '預設 8780；被佔用時會自動往後找')),
        h('div', { class: 'st-actions' }, save),
        note,
      );
    }
    return card;
  }

  // ---------------------------------------------------------------- 偵測預設值
  function monitorCard() {
    if (!ok('monitor') || !S.monitor) return null;
    const m = S.monitor;
    const interval = h('input', { class: 'input', type: 'number', min: '15', max: '86400', value: String(m.defaultIntervalSec), name: 'defaultIntervalSec', inputmode: 'numeric' });
    const conc = h('input', { class: 'input', type: 'number', min: '1', max: '64', value: String(m.concurrency), name: 'concurrency', inputmode: 'numeric' });
    const timeout = h('input', { class: 'input', type: 'number', min: '200', max: '10000', value: String(m.timeoutMs), name: 'timeoutMs', inputmode: 'numeric' });
    const save = h('button', { type: 'submit', class: 'btn primary', dataset: { action: 'save-monitor' }, text: '儲存' });
    const form = h(
      'form',
      {
        class: 'st-form', novalidate: true,
        on: {
          submit: async (e) => {
            e.preventDefault();
            const body = { defaultIntervalSec: Number(interval.value), concurrency: Number(conc.value), timeoutMs: Number(timeout.value) };
            save.disabled = true;
            try {
              S.monitor = await api.put('/api/monitor/settings', body);
              toast?.success?.('偵測設定已儲存');
            } catch (err) {
              fail(err);
            } finally {
              save.disabled = false;
            }
          },
        },
      },
      h('div', { class: 'st-grid' }, field('預設偵測間隔（秒）', interval, '15–86400；套用到之後新增的設備（含 CSV 匯入），已建立的設備請在設備設定個別修改'), field('同時偵測數', conc, '1–64'), field('逾時（毫秒）', timeout, '200–10000')),
      h('div', { class: 'st-actions' }, save),
    );
    return h('section', { class: 'card', dataset: { card: 'monitor' } }, h('h3', { class: 'st-title', text: '偵測預設值' }), h('p', { class: 'st-muted', text: '連續 3 次失敗才會判定離線。' }), form);
  }

  // ---------------------------------------------------------------- 導覽與備份
  function onboardingCard() {
    const reopen = h('button', {
      type: 'button', class: 'btn', dataset: { action: 'reopen-onboarding' }, text: '重新開啟導覽',
      on: {
        click: () => {
          try { localStorage.removeItem(DISMISS_KEY); } catch { /* 沒有儲存空間也能開啟 */ }
          router.navigate('#/onboarding');
        },
      },
    });
    return h('section', { class: 'card', dataset: { card: 'onboarding' } }, h('h3', { class: 'st-title', text: '首次導覽' }), h('p', { class: 'st-muted', text: '忘了怎麼開始？隨時可以再看一次六步驟的導覽。' }), h('div', { class: 'st-actions' }, reopen));
  }

  function backupCard() {
    if (!ok('inventory') || !ok('io')) return null;
    return h(
      'section',
      { class: 'card', dataset: { card: 'backup' } },
      h('h3', { class: 'st-title', text: '備份與還原' }),
      h('p', { class: 'st-muted', text: '所有資料都存在這台電腦。建議定期匯出一份 JSON 備份，換電腦時匯入即可還原。' }),
      h('div', { class: 'st-actions' }, h('a', { class: 'btn', href: '#/devices?view=io', dataset: { action: 'open-backup' } }, '前往匯入／匯出')),
    );
  }

  // ---------------------------------------------------------------- 版本資訊
  function aboutCard() {
    const rows = [['NetworkConnect', S.health ? `v${S.health.version}` : '—'], ['已執行', S.health ? fmtUptime(S.health.uptime) : '—']];
    if (S.nvrStatus) rows.push(['go2rtc', S.nvrStatus.running ? S.nvrStatus.version || '運作中' : '未啟動']);
    rows.push(['瀏覽器網址', window.location.origin]);
    const dl = h('dl', { class: 'st-kv' });
    for (const [k, v] of rows) dl.append(h('dt', { text: k }), h('dd', { text: v }));
    return h('section', { class: 'card', dataset: { card: 'about' } }, h('h3', { class: 'st-title', text: '版本資訊' }), dl);
  }

  function render() {
    root.replaceChildren(
      h('header', { class: 'st-head' }, h('h2', { class: 'st-h2', text: '設定' })),
      ...[authCard(), modulesCard(), monitorCard(), onboardingCard(), backupCard(), aboutCard()].filter(Boolean),
    );
  }
  render();
}

function unmount() {
  if (active) active.gone = true;
  active = null;
}

export default {
  id: 'settings',
  title: '設定',
  icon: 'settings',
  route: '#/settings',
  order: 90,
  showFilters: false,
  requires: [],
  mount,
  unmount,
};
