import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spread, tidyX, bandLayout, levelsByY, treeOrder, routeOrthogonal, toSegments, crossFloorVias } from '../../../web/modules/topology/layout.js';

const GAP = 100;
const it = (id, level, x, parent = null, group = null) => ({ id, level, x, parent, group });

describe('spread', () => {
  test('已經夠寬的期望位置不動；太擠的會被推開且保持順序與最小間距', () => {
    assert.deepEqual(spread([0, 200, 400], GAP), [0, 200, 400]);
    const p = spread([0, 10, 20], GAP);
    for (let i = 1; i < p.length; i++) assert.ok(p[i] - p[i - 1] >= GAP - 1e-9);
    assert.ok(Math.abs((p[0] + p[2]) / 2 - 10) < 1e-9); // 整體仍以原中心為準
  });
  test('空陣列', () => assert.deepEqual(spread([], GAP), []));
});

describe('tidyX', () => {
  test('父節點置中在子節點上方；同層不重疊', () => {
    const items = [it('r', 0, 0), it('a', 1, -300), it('b', 1, 300), it('a1', 2, 0, 'a'), it('a2', 2, 10, 'a'), it('b1', 2, 20, 'b')];
    const x = tidyX(items, { gap: GAP });
    assert.ok(Math.abs(x.get('a') - (x.get('a1') + x.get('a2')) / 2) < 1e-6);
    for (const level of [[1, ['a', 'b']], [2, ['a1', 'a2', 'b1']]]) {
      const xs = level[1].map((id) => x.get(id)).sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= GAP - 1e-6, `level ${level[0]}`);
    }
  });

  test('葉節點貼近上游：離上游很遠的原始位置會被拉回', () => {
    const items = [it('r', 0, 0), it('a', 1, 0, 'r'), it('far', 2, 900, 'a')];
    const x = tidyX(items, { gap: GAP });
    assert.ok(Math.abs(x.get('far') - x.get('a')) < 1e-6);
  });

  test('保持原本的左右順序（不產生交叉）', () => {
    const items = [it('r', 0, 0), it('a', 1, -50, 'r'), it('b', 1, 50, 'r'), it('a1', 2, -10, 'a'), it('b1', 2, 10, 'b')];
    const x = tidyX(items, { gap: GAP });
    assert.ok(x.get('a') < x.get('b') && x.get('a1') < x.get('b1'));
  });

  test('多根與只有一個節點', () => {
    const x = tidyX([it('a', 0, 5), it('b', 0, 6)], { gap: GAP });
    assert.ok(x.get('b') - x.get('a') >= GAP - 1e-6);
    assert.equal(tidyX([it('only', 0, 42)]).get('only'), 42);
  });
});

