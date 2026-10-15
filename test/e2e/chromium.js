// 找 Chromium（不執行 playwright install）：NC_CHROMIUM_PATH，其次 PLAYWRIGHT_BROWSERS_PATH／opt/pw-browsers 下的 chromium-*。
import fs from 'node:fs';
import path from 'node:path';

export function findChromium() {
  if (process.env.NC_CHROMIUM_PATH) return process.env.NC_CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  const rels = [
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'headless_shell'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse()) {
      for (const rel of rels) {
        const p = path.join(root, dir, ...rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // 交給 Playwright 的預設位置
}
