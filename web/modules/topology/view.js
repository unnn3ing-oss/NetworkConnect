// 架構圖畫面（Cytoscape）：工具列、排版、狀態即時更新、全站篩選淡化、匯出 PNG。
// createTopologyView() 回傳 destroy()；所有 bus 訂閱、計時器、觀察者、cy 實例都在 destroy() 中釋放。
import { buildElements, fadedIds, statusClass, STATUS_CLASSES } from './graph.js';
import { buildStyle, readColors } from './style.js';
import { bandLayout, crossFloorVias, routeOrthogonal, tidyX, toSegments, treeOrder } from './layout.js';

const CSS_ATTR = 'data-nc-topology-css';
const STORE_KEY = 'nc.topology.groupByFloor';
const EDGE_KEY = 'nc.topology.edgeStyle';
const GAP = 104; // 同層節點的水平間距
const ROW_GAP = 130; // 上下層的垂直間距：留空間給節點名稱與連線標籤
const LANE_GAP = 8; // 同一個轉接空位裡多條跨樓層連線的間距
const ROUTE_PROPS = 'source-endpoint target-endpoint segment-weights segment-distances';

function ensureCss() {
  if (document.head.querySelector(`link[${CSS_ATTR}]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./topology.css', import.meta.url).href;
  link.setAttribute(CSS_ATTR, '');
  // Cytoscape 初始化時若找不到這個 id，會自己塞一個行內 <style>（被 CSP style-src 'self' 擋掉）；
  // 預先佔住 id，並在 topology.css 提供同樣的規則（.__________cytoscape_container）。
  link.id = '__________cytoscape_stylesheet';
  document.head.append(link);
}

let cytoscapePromise = null;
/** Cytoscape 是 UMD 檔，載入後掛在 window.cytoscape；只載入一次 */
function loadCytoscape() {
  if (globalThis.cytoscape) return Promise.resolve(globalThis.cytoscape);
  cytoscapePromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/cytoscape.min.js';
    s.onload = () => resolve(globalThis.cytoscape);
    s.onerror = () => {
      cytoscapePromise = null;
      s.remove();
      reject(new Error('無法載入架構圖元件（/vendor/cytoscape.min.js）'));
    };
    document.head.append(s);
  });
  return cytoscapePromise;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

/** 類別圖示 → 白色線條 SVG 的 data URI（畫在狀態色圓塊上） */
const iconUrls = new Map();
function iconUrl(iconSvg, name) {
  if (!iconUrls.has(name)) {
    const svg = iconSvg(name, 24).replace(/currentColor/g, '#ffffff');
    iconUrls.set(name, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  }
  return iconUrls.get(name);
}

const readPref = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 無痕模式等情況存不了就算了
  }
};

export async function createTopologyView(host, ctx) {
  const { api, bus } = ctx;
  let destroyed = false;
  let cy = null;
  let reloadTimer = null;
  const offs = [];
  const cleanups = [];

  ensureCss();
  const [ui, cytoscape] = await Promise.all([ctx.ui.load(), loadCytoscape()]);
  if (destroyed) return { destroy() {} };
  const { createEmpty, createSegmented, icon, iconSvg } = ui;

  // ------------------------------------------------------------ 狀態
  const data = { devices: [], categories: [], floors: [] };
  const status = new Map();
  let groupByFloor = readPref(STORE_KEY) === '1';
  let edgeStyle = readPref(EDGE_KEY) === 'orthogonal' ? 'orthogonal' : 'straight';
  let lastSig = '';
  let seq = 0;

  // ------------------------------------------------------------ DOM
  const btn = (label, iconName, onClick, extra = {}) =>
    el('button', { type: 'button', class: 'btn small tp-btn', ...extra, on: { click: onClick } }, icon(iconName, { size: 16 }), el('span', { text: label }));
  const groupBtn = el('button', { type: 'button', class: 'chip tp-group', 'aria-pressed': String(groupByFloor), on: { click: () => setGroup(!groupByFloor) } }, icon('layers', { size: 16 }), el('span', { text: '依樓層分群' }));
  const relayoutBtn = btn('重新排版', 'refresh', () => runLayout());
  const fitBtn = btn('適合畫面', 'search', () => cy?.fit(undefined, 40));
  const pngBtn = btn('匯出 PNG', 'external', () => exportPng());
  const edgeSeg = createSegmented({
    ariaLabel: '連線樣式',
    options: [{ value: 'straight', label: '直線' }, { value: 'orthogonal', label: '直角' }],
    value: edgeStyle,
    onChange: (v) => setEdgeStyle(v),
  });
  const edgeBox = el('div', { class: 'tp-edge', title: '直線：設備之間直接連線。直角：連線只走水平與垂直方向，像組織圖。' }, el('span', { text: '連線' }), edgeSeg.el);
  const tools = el('div', { class: 'tp-tools' }, groupBtn, edgeBox, relayoutBtn, fitBtn, pngBtn);
  const legend = el(
    'ul',
    { class: 'tp-legend', 'aria-label': '圖例' },
    el('li', {}, el('span', { class: 'tp-key tp-key-solid' }), '有線／光纖'),
    el('li', {}, el('span', { class: 'tp-key tp-key-dash' }), 'Wi-Fi／Mesh'),
    el('li', {}, el('span', { class: 'tp-key tp-key-poe' }), 'PoE'),
    el('li', {}, el('span', { class: 'tp-dot tp-dot-up' }), '正常'),
    el('li', {}, el('span', { class: 'tp-dot tp-dot-down' }), '離線警示'),
    el('li', {}, el('span', { class: 'tp-dot tp-dot-offline' }), '離線'),
    el('li', {}, el('span', { class: 'tp-dot tp-dot-unknown' }), '未知'),
  );
  const warnBox = el('div', { class: 'tp-warn', role: 'status', hidden: true });
  const stage = el('div', { class: 'tp-stage', role: 'img', 'aria-label': '網路架構圖：每個節點是一台設備，連線代表上游關係。可在設備頁查看同樣的資料。' });
  const emptyBox = el('div', { class: 'tp-empty', hidden: true });
  const errorBox = el('div', { class: 'tp-error', role: 'alert', hidden: true });
  const root = el('div', { class: 'tp' }, el('header', { class: 'tp-head' }, el('h2', { class: 'tp-title', text: '架構圖' }), tools), warnBox, el('div', { class: 'tp-body' }, stage, emptyBox, errorBox), legend);
  host.replaceChildren(root);
  edgeSeg.setValue(edgeSeg.value); // 掛上 DOM 後重新量測圓塊

  // ------------------------------------------------------------ 資料載入
  async function monitorUsable() {
    try {
      const modules = await api.get('/api/system/modules');
      return modules.find((m) => m.name === 'monitor')?.state === 'ok';
    } catch {
      return false;
    }
  }

  async function load() {
    const my = ++seq;
    const [floors, categories, devices] = await Promise.all([api.get('/api/floors'), api.get('/api/categories'), api.get('/api/devices')]);
    let items = null;
    if (await monitorUsable()) items = await api.get('/api/status').catch(() => null);
    if (destroyed || my !== seq) return;
    if (items) {
      status.clear();
      for (const i of items) status.set(i.deviceId, i.state);
    }
    const sig = JSON.stringify([floors, categories, devices]);
    if (sig === lastSig && cy) {
      applyStatusAll();
      return;
    }
    lastSig = sig;
    Object.assign(data, { floors, categories, devices });
    render();
  }

  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load().catch(showError), 80);
  };

  function showError(err) {
    if (destroyed) return;
    console.error(err);
    errorBox.hidden = false;
    errorBox.replaceChildren(el('p', { text: err?.message ?? String(err) }), el('button', { type: 'button', class: 'btn small', text: '重試', on: { click: () => { errorBox.hidden = true; load().catch(showError); } } }));
  }

  // ------------------------------------------------------------ 圖
  const filtersNow = () => ctx.filters.get();

  function destroyCy() {
    if (!cy) return;
    cy.destroy();
    cy = null;
    stage.__cy = null;
  }

  function render() {
    if (destroyed) return;
    errorBox.hidden = true;
    if (!data.devices.length) {
      destroyCy();
      stage.hidden = true;
      legend.hidden = true;
      tools.hidden = true;
      warnBox.hidden = true;
      emptyBox.hidden = false;
      emptyBox.replaceChildren(
        createEmpty({
          icon: 'topology',
          title: '還沒有設備',
          description: '新增設備並填寫「上游設備」後，網路架構就會畫在這裡。',
          actionLabel: '前往設備',
          onAction: () => {
            location.hash = '#/devices';
          },
        }),
      );
      return;
    }
    emptyBox.hidden = true;
    stage.hidden = false;
    legend.hidden = false;
    tools.hidden = false;

    const built = buildElements(data.devices, data.categories, data.floors, status, { groupByFloor, filters: filtersNow() });
    for (const e of built.elements) if (e.group === 'nodes' && !e.data.isFloor) e.data.iconUrl = iconUrl(iconSvg, e.data.icon);

    if (built.warnings.length) {
      warnBox.hidden = false;
      warnBox.replaceChildren(icon('alert', { size: 16 }), el('span', { text: built.warnings.length === 1 ? built.warnings[0].message : `${built.warnings.length} 台設備的上游設備不存在或形成迴圈，已視為根節點（虛線框）：${built.warnings.map((w) => w.message.split(' 的')[0]).join('、')}` }));
    } else {
      warnBox.hidden = true;
    }

    if (!cy) {
      cy = cytoscape({
        container: stage,
        elements: [],
        style: buildStyle(readColors(), { edgeStyle }),
        minZoom: 0.15,
        maxZoom: 2.5,
        boxSelectionEnabled: false,
        autounselectify: true,
      });
      stage.__cy = cy; // 測試用：讓瀏覽器測試能直接檢查圖的狀態
      // 拖曳設備後重算直角走線（segments 的轉角是固定的，不重算會歪掉）
      let rerouteFrame = 0;
      cy.on('drag', 'node', () => {
        if (edgeStyle !== 'orthogonal' || rerouteFrame) return;
        rerouteFrame = requestAnimationFrame(() => {
          rerouteFrame = 0;
          applyRouting();
        });
      });
      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        if (node.data('isFloor')) return;
        bus.emit('device.open', { id: node.id() });
      });
    }
    cy.batch(() => {
      cy.elements().remove();
      cy.add(built.elements);
    });
    runLayout();
  }

  /**
   * 排版：自己算樹狀位置（treeOrder → tidyX／bandLayout），不使用 breadthfirst。
   * breadthfirst 的結果會隨目前縮放改變，按「重新排版」後再 fit 會讓圖越排越大、畫面越縮越小。
   */
  function runLayout() {
    if (!cy) return;
    cy.resize();
    const nodes = cy.nodes().filter((n) => !n.data('isFloor'));
    const parentOf = new Map();
    const mediumOf = new Map();
    cy.edges().forEach((e) => {
      parentOf.set(e.data('target'), e.data('source'));
      mediumOf.set(e.data('target'), e.classes().find((c) => c.startsWith('m-')) ?? 'm-other');
    });
    const base = nodes.map((n) => ({ id: n.id(), parent: parentOf.get(n.id()) ?? null, group: n.data('parent') ?? null, medium: mediumOf.get(n.id()) ?? 'm-other' }));
    const order = treeOrder(base, { gap: GAP });
    const items = base.map((it) => ({ ...it, ...order.get(it.id) }));
    lanePref = new Map();
    let pos;
    if (groupByFloor) {
      // 跨樓層往下的連線：在上游下一列預留看不見的空位（不畫出來），直角連線從空位往下走，不會穿過設備
      const groupOrder = cy.nodes('.floor').map((n) => n.id());
      const { vias, viaOf } = crossFloorVias(items, groupOrder);
      pos = bandLayout([...items, ...vias], { gap: GAP, rowGap: ROW_GAP, groupOrder });
      const bundles = new Map();
      for (const [child, via] of viaOf) bundles.set(via, [...(bundles.get(via) ?? []), child]);
      for (const [via, kids] of bundles) {
        kids.sort((a, b) => pos.get(a).x - pos.get(b).x);
        kids.forEach((k, j) => lanePref.set(k, pos.get(via).x + (j - (kids.length - 1) / 2) * LANE_GAP));
      }
    } else {
      const xs = tidyX(items, { gap: GAP });
      pos = new Map(items.map((it) => [it.id, { x: xs.get(it.id), y: it.level * ROW_GAP }]));
    }
    cy.batch(() => nodes.forEach((n) => n.position(pos.get(n.id()))));
    applyRouting({ shiftRows: true });
    cy.fit(undefined, 40);
  }

  let lanePref = new Map(); // 下游 id → 跨樓層連線希望走的垂直通道 x
  /**
   * 直角連線：自己算每條線的轉角（routeOrthogonal），任兩條線的水平、垂直段都不重疊；
   * shiftRows＝空白不夠放橫線時把下面的列往下推（排版時才推；拖曳設備後只重算走線）。
   */
  function applyRouting({ shiftRows = false } = {}) {
    if (!cy) return;
    cy.batch(() => {
      const edges = cy.edges();
      if (edgeStyle !== 'orthogonal') {
        edges.removeStyle(ROUTE_PROPS);
        return;
      }
      const nodes = cy.nodes().filter((n) => !n.data('isFloor'));
      const { routes, positions } = routeOrthogonal(
        nodes.map((n) => ({ id: n.id(), x: n.position('x'), y: n.position('y'), w: n.width(), h: n.height() })),
        edges.map((e) => ({ id: e.id(), source: e.data('source'), target: e.data('target'), lane: lanePref.get(e.data('target')) })),
        { shiftRows },
      );
      if (shiftRows) nodes.forEach((n) => n.position(positions.get(n.id())));
      edges.forEach((e) => {
        const r = routes.get(e.id());
        if (!r) return;
        const { weights, distances } = toSegments(r.corners, positions.get(e.data('source')), positions.get(e.data('target')));
        e.style({ 'source-endpoint': `${r.dx}px 50%`, 'target-endpoint': '0px -50%', 'segment-weights': weights, 'segment-distances': distances });
      });
    });
  }

  function applyFaded() {
    if (!cy) return;
    const faded = fadedIds(data.devices, filtersNow());
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (!n.data('isFloor')) n.toggleClass('faded', faded.has(n.id()));
      });
      cy.edges().forEach((e) => e.toggleClass('faded', faded.has(e.data('source')) || faded.has(e.data('target'))));
    });
  }

  function setNodeStatus(deviceId) {
    const node = cy?.getElementById(deviceId);
    if (!node || node.empty()) return;
    const device = data.devices.find((d) => d.id === deviceId);
    node.removeClass(STATUS_CLASSES.join(' ')).addClass(statusClass(device, status.get(deviceId)));
  }
  function applyStatusAll() {
    if (!cy) return;
    cy.batch(() => {
      for (const d of data.devices) setNodeStatus(d.id);
    });
  }

  function setGroup(on) {
    groupByFloor = on;
    writePref(STORE_KEY, on ? '1' : '0');
    groupBtn.setAttribute('aria-pressed', String(on));
    render();
  }

  function setEdgeStyle(v) {
    edgeStyle = v === 'orthogonal' ? 'orthogonal' : 'straight';
    writePref(EDGE_KEY, edgeStyle);
    cy?.style(buildStyle(readColors(), { edgeStyle }));
    runLayout(); // 直角連線可能需要把列距拉開；切回直線時也回到原本的列距
  }

  function exportPng() {
    if (!cy) return;
    const blob = cy.png({ output: 'blob', full: true, scale: 2, bg: readColors().surface });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `topology-${new Date().toISOString().slice(0, 10)}.png` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------ 主題切換：重讀 CSS 變數並重套樣式
  const restyle = () => {
    if (!cy) return;
    cy.style(buildStyle(readColors(), { edgeStyle }));
    applyRouting();
  };
  const observer = new MutationObserver(restyle);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  cleanups.push(() => observer.disconnect());
  const mql = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (mql) {
    mql.addEventListener('change', restyle);
    cleanups.push(() => mql.removeEventListener('change', restyle));
  }

  // ------------------------------------------------------------ 即時事件
  offs.push(
    bus.on('inventory.changed', scheduleReload),
    bus.on('filters.changed', applyFaded),
    bus.on('status.changed', (p) => {
      if (!p?.deviceId) return;
      status.set(p.deviceId, p.to);
      setNodeStatus(p.deviceId);
    }),
    bus.on('status.snapshot', (p) => {
      status.clear();
      for (const i of p?.items ?? []) status.set(i.deviceId, i.state);
      applyStatusAll();
    }),
  );

  try {
    await load();
  } catch (err) {
    showError(err);
  }

  return {
    destroy() {
      destroyed = true;
      clearTimeout(reloadTimer);
      for (const off of offs.splice(0)) off();
      for (const fn of cleanups.splice(0)) fn();
      destroyCy();
      edgeSeg.destroy?.();
      host.replaceChildren();
    },
  };
}