describe('bandLayout（依樓層分群）', () => {
  const items = [
    { id: 'm', x: 0, parent: null, group: 'f1' },
    { id: 'r', x: 0, parent: 'm', group: 'f1' },
    { id: 'p', x: 80, parent: 'r', group: 'f1' },
    { id: 'c1', x: 160, parent: 'p', group: 'f2' }, // 上游在 f1 → f2 的本地根
    { id: 'c2', x: 260, parent: 'p', group: 'f2' },
    { id: 'ph', x: 360, parent: 'c1', group: 'f2' },
    { id: 'l', x: 500, parent: 'ph', group: 'f3' },
  ];

  test('各樓層是由上而下互不重疊的橫向帶；同樓層深度由本地根算起', () => {
    const pos = bandLayout(items, { gap: GAP, rowGap: 100, bandGap: 60, groupOrder: ['f1', 'f2', 'f3'] });
    const ys = (g) => items.filter((i) => i.group === g).map((i) => pos.get(i.id).y);
    assert.ok(Math.max(...ys('f1')) < Math.min(...ys('f2')));
    assert.ok(Math.max(...ys('f2')) < Math.min(...ys('f3')));
    assert.equal(pos.get('c1').y, pos.get('c2').y); // 兩個本地根同一列
    assert.ok(pos.get('ph').y > pos.get('c1').y);
  });

  test('同一帶內同列設備不重疊；每條帶水平置中對齊', () => {
    const pos = bandLayout(items, { gap: GAP, groupOrder: ['f1', 'f2', 'f3'] });
    assert.ok(Math.abs(pos.get('c1').x - pos.get('c2').x) >= GAP - 1e-6);
    const mid = (g) => {
      const xs = items.filter((i) => i.group === g).map((i) => pos.get(i.id).x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    assert.ok(Math.abs(mid('f1')) < 1e-6 && Math.abs(mid('f2')) < 1e-6 && Math.abs(mid('f3')) < 1e-6);
  });

  test('沒有設備的樓層被略過', () => {
    const pos = bandLayout(items.filter((i) => i.group === 'f1'), { groupOrder: ['f1', 'f2'] });
    assert.equal(pos.size, 3);
  });
});

describe('levelsByY', () => {
  test('相同 y 為同一層，由上而下編號', () => {
    const lv = levelsByY([200, 0, 100, 100]);
    assert.deepEqual([0, 100, 200].map(lv), [0, 1, 2]);
  });
});

describe('treeOrder', () => {
  test('層級依上游關係；葉節點各佔一格，父節點置中於下游上方', () => {
    const o = treeOrder([{ id: 'r' }, { id: 'a', parent: 'r' }, { id: 'b', parent: 'r' }, { id: 'a1', parent: 'a' }, { id: 'a2', parent: 'a' }], { gap: GAP });
    assert.deepEqual([...o].map(([id, v]) => [id, v.level]), [['r', 0], ['a', 1], ['a1', 2], ['a2', 2], ['b', 1]]);
    assert.equal(o.get('a1').x, 0);
    assert.equal(o.get('a2').x, GAP);
    assert.equal(o.get('b').x, 2 * GAP);
    assert.equal(o.get('a').x, GAP / 2);
    assert.equal(o.get('r').x, (GAP / 2 + 2 * GAP) / 2);
  });

  test('上游不存在、指向自己、形成迴圈 → 視為根節點；每台設備都有位置', () => {
    const o = treeOrder([{ id: 'x', parent: 'ghost' }, { id: 's', parent: 's' }, { id: 'p', parent: 'q' }, { id: 'q', parent: 'p' }], { gap: GAP });
    assert.equal(o.size, 4);
    for (const v of o.values()) assert.equal(v.level, 0);
  });

  test('同樣輸入永遠得到同樣結果（重新排版不會越排越大）', () => {
    const items = [{ id: 'r' }, { id: 'a', parent: 'r' }, { id: 'b', parent: 'a' }];
    assert.deepEqual([...treeOrder(items)], [...treeOrder(items)]);
  });
});

/** 把 routeOrthogonal 的結果展開成折線（含起點與終點），回傳斜線與任兩條連線重疊的段落 */
function routeProblems(nodes, edges, out) {
  const pos = out.positions;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segs = [];
  const bad = [];
  for (const e of edges) {
    const r = out.routes.get(e.id);
    const s = { ...byId.get(e.source), ...pos.get(e.source) };
    const t = { ...byId.get(e.target), ...pos.get(e.target) };
    const pts = [{ x: s.x + r.dx, y: s.y + s.h / 2 }, ...r.corners, { x: t.x, y: t.y - t.h / 2 }];
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const v = Math.abs(a.x - b.x) < 0.01;
      const h = Math.abs(a.y - b.y) < 0.01;
      if (v && h) continue;
      if (!v && !h) bad.push(`斜線 ${e.id}`);
      segs.push({ id: e.id, v, c: v ? a.x : a.y, lo: Math.min(v ? a.y : a.x, v ? b.y : b.x), hi: Math.max(v ? a.y : a.x, v ? b.y : b.x) });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = [segs[i], segs[j]];
      if (a.id !== b.id && a.v === b.v && Math.abs(a.c - b.c) < 3 && a.lo < b.hi - 0.5 && b.lo < a.hi - 0.5) bad.push(`重疊 ${a.id} / ${b.id}（${a.v ? '垂直' : '水平'}）`);
    }
  }
  return bad;
}

/** 可重現的亂數 */
function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('routeOrthogonal', () => {
  const node = (id, x, y, w = 44) => ({ id, x, y, w, h: w });

  test('一台交換器接一排設備：每條線各自的出發點與橫線高度，正下方那條是直線', () => {
    const nodes = [node('sw', 0, 0, 52), ...[-208, -104, 0, 104, 208].map((x, i) => node(`c${i}`, x, 130, 38))];
    const edges = nodes.slice(1).map((n) => ({ id: `e${n.id}`, source: 'sw', target: n.id }));
    const out = routeOrthogonal(nodes, edges);
    assert.deepEqual(routeProblems(nodes, edges, out), []);
    const dxs = edges.map((e) => out.routes.get(e.id).dx);
    assert.equal(new Set(dxs).size, dxs.length);
    assert.ok(dxs.every((d, i) => i === 0 || d > dxs[i - 1]), '出發點由左到右對應下游由左到右');
    assert.equal(out.routes.get('ec2').corners.length, 1, '正下方的那條沒有轉彎');
  });

  test('隨機樹（含跨多列與往上的連線）：沒有斜線、任兩條線都不重疊', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const items = [{ id: 'n0' }];
      const count = 6 + Math.floor(r() * 30);
      for (let i = 1; i < count; i++) items.push({ id: `n${i}`, parent: `n${Math.floor(r() * i)}` });
      const order = treeOrder(items, { gap: 104 });
      const levels = new Map(items.map((it) => [it.id, order.get(it.id).level]));
      const xs = tidyX(items.map((it) => ({ ...it, ...order.get(it.id) })), { gap: 104 });
      // 部分節點搬到別的列，模擬分群時的跨樓層（往下、往上都有）
      const maxLevel = Math.max(...levels.values()) + 3;
      const nodes = [];
      for (const it of items) {
        let lv = levels.get(it.id);
        let x = xs.get(it.id);
        const moved = Math.floor(r() * maxLevel);
        // 同一列的設備至少相隔 90px（實際排版的間距是 104）；太近就再往下一列
        if (r() < 0.15) [lv, x] = [moved, x + 52];
        while (nodes.some((n) => n.y === lv * 130 && Math.abs(n.x - x) < 90)) lv++;
        nodes.push(node(it.id, x, lv * 130, [38, 44, 52][Math.floor(r() * 3)]));
      }
      const edges = items.filter((it) => it.parent).map((it) => ({ id: `e${it.id}`, source: it.parent, target: it.id }));
      const out = routeOrthogonal(nodes, edges);
      assert.deepEqual(routeProblems(nodes, edges, out), [], `seed ${seed}`);
    }
  });

  test('橫線太多放不下：把下面的列往下推；shiftRows: false 時不動', () => {
    const nodes = [node('sw', 0, 0, 58), ...Array.from({ length: 12 }, (_, i) => node(`c${i}`, (i - 5.5) * 104, 130, 38))];
    const edges = nodes.slice(1).map((n) => ({ id: `e${n.id}`, source: 'sw', target: n.id }));
    const out = routeOrthogonal(nodes, edges);
    assert.ok(out.positions.get('c0').y > 130);
    assert.equal(out.positions.get('sw').y, 0);
    assert.deepEqual(routeProblems(nodes, edges, out), []);
    assert.equal(routeOrthogonal(nodes, edges, { shiftRows: false }).positions.get('c0').y, 130);
  });

  test('跨多列的通道避開途經的設備', () => {
    const nodes = [node('a', 0, 0), node('mid', 0, 130), node('b', 0, 260)];
    const edges = [{ id: 'e', source: 'a', target: 'b' }];
    const out = routeOrthogonal(nodes, edges);
    const lane = out.routes.get('e').corners[1].x;
    assert.ok(Math.abs(lane) >= 54);
    assert.deepEqual(routeProblems(nodes, edges, out), []);
  });
});

