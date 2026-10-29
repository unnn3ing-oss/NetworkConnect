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

/**
 * 樹狀排版的起點（取代 breadthfirst，不受目前縮放與上一次排版影響，按幾次「重新排版」結果都一樣）：
 * 由根節點依深度優先走訪，決定每台設備在第幾層（level）與起始橫向位置：
 * 葉節點依序各佔一格（gap），有下游的設備置中於下游上方，之後再交給 tidyX／bandLayout 消除重疊。
 * 上游不存在、或形成迴圈的設備視為根節點。
 * @param {{id: string, parent?: string|null}[]} items 依想要的左右順序排好
 * @returns {Map<string, {level: number, x: number}>}
 */
export function treeOrder(items, { gap = 100 } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const children = new Map();
  const roots = [];
  const reaches = (start) => {
    // 往上走，若回到自己表示迴圈
    const seen = new Set();
    for (let p = byId.get(start)?.parent; p && byId.has(p); p = byId.get(p).parent) {
      if (p === start || seen.has(p)) return false;
      seen.add(p);
    }
    return true;
  };
  for (const it of items) {
    if (it.parent && it.parent !== it.id && byId.has(it.parent) && reaches(it.id)) children.set(it.parent, [...(children.get(it.parent) ?? []), it.id]);
    else roots.push(it.id);
  }
  const out = new Map();
  let slot = 0;
  const visit = (id, level) => {
    if (out.has(id)) return;
    const node = { level, x: 0 };
    out.set(id, node);
    const kids = (children.get(id) ?? []).filter((c) => !out.has(c));
    for (const c of kids) visit(c, level + 1);
    node.x = kids.length ? kids.reduce((sum, c) => sum + out.get(c).x, 0) / kids.length : slot++ * gap;
  };
  for (const r of roots) visit(r, 0);
  // 迴圈裡的設備（理論上 graph.js 已處理）：放在最上層
  for (const it of items) visit(it.id, 0);
  return out;
}

/**
 * 直角連線的走線：同一台設備往下的連線依「連線種類」（有線、Wi-Fi、Mesh、光纖…）分組，
 * 每組各走一條主幹——從設備底部出發的位置左右錯開（dx），橫向主幹的高度也錯開（turn）。
 * 否則不同種類的連線會共用同一段線，實線、虛線、點線疊在一起分不出來。同種類的連線共用主幹沒有問題（樣式相同）。
 * @param {{id: string, source: string, target: string, medium: string}[]} edges
 * @param {Map<string, {x: number, y: number}>} pos 節點位置
 * @returns {Map<string, {dx: number, turn: number}>} dx＝出發點相對設備中心的水平位移（px）；turn＝離開設備後多遠轉彎（px）
 */
export function orthogonalRoutes(edges, pos, { stemGap = 16, baseTurn = 34, turnStep = 10 } = {}) {
  const bySource = new Map();
  for (const e of edges) {
    if (!pos.has(e.source) || !pos.has(e.target)) continue;
    const groups = bySource.get(e.source) ?? new Map();
    bySource.set(e.source, groups);
    groups.set(e.medium, [...(groups.get(e.medium) ?? []), e]);
  }
  const out = new Map();
  for (const groups of bySource.values()) {
    // 依下游設備的平均 x 由左到右排：左邊那組從左邊出發，主幹才不會互相穿過
    const list = [...groups.values()]
      .map((es) => ({ es, mid: es.reduce((s, e) => s + pos.get(e.target).x, 0) / es.length }))
      .sort((a, b) => a.mid - b.mid);
    const n = list.length;
    list.forEach(({ es }, i) => {
      const dx = n > 1 ? (i - (n - 1) / 2) * stemGap : 0;
      const turn = baseTurn + i * turnStep;
      for (const e of es) out.set(e.id, { dx, turn });
    });
  }
  return out;
}

/**
 * 依樓層分群時，跨樓層往下的連線要經過中間好幾排設備；直接拉線會穿過、擦過那些設備。
 * 這裡替「上游在上面樓層」的設備，在上游那一排的下一列預留一個看不見的轉接點（via），
 * 樹狀排版會把它當成上游的子設備，在兄弟設備之間留出空位，線就從空位往下走。
 * 同一個上游、同一種連線、同一個目標樓層的設備共用一個轉接點。
 * @param {{id: string, parent?: string|null, group: string, x: number, medium?: string}[]} items
 * @param {string[]} groupOrder 樓層由上到下的順序
 * @returns {{vias: {id: string, parent: string, group: string, x: number, medium: string}[], viaOf: Map<string, string>}}
 *   viaOf：子設備 id → 轉接點 id
 */
export function crossFloorVias(items, groupOrder) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rank = new Map(groupOrder.map((g, i) => [g, i]));
  const vias = new Map();
  const viaOf = new Map();
  for (const it of items) {
    const p = it.parent ? byId.get(it.parent) : null;
    if (!p || p.group === it.group) continue;
    if (!(rank.get(it.group) > rank.get(p.group))) continue; // 只處理往下的連線
    const medium = it.medium ?? 'm-other';
    const id = `via:${p.id}:${medium}:${it.group}`;
    if (!vias.has(id)) vias.set(id, { id, parent: p.id, group: p.group, x: p.x, medium });
    viaOf.set(it.id, id);
  }
  return { vias: [...vias.values()], viaOf };
}
