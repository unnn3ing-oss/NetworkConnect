// demo.html 的互動：展示所有元件與兩種主題。這支檔案只給目視檢查用，B 組不需要讀。
import { icon, iconNames, categoryIcons } from './icons.js';
import { createGuide } from './guide.js';
import { createWizard, opGroup, box, kv, field } from './wizard.js';
import { toast } from './toast.js';
import { confirm } from './dialog.js';
import { createDrawer } from './drawer.js';
import { createSegmented } from './segmented.js';
import { createChips } from './chips.js';
import { createStatusDot } from './status-dot.js';
import { createEmpty } from './empty.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

// ---- 頂欄與主題 ----
const brand = $('brand');
brand.append(icon('topology', { size: 22 }), el('span', 'brand-text', 'NetworkConnect UI'));
const saved = (() => { try { return localStorage.getItem('nc-theme'); } catch { return null; } })();
const setTheme = (t) => {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('nc-theme', t); } catch { /* 無痕模式等情況略過 */ }
};
const theme = createSegmented({
  ariaLabel: '主題',
  options: [{ value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }],
  value: saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  onChange: setTheme,
});
setTheme(theme.value);
$('themeHost').append(theme.el);

// ---- 分段與 chips ----
$('segHost').append(createSegmented({
  ariaLabel: '分割數', value: '4', options: [{ value: '1', label: '1 格' }, { value: '4', label: '4 格' }, { value: '9', label: '9 格' }, { value: '16', label: '16 格' }],
  onChange: (v) => toast(`分割數：${v}`, { duration: 1500 }),
}).el);
$('segHost').append(createSegmented({
  ariaLabel: '主導覽', role: 'tablist', value: 'topology',
  options: [{ value: 'inventory', label: '設備', icon: icon('inventory', { size: 16 }) }, { value: 'topology', label: '架構圖', icon: icon('topology', { size: 16 }) }, { value: 'floorplan', label: '平面圖', icon: icon('floorplan', { size: 16 }) }, { value: 'monitor', label: '監視器', icon: icon('monitor', { size: 16 }) }],
}).el);

const chips = createChips({
  ariaLabel: '樓層', allLabel: '全部', value: ['f1'],
  options: [{ value: 'f1', label: '1 樓', count: 12 }, { value: 'f2', label: '2 樓', count: 8 }, { value: 'b1', label: '地下室', count: 3 }, { value: 'out', label: '戶外', count: 2 }],
  onChange: (v) => { $('chipOut').textContent = `已選：${v.length ? v.join('、') : '（無，等於全部）'}`; },
});
$('chipHost').append(chips.el);
$('chipOut').textContent = `已選：${chips.value.join('、')}`;

// ---- 燈號 ----
const dots = [['up', true], ['down', true], ['down', false], ['unknown', false], ['disabled', false]];
for (const [status, critical] of dots) {
  const wrap = el('span', 'row');
  wrap.append(createStatusDot({ status, critical }));
  $('statusHost').append(wrap);
}
$('statusHost').append(createStatusDot({ status: 'up', showLabel: false }), createStatusDot({ status: 'down', critical: true, showLabel: false }));

// ---- 空狀態 ----
$('emptyHost').append(createEmpty({
  icon: 'inventory', title: '還沒有任何設備', description: '先新增第一台設備，架構圖與平面圖就會自動出現。',
  actionLabel: '新增設備', onAction: () => $('btnWizard').click(),
}));

// ---- 圖示 ----
const seen = new Set(['devices', 'cameras', 'gear', 'delete', 'add', 'x']);   // 別名不重複展示
for (const n of [...categoryIcons, ...iconNames]) {
  if (seen.has(n)) continue;
  seen.add(n);
  const c = el('div', 'icon-cell');
  c.append(icon(n, { size: 26 }), el('span', '', n));
  $('iconHost').append(c);
}

// ---- 通知、對話框、抽屜 ----
$('btnToast').addEventListener('click', () => toast.success('設備已儲存'));
$('btnToastErr').addEventListener('click', () => toast.error('無法連線到 NVR，請檢查 IP 與密碼'));
$('btnConfirm').addEventListener('click', async () => toast.info((await confirm({ title: '套用設定？', message: '會重新啟動偵測，約需 5 秒。' })) ? '已套用' : '已取消'));
$('btnDanger').addEventListener('click', async () => {
  const ok = await confirm({ title: '刪除「客廳 Mesh 主節點」？', message: '此動作無法復原，相關連線也會一併移除。', danger: true, okText: '刪除' });
  if (ok) toast.success('已刪除');
});

const drawerBody = el('div');
{
  const status = createStatusDot({ status: 'down', critical: true });
  drawerBody.append(status, kv([['名稱', '客廳 Mesh 主節點'], ['類別', '路由器'], ['IP', '192.168.1.2'], ['MAC', 'AA:BB:CC:DD:EE:FF']]));
  drawerBody.classList.add('demo-drawer');
}
$('btnDrawer').addEventListener('click', () => createDrawer({ title: '設備資訊', content: drawerBody }).open());

