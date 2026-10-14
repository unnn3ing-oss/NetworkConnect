// 安裝教學的內容：Mac（Apple 晶片）與 Windows 兩條路線。純資料與 SVG 字串，沒有 DOM 相依（方便測試）。
// 示意圖只用 web/ui/guide.css 末段提供的 class 上色（sv-surface sv-soft sv-track sv-acc sv-ok sv-edge sv-line sv-ico sv-t），
// 不用行內 style，會通過 A1 guide 的 SVG 淨化。

const W = 480;
const H = 300;
const svg = (inner) =>
  `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img">${inner}</svg>`;

// ---- 小積木 ----
const win = (x, y, w, h, title = '') =>
  `<rect class="sv-surface" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>` +
  `<rect class="sv-edge" x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>` +
  `<circle class="sv-track" cx="${x + 18}" cy="${y + 18}" r="5"/><circle class="sv-track" cx="${x + 34}" cy="${y + 18}" r="5"/><circle class="sv-track" cx="${x + 50}" cy="${y + 18}" r="5"/>` +
  (title ? `<text class="sv-t m" x="${x + w / 2}" y="${y + 22}" text-anchor="middle">${title}</text>` : '');
const bar = (x, y, w, h = 8) => `<rect class="sv-track" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
const btn = (x, y, w, h, label, filled = true) =>
  filled
    ? `<rect class="sv-acc" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><text class="sv-t w" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${label}</text>`
    : `<rect class="sv-surface" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><rect class="sv-edge" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><text class="sv-t" x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle">${label}</text>`;
/** 強調圈（脈動以外不用動畫，避免 prefers-reduced-motion 問題） */
const ring = (x, y, w, h, r = 18) => `<rect class="sv-line" x="${x - 5}" y="${y - 5}" width="${w + 10}" height="${h + 10}" rx="${r}"/>`;
const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = (d) => (x2 - Math.cos(a + d) * 10).toFixed(1);
  const hy = (d) => (y2 - Math.sin(a + d) * 10).toFixed(1);
  return `<path class="sv-line" d="M${x1} ${y1}L${x2} ${y2}M${hx(0.5)} ${hy(0.5)}L${x2} ${y2}L${hx(-0.5)} ${hy(-0.5)}"/>`;
};
const badge = (cx, cy, n) => `<circle class="sv-acc" cx="${cx}" cy="${cy}" r="13"/><text class="sv-t w" x="${cx}" y="${cy + 4.5}" text-anchor="middle">${n}</text>`;
const hub = (cx, cy, s = 1) =>
  `<g><path class="sv-ico" d="M${cx} ${cy}L${cx} ${cy - 30 * s}M${cx} ${cy}L${cx - 26 * s} ${cy + 15 * s}M${cx} ${cy}L${cx + 26 * s} ${cy + 15 * s}"/>` +
  `<circle class="sv-acc" cx="${cx}" cy="${cy}" r="${10 * s}"/><circle class="sv-soft" cx="${cx}" cy="${cy - 30 * s}" r="${7 * s}"/><circle class="sv-soft" cx="${cx - 26 * s}" cy="${cy + 15 * s}" r="${7 * s}"/><circle class="sv-soft" cx="${cx + 26 * s}" cy="${cy + 15 * s}" r="${7 * s}"/>` +
  `<circle class="sv-ico" cx="${cx}" cy="${cy - 30 * s}" r="${7 * s}"/><circle class="sv-ico" cx="${cx - 26 * s}" cy="${cy + 15 * s}" r="${7 * s}"/><circle class="sv-ico" cx="${cx + 26 * s}" cy="${cy + 15 * s}" r="${7 * s}"/></g>`;
const phone = (x, y, w = 96, h = 190) =>
  `<rect class="sv-surface" x="${x}" y="${y}" width="${w}" height="${h}" rx="18"/><rect class="sv-edge" x="${x}" y="${y}" width="${w}" height="${h}" rx="18"/>` +
  `<rect class="sv-track" x="${x + w / 2 - 14}" y="${y + 8}" width="28" height="5" rx="2.5"/>`;
