// 靜態 inline SVG 圖示集（24×24、線條風格、currentColor）。不載入任何外部資源，符合 CSP。
// 用法：icon('router') 取得 <svg>；iconSvg('router') 取得字串；iconNames 為全部名稱。
import { parseSvg } from './util.js';

const P = {
  // ---- 內建設備類別（對應 15 個 builtin categories）----
  modem: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01"/><circle cx="12" cy="6" r="3"/><path d="M12 9v4"/>',
  router: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01"/><path d="M7 13 5 5M17 13l2-8"/>',
  mesh: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m6.5 6.5 3.4 3.4M17.5 6.5l-3.4 3.4M6.5 17.5l3.4-3.4M17.5 17.5l-3.4-3.4"/>',
  switch: '<rect x="2.5" y="8" width="19" height="9" rx="2"/><path d="M6.5 11.5v2.5M10 11.5v2.5M14 11.5v2.5M17.5 11.5v2.5"/>',
  'poe-switch': '<rect x="2.5" y="12" width="19" height="8" rx="2"/><path d="M6.5 15.5V18M10 15.5V18M14 15.5V18M17.5 15.5V18"/><path d="M13 2.5 9 8.5h3.5L11 11.5l5-6h-3.5z"/>',
  ap: '<path d="M4 20a8 8 0 0 1 16 0z"/><path d="M8.5 8.5a5 5 0 0 1 7 0M6 6a8.5 8.5 0 0 1 12 0"/>',
  nvr: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M13 10.5h5M13 13.5h3"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/>',
  computer: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m8 21 1-4M16 21l-1-4M9 21h6"/>',
  'smart-home': '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9.5 15a3.5 3.5 0 0 1 5 0"/><path d="M12 18h.01"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  nas: '<rect x="4" y="3" width="16" height="8" rx="2"/><rect x="4" y="13" width="16" height="8" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/>',
  other: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',

  // ---- 主導覽 ----
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  topology: '<rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="2.5" y="16" width="6" height="5" rx="1.2"/><rect x="15.5" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M5.5 16v-4h13v4"/>',
  floorplan: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v7M3 12h9M12 14v7M16 12h5"/>',
  inventory: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M9 21h6M12 17v4"/><path d="M10.5 8v5l4-2.5z"/>',
  status: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',

  // ---- 通用 ----
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
  edit: '<path d="m4 20 1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="m14.5 6.5 3 3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  wifi: '<path d="M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10.5 10.5 0 0 1 13 0M8.8 16a6 6 0 0 1 6.4 0"/><path d="M12 19.5h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

// 別名：讓模組可以用較口語的名稱
const ALIAS = { devices: 'inventory', cameras: 'monitor', gear: 'settings', delete: 'trash', add: 'plus', x: 'close' };
for (const [a, b] of Object.entries(ALIAS)) P[a] = P[b];

export const categoryIcons = ['modem', 'router', 'mesh', 'switch', 'poe-switch', 'ap', 'nvr', 'camera', 'computer', 'phone', 'tv', 'smart-home', 'printer', 'nas', 'other'];
export const navIcons = ['overview', 'topology', 'floorplan', 'inventory', 'monitor', 'status', 'settings', 'home', 'import', 'devices', 'cameras'];
export const iconNames = Object.keys(P);

/** 圖示的 SVG 字串（未知名稱退回 other）。 */
export function iconSvg(name, size = 20) {
  const body = P[name] || P.other;
  return `<svg class="nc-icon" data-icon="${P[name] ? name : 'other'}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${body}</svg>`;
}

/** 回傳 <svg> 元素。有 title 時為 role=img＋aria-label，否則 aria-hidden。 */
export function icon(name, { size = 20, title } = {}) {
  const svg = parseSvg(iconSvg(name, size));
  if (title) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title); }
  else svg.setAttribute('aria-hidden', 'true');
  return svg;
}
