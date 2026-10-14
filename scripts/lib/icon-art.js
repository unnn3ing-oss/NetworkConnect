// App 圖示與系統匣圖示的繪製：以帶號距離場（SDF）解析抗鋸齒，輸出非預乘 RGBA。
// 圖樣：一個中心節點連到三個衛星節點（網路「樞紐」），App 圖示為藍色圓角方塊上的白色圖樣。

const ACCENT = [0x00, 0x4a, 0xad];
const ACCENT_LIGHT = [0x2f, 0x7d, 0xe8];
const DANGER = [0xd9, 0x30, 0x25];

const dCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function dSegment(x, y, ax, ay, bx, by, halfWidth) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy) - halfWidth;
}
function dRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 樞紐圖樣的距離場。座標單位：整張圖為 0..1，圖樣以 (cx,cy) 為中心、scale 為半徑。 */
function glyphDistance(x, y, cx, cy, scale) {
  const hubR = 0.27 * scale;
  const satR = 0.17 * scale;
  const dist = 0.74 * scale;
  const lineHalf = 0.06 * scale;
  let d = dCircle(x, y, cx, cy, hubR);
  for (const deg of [-90, 30, 150]) {
    const a = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(a) * dist;
    const sy = cy + Math.sin(a) * dist;
    d = Math.min(d, dCircle(x, y, sx, sy, satR), dSegment(x, y, cx, cy, sx, sy, lineHalf));
  }
  return d;
}

const coverage = (d, size) => Math.max(0, Math.min(1, 0.5 - d * size));

/** 在 rgba（非預乘）上以 color 疊上一層覆蓋率 */
function over(data, i, color, cov) {
  if (cov <= 0) return;
  const a0 = data[i + 3] / 255;
  const a = cov + a0 * (1 - cov);
  for (let k = 0; k < 3; k++) data[i + k] = Math.round((color[k] * cov + data[i + k] * a0 * (1 - cov)) / a);
  data[i + 3] = Math.round(a * 255);
}

function paint(size, fn) {
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) fn(data, (py * size + px) * 4, (px + 0.5) / size, (py + 0.5) / size);
  }
  return { width: size, height: size, data };
}

/** App 圖示（供 .icns／.ico／1024 原圖） */
export function renderAppIcon(size) {
  return paint(size, (data, i, x, y) => {
    const inset = 0.098; // 與 macOS 圖示網格一致的留白
    const bg = dRoundRect(x, y, inset, inset, 1 - inset, 1 - inset, 0.18);
    const t = (x + y) / 2;
    const color = ACCENT_LIGHT.map((c, k) => c + (ACCENT[k] - c) * Math.min(1, Math.max(0, (t - 0.1) / 0.8)));
    over(data, i, color, coverage(bg, size));
    over(data, i, [255, 255, 255], coverage(glyphDistance(x, y, 0.5, 0.52, 0.27), size));
  });
}

/**
 * 系統匣圖示。
 * - template:true（macOS）：純黑色＋透明度，系統會依深淺色選單列自動上色；警示版在右上角多一顆實心圓點。
 * - template:false（Windows／Linux）：藍色（正常）或紅色（警示）圓角方塊＋白色圖樣。
 */
export function renderTrayGlyph(size, { template, alert }) {
  const badge = { x: 0.8, y: 0.2, r: 0.2 };
  return paint(size, (data, i, x, y) => {
    if (template) {
      let d = glyphDistance(x, y, 0.5, 0.52, 0.4);
      if (alert) {
        // 在圓點周圍挖出一圈空隙，讓警示點與圖樣分得開
        d = Math.max(d, -dCircle(x, y, badge.x, badge.y, badge.r + 0.07));
        d = Math.min(d, dCircle(x, y, badge.x, badge.y, badge.r));
      }
      over(data, i, [0, 0, 0], coverage(d, size));
      return;
    }
    const bg = dRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22);
    over(data, i, alert ? DANGER : ACCENT, coverage(bg, size));
    over(data, i, [255, 255, 255], coverage(glyphDistance(x, y, 0.5, 0.53, 0.3), size));
  });
}
