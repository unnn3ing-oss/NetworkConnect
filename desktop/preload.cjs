// 預載腳本（sandbox:true，必須是 CommonJS）。只暴露 ncDesktop.{version, platform, openExternal}（規格 §8.6）。
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('nc:info');

contextBridge.exposeInMainWorld(
  'ncDesktop',
  Object.freeze({
    version: String(info?.version ?? ''),
    platform: process.platform,
    /** 以系統瀏覽器開啟 http／https 連結（主行程會再檢查一次）。 */
    openExternal: (url) => ipcRenderer.invoke('nc:open-external', String(url)),
  }),
);
