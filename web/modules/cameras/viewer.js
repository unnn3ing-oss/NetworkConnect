// 監視器頁：分割 1／4／9／16、頻道勾選、畫面牆畫質（子碼流／主碼流）、雙擊全螢幕（預設子碼流，可切換為主碼流）、同時串流上限、分頁隱藏時關閉全部串流。
//
// 串流一律由 syncStreams() 依「目前應該開啟哪些」統一對帳：
//   - 分頁隱藏（visibilitychange）→ 全部關閉；回來再開
//   - 開啟全螢幕 → 格子全部暫停，只留全螢幕一路；關閉後格子恢復（畫面牆畫質不變）
//   - 超過同時串流上限的格子不連線，顯示「已達上限」
//   - destroy()（模組 unmount）→ 全部關閉
import { h, store } from './dom.js';
import { createPlayer, connectPlayer } from './player.js';
import {
  QUALITY_LABELS, SPLITS, applyLimit, clampLimit, clampQuality, clampSplit, flattenChannels, gridCols, pageSlice, parseTarget, selectedKeys, streamName, wsPath,
} from './logic.js';

const KEYS = { split: 'nc.cameras.split', limit: 'nc.cameras.limit', hidden: 'nc.cameras.hidden', quality: 'nc.cameras.quality' };
const STATUS_POLL_MS = 5000;

const STATE_TEXT = {
  idle: '',
  connecting: '連線中…',
  live: '',
  paused: '已暫停',
};

/**
 * @param {HTMLElement} el
 * @param {object} ctx  shell 的 ctx（api、bus、router、ui）
 * @param {{onAddNvr: () => void, onManage: () => void, uiLib: object}} hooks
 */
