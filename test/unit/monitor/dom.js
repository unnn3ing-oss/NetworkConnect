// 測試用：建立 jsdom 並把需要的全域物件掛到 globalThis（web/modules/status 只在呼叫時才碰 document）。
import { createRequire } from 'node:module';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'MouseEvent', 'DOMParser']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}

export const document = w.document;
export const reset = () => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
};
export const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];
