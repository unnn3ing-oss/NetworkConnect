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

const LABEL_SPACE = 22; // 節點下方名稱佔的高度：橫線不能從名稱上穿過
const EDGE_MARGIN = 10; // 橫線離下一排節點頂端至少多遠
const TRACK_MIN = 8; // 同一段空白裡兩條橫線的最小間距；不夠就把下面的列往下推
const LANE_GAP = 8; // 跨多列的垂直線彼此間距
const LANE_CLEAR = 54; // 跨多列的垂直線離途經節點（含名稱）的最小水平距離
const NEAR = 5; // 兩條垂直線水平距離小於這個值就算疊在一起
const PAD = 4; // 同一高度的兩段橫線端點至少相隔多遠

/**
 * 直角連線走線：每條連線都只走水平、垂直，而且任兩條連線的水平段、垂直段都不會疊在一起。
 * - 從上游底部出發：同一台上游的每條連線出發點左右錯開（依下游位置由左到右排，避免互相交叉）；
 *   下游正下方的那條會對齊成一直線。出發點也會避開下一排其他設備的進線位置。
 * - 相鄰兩排：在兩排之間的空白找一條自己的橫線高度（track），橫移到下游正上方再往下進入。
 * - 跨好幾排（分群時跨樓層、或往上連）：先橫移到一條自己的垂直通道（lane），通道避開途經的設備與名稱，
 *   到下游上方那段空白再橫移進入。
 * - 同一段空白裡會互相重疊的橫線分到不同高度；高度不夠時（shiftRows）把下面的列往下推。
 * @param {{id: string, x: number, y: number, w: number, h: number}[]} nodes 節點中心與寬高
 * @param {{id: string, source: string, target: string, lane?: number}[]} edges lane＝跨多排時希望的垂直通道 x
 * @param {{shiftRows?: boolean}} [opts]
 * @returns {{routes: Map<string, {dx: number, corners: {x: number, y: number}[]}>, positions: Map<string, {x: number, y: number}>}}
 *   dx＝出發點相對上游中心的水平位移；corners＝轉角（不含起點與終點）；positions＝（推移後的）節點位置
 */
