// Cytoscape 樣式。顏色一律來自 web/ui 的 CSS 變數（readColors），主題切換時重新讀取並 cy.style(buildStyle(...))。

/** 要從 CSS 變數讀取的顏色 → 變數名稱 */
const VARS = {
  text: '--text',
  muted: '--muted',
  border: '--border',
  surface: '--surface',
  accent: '--accent',
  warn: '--warn',
  up: '--st-up',
  down: '--st-down',
  offline: '--st-offline',
  unknown: '--st-unknown',
  disabled: '--st-disabled',
};

/** 讀 :root 目前（含主題）的顏色；讀不到時退回合理的預設，避免 Cytoscape 收到空字串而報錯 */
export function readColors(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const fallback = { text: '#1f2a3d', muted: '#6b7890', border: '#c9d4ea', surface: '#ffffff', accent: '#004aad', warn: '#b7791f', up: '#16a34a', down: '#d93636', offline: '#8b97ab', unknown: '#e0a100', disabled: '#c3cbd9' };
  const out = {};
  for (const [k, v] of Object.entries(VARS)) out[k] = cs.getPropertyValue(v).trim() || fallback[k];
  return out;
}

const FONT = 'system-ui, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';

/**
 * @param {ReturnType<typeof readColors>} c
 * @param {{edgeStyle?: 'straight'|'orthogonal'}} [opts] straight＝直線連線；orthogonal＝直角連線（只走水平、垂直）
 */
export function buildStyle(c, { edgeStyle = 'straight' } = {}) {
  const orthogonal = edgeStyle === 'orthogonal';
  const status = (cls, color) => ({ selector: `node.${cls}`, style: { 'background-color': color } });
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        shape: 'ellipse',
        width: 44,
        height: 44,
        'background-color': c.unknown,
        'background-image': 'data(iconUrl)',
        'background-fit': 'none',
        'background-width': '55%',
        'background-height': '55%',
        'border-width': 3,
        'border-color': c.surface,
        color: c.text,
        'font-family': FONT,
        'font-size': 12,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'ellipsis',
        'text-max-width': 96,
        'text-background-color': c.surface,
        'text-background-opacity': 0.82,
        'text-background-padding': 2,
        'text-background-shape': 'roundrectangle',
        'min-zoomed-font-size': 8,
        'overlay-opacity': 0,
      },
    },
    { selector: 'node.tier-core', style: { width: 58, height: 58, shape: 'round-rectangle', 'font-weight': 700 } },
    { selector: 'node.tier-distribution', style: { width: 52, height: 52, shape: 'round-rectangle' } },
    { selector: 'node.tier-access', style: { width: 46, height: 46 } },
    { selector: 'node.tier-endpoint', style: { width: 38, height: 38 } },
    status('st-up', c.up),
    status('st-down', c.down),
    status('st-offline', c.offline),
    status('st-unknown', c.unknown),
    status('st-disabled', c.disabled),
    // 上游不存在／迴圈：虛線警示框
    { selector: 'node.orphan', style: { 'border-style': 'dashed', 'border-color': c.warn, 'border-width': 4 } },
    { selector: 'node:selected', style: { 'border-color': c.accent, 'border-width': 4 } },
    { selector: 'node.faded', style: { opacity: 0.16 } },
    // 樓層 compound
    {
      selector: 'node.floor',
      style: {
        shape: 'round-rectangle',
        'background-color': c.accent,
        'background-opacity': 0.05,
        'background-image': 'none',
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': c.border,
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'left',
        'text-margin-x': 12,
        'text-margin-y': 22,
        'text-background-opacity': 0,
        'font-size': 14,
        'font-weight': 700,
        color: c.muted,
        padding: 28,
        'min-zoomed-font-size': 0,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'curve-style': 'bezier',
        'line-color': c.muted,
        'line-style': 'solid',
        'target-arrow-shape': 'none',
        // 標籤放在靠近下游設備的一端：扇形連線（例如 PoE 交換器接多台攝影機）時，各標籤才不會擠在一起
        'target-label': 'data(label)',
        'target-text-offset': 34,
        'target-text-rotation': 'autorotate',
        'font-family': FONT,
        'font-size': 10,
        color: c.muted,
        'text-background-color': c.surface,
        'text-background-opacity': 0.9,
        'text-background-padding': 2,
        'text-background-shape': 'roundrectangle',
        'min-zoomed-font-size': 9, // 縮太小時隱藏邊標籤
        'overlay-opacity': 0,
      },
    },
    { selector: 'edge.m-ethernet', style: { 'line-color': c.muted } },
    { selector: 'edge.m-fiber', style: { 'line-color': c.accent, width: 3 } },
    { selector: 'edge.m-wifi', style: { 'line-style': 'dashed', 'line-dash-pattern': [7, 5], 'line-color': c.muted } },
    { selector: 'edge.m-mesh', style: { 'line-style': 'dashed', 'line-dash-pattern': [3, 4], 'line-color': c.accent } },
    { selector: 'edge.m-poe', style: { 'line-color': c.warn, color: c.warn } },
    { selector: 'edge.m-other', style: { 'line-color': c.disabled } },
    { selector: 'edge.faded', style: { opacity: 0.12 } },
    // 直角連線：從上游往下走到兩層中間再橫移、最後垂直進入下游；標籤保持水平
    ...(orthogonal
      ? [{ selector: 'edge', style: { 'curve-style': 'taxi', 'taxi-direction': 'downward', 'taxi-turn': '50%', 'taxi-radius': 6, 'target-text-rotation': 'none', 'target-text-offset': 30 } }]
      : []),
  ];
}
