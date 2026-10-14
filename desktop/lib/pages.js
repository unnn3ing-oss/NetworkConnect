// 主行程自己產生的兩個小頁面：「手機連線」視窗與伺服器失敗時的錯誤頁。
// 以 data: URL 載入，CSP 禁止一切腳本與外部資源；互動靠 nc-action:// 連結（由主行程攔截）。
import { renderQrSvg } from './qr.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f7fd;--surface:#fff;--text:#14213d;--muted:#5b6785;--accent:#004aad;--border:#d8e0f0;--danger:#c62828}
@media(prefers-color-scheme:dark){:root{--bg:#0e1424;--surface:#161e33;--text:#e8ecf7;--muted:#9aa6c4;--accent:#5b9bff;--border:#2a3556;--danger:#ff7b7b}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang TC","Microsoft JhengHei",sans-serif;padding:20px}
main{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:24px;text-align:center}
h1{font-size:18px;margin:0 0 6px}
p{margin:6px 0;color:var(--muted)}
.qr{width:220px;height:220px;margin:14px auto;border-radius:12px;overflow:hidden;border:1px solid var(--border)}
.qr svg{display:block;width:100%;height:100%}
ul{list-style:none;padding:0;margin:10px 0 0}
li{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:var(--text);word-break:break-all;padding:4px 0}
a.btn{display:inline-block;margin:6px 4px 0;padding:8px 18px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);text-decoration:none;font-weight:600}
a.btn.primary{background:var(--accent);color:var(--bg)}
.err h1{color:var(--danger)}
`;

const page = (title, body) =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

/** @param {{urls: string[], lanAccess: boolean}} args */
export function buildMobilePageHtml({ urls, lanAccess }) {
  let inner;
  if (!lanAccess) {
    inner = `<p>目前只允許這台電腦連線。</p><p>請在選單列（系統匣）選單開啟「允許手機在區網連線」，伺服器會自動重新啟動。</p>`;
  } else if (urls.length === 0) {
    inner = `<p>找不到可用的區域網路位址。</p><p>請確認電腦已連上家中的 Wi-Fi 或網路線，再重新開啟此視窗。</p>`;
  } else {
    inner = `<p>用手機掃描 QR Code，或在瀏覽器輸入下列網址（手機需連上同一個 Wi-Fi）。</p>
<div class="qr">${renderQrSvg(urls[0])}</div>
<ul>${urls.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>`;
  }
  return page('手機連線', `<main><h1>手機連線</h1>${inner}</main>`);
}

/** @param {{message: string}} args */
export function buildErrorPageHtml({ message }) {
  return page(
    'NetworkConnect 無法啟動',
    `<main class="err"><h1>伺服器無法啟動</h1><p>${esc(message)}</p><p>已自動重試 3 次仍然失敗。</p>
<a class="btn primary" href="nc-action://restart">重新啟動</a><a class="btn" href="nc-action://open-logs">查看紀錄</a></main>`,
  );
}

export const toDataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