export function routeOrthogonal(nodes, edges, { shiftRows = true } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  const list = [...byId.values()];
  const ys = [...new Set(list.map((n) => Math.round(n.y)))].sort((a, b) => a - b);
  const rowOf = new Map(ys.map((y, i) => [y, i]));
  const rows = ys.map(() => []);
  for (const n of list) {
    n.row = rowOf.get(Math.round(n.y));
    rows[n.row].push(n);
  }
  const R = rows.length;
  const es = [];
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    // g1＝上游下方那段空白；g2＝下游上方那段空白（-1＝第一排上方，R-1＝最後一排下方）
    es.push({ id: e.id, s, t, lane: e.lane, g1: s.row, g2: t.row - 1, direct: t.row === s.row + 1 });
  }

  // 1. 出發點
  const bySource = new Map();
  for (const e of es) bySource.set(e.s, [...(bySource.get(e.s) ?? []), e]);
  for (const [s, out] of bySource) {
    const aim = (e) => (e.direct ? e.t.x : e.lane ?? (s.x + e.t.x) / 2);
    out.sort((a, b) => aim(a) - aim(b));
    const k = out.length;
    const half = s.w / 2 - 2;
    const step = k > 1 ? Math.min(12, Math.max(6, (s.w - 12) / (k - 1))) : 0;
    const base = out.map((_, i) => (i - (k - 1) / 2) * step);
    const finals = s.row + 1 < R ? rows[s.row + 1].map((n) => n.x) : [];
    const ok = (d) =>
      out.every((e, i) => {
        const x = s.x + base[i] + d;
        return finals.every((f) => Math.abs(x - f) >= NEAR || (e.direct && e.t.x === f && Math.abs(x - f) < 0.01));
      });
    const straighten = out
      .map((e, i) => (e.direct ? e.t.x - s.x - base[i] : null))
      .filter((d) => d !== null && base.every((b) => Math.abs(b + d) <= half))
      .sort((a, b) => Math.abs(a) - Math.abs(b));
    const tries = [...straighten];
    for (let i = 0; i <= 60; i++) tries.push(i / 2, -i / 2);
    const d = tries.find(ok) ?? 0;
    out.forEach((e, i) => {
      e.dx = base[i] + d;
      e.sx = s.x + e.dx;
    });
  }

  // 2. 跨多排的垂直通道
  const lanes = [];
  const stemsIn = (g) => es.filter((o) => o.s.row === g).map((o) => o.sx);
  for (const e of es.filter((x) => !x.direct).sort((a, b) => (a.lane ?? a.t.x) - (b.lane ?? b.t.x))) {
    const down = e.t.row > e.s.row;
    const rLo = down ? e.s.row + 1 : e.t.row;
    const rHi = down ? e.t.row - 1 : e.s.row;
    const gLo = Math.min(e.g1, e.g2);
    const gHi = Math.max(e.g1, e.g2);
    const near = [];
    for (let r = rLo; r <= rHi; r++) for (const n of rows[r]) near.push([n.x, LANE_CLEAR]);
    for (let g = gLo; g <= gHi; g++) {
      for (const x of stemsIn(g)) near.push([x, NEAR]);
      if (g + 1 < R) for (const n of rows[g + 1]) near.push([n.x, NEAR]);
    }
    for (const l of lanes) if (l.gLo <= gHi && gLo <= l.gHi) near.push([l.x, LANE_GAP - 0.5]);
    const blocked = (x) => near.some(([c, r]) => Math.abs(x - c) < r);
    const pref = e.lane ?? (e.sx + e.t.x) / 2;
    let x = pref;
    for (let i = 1; blocked(x) && i < 4000; i++) x = pref + Math.ceil(i / 2) * (i % 2 ? 1 : -1) * (LANE_GAP / 2);
    e.lx = x;
    lanes.push({ x, gLo, gHi });
  }

  // 3. 每段空白裡的橫線高度
  const segs = new Map();
  const addSeg = (g, a, b, e, key, which) => {
    if (Math.abs(a - b) < 0.5) return;
    const sg = { lo: Math.min(a, b), hi: Math.max(a, b), e, key, which };
    segs.set(g, [...(segs.get(g) ?? []), sg]);
  };
  for (const e of es) {
    const firstTo = e.direct ? e.t.x : e.lx;
    addSeg(e.g1, e.sx, firstTo, e, `${e.s.id}|${Math.sign(firstTo - e.sx)}`, 'y1');
    if (!e.direct) addSeg(e.g2, e.lx, e.t.x, e, null, 'y2');
  }
  const overlap = (a, b) => a.lo < b.hi + PAD && b.lo < a.hi + PAD;
  const count = new Map();
  for (const [g, list2] of segs) {
    // 長的放上面：同一台上游往同一側的扇形連線，越遠的越高，彼此才不會交叉
    list2.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
    const done = [];
    for (const sg of list2) {
      let t = 0;
      for (const o of done) if (sg.key && o.key === sg.key && overlap(o, sg)) t = Math.max(t, o.t + 1);
      while (done.some((o) => o.t === t && overlap(o, sg))) t++;
      sg.t = t;
      done.push(sg);
    }
    count.set(g, Math.max(...done.map((o) => o.t)) + 1);
  }

  // 4. 空白不夠放橫線時，把下面的列往下推
  const topOf = (r) => Math.min(...rows[r].map((n) => n.y - n.h / 2));
  const bottomOf = (r) => Math.max(...rows[r].map((n) => n.y + n.h / 2)) + LABEL_SPACE;
  const need = (g) => ((count.get(g) ?? 0) + 1) * TRACK_MIN;
  let acc = 0;
  for (let r = 0; r < R; r++) {
    for (const n of rows[r]) n.y += acc;
    if (shiftRows && r + 1 < R) {
      const room = topOf(r + 1) + acc - EDGE_MARGIN - bottomOf(r);
      if (room < need(r)) acc += need(r) - room;
    }
  }
  const box = (g) => {
    let top;
    let bottom;
    if (g < 0) {
      bottom = topOf(0) - EDGE_MARGIN;
      top = bottom - Math.max(40, need(g));
    } else if (g >= R - 1) {
      top = bottomOf(R - 1);
      bottom = top + Math.max(40, need(g));
    } else {
      top = bottomOf(g);
      bottom = topOf(g + 1) - EDGE_MARGIN;
      if (bottom - top < need(g)) bottom = top + need(g); // 只會在使用者拖曳後發生
    }
    return { top, bottom };
  };
  for (const [g, list2] of segs) {
    const { top, bottom } = box(g);
    const n = count.get(g);
    for (const sg of list2) sg.e[sg.which] = top + ((sg.t + 1) * (bottom - top)) / (n + 1);
  }

  // 5. 轉角
  const routes = new Map();
  for (const e of es) {
    let corners;
    if (e.direct) {
      // 對齊成一直線的那條也給一個轉角（在線上），Cytoscape 才會照著出發點畫成垂直線
      corners = e.y1 === undefined ? [{ x: e.t.x, y: (e.s.y + e.s.h / 2 + e.t.y - e.t.h / 2) / 2 }] : [{ x: e.sx, y: e.y1 }, { x: e.t.x, y: e.y1 }];
    } else {
      corners = [];
      if (e.y1 !== undefined) corners.push({ x: e.sx, y: e.y1 }, { x: e.lx, y: e.y1 });
      if (e.y2 !== undefined) corners.push({ x: e.lx, y: e.y2 }, { x: e.t.x, y: e.y2 });
    }
    routes.set(e.id, { dx: e.dx, corners });
  }
  return { routes, positions: new Map(list.map((n) => [n.id, { x: n.x, y: n.y }])) };
}

/**
 * 把絕對座標的轉角換成 Cytoscape segments 連線用的 segment-weights／segment-distances
 * （edge-distances: node-position：以上游中心 → 下游中心這條線為基準）。
 * @param {{x: number, y: number}[]} points
 * @param {{x: number, y: number}} S 上游中心
 * @param {{x: number, y: number}} T 下游中心
 */
export function toSegments(points, S, T) {
  const dx = T.x - S.x;
  const dy = T.y - S.y;
  const len2 = dx * dx + dy * dy || 1;
  const len = Math.sqrt(len2);
  return {
    weights: points.map((p) => ((p.x - S.x) * dx + (p.y - S.y) * dy) / len2),
    distances: points.map((p) => ((p.y - S.y) * dx - (p.x - S.x) * dy) / len), // Cytoscape 的法向量是 (-dy, dx)
  };
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
