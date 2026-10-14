#!/usr/bin/env node
// 產生 desktop/icons/ 下所有圖示：node scripts/make-icons.js
//   icon-1024.png（原圖）、icon.icns（macOS）、icon.ico（Windows）、
//   trayTemplate[@2x].png／trayAlertTemplate[@2x].png（macOS 選單列 template image）、tray.png／tray-alert.png（Windows）
// 全部由 scripts/lib/icon-art.js 計算產生，沒有外部相依；想換圖樣就改 icon-art.js 再重跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.js';
import { encodeIco, encodeIcns } from './lib/icon-formats.js';
import { renderAppIcon, renderTrayGlyph } from './lib/icon-art.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const png = ({ width, height, data }) => encodePng(width, height, data);
const write = (name, buf) => {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`寫入 ${name}（${buf.length} bytes）`);
};

const app = (size) => renderAppIcon(size);
write('icon-1024.png', png(app(1024)));
write('icon.icns', encodeIcns([128, 256, 512, 1024].map((size) => ({ size, png: png(app(size)) }))));
write(
  'icon.ico',
  encodeIco([16, 24, 32, 48, 64, 256].map((size) => {
    const img = app(size);
    return { size, rgba: img.data, png: png(img) };
  })),
);

write('trayTemplate.png', png(renderTrayGlyph(22, { template: true, alert: false })));
write('trayTemplate@2x.png', png(renderTrayGlyph(44, { template: true, alert: false })));
write('trayAlertTemplate.png', png(renderTrayGlyph(22, { template: true, alert: true })));
write('trayAlertTemplate@2x.png', png(renderTrayGlyph(44, { template: true, alert: true })));
write('tray.png', png(renderTrayGlyph(32, { template: false, alert: false })));
write('tray-alert.png', png(renderTrayGlyph(32, { template: false, alert: true })));