// ---- 精靈 ----
const CATS = [['router', '路由器'], ['switch', '交換器'], ['ap', '無線基地台'], ['nvr', 'NVR'], ['camera', 'IP 攝影機'], ['nas', 'NAS'], ['other', '其他']];
$('btnWizard').addEventListener('click', () => {
  const wiz = createWizard({
    title: '新增設備',
    initialState: { cat: 'router' },
    steps: [
      {
        id: 'cat', label: '類別',
        render: (s) => {
          const g = opGroup({ ariaLabel: '設備類別', value: s.cat, options: CATS.map(([value, label]) => ({ value, label })), onChange: (v) => { s.cat = v; } });
          const wrap = el('div', 'nc-stack');
          wrap.append(el('h3', 'nc-section-title', '這是哪一種設備？'), g.el);
          return wrap;
        },
        validate: (s) => (s.cat ? null : '請選擇設備類別'),
      },
      {
        id: 'info', label: '基本資料',
        render: (s) => {
          const wrap = el('div', 'nc-stack');
          wrap.append(field(s, { name: 'name', label: '名稱', required: true, placeholder: '例如：客廳 Mesh 主節點' }), field(s, { name: 'ip', label: 'IP 位址', placeholder: '192.168.1.2', hint: '選填，填了才能偵測連線狀態' }));
          return wrap;
        },
        validate: (s) => (!s.name || !s.name.trim() ? '請輸入設備名稱' : null),
      },
      {
        id: 'ok', label: '確認',
        render: (s) => box('確認內容', kv([['類別', (CATS.find((c) => c[0] === s.cat) || [])[1]], ['名稱', s.name], ['IP', s.ip]])),
      },
    ],
    onSubmit: async (s) => { await new Promise((r) => setTimeout(r, 300)); toast.success(`已新增「${s.name}」`); },
  });
  wiz.open();
});

// ---- 導覽 ----
const art = (inner) => `<svg viewBox="0 0 480 300" focusable="false">${inner}</svg>`;
const ART1 = art(`
  <rect class="sv-surface sv-edge" x="70" y="40" width="340" height="62" rx="14"/><rect class="sv-soft" x="86" y="56" width="30" height="30" rx="8"/><text class="sv-t" x="130" y="76">2 樓</text>
  <rect class="sv-surface sv-edge" x="70" y="118" width="340" height="62" rx="14"/><rect class="sv-soft" x="86" y="134" width="30" height="30" rx="8"/><text class="sv-t" x="130" y="154">1 樓</text>
  <rect class="sv-surface sv-edge" x="70" y="196" width="340" height="62" rx="14"/><rect class="sv-soft" x="86" y="212" width="30" height="30" rx="8"/><text class="sv-t" x="130" y="232">地下室</text>
  <rect class="sv-acc" x="334" y="140" width="64" height="26" rx="13"/><text class="sv-t w" x="366" y="157" text-anchor="middle">＋ 新增</text>`);
const ART2 = art(`
  <path class="sv-line" d="M240 70v50M240 120H130v40M240 120h110v40"/>
  <rect class="sv-acc" x="205" y="40" width="70" height="34" rx="10"/><text class="sv-t w" x="240" y="62" text-anchor="middle">數據機</text>
  <rect class="sv-surface sv-edge" x="95" y="160" width="70" height="34" rx="10"/><text class="sv-t" x="130" y="182" text-anchor="middle">交換器</text>
  <rect class="sv-surface sv-edge" x="315" y="160" width="70" height="34" rx="10"/><text class="sv-t" x="350" y="182" text-anchor="middle">基地台</text>
  <text class="sv-t m" x="240" y="250" text-anchor="middle">依「上游設備」自動排成樹狀</text>`);
const ART3 = art(`
  <rect class="sv-surface sv-edge" x="60" y="50" width="360" height="200" rx="16"/>
  <circle class="sv-ok" cx="130" cy="110" r="9"/><circle class="sv-ok" cx="250" cy="150" r="9"/><circle class="sv-acc" cx="340" cy="100" r="9"/><circle class="sv-track" cx="180" cy="200" r="9"/>
  <text class="sv-t m" x="240" y="232" text-anchor="middle">拖放設備到平面圖上的位置</text>`);
const bodyOf = (lead, items) => {
  const wrap = el('div');
  wrap.append(el('p', '', lead));
  const ol = el('ol', 'nc-do');
  for (const t of items) ol.append(el('li', '', t));
  wrap.append(ol, el('p', 'nc-tip', '小提醒：之後隨時可以從設定重新開啟導覽。'));
  return wrap;
};
$('btnGuide').addEventListener('click', () => {
  createGuide({
    title: '開始使用 NetworkConnect', subtitle: '大約 3 分鐘，跟著做一次就會了',
    steps: [
      { label: '建立樓層', art: ART1, body: bodyOf('先告訴我房子有幾層樓，之後設備才有地方放。', ['按右上角「設定」，選「樓層」。', '輸入樓層名稱，例如「1 樓」。', '重複直到所有樓層都建好。']) },
      { label: '登錄設備', art: ART2, body: bodyOf('每台設備填名稱、類別與上游設備，架構圖就會自動畫出來。', ['到「設備」頁按「新增設備」。', '選類別，填名稱與 IP。', '指定它接在哪台設備下面。']) },
      { label: '放上平面圖', art: ART3, body: bodyOf('上傳平面圖後，把設備拖到實際位置，燈號會跟著連線狀態變色。', ['到「平面圖」頁選樓層。', '上傳圖片。', '把設備拖放到位置。']) },
    ],
    onClose: ({ completed }) => toast(completed ? '導覽完成' : '已離開導覽'),
  }).open();
});