/** 示意用 QR（只是裝飾，不能掃） */
const qr = (x, y, s = 72) => {
  const c = s / 9;
  const cells = ['111111101', '100000101', '101110101', '101110100', '101110110', '100000101', '111111101', '000101010', '110010111'];
  let out = `<rect class="sv-surface" x="${x - 6}" y="${y - 6}" width="${s + 12}" height="${s + 12}" rx="8"/><rect class="sv-edge" x="${x - 6}" y="${y - 6}" width="${s + 12}" height="${s + 12}" rx="8"/>`;
  cells.forEach((row, r) => [...row].forEach((v, col) => { if (v === '1') out += `<rect class="sv-acc" x="${(x + col * c).toFixed(1)}" y="${(y + r * c).toFixed(1)}" width="${c.toFixed(1)}" height="${c.toFixed(1)}"/>`; }));
  return out;
};
const dialog = (x, y, w, h, title, lines, buttons) =>
  `<rect class="sv-surface" x="${x}" y="${y}" width="${w}" height="${h}" rx="16"/><rect class="sv-edge" x="${x}" y="${y}" width="${w}" height="${h}" rx="16"/>` +
  `<text class="sv-t" x="${x + 18}" y="${y + 30}">${title}</text>` +
  lines.map((l, i) => `<text class="sv-t m" x="${x + 18}" y="${y + 52 + i * 17}">${l}</text>`).join('') +
  buttons;

