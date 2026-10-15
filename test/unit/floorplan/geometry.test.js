// 平面圖座標換算純函式（B4 驗收 2）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { screenToPlan, planToScreen, zoomAt, fitView, panBy, pinchView, clampScale, clampRatio, wheelFactor, MIN_SCALE, MAX_SCALE } from '../../../web/modules/floorplan/geometry.js';

const size = { width: 800, height: 500 };
const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} 與 ${b} 相差超過 ${eps}`);

describe('座標換算', () => {
  test('基本對應', () => {
    const view = { scale: 2, tx: 10, ty: 20 };
    assert.deepEqual(planToScreen({ x: 0, y: 0 }, view, size), { x: 10, y: 20 });
    assert.deepEqual(planToScreen({ x: 1, y: 1 }, view, size), { x: 1610, y: 1020 });
    assert.deepEqual(screenToPlan({ x: 810, y: 520 }, view, size), { x: 0.5, y: 0.5 });
  });

  test('縮放與平移後來回換算誤差 < 0.001（比例座標與畫面座標兩個方向）', () => {
    let view = fitView({ width: 1024, height: 640 }, size);
    view = zoomAt(view, { x: 300, y: 200 }, 3.7);
    view = panBy(view, -123.4, 57.9);
    view = zoomAt(view, { x: 900, y: 50 }, 0.31);
    view = panBy(view, 301, -88);
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.42, y: 0.31 }, { x: 0.999, y: 0.001 }]) {
      const back = screenToPlan(planToScreen(p, view, size), view, size);
      near(back.x, p.x);
      near(back.y, p.y);
    }
    for (const s of [{ x: 0, y: 0 }, { x: 512, y: 320 }, { x: 1023.5, y: 639.25 }]) {
      const back = planToScreen(screenToPlan(s, view, size), view, size);
      near(back.x, s.x);
      near(back.y, s.y);
    }
  });
});

describe('zoomAt', () => {
  test('游標下方的圖片位置縮放前後不變', () => {
    const view = { scale: 1.3, tx: -40, ty: 25 };
    const cursor = { x: 333, y: 222 };
    const before = screenToPlan(cursor, view, size);
    const after = screenToPlan(cursor, zoomAt(view, cursor, 2.5), size);
    near(after.x, before.x, 1e-9);
    near(after.y, before.y, 1e-9);
  });
  test('縮放範圍限制在 0.2–8；到達上下限後游標位置仍不變', () => {
    let v = { scale: 1, tx: 0, ty: 0 };
    const c = { x: 100, y: 100 };
    for (let i = 0; i < 50; i++) v = zoomAt(v, c, 1.5);
    assert.equal(v.scale, MAX_SCALE);
    const pinned = screenToPlan(c, v, size);
    v = zoomAt(v, c, 1.5);
    near(screenToPlan(c, v, size).x, pinned.x, 1e-9);
    for (let i = 0; i < 50; i++) v = zoomAt(v, c, 0.5);
    assert.equal(v.scale, MIN_SCALE);
  });
  test('clampScale／clampRatio', () => {
    assert.equal(clampScale(0.01), MIN_SCALE);
    assert.equal(clampScale(99), MAX_SCALE);
    assert.equal(clampScale(2), 2);
    assert.equal(clampRatio(-1), 0);
    assert.equal(clampRatio(2), 1);
    assert.equal(clampRatio(0.4), 0.4);
  });
});

describe('fitView', () => {
  test('完整置中顯示整張圖', () => {
    const vp = { width: 1000, height: 800 };
    const v = fitView(vp, size, 0);
    near(v.scale, 1.25, 1e-9);
    const tl = planToScreen({ x: 0, y: 0 }, v, size);
    const br = planToScreen({ x: 1, y: 1 }, v, size);
    near(tl.x, vp.width - br.x, 1e-9);
    near(tl.y, vp.height - br.y, 1e-9);
    assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= vp.width && br.y <= vp.height);
  });
  test('畫布極小時仍不低於最小倍率', () => assert.equal(fitView({ width: 20, height: 20 }, { width: 100000, height: 100000 }).scale, MIN_SCALE));
});

describe('pinchView', () => {
  test('兩指間距加倍 → 倍率加倍，且中點下方的圖片位置不動', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    const start = [{ x: 100, y: 100 }, { x: 200, y: 100 }];
    const cur = [{ x: 50, y: 100 }, { x: 250, y: 100 }];
    const v = pinchView(view, start, cur);
    near(v.scale, 2, 1e-9);
    const m0 = screenToPlan({ x: 150, y: 100 }, view, size);
    const m1 = screenToPlan({ x: 150, y: 100 }, v, size);
    near(m0.x, m1.x, 1e-9);
    near(m0.y, m1.y, 1e-9);
  });
  test('兩指一起平移 → 只平移不縮放', () => {
    const v = pinchView({ scale: 1.5, tx: 5, ty: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 30, y: 40 }, { x: 40, y: 40 }]);
    near(v.scale, 1.5, 1e-9);
    near(v.tx, 35, 1e-9);
    near(v.ty, 45, 1e-9);
  });
});

test('wheelFactor：向上滾放大、向下滾縮小，且有上限', () => {
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  near(wheelFactor(-100) * wheelFactor(100), 1, 1e-9);
  assert.equal(wheelFactor(-99999), wheelFactor(-300));
});
