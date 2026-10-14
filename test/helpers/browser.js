// 啟動 Playwright 的 Chromium。找不到瀏覽器時回傳 null，呼叫端的測試會 skip（例如沒裝 Chromium 的 CI）。
import fs from 'node:fs';
import path from 'node:path';

function findChromium() {
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
  return undefined; // 交給 Playwright 自己的預設位置
}

/** @returns {Promise<import('@playwright/test').Browser | null>} */
export async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    return null;
  }
  try {
    return await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  } catch {
    return null;
  }
}
