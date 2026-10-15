// 排版後處理（純函式）：breadthfirst 決定每台設備在第幾層與同層順序，這裡再把每層的 x 座標整理成
// 「父節點置中在子節點上方、同層不重疊」的樹狀圖，並在「依樓層分群」時讓各樓層佔據互不重疊的直條。
// 不依賴 Cytoscape，可直接在 Node 測試。

/**
 * 同層排列：每個節點有期望位置 desired，相鄰至少相隔 gap，總偏移平方和最小（pool-adjacent-violators）。
 * @param {number[]} desired 已依左右順序排好
 * @returns {number[]}
 */
export function spread(desired, gap) {
  const z = desired.map((d, i) => d - i * gap);
  const blocks = []; // {sum, n}
  for (const v of z) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + out.length * gap);
  return out;
}

/**
 * @param {{id: string, level: number, x: number, parent?: string|null}[]} items
 *   level＝第幾層（0 為根）、x＝breadthfirst 給的橫向位置（用來決定同層左右順序）、parent＝上游設備 id
 * @returns {Map<string, number>} id → 新的 x（父節點置中於子節點上方；沒有子節點的設備貼近自己的上游；同層至少相隔 gap）
 */
export function tidyX(items, { gap = 100, passes = 2 } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const children = new Map();
  for (const it of items) if (it.parent && byId.has(it.parent)) children.set(it.parent, [...(children.get(it.parent) ?? []), it.id]);
  const levels = new Map();
  for (const it of items) levels.set(it.level, [...(levels.get(it.level) ?? []), it]);
  const order = [...levels.keys()].sort((a, b) => b - a); // 由深到淺
  const rows = new Map([...levels].map(([lv, row]) => [lv, row.slice().sort((a, b) => a.x - b.x)]));
  let x = new Map(items.map((i) => [i.id, i.x]));

  for (let pass = 0; pass < passes; pass++) {
    const prev = x;
    x = new Map(prev);
    for (const level of order) {
      const row = rows.get(level);
      const desired = row.map((it) => {
        const kids = children.get(it.id);
        if (kids?.length) return kids.reduce((sum, k) => sum + x.get(k), 0) / kids.length;
        // 葉節點：靠近自己的上游（上一輪的位置），不要散落在別處讓連線橫跨整張圖
        return it.parent && prev.has(it.parent) ? prev.get(it.parent) : prev.get(it.id);
      });
      const placed = spread(desired, gap);
      row.forEach((it, i) => x.set(it.id, placed[i]));
    }
  }
  return x;
}

/**
 * 依樓層分群的排版：每層樓一條橫向帶狀區，由上而下依 groupOrder 排；帶內各自做樹狀整理
 * （上游在別層樓的設備視為該樓層的本地根），跨樓層的連線只剩上下方向，樓層外框不會互相重疊。
 * @param {{id: string, x: number, parent?: string|null, group: string}[]} items
 * @returns {Map<string, {x: number, y: number}>}
 */
export function bandLayout(items, { gap = 100, rowGap = 100, bandGap = 90, groupOrder = [] } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = new Map();
  const depthOf = (it, seen = new Set()) => {
    if (depth.has(it.id)) return depth.get(it.id);
    const p = it.parent ? byId.get(it.parent) : null;
    let d = 0;
    if (p && p.group === it.group && !seen.has(p.id)) d = depthOf(p, new Set([...seen, it.id])) + 1;
    depth.set(it.id, d);
    return d;
  };
  items.forEach((it) => depthOf(it));

  const out = new Map();
  const groups = groupOrder.filter((g) => items.some((i) => i.group === g));
  const spans = [];
  let top = 0;
  for (const g of groups) {
    const members = items.filter((i) => i.group === g);
    const xs = tidyX(members.map((m) => ({ id: m.id, level: depth.get(m.id), x: m.x, parent: m.parent })), { gap });
    const rowsInBand = Math.max(...members.map((m) => depth.get(m.id))) + 1;
    for (const m of members) out.set(m.id, { x: xs.get(m.id), y: top + depth.get(m.id) * rowGap });
    const vals = members.map((m) => xs.get(m.id));
    spans.push({ g, mid: (Math.min(...vals) + Math.max(...vals)) / 2 });
    top += (rowsInBand - 1) * rowGap + bandGap + rowGap;
  }
  // 每條帶的水平中心對齊，跨樓層的連線才不會一路斜到邊緣
  for (const { g, mid } of spans) for (const m of items.filter((i) => i.group === g)) out.get(m.id).x -= mid;
  return out;
}

/** 依 y 座標把節點分層（相同 y 為同一層，由上而下 0,1,2…） */
export function levelsByY(ys, tolerance = 1) {
  const sorted = [...new Set(ys.map((y) => Math.round(y / tolerance)))].sort((a, b) => a - b);
  return (y) => sorted.indexOf(Math.round(y / tolerance));
}
