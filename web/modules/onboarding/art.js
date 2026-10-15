// 首次導覽每一步左側的靜態示意圖（簡化版的對應頁面）。
// 只用 guide.css 提供的調色 class（sv-*），沒有 style／script／外部連結；文字為純文字。

/** 瀏覽器視窗外框：頂欄三點＋分頁膠囊，active＝目前高亮的分頁索引 */
const TABS = ['總覽', '設備', '架構圖', '平面圖', '監視器'];
function frame(active, inner) {
  const tabs = TABS.map((t, i) => {
    const x = 78 + i * 62;
    return `<rect class="${i === active ? 'sv-acc' : 'sv-track'}" x="${x}" y="22" width="56" height="16" rx="8"/>`
      + `<text class="sv-t ${i === active ? 'w' : 'm'}" x="${x + 28}" y="34" text-anchor="middle">${t}</text>`;
  }).join('');
  return `<svg viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg" role="img">
  <rect class="sv-surface" x="12" y="10" width="456" height="280" rx="14"/>
  <rect class="sv-edge" x="12" y="10" width="456" height="280" rx="14"/>
  <circle class="sv-track" cx="30" cy="30" r="4"/><circle class="sv-track" cx="44" cy="30" r="4"/><circle class="sv-track" cx="58" cy="30" r="4"/>
  ${tabs}
  <line class="sv-edge" x1="12" y1="48" x2="468" y2="48"/>
  ${inner}
</svg>`;
}

/** 1 建立樓層：左側樓層清單、一個「＋新增樓層」 */
const floor = frame(1, `
  <rect class="sv-soft" x="32" y="66" width="130" height="30" rx="10"/><text class="sv-t" x="46" y="86">1F</text>
  <rect class="sv-track" x="32" y="104" width="130" height="30" rx="10"/><text class="sv-t" x="46" y="124">2F</text>
  <rect class="sv-track" x="32" y="142" width="130" height="30" rx="10"/><text class="sv-t" x="46" y="162">3F</text>
  <rect class="sv-edge" x="32" y="180" width="130" height="30" rx="15"/>
  <path class="sv-ico" d="M52 195h14M59 188v14"/><text class="sv-t m" x="74" y="199">新增樓層</text>
  <rect class="sv-track" x="186" y="66" width="262" height="204" rx="12"/>
  <text class="sv-t m" x="206" y="96">每一層樓都是一個分類，</text>
  <text class="sv-t m" x="206" y="114">設備、房間和平面圖都歸在樓層底下。</text>
  <circle class="sv-ok" cx="206" cy="150" r="6"/><text class="sv-t" x="220" y="154">1F 已建立</text>`);

/** 2 上傳平面圖：房間格局＋虛線上傳箭頭 */
const plan = frame(3, `
  <rect class="sv-track" x="32" y="64" width="270" height="208" rx="10"/>
  <path class="sv-edge" d="M48 80h238v176H48zM48 150h110M158 80v100M158 200v56M220 80v176"/>
  <circle class="sv-ok" cx="100" cy="112" r="7"/><circle class="sv-ok" cx="190" cy="124" r="7"/><circle class="sv-acc" cx="254" cy="168" r="7"/>
  <rect class="sv-soft" x="322" y="64" width="126" height="208" rx="12"/>
  <path class="sv-ico" d="M385 150v-40M368 126l17-17 17 17"/>
  <text class="sv-t" x="385" y="182" text-anchor="middle">上傳圖檔</text>
  <text class="sv-t m" x="385" y="200" text-anchor="middle">PNG／JPG／SVG</text>
  <text class="sv-t m" x="385" y="236" text-anchor="middle">沒有圖也沒關係</text>`);

/** 3 建立房間：樓層分頁＋房間卡片 */
const room = frame(1, `
  <rect class="sv-acc" x="32" y="64" width="50" height="22" rx="11"/><text class="sv-t w" x="57" y="79" text-anchor="middle">1F</text>
  <rect class="sv-track" x="90" y="64" width="50" height="22" rx="11"/><text class="sv-t m" x="115" y="79" text-anchor="middle">2F</text>
  <rect class="sv-soft" x="32" y="104" width="132" height="70" rx="12"/><text class="sv-t" x="48" y="130">客廳</text><text class="sv-t m" x="48" y="150">3 台設備</text>
  <rect class="sv-soft" x="176" y="104" width="132" height="70" rx="12"/><text class="sv-t" x="192" y="130">書房</text><text class="sv-t m" x="192" y="150">2 台設備</text>
  <rect class="sv-edge" x="320" y="104" width="128" height="70" rx="12"/>
  <path class="sv-ico" d="M370 139h28M384 125v28"/>
  <text class="sv-t m" x="384" y="166" text-anchor="middle">新增房間</text>
  <rect class="sv-track" x="32" y="192" width="416" height="70" rx="12"/>
  <text class="sv-t m" x="48" y="222">房間用來描述「設備放在哪裡」，</text><text class="sv-t m" x="48" y="240">之後可以依房間篩選設備。</text>`);

