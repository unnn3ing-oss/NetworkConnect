// 系統匣／選單列的選單內容（規格 §8.6）：純函式，回傳 Electron Menu.buildFromTemplate 可用的陣列。

export function trayTooltip({ alert, paused }) {
  if (paused) return 'NetworkConnect：偵測已暫停';
  return alert ? 'NetworkConnect：有關鍵設備離線' : 'NetworkConnect：全部正常';
}

/**
 * @param {object} args
 * @param {string} args.version
 * @param {boolean} args.alert      有關鍵設備離線
 * @param {boolean} args.paused     偵測暫停中
 * @param {string|null} [args.updateVersion]  背景檢查發現的新版本號
 * @param {boolean} [args.downloading]        新版本下載中
 * @param {{autoLaunch: boolean, preventSleep: boolean, lanAccess: boolean}} args.settings
 * @param {Record<string, (...a: any[]) => void>} args.handlers
 *   openMain、showMobile、pauseMonitoring、resumeMonitoring、setAutoLaunch(bool)、setPreventSleep(bool)、setLanAccess(bool)、checkUpdates、quit
 */
export function buildTrayMenu({ version, alert, paused, settings, handlers, updateVersion = null, downloading = false }) {
  const status = paused ? '偵測已暫停' : alert ? '有關鍵設備離線' : '全部正常';
  return [
    { label: `狀態：${status}`, enabled: false },
    { type: 'separator' },
    { label: '開啟主控台', click: () => handlers.openMain() },
    { label: '手機連線…', click: () => handlers.showMobile() },
    paused
      ? { label: '恢復偵測', click: () => handlers.resumeMonitoring() }
      : { label: '暫停偵測 30 分鐘', click: () => handlers.pauseMonitoring() },
    { type: 'separator' },
    { label: '開機自動啟動', type: 'checkbox', checked: settings.autoLaunch, click: (item) => handlers.setAutoLaunch(item.checked) },
    { label: '偵測期間防止電腦閒置睡眠', type: 'checkbox', checked: settings.preventSleep, click: (item) => handlers.setPreventSleep(item.checked) },
    { label: '允許手機在區網連線（會重新啟動伺服器）', type: 'checkbox', checked: settings.lanAccess, click: (item) => handlers.setLanAccess(item.checked) },
    { type: 'separator' },
    downloading
      ? { label: '正在下載新版本…', enabled: false }
      : { label: updateVersion ? `安裝新版本 ${updateVersion}…` : '檢查更新…', click: () => handlers.checkUpdates() },
    { label: `NetworkConnect ${version}`, enabled: false },
    { type: 'separator' },
    { label: '結束 NetworkConnect', click: () => handlers.quit() },
  ];
}