// ---- 示意圖 ----
const art = {
  macDownload: svg(
    `${win(24, 30, 250, 170, 'GitHub Releases')}${bar(48, 70, 130)}${bar(48, 88, 190, 6)}${bar(48, 102, 160, 6)}` +
      `${btn(48, 126, 190, 30, '下載 mac-arm64.dmg')}${ring(48, 126, 190, 30, 20)}` +
      `<rect class="sv-soft" x="292" y="40" width="164" height="150" rx="16"/>` +
      `<rect class="sv-acc" x="308" y="76" width="56" height="56" rx="14"/>${hub(336, 104, 0.55)}` +
      `<rect class="sv-surface" x="386" y="76" width="56" height="56" rx="14"/><rect class="sv-edge" x="386" y="76" width="56" height="56" rx="14"/><text class="sv-t m" x="414" y="108" text-anchor="middle">Apps</text>` +
      `${arrow(370, 104, 382, 104)}<text class="sv-t m" x="374" y="156" text-anchor="middle">拖進「應用程式」</text>` +
      `<text class="sv-t" x="${W / 2}" y="238" text-anchor="middle">只支援 Apple 晶片（M1 以後）</text><text class="sv-t m" x="${W / 2}" y="258" text-anchor="middle"> → 關於這台 Mac 看到「晶片：Apple M…」</text>`,
  ),
  macGatekeeper: svg(
    `${win(30, 24, 420, 210, '隱私權與安全性')}${bar(54, 66, 110)}${bar(54, 84, 90, 6)}` +
      `<rect class="sv-soft" x="54" y="110" width="372" height="76" rx="12"/>` +
      `<text class="sv-t" x="70" y="136">「NetworkConnect」已被阻擋，因為無法驗證開發者。</text>` +
      `${btn(300, 150, 110, 28, '仍要打開')}${ring(300, 150, 110, 28, 18)}` +
      `${badge(436, 118, 1)}${badge(436, 164, 2)}` +
      `<text class="sv-t m" x="${W / 2}" y="266" text-anchor="middle">顯示「已損毀」時：終端機執行 xattr -cr /Applications/NetworkConnect.app</text>`,
  ),
  macLocalNetwork: svg(
    `${dialog(80, 44, 320, 150, '「NetworkConnect」想要尋找並連接區域網路上的裝置', ['用來偵測家中網路設備的連線狀態', '與讀取監視器畫面'], `${btn(118, 144, 110, 30, '不允許', false)}${btn(252, 144, 110, 30, '允許')}${ring(252, 144, 110, 30, 20)}`)}` +
      `<text class="sv-t" x="${W / 2}" y="236" text-anchor="middle">按錯了？</text><text class="sv-t m" x="${W / 2}" y="256" text-anchor="middle">系統設定 → 隱私權與安全性 → 區域網路 → 開啟 NetworkConnect</text>`,
  ),
  macFirewall: svg(
    `${dialog(80, 44, 320, 150, '要允許「NetworkConnect」接受連入網路連線嗎？', ['允許後，家裡的手機才能連到這台電腦的主控台。'], `${btn(118, 144, 110, 30, '拒絕', false)}${btn(252, 144, 110, 30, '允許')}${ring(252, 144, 110, 30, 20)}`)}` +
      `${phone(206, 206, 68, 80)}<text class="sv-t m" x="${W / 2 + 70}" y="250">手機 ↔ 電腦</text>`,
  ),
  macPhone: svg(
    `<rect class="sv-surface" x="24" y="24" width="300" height="26" rx="13"/><rect class="sv-edge" x="24" y="24" width="300" height="26" rx="13"/>` +
      `<circle class="sv-ok" cx="318" cy="37" r="6"/><circle class="sv-acc" cx="296" cy="37" r="6"/><text class="sv-t m" x="40" y="42">選單列</text>` +
      `<rect class="sv-surface" x="170" y="60" width="150" height="76" rx="12"/><rect class="sv-edge" x="170" y="60" width="150" height="76" rx="12"/>` +
      `<text class="sv-t" x="184" y="86">手機連線…</text>${bar(184, 98, 100, 6)}${bar(184, 112, 80, 6)}${ring(176, 70, 138, 24, 10)}` +
      `${phone(364, 40, 96, 230)}${qr(388, 100, 48)}<text class="sv-t m" x="412" y="190" text-anchor="middle">掃描</text>` +
      `${arrow(322, 100, 360, 120)}<text class="sv-t m" x="150" y="204" text-anchor="middle">手機要連同一個 Wi-Fi</text>`,
  ),
  winDownload: svg(
    `${win(24, 30, 250, 170, 'GitHub Releases')}${bar(48, 70, 130)}${bar(48, 88, 190, 6)}${bar(48, 102, 160, 6)}` +
      `${btn(48, 126, 190, 30, '下載 win-x64.exe')}${ring(48, 126, 190, 30, 20)}` +
      `<rect class="sv-soft" x="292" y="40" width="164" height="150" rx="16"/>${hub(374, 100, 0.9)}` +
      `<text class="sv-t" x="374" y="156" text-anchor="middle">一鍵安裝</text><text class="sv-t m" x="374" y="174" text-anchor="middle">不需要系統管理員</text>` +
      `<text class="sv-t m" x="${W / 2}" y="246" text-anchor="middle">安裝在你的使用者資料夾，裝完會自動開啟</text>`,
  ),
  winSmartScreen: svg(
    `<rect class="sv-soft" x="80" y="26" width="320" height="196" rx="12"/><rect class="sv-edge" x="80" y="26" width="320" height="196" rx="12"/>` +
      `<rect class="sv-acc" x="80" y="26" width="320" height="8" rx="4"/>` +
      `<text class="sv-t" x="104" y="64">Windows 已保護您的電腦</text>` +
      `<text class="sv-t m" x="104" y="88">SmartScreen 已防止未辨識的應用程式啟動。</text>` +
      `<text class="sv-t" x="108" y="124">其他資訊</text><rect class="sv-line" x="98" y="108" width="74" height="24" rx="6"/>` +
      `${btn(236, 170, 72, 30, '仍要執行', false)}${btn(318, 170, 62, 30, '不執行', false)}${ring(236, 170, 72, 30, 18)}` +
      `${badge(94, 150, 1)}${badge(226, 150, 2)}` +
      `<text class="sv-t m" x="${W / 2}" y="258" text-anchor="middle">先按「其他資訊」，才會出現「仍要執行」</text>`,
  ),
  winFirewall: svg(
    `${dialog(60, 30, 360, 190, 'Windows 防火牆封鎖了這個應用程式的部分功能', ['允許 NetworkConnect 在這些網路上通訊：'], `<rect class="sv-soft" x="78" y="96" width="14" height="14" rx="3"/><path class="sv-ico" d="M81 103l3 3 6-7"/><text class="sv-t" x="100" y="108">私人網路（家用或工作場所）</text><rect class="sv-track" x="78" y="124" width="14" height="14" rx="3"/><text class="sv-t m" x="100" y="136">公用網路（機場、咖啡廳）— 不建議</text>${btn(270, 168, 130, 30, '允許存取')}${ring(270, 168, 130, 30, 20)}`)}` +
      `<text class="sv-t m" x="${W / 2}" y="256" text-anchor="middle">只勾「私人網路」就夠了，手機才連得到這台電腦</text>`,
  ),
  winPhone: svg(
    `<rect class="sv-surface" x="24" y="206" width="300" height="34" rx="10"/><rect class="sv-edge" x="24" y="206" width="300" height="34" rx="10"/>` +
      `<circle class="sv-acc" cx="270" cy="223" r="8"/><text class="sv-t m" x="40" y="227">工作列右下角（^ 隱藏的圖示）</text>` +
      `<rect class="sv-surface" x="150" y="106" width="150" height="76" rx="12"/><rect class="sv-edge" x="150" y="106" width="150" height="76" rx="12"/>` +
      `<text class="sv-t" x="164" y="132">手機連線…</text>${bar(164, 144, 100, 6)}${bar(164, 158, 80, 6)}${ring(156, 116, 138, 24, 10)}${arrow(270, 200, 270, 186)}` +
      `${phone(364, 40, 96, 230)}${qr(388, 100, 48)}<text class="sv-t m" x="412" y="190" text-anchor="middle">掃描</text>` +
      `${arrow(304, 130, 360, 124)}<text class="sv-t m" x="150" y="76" text-anchor="middle">手機要連同一個 Wi-Fi</text>`,
  ),
};