describe('toSegments', () => {
  test('weights 沿上游→下游方向；distances 用 Cytoscape 的法向量 (-dy, dx)', () => {
    const { weights, distances } = toSegments([{ x: 0, y: 50 }, { x: -10, y: 50 }], { x: 0, y: 0 }, { x: 0, y: 100 });
    assert.deepEqual(weights, [0.5, 0.5]);
    assert.deepEqual(distances, [0, 10]);
  });
});

describe('crossFloorVias', () => {
  const items = [
    { id: 'core', group: '2F', x: 0 },
    { id: 'ap', parent: 'core', group: '2F', x: 0, medium: 'm-wired' },
    { id: 'cam1', parent: 'core', group: '1F', x: 0, medium: 'm-poe' },
    { id: 'cam2', parent: 'core', group: '1F', x: 0, medium: 'm-poe' },
    { id: 'tv', parent: 'core', group: '1F', x: 0, medium: 'm-wired' },
    { id: 'up', parent: 'cam1', group: '2F', x: 0 },
  ];

  test('同上游＋同連線＋同目標樓層共用一個轉接點；轉接點放在上游的樓層', () => {
    const { vias, viaOf } = crossFloorVias(items, ['2F', '1F']);
    assert.equal(vias.length, 2);
    assert.equal(viaOf.get('cam1'), viaOf.get('cam2'));
    assert.notEqual(viaOf.get('cam1'), viaOf.get('tv'));
    for (const v of vias) {
      assert.equal(v.parent, 'core');
      assert.equal(v.group, '2F');
    }
  });

  test('同樓層與往上的連線不加轉接點', () => {
    const { viaOf } = crossFloorVias(items, ['2F', '1F']);
    assert.equal(viaOf.has('ap'), false);
    assert.equal(viaOf.has('up'), false);
  });
});
