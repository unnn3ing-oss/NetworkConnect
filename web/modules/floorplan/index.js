// 平面圖前端模組（B4）：每層樓一張圖＋設備點；縮放平移、編輯模式放置／移動／移除、無平面圖時的格狀檢視。
// 座標換算與縮放運算在 geometry.js、資料整理在 model.js（皆為純函式，有單元測試）。
// 所有文字以 textContent 插入；不使用行內樣式屬性（CSP style-src 'self'）——位置與縮放用 CSSOM（el.style.transform）設定。
import { clampRatio, fitView, LABEL_MIN_SCALE, panBy, pinchView, planToScreen, screenToPlan, wheelFactor, zoomAt } from './geometry.js';
import { groupByRoom, pickFloor, placedOnFloor, unplacedDevices } from './model.js';

const CSS_HREF = '/modules/floorplan/floorplan.css';
const MAX_UPLOAD = 10 * 1024 * 1024;
const LONG_PRESS_MS = 600;
const MOVE_THRESHOLD = 5;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return el;
}

function ensureCss() {
  if (document.head.querySelector(`link[href="${CSS_HREF}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF }));
}

async function createView(el, ctx) {
  const { api, bus, filters, router } = ctx;
  const ui = await ctx.ui.load();
  const { icon, createSegmented, createStatusDot, createEmpty, toast, confirm } = ui;
  const offs = [];
  const timers = new Set();
  let destroyed = false;
  let resizeObs = null;
  let ghost = null;

  // ------------------------------------------------------------------ 狀態
  const S = {
    floors: [], rooms: [], categories: [], devices: [], plans: new Map(), placements: [], status: new Map(),
    floorId: '', shown: null, edit: false, selected: null,
    view: { scale: 1, tx: 0, ty: 0 }, userMoved: false,
  };
  const dom = { root: null, viewport: null, stage: null, dots: null, side: null, grid: null, segmented: null };
  const dotEls = new Map(); // deviceId → { el, status, label }

  const plan = () => S.plans.get(S.floorId) ?? null;
  const size = () => ({ width: plan()?.width ?? 1, height: plan()?.height ?? 1 });
  const category = (d) => S.categories.find((c) => c.id === d.categoryId);
  const iconName = (d) => category(d)?.icon ?? 'other';
  const isCamera = (d) => iconName(d) === 'camera';
  const statusOf = (d) => S.status.get(d.id) ?? 'unknown';
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); if (!destroyed) fn(); }, ms);
    timers.add(t);
    return t;
  };
  const fail = (err) => toast.error(err?.message ?? String(err));

  // ------------------------------------------------------------------ 資料
  async function loadAll() {
    const [floors, rooms, categories, devices, plans, placements, status] = await Promise.all([
      api.get('/api/floors'), api.get('/api/rooms'), api.get('/api/categories'), api.get('/api/devices'),
      api.get('/api/plans'), api.get('/api/placements'), api.get('/api/status').catch(() => []),
    ]);
    Object.assign(S, { floors, rooms, categories, devices, placements });
    S.plans = new Map(plans.map((p) => [p.floorId, p]));
    S.status = new Map(status.map((s) => [s.deviceId, s.state]));
  }
  const reload = {
    inventory: async () => {
      const [floors, rooms, categories, devices] = await Promise.all([api.get('/api/floors'), api.get('/api/rooms'), api.get('/api/categories'), api.get('/api/devices')]);
      Object.assign(S, { floors, rooms, categories, devices });
    },
    plans: async () => { S.plans = new Map((await api.get('/api/plans')).map((p) => [p.floorId, p])); },
    placements: async () => { S.placements = await api.get('/api/placements'); },
  };

  // ------------------------------------------------------------------ 視圖（縮放平移）
  function applyView() {
    if (!dom.stage) return;
    const { scale, tx, ty } = S.view;
    dom.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    dom.dots.classList.toggle('is-lowzoom', scale < LABEL_MIN_SCALE);
    positionDots();
  }
  function positionDots() {
    const p = plan();
    if (!p) return;
    for (const [id, d] of dotEls) {
      const pl = S.placements.find((x) => x.deviceId === id);
      if (!pl) continue;
      const pt = planToScreen(pl, S.view, size());
      d.el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    }
  }
  function fit() {
    if (!dom.viewport) return;
    const { clientWidth: width, clientHeight: height } = dom.viewport;
    if (!width || !height) return;
    S.view = fitView({ width, height }, size());
    S.userMoved = false;
    applyView();
  }
  const setView = (v, { user = true } = {}) => {
    S.view = v;
    if (user) S.userMoved = true;
    applyView();
  };
  const zoomCenter = (f) => setView(zoomAt(S.view, { x: dom.viewport.clientWidth / 2, y: dom.viewport.clientHeight / 2 }, f));

  // ------------------------------------------------------------------ 落點操作
  const local = (e) => {
    const r = dom.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inViewport = (e) => {
    const r = dom.viewport?.getBoundingClientRect();
    return Boolean(r) && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  async function savePlacement(deviceId, x, y) {
    try {
      const rec = await api.put(`/api/placements/${deviceId}`, { floorId: S.floorId, x: clampRatio(x), y: clampRatio(y) });
      S.placements = [...S.placements.filter((p) => p.deviceId !== deviceId), rec];
    } catch (err) {
      fail(err);
      await reload.placements().catch(() => {});
    }
    refreshDots();
    refreshSide();
  }
  const placeAt = (deviceId, pt) => {
    const p = screenToPlan(pt, S.view, size());
    return savePlacement(deviceId, p.x, p.y);
  };

  let confirming = false;
  async function removePlacement(device) {
    if (confirming) return;
    confirming = true;
    try {
      const ok = await confirm({ title: '從平面圖移除？', message: `「${device.name}」會從這張平面圖移除（設備資料不會刪除）。`, danger: true, okText: '移除' });
      if (!ok || destroyed) return;
      await api.delete(`/api/placements/${device.id}`);
      S.placements = S.placements.filter((p) => p.deviceId !== device.id);
      refreshDots();
      refreshSide();
    } catch (err) {
      fail(err);
    } finally {
      confirming = false;
    }
  }

  // ------------------------------------------------------------------ 設備點
  function makeDot(device) {
    const dot = createStatusDot({ status: statusOf(device), critical: device.monitor?.critical, showLabel: false });
    const label = h('span', { class: 'nc-fp-label' });
    const body = h('span', { class: 'nc-fp-dot-body' }, icon(iconName(device), { size: 18 }), dot);
    const el = h('div', { class: 'nc-fp-dot', dataset: { device: device.id }, role: 'button', tabindex: '0' }, body, label);
    if (isCamera(device)) {
      const cam = h('button', { class: 'nc-fp-cam', type: 'button', 'aria-label': `看「${device.name}」的畫面`, title: '看畫面' }, icon('camera', { size: 14 }), h('span', { text: '看畫面' }));
      cam.addEventListener('pointerdown', (e) => e.stopPropagation());
      cam.addEventListener('click', (e) => {
        e.stopPropagation();
        router.navigate(`#/cameras?device=${encodeURIComponent(device.id)}`);
      });
      el.append(cam);
    }
    wireDot(el, device.id);
    return { el, status: dot, label };
  }

  function wireDot(el, deviceId) {
    const find = () => S.devices.find((d) => d.id === deviceId);
    let drag = null;
    let suppressClick = false;
    const open = () => bus.emit('device.open', { id: deviceId });
    el.addEventListener('click', () => {
      if (suppressClick) return;
      open();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    el.addEventListener('contextmenu', (e) => {
      if (!S.edit) return;
      e.preventDefault();
      const d = find();
      if (d) removePlacement(d);
    });
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!S.edit || e.target.closest('.nc-fp-cam') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      el.setPointerCapture?.(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: false, long: false, timer: null, last: null };
      drag.timer = later(() => {
        if (!drag || drag.moved) return;
        drag.long = true;
        suppressClick = true;
        const d = find();
        if (d) removePlacement(d);
      }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > MOVE_THRESHOLD) {
        drag.moved = true;
        clearTimeout(drag.timer);
        el.classList.add('is-dragging');
      }
      if (!drag.moved) return;
      const p = screenToPlan(local(e), S.view, size());
      drag.last = { x: clampRatio(p.x), y: clampRatio(p.y) };
      const pt = planToScreen(drag.last, S.view, size());
      el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    });
    const finish = (e, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      clearTimeout(d.timer);
      el.classList.remove('is-dragging');
      if (d.moved || d.long) {
        suppressClick = true;
        later(() => { suppressClick = false; }, 0);
      }
      if (d.moved && !cancelled && d.last) savePlacement(deviceId, d.last.x, d.last.y);
      else if (d.moved) positionDots();
      void e;
    };
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));
  }

  function refreshDots() {
    if (!dom.dots) return;
    const items = placedOnFloor(S.devices, S.placements, S.floorId);
    const keep = new Set(items.map((i) => i.device.id));
    for (const [id, d] of dotEls) {
      if (!keep.has(id)) {
        d.el.remove();
        dotEls.delete(id);
      }
    }
    for (const { device } of items) {
      let d = dotEls.get(device.id);
      if (!d) {
        d = makeDot(device);
        dotEls.set(device.id, d);
        dom.dots.append(d.el);
      }
      d.label.textContent = device.name;
      d.el.setAttribute('aria-label', `${device.name}（${statusOf(device)}）`);
      d.el.dataset.status = statusOf(device);
      d.status.update({ status: statusOf(device), critical: device.monitor?.critical });
      d.el.classList.toggle('is-selected', S.selected === device.id);
    }
    positionDots();
  }

  // ------------------------------------------------------------------ 左側未放置清單（編輯模式）
  function refreshSide() {
    if (!dom.side) return;
    const list = unplacedDevices(S.devices, S.placements, S.floorId, filters.get());
    // 清單內容沒變就不重建，避免拖曳進行中元素被換掉
    const key = `${S.selected}|${list.map((d) => `${d.id}:${d.name}:${d.code ?? ''}`).join(',')}`;
    if (dom.side.dataset.key === key) return;
    dom.side.dataset.key = key;
    const items = list.map((d) => {
      const btn = h('button', { class: 'nc-fp-item', type: 'button', dataset: { device: d.id }, 'aria-pressed': String(S.selected === d.id) },
        icon(iconName(d), { size: 18 }), h('span', { class: 'nc-fp-item-name', text: d.name }), d.code ? h('span', { class: 'nc-fp-item-code', text: d.code }) : null);
      wireItem(btn, d);
      return h('li', {}, btn);
    });
    dom.side.querySelector('.nc-fp-side-count').textContent = String(list.length);
    dom.side.querySelector('.nc-fp-list').replaceChildren(...items);
    dom.side.querySelector('.nc-fp-side-empty').hidden = list.length > 0;
  }

  function wireItem(btn, device) {
    let g = null;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      btn.setPointerCapture?.(e.pointerId);
      g = { x: e.clientX, y: e.clientY, moved: false };
    });
    btn.addEventListener('pointermove', (e) => {
      if (!g) return;
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > MOVE_THRESHOLD) {
        g.moved = true;
        ghost = h('div', { class: 'nc-fp-ghost' }, icon(iconName(device), { size: 18 }), h('span', { text: device.name }));
        document.body.append(ghost);
      }
      if (g.moved && ghost) {
        ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
        dom.viewport?.classList.toggle('is-drop', inViewport(e));
      }
    });
    const end = (e, cancelled) => {
      if (!g) return;
      const moved = g.moved;
      g = null;
      ghost?.remove();
      ghost = null;
      dom.viewport?.classList.remove('is-drop');
      if (moved) {
        if (!cancelled && inViewport(e)) placeAt(device.id, local(e));
        return;
      }
      if (cancelled) return;
      S.selected = S.selected === device.id ? null : device.id; // 點選 → 再點圖上位置放置（觸控裝置用）
      refreshSide();
      refreshDots();
      updateHint();
    };
    btn.addEventListener('pointerup', (e) => end(e, false));
    btn.addEventListener('pointercancel', (e) => end(e, true));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        S.selected = S.selected === device.id ? null : device.id;
        refreshSide();
        updateHint();
      }
    });
  }

  function updateHint() {
    const hint = dom.root?.querySelector('.nc-fp-hint');
    if (!hint) return;
    const d = S.devices.find((x) => x.id === S.selected);
    hint.hidden = !S.edit;
    hint.textContent = d ? `已選取「${d.name}」，點圖上要放置的位置` : '把左側設備拖到圖上；拖曳圖上的點可移動，右鍵或長按可移除';
  }

  // ------------------------------------------------------------------ 畫布手勢
  function wireViewport(vp) {
    const ptrs = new Map();
    let pan = null;
    let pinch = null;
    let moved = false;

    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      setView(zoomAt(S.view, local(e), wheelFactor(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY)));
    }, { passive: false });

    vp.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.nc-fp-controls') || e.target.closest('.nc-fp-dot')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      vp.setPointerCapture?.(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) {
        pan = { start: local(e), view: { ...S.view } };
        moved = false;
      } else if (ptrs.size === 2) {
        pinch = { view: { ...S.view }, pts: [...ptrs.values()].map((p) => ({ ...p })) };
        pan = null;
        moved = true;
      }
    });
    vp.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, local(e));
      if (pinch && ptrs.size >= 2) {
        setView(pinchView(pinch.view, pinch.pts, [...ptrs.values()].slice(0, 2)));
      } else if (pan) {
        const pt = local(e);
        const dx = pt.x - pan.start.x;
        const dy = pt.y - pan.start.y;
        if (!moved && Math.hypot(dx, dy) > MOVE_THRESHOLD) moved = true;
        if (moved) setView(panBy(pan.view, dx, dy));
      }
    });
    const up = (e, cancelled) => {
      if (!ptrs.has(e.pointerId)) return;
      const wasTap = ptrs.size === 1 && !moved && !cancelled;
      const pt = local(e);
      ptrs.delete(e.pointerId);
      vp.classList.remove('is-panning');
      if (wasTap && S.edit && S.selected) {
        const id = S.selected;
        S.selected = null;
        updateHint();
        placeAt(id, pt);
      }
      pinch = null;
      if (ptrs.size === 1) {
        const [only] = [...ptrs.values()];
        pan = { start: only, view: { ...S.view } }; // 放開一指後，剩下的一指接續平移
        moved = true;
      } else {
        pan = null;
      }
    };
    vp.addEventListener('pointerup', (e) => up(e, false));
    vp.addEventListener('pointercancel', (e) => up(e, true));
  }

  // ------------------------------------------------------------------ 版面
  const fileInput = h('input', { class: 'nc-fp-file visually-hidden', type: 'file', accept: '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml', 'aria-label': '選擇平面圖檔案', tabindex: '-1' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD) return toast.error('檔案超過 10 MB，請壓縮後再上傳');
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      await api.upload(`/api/plans/${S.floorId}`, fd);
      toast.success('平面圖已更新');
      await reload.plans();
      S.userMoved = false;
      build();
    } catch (err) {
      fail(err);
    }
  });
  const pickFile = () => fileInput.click();

  async function removePlan() {
    const ok = await confirm({ title: '移除平面圖？', message: '只會移除圖片；設備在圖上的位置仍會保留，重新上傳後會回到原處。', danger: true, okText: '移除圖片' });
    if (!ok) return;
    try {
      await api.delete(`/api/plans/${S.floorId}`);
      await reload.plans();
      build();
    } catch (err) {
      fail(err);
    }
  }

  function setFloor(id) {
    if (!id || id === S.floorId) return;
    S.floorId = id;
    S.selected = null;
    S.userMoved = false;
    build();
  }

  function buildBar() {
    const seg = createSegmented({
      options: S.floors.map((f) => ({ value: f.id, label: f.name })),
      value: S.floorId,
      ariaLabel: '樓層',
      onChange: (v) => {
        const room = S.rooms.find((r) => r.id === filters.get().roomId);
        filters.set({ floorId: v, roomId: room && room.floorId !== v ? '' : filters.get().roomId });
        setFloor(v); // 篩選沒變（例如已是同一層）時 filters.changed 不會觸發，直接切換
      },
    });
    dom.segmented = seg;
    const hasPlan = Boolean(plan());
    const tools = h('div', { class: 'nc-fp-tools' });
    if (hasPlan) {
      tools.append(
        h('button', { class: `btn small${S.edit ? ' primary' : ''}`, type: 'button', dataset: { act: 'edit' }, 'aria-pressed': String(S.edit), text: S.edit ? '完成編輯' : '編輯模式', on: { click: () => { S.edit = !S.edit; S.selected = null; build(); } } }),
        h('button', { class: 'btn small', type: 'button', dataset: { act: 'replace' }, text: '更換平面圖', on: { click: pickFile } }),
        h('button', { class: 'btn small danger', type: 'button', dataset: { act: 'remove' }, text: '移除平面圖', on: { click: removePlan } }),
      );
    }
    return h('div', { class: 'nc-fp-bar' }, seg.el, h('span', { class: 'nc-fp-grow' }), tools, fileInput);
  }

  function buildViewport() {
    const p = plan();
    const img = h('img', { class: 'nc-fp-img', src: api.url(`/api/plans/${S.floorId}/image`, { v: p.updatedAt }), alt: `${S.floors.find((f) => f.id === S.floorId)?.name ?? ''}平面圖`, draggable: 'false' });
    img.style.width = `${p.width}px`;
    img.style.height = `${p.height}px`;
    dom.stage = h('div', { class: 'nc-fp-stage' }, img);
    dom.stage.style.width = `${p.width}px`;
    dom.stage.style.height = `${p.height}px`;
    dom.dots = h('div', { class: 'nc-fp-dots' });
    const controls = h('div', { class: 'nc-fp-controls' },
      h('button', { class: 'btn small', type: 'button', 'aria-label': '放大', text: '＋', on: { click: () => zoomCenter(1.25) } }),
      h('button', { class: 'btn small', type: 'button', 'aria-label': '縮小', text: '－', on: { click: () => zoomCenter(0.8) } }),
      h('button', { class: 'btn small', type: 'button', dataset: { act: 'fit' }, text: '適合畫面', on: { click: fit } }),
    );
    const vp = h('div', { class: 'nc-fp-viewport', tabindex: '0', 'aria-label': '平面圖，可用滾輪或雙指縮放、拖曳平移' }, dom.stage, dom.dots, controls);
    dom.viewport = vp;
    wireViewport(vp);
    img.addEventListener('load', () => { if (!S.userMoved) fit(); });
    resizeObs?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => { if (!S.userMoved) fit(); else positionDots(); });
      resizeObs.observe(vp);
    }
    return vp;
  }

  function buildSide() {
    return h('aside', { class: 'nc-fp-side', 'aria-label': '本層未放置設備' },
      h('div', { class: 'nc-fp-side-head' }, h('strong', { text: '本層未放置設備' }), h('span', { class: 'nc-fp-side-count' })),
      h('ul', { class: 'nc-fp-list' }),
      h('p', { class: 'nc-fp-side-empty', text: '本層的設備都已放置。' }),
    );
  }

  function buildGrid() {
    const groups = groupByRoom(S.devices, S.rooms, S.floorId, filters.get());
    const wrap = h('section', { class: 'nc-fp-grid', 'aria-label': '格狀檢視' }, h('h3', { class: 'nc-fp-grid-title', text: '格狀檢視（依房間）' }));
    if (!groups.length) {
      wrap.append(h('p', { class: 'nc-fp-side-empty', text: '這一層沒有符合篩選的設備。' }));
      return wrap;
    }
    for (const g of groups) {
      const cards = g.devices.map((d) => {
        const dot = createStatusDot({ status: statusOf(d), critical: d.monitor?.critical, showLabel: false });
        dot.dataset.device = d.id;
        return h('li', {}, h('button', { class: 'nc-fp-card', type: 'button', dataset: { device: d.id }, on: { click: () => bus.emit('device.open', { id: d.id }) } },
          icon(iconName(d), { size: 18 }), h('span', { class: 'nc-fp-card-name', text: d.name }), dot));
      });
      wrap.append(h('div', { class: 'nc-fp-room' }, h('h4', { text: g.room?.name ?? '未指定房間' }), h('ul', { class: 'nc-fp-cards' }, cards)));
    }
    return wrap;
  }

  function build() {
    if (destroyed) return;
    dotEls.clear();
    S.shown = plan()?.updatedAt ?? null;
    dom.segmented?.destroy();
    Object.assign(dom, { viewport: null, stage: null, dots: null, side: null, grid: null });
    resizeObs?.disconnect();
    if (!S.floors.length) {
      dom.root.replaceChildren(createEmpty({ icon: 'floorplan', title: '還沒有樓層', description: '請先到「設備」頁建立樓層與設備，再回到這裡放置平面圖。' }));
      return;
    }
    const parts = [buildBar()];
    if (plan()) {
      const body = h('div', { class: `nc-fp-body${S.edit ? ' is-edit' : ''}` });
      if (S.edit) {
        dom.side = buildSide();
        body.append(dom.side);
      }
      body.append(buildViewport());
      parts.push(h('p', { class: 'nc-fp-hint', hidden: !S.edit }), body);
      dom.root.replaceChildren(...parts);
      updateHint();
      refreshSide();
      refreshDots();
      applyView();
      fit();
      return;
    }
    parts.push(createEmpty({ icon: 'floorplan', title: '這一層還沒有平面圖', description: '上傳 PNG、JPG、WebP 或 SVG（10 MB 以內）後，就能把設備放到圖上。', actionLabel: '上傳平面圖', onAction: pickFile }));
    dom.grid = buildGrid();
    parts.push(dom.grid);
    dom.root.replaceChildren(...parts);
  }

  // ------------------------------------------------------------------ 事件
  function wireEvents() {
    let invTimer = null;
    offs.push(
      bus.on('filters.changed', (f) => {
        const next = pickFloor(S.floors, f.floorId);
        if (f.floorId && next !== S.floorId) setFloor(next);
        else if (S.edit) refreshSide();
        else if (dom.grid) build();
      }),
      bus.on('status.changed', (p) => {
        S.status.set(p.deviceId, p.to);
        if (dotEls.has(p.deviceId)) refreshDots();
        else if (dom.grid) dom.grid.querySelectorAll(`.nc-status[data-device="${p.deviceId}"]`).forEach((n) => n.update?.({ status: p.to, critical: S.devices.find((d) => d.id === p.deviceId)?.monitor?.critical }));
      }),
      bus.on('status.snapshot', (p) => {
        S.status = new Map((p.items ?? []).map((s) => [s.deviceId, s.state]));
        refreshDots();
        if (dom.grid) build();
      }),
      bus.on('inventory.changed', () => {
        clearTimeout(invTimer);
        invTimer = later(async () => {
          try {
            await reload.inventory();
            await reload.placements();
            if (!S.floors.some((f) => f.id === S.floorId)) S.floorId = pickFloor(S.floors, filters.get().floorId);
            build();
          } catch { /* 下次事件再重試 */ }
        }, 150);
        timers.add(invTimer);
      }),
      bus.on('plan.changed', async () => {
        try {
          await reload.plans();
          if ((plan()?.updatedAt ?? null) !== S.shown) { // 目前畫面顯示的版本與最新不同才重建（自己上傳造成的事件不會重複重建）
            S.userMoved = false;
            build();
          }
        } catch { /* 忽略 */ }
      }),
      bus.on('placement.changed', async () => {
        try {
          await reload.placements();
          refreshDots();
          refreshSide();
        } catch { /* 忽略 */ }
      }),
    );
  }

  // ------------------------------------------------------------------ 啟動
  ensureCss();
  dom.root = h('div', { class: 'nc-fp' });
  el.replaceChildren(dom.root);
  await loadAll();
  S.floorId = pickFloor(S.floors, filters.get().floorId);

  // #/floorplan?place=<deviceId>：切到該設備所在樓層並進入放置模式
  const placeId = router.current?.().query?.place;
  const target = placeId ? S.devices.find((d) => d.id === placeId) : null;
  if (target) {
    S.floorId = target.floorId && S.floors.some((f) => f.id === target.floorId) ? target.floorId : S.floorId;
    S.edit = Boolean(plan());
    S.selected = S.edit ? target.id : null;
    if (filters.get().floorId !== S.floorId) filters.set({ floorId: S.floorId });
  }
  build();
  wireEvents();

  return {
    destroy() {
      destroyed = true;
      for (const off of offs.splice(0)) off();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      resizeObs?.disconnect();
      ghost?.remove();
      ghost = null;
    },
  };
}

let current = null;
let mountSeq = 0;

export default {
  id: 'floorplan',
  title: '平面圖',
  icon: 'floorplan',
  route: '#/floorplan',
  order: 40,
  requires: ['inventory', 'floorplan'],
  async mount(el, ctx) {
    const seq = ++mountSeq;
    const view = await createView(el, ctx);
    if (seq !== mountSeq) view.destroy(); // mount 還沒完成就已 unmount
    else current = view;
  },
  unmount() {
    mountSeq += 1;
    current?.destroy();
    current = null;
  },
};
