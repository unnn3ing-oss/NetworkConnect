// 平面圖座標與視圖運算（純函式，無 DOM）。
// view = { scale, tx, ty }：圖片像素座標 (ix, iy) 的畫面位置 = (ix * scale + tx, iy * scale + ty)，
// 畫面位置相對於畫布（viewport）左上角。size = { width, height } 為圖片像素寬高。
// 落點以 0–1 比例儲存：ix = x * width。

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;
/** 縮小到此倍率以下就隱藏名稱標籤 */
export const LABEL_MIN_SCALE = 0.6;

export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
export const clampRatio = (n) => Math.min(1, Math.max(0, n));

/** 畫面座標 → 0–1 比例座標（不夾；超出圖片範圍會小於 0 或大於 1，由呼叫端決定要不要 clampRatio） */
export function screenToPlan(pt, view, size) {
  return { x: (pt.x - view.tx) / view.scale / size.width, y: (pt.y - view.ty) / view.scale / size.height };
}

/** 0–1 比例座標 → 畫面座標 */
export function planToScreen(p, view, size) {
  return { x: p.x * size.width * view.scale + view.tx, y: p.y * size.height * view.scale + view.ty };
}

/** 以 cursor（畫面座標）為中心縮放 factor 倍；cursor 下方的圖片位置保持不動 */
export function zoomAt(view, cursor, factor) {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, tx: cursor.x - (cursor.x - view.tx) * k, ty: cursor.y - (cursor.y - view.ty) * k };
}

export const panBy = (view, dx, dy) => ({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy });

/** 「適合畫面」：整張圖置中並完整顯示 */
export function fitView(viewport, size, padding = 16) {
  const aw = Math.max(1, viewport.width - padding * 2);
  const ah = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(aw / size.width, ah / size.height));
  return { scale, tx: (viewport.width - size.width * scale) / 2, ty: (viewport.height - size.height * scale) / 2 };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 雙指縮放：由開始時的視圖與兩指位置，計算目前兩指位置對應的視圖（縮放以中點為準，同時跟隨中點平移） */
export function pinchView(startView, startPts, curPts) {
  const d0 = dist(startPts[0], startPts[1]);
  const d1 = dist(curPts[0], curPts[1]);
  const m0 = mid(startPts[0], startPts[1]);
  const m1 = mid(curPts[0], curPts[1]);
  const scale = clampScale(d0 > 0 ? startView.scale * (d1 / d0) : startView.scale);
  const ix = (m0.x - startView.tx) / startView.scale;
  const iy = (m0.y - startView.ty) / startView.scale;
  return { scale, tx: m1.x - ix * scale, ty: m1.y - iy * scale };
}

/** 滾輪 deltaY（像素）→ 縮放倍率 */
export const wheelFactor = (deltaY) => Math.exp(-Math.max(-300, Math.min(300, deltaY)) * 0.0015);
