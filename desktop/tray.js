// 選單列（macOS）／系統匣（Windows）：狀態圖示與選單。選單內容由 lib/tray-menu.js（純函式）產生。
import path from 'node:path';
import { Menu, Tray, nativeImage } from 'electron';
import { buildTrayMenu, trayTooltip } from './lib/tray-menu.js';

/**
 * @param {object} opts
 * @param {string} opts.iconsDir
 * @param {string} opts.platform
 * @param {string} opts.version
 * @param {() => void} opts.onClick   Windows／Linux 左鍵點圖示
 * @param {() => object} opts.getHandlers
 * @param {() => object} opts.getSettings
 */
export function createTrayController({ iconsDir, platform, version, onClick, getHandlers, getSettings }) {
  const image = (alert) => {
    // macOS：檔名以 Template 結尾的圖片會被當成 template image，系統依深淺色選單列自動上色；@2x 自動載入
    const file = platform === 'darwin' ? (alert ? 'trayAlertTemplate.png' : 'trayTemplate.png') : alert ? 'tray-alert.png' : 'tray.png';
    return nativeImage.createFromPath(path.join(iconsDir, file));
  };

  let tray = null;
  let state = { alert: false, paused: false };
  try {
    tray = new Tray(image(false));
    if (platform !== 'darwin') tray.on('click', onClick);
  } catch (err) {
    // 沒有系統匣的環境（例如無桌面的 Linux 容器）：App 仍可運作，只是沒有圖示
    console.warn(`無法建立系統匣圖示：${err.message}`);
  }

  function render() {
    if (!tray) return;
    tray.setImage(image(state.alert));
    tray.setToolTip(trayTooltip(state));
    tray.setContextMenu(
      Menu.buildFromTemplate(buildTrayMenu({ version, alert: state.alert, paused: state.paused, settings: getSettings(), handlers: getHandlers() })),
    );
  }

  render();
  return {
    /** @param {{alert?: boolean, paused?: boolean}} next 只更新有帶的欄位；選單勾選狀態每次都重新讀取設定 */
    update(next = {}) {
      state = { ...state, ...next };
      render();
    },
    destroy() {
      tray?.destroy();
      tray = null;
    },
    get available() {
      return tray !== null;
    },
  };
}