const RELEASES = 'https://github.com/unnn3ing-oss/NetworkConnect/releases';

/** body 欄位：intro（一段話）、items（編號步驟）、tip（提示框）。items／intro／tip 內用 `反引號` 標示程式碼。 */
export const routes = {
  mac: {
    id: 'mac',
    name: 'Mac（Apple 晶片）',
    title: '在 Mac 上安裝 NetworkConnect',
    subtitle: '約 5 分鐘・只支援 Apple 晶片（M1 以後），不支援 Intel Mac',
    steps: [
      {
        label: '下載並安裝',
        art: art.macDownload,
        body: {
          items: [
            `到 Releases 頁面下載 \`NetworkConnect-…-mac-arm64.dmg\`。`,
            '雙擊 dmg，把 NetworkConnect 拖進「應用程式」資料夾。',
            '還不要急著開啟，先看下一步。',
          ],
          tip: '不確定自己是不是 Apple 晶片？左上角  → 關於這台 Mac，「晶片」欄位寫 Apple M1／M2／M3／M4 就可以安裝。',
        },
      },
      {
        label: '放行未簽章 App',
        art: art.macGatekeeper,
        body: {
          intro: '這個 App 尚未付費簽章，第一次開啟會被 macOS 擋下，這是正常的。',
          items: [
            '雙擊開啟 NetworkConnect，出現警告後先按「完成」。',
            '打開「系統設定 → 隱私權與安全性」，往下捲到「安全性」。',
            '找到「NetworkConnect 已被阻擋」，按「仍要打開」，輸入密碼或 Touch ID。',
          ],
          tip: 'macOS 15 起不能再用「右鍵 → 打開」。如果顯示「已損毀，無法打開」，請開啟「終端機」執行：`xattr -cr /Applications/NetworkConnect.app`，再重新開啟。',
        },
      },
      {
        label: '允許區域網路',
        art: art.macLocalNetwork,
        body: {
          intro: 'App 第一次偵測家裡的設備時，macOS 會詢問「區域網路」權限。',
          items: ['出現詢問視窗時按「允許」。', '沒有這個權限，所有設備都會顯示離線。'],
          tip: '不小心按了「不允許」？到「系統設定 → 隱私權與安全性 → 區域網路」，把 NetworkConnect 打開即可。App 偵測到全部離線時也會提醒你。',
        },
      },
      {
        label: '允許防火牆',
        art: art.macFirewall,
        body: {
          intro: '要讓手機連到這台 Mac，macOS 防火牆會詢問一次是否允許連入連線。',
          items: ['出現「要允許 NetworkConnect 接受連入網路連線嗎？」時按「允許」。'],
          tip: '只想在這台 Mac 上看？可以按「拒絕」，並在選單列圖示取消「允許手機在區網連線」。',
        },
      },
      {
        label: '用手機掃 QR Code',
        art: art.macPhone,
        body: {
          items: [
            '按螢幕上方選單列的 NetworkConnect 圖示，選「手機連線…」。',
            '手機連上同一個 Wi-Fi，用相機掃描畫面上的 QR Code。',
            '建議在手機瀏覽器「加入主畫面」，之後像 App 一樣開啟。',
          ],
          tip: '關閉視窗只會隱藏到選單列，偵測會持續進行。電腦睡眠時偵測會暫停，建議用不睡眠的電腦，或在選單勾選「偵測期間防止電腦閒置睡眠」。',
        },
      },
    ],
  },
  win: {
    id: 'win',
    name: 'Windows（64 位元）',
    title: '在 Windows 上安裝 NetworkConnect',
    subtitle: '約 3 分鐘・Windows 10／11 64 位元・不需要系統管理員權限',
    steps: [
      {
        label: '下載並安裝',
        art: art.winDownload,
        body: {
          items: ['到 Releases 頁面下載 `NetworkConnect-…-win-x64.exe`。', '雙擊執行，安裝會自動完成並開啟 App。'],
          tip: '安裝在你的使用者資料夾，不需要系統管理員權限，也不會動到其他使用者。',
        },
      },
      {
        label: '放行 SmartScreen',
        art: art.winSmartScreen,
        body: {
          intro: '這個 App 尚未付費簽章，Windows 會跳出藍色的「Windows 已保護您的電腦」，這是正常的。',
          items: ['按視窗中的「其他資訊」。', '按下方出現的「仍要執行」。'],
          tip: '只有第一次安裝會出現。請確認安裝檔是從本專案的 Releases 頁面下載的。',
        },
      },
      {
        label: '允許防火牆',
        art: art.winFirewall,
        body: {
          intro: '要讓手機連到這台電腦，Windows 防火牆會詢問一次。',
          items: ['勾選「私人網路」。', '不要勾「公用網路」，按「允許存取」。'],
          tip: '不小心按了取消？到「控制台 → Windows Defender 防火牆 → 允許應用程式通過防火牆」，把 NetworkConnect 的「私人」打勾。',
        },
      },
      {
        label: '用手機掃 QR Code',
        art: art.winPhone,
        body: {
          items: [
            '按工作列右下角的 NetworkConnect 圖示（可能收在「^」裡），選「手機連線…」。',
            '手機連上同一個 Wi-Fi，用相機掃描畫面上的 QR Code。',
            '建議在手機瀏覽器「加入主畫面」，之後像 App 一樣開啟。',
          ],
          tip: '關閉視窗只會縮到系統匣，偵測會持續進行；要結束請在系統匣圖示按右鍵選「結束 NetworkConnect」。電腦睡眠時偵測會暫停。',
        },
      },
    ],
  },
};

export const RELEASES_URL = RELEASES;

/** 把含 `反引號` 的字串拆成 [{text, code}]，供以 textContent 安全組 DOM（不使用 innerHTML）。 */
export function splitInline(text) {
  return String(text)
    .split('`')
    .map((t, i) => ({ text: t, code: i % 2 === 1 }))
    .filter((p) => p.text !== '');
}
