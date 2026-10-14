// 測試用：建立 jsdom 並把需要的全域物件掛到 globalThis，元件模組只在呼叫時才碰 document。
// jsdom 由 web/ui/package.json 提供（找不到再退回根目錄的 node_modules）。
import { createRequire } from 'node:module';

const req = createRequire(new URL('../../../web/ui/package.json', import.meta.url));
let JSDOM;
try { ({ JSDOM } = req('jsdom')); } catch { ({ JSDOM } = createRequire(import.meta.url)('jsdom')); }

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'DOMParser', 'CustomEvent']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}

export const document = w.document;
export const reset = () => { document.body.innerHTML = ''; document.documentElement.className = ''; };
export const key = (el, k, init = {}) => {
  const ev = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};
export const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];
