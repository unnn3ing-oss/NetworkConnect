// 安裝教學頁：選擇 Mac／Windows → 開啟 A1 的全螢幕 guide。內容在 steps.js。
import { createGuide } from '../../web/ui/guide.js';
import { routes, splitInline } from './steps.js';

function inline(parent, text) {
  for (const part of splitInline(text)) {
    if (part.code) {
      const code = document.createElement('code');
      code.textContent = part.text;
      parent.append(code);
    } else {
      parent.append(document.createTextNode(part.text));
    }
  }
  return parent;
}

function bodyNode({ intro, items = [], tip }) {
  const root = document.createElement('div');
  if (intro) root.append(inline(document.createElement('p'), intro));
  if (items.length) {
    const ol = document.createElement('ol');
    ol.className = 'nc-do';
    for (const item of items) ol.append(inline(document.createElement('li'), item));
    root.append(ol);
  }
  if (tip) {
    const p = document.createElement('p');
    p.className = 'nc-tip';
    root.append(inline(p, tip));
  }
  return root;
}

function openRoute(id) {
  const route = routes[id];
  if (!route) return;
  history.replaceState(null, '', `#${id}`);
  const guide = createGuide({
    title: route.title,
    subtitle: route.subtitle,
    steps: route.steps.map((s) => ({ label: s.label, art: s.art, body: bodyNode(s.body) })),
    onClose() {
      history.replaceState(null, '', location.pathname + location.search);
      document.querySelector(`[data-route="${id}"]`)?.focus();
    },
  });
  guide.open();
}

for (const btn of document.querySelectorAll('[data-route]')) {
  btn.addEventListener('click', () => openRoute(btn.dataset.route));
}

// 依瀏覽器判斷建議的路線（只是標示，不影響選擇）
const ua = `${navigator.userAgent} ${navigator.platform ?? ''}`;
const guess = /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'mac' : /Win/i.test(ua) ? 'win' : null;
if (guess) {
  const badge = document.querySelector(`[data-route="${guess}"] .route-badge`);
  if (badge) badge.hidden = false;
}

const fromHash = location.hash.replace('#', '');
if (routes[fromHash]) openRoute(fromHash);
