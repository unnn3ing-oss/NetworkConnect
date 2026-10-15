// 「怎麼找 RTSP 設定」全螢幕說明（web/ui 的 guide 元件）。
// art 是靜態 SVG 字串（會被淨化：不能有行內 style、外部連結），顏色靠 guide.css 的 sv-* class。
import { h } from './dom.js';

const ART = {
  network: `<svg viewBox="0 0 480 300" role="img"><rect class="sv-soft" x="20" y="30" width="440" height="240" rx="18"/>
    <rect class="sv-surface sv-edge" x="50" y="100" width="130" height="90" rx="12"/><text class="sv-t" x="115" y="150" text-anchor="middle">這台電腦</text>
    <rect class="sv-surface sv-edge" x="300" y="100" width="130" height="90" rx="12"/><text class="sv-t" x="365" y="142" text-anchor="middle">NVR</text><text class="sv-t m" x="365" y="162" text-anchor="middle">192.168.1.20</text>
    <path class="sv-line" d="M180 145 H300"/><circle class="sv-ok" cx="240" cy="145" r="7"/><text class="sv-t m" x="240" y="175" text-anchor="middle">同一個網路</text></svg>`,
  rtsp: `<svg viewBox="0 0 480 300" role="img"><rect class="sv-soft" x="20" y="30" width="440" height="240" rx="18"/>
    <rect class="sv-surface sv-edge" x="60" y="70" width="360" height="160" rx="12"/>
    <text class="sv-t" x="84" y="104">網路設定 › 連接埠</text>
    <rect class="sv-track" x="84" y="124" width="150" height="28" rx="8"/><text class="sv-t m" x="96" y="143">RTSP 埠 554</text>
    <rect class="sv-acc" x="84" y="172" width="44" height="24" rx="12"/><circle class="sv-surface" cx="116" cy="184" r="9"/><text class="sv-t" x="140" y="189">啟用 RTSP</text></svg>`,
  account: `<svg viewBox="0 0 480 300" role="img"><rect class="sv-soft" x="20" y="30" width="440" height="240" rx="18"/>
    <rect class="sv-surface sv-edge" x="110" y="70" width="260" height="160" rx="12"/>
    <circle class="sv-track" cx="240" cy="116" r="22"/><path class="sv-ico" d="M226 116a14 14 0 0 1 28 0"/>
    <rect class="sv-track" x="150" y="156" width="180" height="22" rx="8"/><text class="sv-t m" x="162" y="172">帳號 admin</text>
    <rect class="sv-track" x="150" y="188" width="180" height="22" rx="8"/><text class="sv-t m" x="162" y="204">密碼 ••••••••</text></svg>`,
  codec: `<svg viewBox="0 0 480 300" role="img"><rect class="sv-soft" x="20" y="30" width="440" height="240" rx="18"/>
    <rect class="sv-surface sv-edge" x="60" y="70" width="170" height="160" rx="12"/><text class="sv-t" x="145" y="104" text-anchor="middle">主碼流</text><text class="sv-t m" x="145" y="130" text-anchor="middle">高畫質（全螢幕用）</text>
    <rect class="sv-surface sv-edge" x="250" y="70" width="170" height="160" rx="12"/><text class="sv-t" x="335" y="104" text-anchor="middle">子碼流</text><text class="sv-t m" x="335" y="130" text-anchor="middle">畫面牆用</text>
    <rect class="sv-ok" x="285" y="160" width="100" height="30" rx="15"/><text class="sv-t w" x="335" y="180" text-anchor="middle">H.264</text></svg>`,
  channel: `<svg viewBox="0 0 480 300" role="img"><rect class="sv-soft" x="20" y="30" width="440" height="240" rx="18"/>
    <rect class="sv-surface sv-edge" x="60" y="60" width="160" height="90" rx="10"/><text class="sv-t" x="140" y="110" text-anchor="middle">CH1 前門</text>
    <rect class="sv-surface sv-edge" x="260" y="60" width="160" height="90" rx="10"/><text class="sv-t" x="340" y="110" text-anchor="middle">CH2 後門</text>
    <rect class="sv-surface sv-edge" x="60" y="170" width="160" height="70" rx="10"/><text class="sv-t" x="140" y="210" text-anchor="middle">CH3 車道</text>
    <rect class="sv-surface sv-edge" x="260" y="170" width="160" height="70" rx="10"/><text class="sv-t" x="340" y="210" text-anchor="middle">CH4 …</text></svg>`,
};