/** 4 核心設備：數據機 → 路由器 */
const core = frame(2, `
  <rect class="sv-soft" x="52" y="120" width="120" height="68" rx="14"/>
  <rect class="sv-ico" x="82" y="136" width="60" height="22" rx="5"/><circle class="sv-ok" cx="94" cy="147" r="3"/><circle class="sv-ok" cx="106" cy="147" r="3"/>
  <text class="sv-t" x="112" y="178" text-anchor="middle">數據機</text>
  <path class="sv-line" d="M172 154h60"/>
  <rect class="sv-soft" x="232" y="120" width="120" height="68" rx="14"/>
  <path class="sv-ico" d="M262 152a40 40 0 0 1 60 0M272 160a26 26 0 0 1 40 0"/><circle class="sv-acc" cx="292" cy="167" r="3"/>
  <text class="sv-t" x="292" y="180" text-anchor="middle">路由器</text>
  <path class="sv-line" d="M352 154h30"/>
  <circle class="sv-edge" cx="410" cy="154" r="26"/><path class="sv-ico" d="M398 154h24M410 142v24"/>
  <text class="sv-t m" x="240" y="236" text-anchor="middle">先登錄最上游的設備，其他設備再接在它底下</text>`);

/** 5 其他設備／匯入：路由器下接三台＋CSV */
const devices = frame(2, `
  <rect class="sv-soft" x="160" y="64" width="100" height="40" rx="12"/><text class="sv-t" x="210" y="89" text-anchor="middle">路由器</text>
  <path class="sv-line" d="M210 104v22M90 126h240M90 126v22M210 126v22M330 126v22"/>
  <rect class="sv-track" x="40" y="148" width="100" height="40" rx="12"/><text class="sv-t" x="90" y="173" text-anchor="middle">交換器</text>
  <rect class="sv-track" x="160" y="148" width="100" height="40" rx="12"/><text class="sv-t" x="210" y="173" text-anchor="middle">NAS</text>
  <rect class="sv-track" x="280" y="148" width="100" height="40" rx="12"/><text class="sv-t" x="330" y="173" text-anchor="middle">AP</text>
  <rect class="sv-soft" x="40" y="218" width="340" height="40" rx="12"/>
  <path class="sv-ico" d="M60 232h14v14H60zM60 239h14M67 232v14"/>
  <text class="sv-t" x="86" y="243">也可以用 CSV 一次匯入舊的設備清單</text>
  <circle class="sv-ok" cx="418" cy="168" r="6"/><circle class="sv-ok" cx="418" cy="188" r="6"/><circle class="sv-track" cx="418" cy="208" r="6"/>`);

/** 6 NVR：2x2 影像牆 */
const nvr = frame(4, `
  <rect class="sv-track" x="32" y="64" width="196" height="100" rx="10"/><path class="sv-ico" d="M110 100h24l8 8h8v22h-48z"/><circle class="sv-ok" cx="46" cy="78" r="4"/>
  <rect class="sv-track" x="236" y="64" width="196" height="100" rx="10"/><path class="sv-ico" d="M314 100h24l8 8h8v22h-48z"/><circle class="sv-ok" cx="250" cy="78" r="4"/>
  <rect class="sv-track" x="32" y="172" width="196" height="100" rx="10"/><path class="sv-ico" d="M110 208h24l8 8h8v22h-48z"/><circle class="sv-ok" cx="46" cy="186" r="4"/>
  <rect class="sv-soft" x="236" y="172" width="196" height="100" rx="10"/><path class="sv-ico" d="M320 212v32M304 228h32"/>
  <text class="sv-t m" x="334" y="262" text-anchor="middle">新增 NVR</text>`);

export const ART = { floor, plan, room, core, devices, nvr };