export function createViewer(el, ctx, { onAddNvr, onManage, uiLib }) {
  const { api, bus, router } = ctx;
  const { createSegmented, createEmpty, icon } = uiLib;

  const st = {
    nvrs: [],
    channels: [],
    hidden: store.get(KEYS.hidden, []),
    split: clampSplit(store.get(KEYS.split, 4)),
    limit: clampLimit(store.get(KEYS.limit, 9)),
    quality: clampQuality(store.get(KEYS.quality, 'sub')), // 畫面牆用哪個碼流
    page: 0,
    target: { mode: 'all' },
    full: null, // 全螢幕中的頻道 key
    tiles: new Map(), // key → tile
    fullView: null,
    tabHidden: typeof document !== 'undefined' && document.hidden === true,
    running: null, // go2rtc 是否在執行（null＝尚未知道）
    destroyed: false,
    wizardOpen: false,
  };
  const offs = [];
  let statusTimer = null;
  let reloadTimer = null;
  let loadedOnce = false;

  // ------------------------------------------------------------ 骨架
  const segmented = createSegmented({
    options: SPLITS.map((n) => ({ value: String(n), label: n === 1 ? '1 格' : `${n} 格` })),
    value: String(st.split),
    ariaLabel: '分割數',
    role: 'radiogroup',
    onChange: (v) => {
      st.split = Number(v);
      st.page = 0;
      store.set(KEYS.split, st.split);
      renderGrid();
    },
  });
  const limitInput = h('input', {
    class: 'input cam-limit-input', type: 'number', min: '1', max: '16', value: String(st.limit), 'aria-label': '同時串流上限',
    onchange: (e) => {
      st.limit = clampLimit(e.target.value);
      e.target.value = String(st.limit);
      store.set(KEYS.limit, st.limit);
      renderGrid();
    },
  });
  const qualitySeg = createSegmented({
    options: ['sub', 'main'].map((q) => ({ value: q, label: QUALITY_LABELS[q] })),
    value: st.quality,
    ariaLabel: '畫面牆畫質',
    role: 'radiogroup',
    onChange: (v) => {
      st.quality = clampQuality(v);
      store.set(KEYS.quality, st.quality);
      renderGrid();
    },
  });
  const sideToggle = h('button', { type: 'button', class: 'btn small cam-side-toggle', 'aria-expanded': 'true', onclick: () => toggleSide() }, '頻道');
  const head = h('header', { class: 'cam-head' },
    h('h2', { class: 'cam-title' }, '監視器'),
    segmented.el,
    h('label', { class: 'cam-limit', title: '同時間最多開幾路串流，超過的格子不連線（預設 9）' }, h('span', {}, '串流上限'), limitInput),
    h('div', { class: 'cam-quality', title: '子碼流：畫質較低但流暢、省頻寬（建議）。主碼流：最清晰，但同時開很多路會吃網路頻寬與電腦效能' },
      h('span', {}, '畫質'), qualitySeg.el),
    h('span', { class: 'cam-grow' }),
    sideToggle,
    h('button', { type: 'button', class: 'btn small', 'data-action': 'manage', onclick: () => onManage() }, 'NVR 管理'),
    h('button', { type: 'button', class: 'btn small primary', 'data-action': 'add-nvr', onclick: () => onAddNvr() }, icon('plus', { size: 16 }), ' 新增 NVR'));

  const notices = h('div', { class: 'cam-notices' });
  const side = h('aside', { class: 'cam-side', 'aria-label': '頻道清單' });
  const grid = h('div', { class: 'cam-grid', role: 'list' });
  const pager = h('nav', { class: 'cam-pager', 'aria-label': '分頁', hidden: true });
  const main = h('div', { class: 'cam-main' }, grid, pager);
  const body = h('div', { class: 'cam-body' }, side, main);
  const root = h('div', { class: 'cam' }, head, notices, body);
  el.replaceChildren(root);
  segmented.setValue(segmented.value); // 掛上 DOM 後重新量測圓塊
  qualitySeg.setValue(qualitySeg.value);

  const narrow = () => window.matchMedia?.('(max-width: 860px)').matches;
  function toggleSide(open) {
    const next = open ?? root.classList.contains('side-closed');
    root.classList.toggle('side-closed', !next);
    sideToggle.setAttribute('aria-expanded', String(next));
  }
  if (narrow()) toggleSide(false);

  // ------------------------------------------------------------ 資料
  const visibleChannels = () => (st.target.mode === 'single' ? st.channels.filter((c) => c.key === st.target.key) : st.channels.filter((c) => selectedKeys(st.hidden, st.channels).includes(c.key)));
  const channelOf = (key) => st.channels.find((c) => c.key === key);

  async function checkStatus() {
    let running = false;
    try {
      running = Boolean((await api.get('/api/nvr/status')).running);
    } catch {
      running = false;
    }
    if (st.destroyed) return;
    const was = st.running;
    st.running = running;
    renderNotices();
    if (running && was === false) {
      for (const t of st.tiles.values()) t.player?.retry();
      st.fullView?.player?.retry();
    }
    if (!running && !statusTimer) statusTimer = setInterval(checkStatus, STATUS_POLL_MS);
    if (running && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  async function load() {
    const [nvrs] = await Promise.all([api.get('/api/nvrs'), checkStatus()]);
    if (st.destroyed) return;
    st.nvrs = nvrs;
    st.channels = flattenChannels(nvrs);
    applyRoute(router.current().query, { render: false });
    renderSide();
    renderGrid();
    loadedOnce = true;
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (st.destroyed || st.wizardOpen) return;
      load().catch(report);
    }, 150);
  }

  const report = (err) => {
    console.error(err);
    uiLib.toast?.error?.(err?.message ?? String(err));
  };

  // ------------------------------------------------------------ 網址目標
  function applyRoute(query, { render = true } = {}) {
    const next = parseTarget(query, st.channels);
    const changed = JSON.stringify(next) !== JSON.stringify(st.target);
    st.target = next;
    if (changed) st.page = 0;
    if (changed && st.full) closeFull();
    if (render && changed && loadedOnce) {
      renderSide();
      renderGrid();
    }
    renderNotices();
  }

  function leaveSingle() {
    router.setQuery({ device: '', ch: '' }, { replace: false });
  }

  // ------------------------------------------------------------ 提示列
  function renderNotices() {
    const items = [];
    if (st.running === false) {
      items.push(h('div', { class: 'cam-notice warn', role: 'status', 'data-notice': 'down' },
        h('div', { class: 'cam-notice-text' },
          h('strong', {}, '串流服務未啟動'),
          h('span', {}, '畫面暫時無法顯示。程式會自動重試；若一直無法恢復，請重新開啟 App，或到「設定」確認監視器功能已啟用。')),
        h('button', { type: 'button', class: 'btn small', onclick: () => checkStatus() }, '重新檢查')));
    }
    if (st.target.mode === 'missing') {
      items.push(h('div', { class: 'cam-notice warn', role: 'status', 'data-notice': 'missing' },
        h('div', { class: 'cam-notice-text' }, h('strong', {}, '無法開啟單一畫面'), h('span', {}, st.target.reason)),
        h('button', { type: 'button', class: 'btn small', onclick: () => leaveSingle() }, '查看全部')));
    }
    if (st.target.mode === 'single') {
      const c = channelOf(st.target.key);
      items.push(h('div', { class: 'cam-notice info', 'data-notice': 'single' },
        h('div', { class: 'cam-notice-text' }, h('strong', {}, `單一畫面：${c?.name ?? ''}`), h('span', {}, c ? c.nvrName : '')),
        h('button', { type: 'button', class: 'btn small', onclick: () => leaveSingle() }, '查看全部')));
    }
    notices.replaceChildren(...items);
  }

  // ------------------------------------------------------------ 頻道清單
  function renderSide() {
    side.hidden = st.target.mode === 'single';
    if (!st.nvrs.length) {
      side.replaceChildren();
      return;
    }
    const on = new Set(selectedKeys(st.hidden, st.channels));
    const groups = st.nvrs.map((nvr) => {
      const chans = st.channels.filter((c) => c.nvrId === nvr.id);
      const items = chans.map((c) => {
        const input = h('input', {
          type: 'checkbox', checked: on.has(c.key), 'data-key': c.key,
          onchange: (e) => {
            const off = new Set(st.hidden);
            if (e.target.checked) off.delete(c.key);
            else off.add(c.key);
            st.hidden = [...off];
            store.set(KEYS.hidden, st.hidden);
            st.page = 0;
            renderGrid();
          },
        });
        return h('li', {}, h('label', { class: 'cam-check' }, input, h('span', { class: 'cam-check-name' }, c.name), h('small', { class: 'cam-check-ch' }, `CH${c.ch}`)));
      });
      const setAll = (value) => {
        const off = new Set(st.hidden);
        for (const c of chans) {
          if (value) off.delete(c.key);
          else off.add(c.key);
        }
        st.hidden = [...off];
        store.set(KEYS.hidden, st.hidden);
        st.page = 0;
        renderSide();
        renderGrid();
      };
      return h('section', { class: 'cam-side-group' },
        h('div', { class: 'cam-side-head' },
          h('strong', {}, nvr.name),
          h('span', { class: 'cam-side-actions' },
            h('button', { type: 'button', class: 'cam-link', onclick: () => setAll(true) }, '全選'),
            h('button', { type: 'button', class: 'cam-link', onclick: () => setAll(false) }, '全不選'))),
        items.length ? h('ul', { class: 'cam-check-list' }, items) : h('p', { class: 'cam-muted' }, '沒有啟用的頻道'));
    });
    side.replaceChildren(...groups);
  }

  // ------------------------------------------------------------ 格子
  function makeTile(channel, { limited }) {
    const name = streamName(channel.nvrId, channel.ch, st.quality);
    const msg = h('span', { class: 'cam-tile-msg' });
    const retry = h('button', { type: 'button', class: 'btn small cam-retry', hidden: true, onclick: (e) => { e.stopPropagation(); tile.retry(); } }, '重試');
    const overlay = h('div', { class: 'cam-tile-overlay' }, msg, retry);
    const videoBox = h('div', { class: 'cam-video' });
    const dot = h('span', { class: 'cam-dot', 'aria-hidden': 'true' });
    const full = h('button', {
      type: 'button', class: 'cam-icon-btn', 'aria-label': `${channel.name} 全螢幕`, title: '全螢幕（也可雙擊畫面；預設子碼流，可切換主碼流）',
      onclick: (e) => { e.stopPropagation(); openFull(channel.key); },
    }, icon('external', { size: 16 }));
    const label = h('div', { class: 'cam-tile-label' }, dot, h('span', { class: 'cam-tile-name' }, channel.name), full);
    const node = h('div', {
      class: 'cam-tile', role: 'listitem', tabindex: '0', 'data-key': channel.key, 'data-stream': name, 'data-state': 'idle',
      'aria-label': `${channel.name}，雙擊或按 Enter 開全螢幕`,
      ondblclick: () => openFull(channel.key),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === node) openFull(channel.key); },
    }, videoBox, label, overlay);

    const tile = {
      key: channel.key, el: node, limited, player: null, state: 'idle',
      setState(state, detail) {
        tile.state = state;
        node.dataset.state = state;
        const text = state === 'error' ? detail || '連線失敗' : state === 'limited' ? `已達同時串流上限（${st.limit} 路），不連線` : STATE_TEXT[state] ?? '';
        msg.textContent = text;
        msg.title = text;
        overlay.hidden = !text;
        retry.hidden = state !== 'error';
      },
      start() {
        if (tile.player || tile.limited) return;
        tile.setState('connecting');
        const player = createPlayer((s, detail) => tile.setState(s, detail));
        tile.player = player;
        videoBox.append(player);
        connectPlayer(player, wsPath(name));
      },
      stop() {
        if (tile.player) {
          tile.player.stop();
          tile.player = null;
        }
        tile.setState(tile.limited ? 'limited' : 'paused');
      },
      retry() {
        if (tile.limited) return;
        if (tile.player) tile.player.retry();
        else tile.start();
      },
    };
    tile.setState(limited ? 'limited' : 'idle');
    return tile;
  }

  function destroyTiles() {
    for (const t of st.tiles.values()) {
      t.stop();
      t.el.remove();
    }
    st.tiles.clear();
  }

  function renderGrid() {
    if (st.destroyed) return;
    destroyTiles();
    const channels = visibleChannels();
    const cells = st.target.mode === 'single' ? 1 : st.split;
    grid.dataset.cols = String(gridCols(cells));
    grid.dataset.split = String(cells);

    if (!st.nvrs.length || !st.channels.length || (!channels.length && st.target.mode !== 'missing')) {
      grid.replaceChildren(emptyState());
      renderPager({ page: 0, pages: 1 });
      return;
    }
    if (st.target.mode === 'missing') {
      grid.replaceChildren();
      renderPager({ page: 0, pages: 1 });
      return;
    }

    const slice = pageSlice(channels.map((c) => c.key), cells, st.page);
    st.page = slice.page;
    const { limited } = applyLimit(slice.keys, st.limit);
    const limitedSet = new Set(limited);
    const nodes = slice.keys.map((key) => {
      const tile = makeTile(channelOf(key), { limited: limitedSet.has(key) });
      st.tiles.set(key, tile);
      return tile.el;
    });
    // 補空格，讓版面維持整齊（1／4／9／16）
    for (let i = slice.keys.length; i < cells && cells > 1; i++) nodes.push(h('div', { class: 'cam-tile cam-tile-empty', 'aria-hidden': 'true' }));
    grid.replaceChildren(...nodes);
    renderPager(slice);
    syncStreams();
  }

  function emptyState() {
    if (!st.nvrs.length) {
      return createEmpty({ icon: 'cameras', title: '尚未設定 NVR', description: '新增 NVR 後，就能在這裡同時查看多台攝影機。設定精靈約 2 分鐘。', actionLabel: '新增 NVR', onAction: () => onAddNvr() });
    }
    if (!st.channels.length) {
      return createEmpty({ icon: 'cameras', title: '沒有啟用的頻道', description: '到「NVR 管理」編輯 NVR，啟用至少一個頻道。', actionLabel: 'NVR 管理', onAction: () => onManage() });
    }
    return createEmpty({ icon: 'cameras', title: '沒有勾選任何頻道', description: '在左側的頻道清單勾選要顯示的攝影機。' });
  }

  function renderPager({ page, pages }) {
    pager.hidden = pages <= 1;
    if (pages <= 1) {
      pager.replaceChildren();
      return;
    }
    pager.replaceChildren(
      h('button', { type: 'button', class: 'btn small', disabled: page === 0, onclick: () => { st.page = page - 1; renderGrid(); } }, '上一頁'),
      h('span', { class: 'cam-pager-text' }, `第 ${page + 1} / ${pages} 頁`),
      h('button', { type: 'button', class: 'btn small', disabled: page >= pages - 1, onclick: () => { st.page = page + 1; renderGrid(); } }, '下一頁'));
  }

  // ------------------------------------------------------------ 串流對帳
  function syncStreams() {
    if (st.destroyed) return;
    const gridActive = !st.tabHidden && !st.full;
    for (const t of st.tiles.values()) {
      if (gridActive && !t.limited) t.start();
      else t.stop();
    }
    if (st.fullView) {
      if (st.tabHidden) st.fullView.stop();
      else st.fullView.start();
    }
  }

  // ------------------------------------------------------------ 全螢幕（預設子碼流，可切換主碼流）
  function openFull(key) {
    const channel = channelOf(key);
    if (!channel || st.full || st.destroyed) return;
    st.full = key;
    const opener = document.activeElement;
    let kind = 'sub'; // 預設子碼流：開得快、不吃頻寬；要看細節再切主碼流
    const nameOf = () => streamName(channel.nvrId, channel.ch, kind);
    const msg = h('span', { class: 'cam-tile-msg' });
    const retry = h('button', { type: 'button', class: 'btn small cam-retry', hidden: true, onclick: () => view.player?.retry() }, '重試');
    const overlay = h('div', { class: 'cam-tile-overlay' }, msg, retry);
    const videoBox = h('div', { class: 'cam-video cam-full-video' });
    const closeBtn = h('button', { type: 'button', class: 'btn', 'data-action': 'close-full', onclick: () => closeFull() }, icon('close', { size: 16 }), ' 關閉');
    const subtitle = h('small', { class: 'cam-muted' });
    const kindBtn = h('button', { type: 'button', class: 'btn', 'data-action': 'toggle-quality', onclick: () => view.setKind(kind === 'main' ? 'sub' : 'main') });
    const node = h('div', {
      class: 'cam-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${channel.name} 全螢幕`, 'data-state': 'idle', tabindex: '-1',
      ondblclick: () => closeFull(),
      onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFull(); } },
    },
    h('div', { class: 'cam-full-bar' }, h('strong', { class: 'cam-full-title' }, channel.name), subtitle, h('span', { class: 'cam-grow' }), kindBtn, closeBtn),
    videoBox, overlay);

    const view = {
      key, el: node, opener, player: null,
      setState(state, detail) {
        node.dataset.state = state;
        const text = state === 'error' ? detail || '連線失敗' : STATE_TEXT[state] ?? '';
        msg.textContent = text;
        overlay.hidden = !text;
        retry.hidden = state !== 'error';
      },
      start() {
        if (view.player) return;
        view.setState('connecting');
        const player = createPlayer((s, d) => view.setState(s, d));
        view.player = player;
        videoBox.append(player);
        connectPlayer(player, wsPath(nameOf()));
      },
      stop() {
        view.player?.stop();
        view.player = null;
        view.setState('paused');
      },
      /** 切換主／子碼流：更新標示後重新連線（分頁隱藏中就等回來再連） */
      setKind(next) {
        kind = next;
        node.dataset.stream = nameOf();
        subtitle.textContent = `${channel.nvrName} · CH${channel.ch} · ${QUALITY_LABELS[kind]}`;
        kindBtn.textContent = `切換為${QUALITY_LABELS[kind === 'main' ? 'sub' : 'main']}`;
        if (!view.player) return;
        view.stop();
        if (!st.tabHidden) view.start();
      },
    };
    view.setKind(kind);
    st.fullView = view;
    document.body.append(node);
    document.documentElement.classList.add('cam-full-open');
    syncStreams(); // 格子暫停、全螢幕串流開始
    closeBtn.focus();
  }

  function closeFull() {
    const view = st.fullView;
    if (!view) return;
    st.fullView = null;
    st.full = null;
    view.stop();
    view.el.remove();
    document.documentElement.classList.remove('cam-full-open');
    syncStreams(); // 回到子碼流
    if (view.opener?.isConnected) view.opener.focus?.();
  }

  // ------------------------------------------------------------ 事件
  const onVisibility = () => {
    st.tabHidden = document.hidden === true;
    syncStreams();
  };
  document.addEventListener('visibilitychange', onVisibility);
  offs.push(() => document.removeEventListener('visibilitychange', onVisibility));

  offs.push(bus.on('nvr.changed', scheduleReload));
  offs.push(router.on(({ path, query }) => {
    if (path === '/cameras') applyRoute(query);
  }));

  // ------------------------------------------------------------ 對外
  return {
    el: root,
    state: st,
    async start() {
      await load();
    },
    reload: () => load(),
    /** 精靈開啟期間暫停自動重新載入（精靈自己會建立草稿 NVR），關閉後補一次 */
    setWizardOpen(open) {
      st.wizardOpen = open;
      if (!open) scheduleReload();
    },
    openFull,
    closeFull,
    destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      closeFull();
      clearTimeout(reloadTimer);
      clearInterval(statusTimer);
      statusTimer = null;
      destroyTiles();
      for (const off of offs.splice(0)) off();
      segmented.destroy?.();
      root.remove();
    },
  };
}
