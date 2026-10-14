// 系統通知（Electron 端）：把 lib/notifier.js 的規則接到 Notification。
import { Notification } from 'electron';
import { createNotifier } from './lib/notifier.js';
import { createNotifyThrottle } from './lib/notify-rules.js';

/**
 * @param {object} opts
 * @param {(id: string) => Promise<{name: string, critical: boolean}|null>} opts.getDevice
 * @param {() => void} opts.onClick  點通知時開啟主視窗
 * @param {{warn: Function}} opts.log
 */
export function createDesktopNotifier({ getDevice, onClick, log }) {
  return createNotifier({
    getDevice,
    throttle: createNotifyThrottle(),
    log,
    show({ title, body }) {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', onClick);
      n.show();
    },
  });
}

/** 一般用途的說明通知（例如 Windows 第一次隱藏到系統匣）。 */
export function showInfoNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}
