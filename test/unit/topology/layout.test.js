import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spread, tidyX, bandLayout, levelsByY, treeOrder, orthogonalRoutes, crossFloorVias } from '../../../web/modules/topology/layout.js';

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

describe('orthogonalRoutes', () => {
  const pos = new Map([['sw', { x: 0 }], ['a', { x: -200 }], ['b', { x: -100 }], ['c', { x: 200 }], ['d', { x: 300 }], ['x', { x: 0 }]]);

  test('同一來源只有一種連線：從中間出發、轉折高度用基準值', () => {
    const r = orthogonalRoutes([{ id: 'e1', source: 'sw', target: 'a', medium: 'm-wired' }], pos);
    assert.deepEqual(r.get('e1'), { dx: 0, turn: 34 });
  });

  test('不同連線種類分開出發點與轉折高度；同種共用；左邊那組從左邊出發', () => {
    const r = orthogonalRoutes([
      { id: 'w1', source: 'sw', target: 'c', medium: 'm-wired' },
      { id: 'w2', source: 'sw', target: 'd', medium: 'm-wired' },
      { id: 'p1', source: 'sw', target: 'a', medium: 'm-poe' },
      { id: 'p2', source: 'sw', target: 'b', medium: 'm-poe' },
    ], pos);
    assert.deepEqual(r.get('p1'), r.get('p2'));
    assert.deepEqual(r.get('w1'), r.get('w2'));
    assert.ok(r.get('p1').dx < r.get('w1').dx);
    assert.notEqual(r.get('p1').turn, r.get('w1').turn);
    assert.equal(r.get('p1').dx + r.get('w1').dx, 0);
  });

  test('端點不在 pos 裡的連線略過', () => {
    const r = orthogonalRoutes([{ id: 'e', source: 'sw', target: 'nope', medium: 'm-wired' }], pos);
    assert.equal(r.size, 0);
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