const steps = (...items) => h('ol', { class: 'nc-do' }, items.map((t) => h('li', {}, t)));
const tip = (...c) => h('p', { class: 'nc-tip' }, c);

/**
 * @param {object} uiLib  ctx.ui.load() 的結果
 * @param {Array<{id: string, name: string, notes: string}>} [templates]
 */
export function createRtspGuide(uiLib, templates = []) {
  const brandRows = templates.filter((t) => t.id !== 'custom').map((t) => h('li', {}, h('strong', {}, `${t.name}：`), t.notes));
  return uiLib.createGuide({
    title: '怎麼找 RTSP 設定',
    subtitle: '大約 3 分鐘，照著 NVR 的設定畫面找即可',
    steps: [
      {
        label: '找到 NVR 的位址',
        art: ART.network,
        body: h('div', {}, steps(
          '在 NVR 本機畫面的「網路」設定，或路由器的裝置清單，找到 NVR 的 IP 位址（例如 192.168.1.20）。',
          '確認這台電腦和 NVR 在同一個網路（同一台路由器底下）。',
          '建議在路由器把 NVR 的 IP 固定下來，之後才不會變動。',
        ), tip('RTSP 預設埠是 554。如果你的 NVR 改過，請填實際的埠。')),
      },
      {
        label: '開啟 RTSP',
        art: ART.rtsp,
        body: h('div', {}, steps(
          '登入 NVR 的設定（本機畫面或瀏覽器），找到「網路」→「連接埠」（或「進階設定」）。',
          '確認有 RTSP 功能並已啟用，記下 RTSP 埠。',
        ), h('ul', { class: 'cam-guide-list' }, brandRows)),
      },
      {
        label: '帳號與密碼',
        art: ART.account,
        body: h('div', {}, steps(
          '使用可以觀看即時影像的帳號。建議在 NVR 新增一個專用的「只能觀看」帳號給本程式用。',
          '密碼可以包含 @ # : / 等特殊符號，程式會自動處理。',
        ), tip('密碼只存在這台電腦，不會上傳，也不會出現在網頁或匯出檔中。')),
      },
      {
        label: '子碼流改 H.264',
        art: ART.codec,
        body: h('div', {}, steps(
          '在 NVR 的「編碼設定」（或「視訊」）找到「子碼流」。',
          '把編碼格式改成 H.264（不要用 H.265 / H.265+ / Smart Codec）。',
          '解析度建議 640×360 到 1280×720，影格率 10–15 即可。',
        ), tip('瀏覽器對 H.265 支援不穩，畫面牆一律使用子碼流，所以子碼流一定要是 H.264。主碼流（雙擊畫面才會用）則不受限制。')),
      },
      {
        label: '頻道編號',
        art: ART.channel,
        body: h('div', {}, steps(
          '頻道數就是 NVR 接了幾支攝影機（例如 8 路 NVR 就填 8）。',
          '頻道編號從 1 開始，和 NVR 畫面上的 CH1、CH2 對應。',
          '設定精靈會在「測試」步驟連線第 1 頻道的子碼流，成功才會繼續。',
        ), tip('連不上時，先在同一台電腦用 VLC 開啟 rtsp://帳號:密碼@NVR位址:554/… 確認 NVR 本身可用，再回來設定。')),
      },
    ],
  });
}
