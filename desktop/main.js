// NetworkConnect 桌面 App 主行程（規格 §8.6）。
// 可測的邏輯都在 desktop/lib/（純函式，npm test 在 Linux 容器內執行）；這支檔案只負責把它們接上 Electron。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, net, powerSaveBlocker, session, shell, utilityProcess } from 'electron';
import { createFileLogger } from './lib/logger.js';
import { buildMobileUrls } from './lib/lan-ip.js';
import { buildErrorPageHtml, buildMobilePageHtml, toDataUrl } from './lib/pages.js';
import { buildServerEnv, resolveDataDir, resolveGo2rtcPath } from './lib/paths.js';
import { createOverviewClient, looksLikeLocalNetworkDenied } from './lib/overview.js';
import { createSupervisor } from './lib/server-supervisor.js';
import { loadDesktopSettings, saveDesktopSettings } from './lib/settings.js';
import { checkForUpdate, installerSuffix } from './lib/semver.js';
import { buildInstallCommand, downloadInstaller, selfInstallSupport } from './lib/updater.js';
import { isAppUrl, isSafeExternalUrl, parseActionUrl } from './lib/window-policy.js';
import { createTrayController } from './tray.js';
import { createDesktopNotifier, showInfoNotification } from './notify.js';

const APP_ID = 'io.github.unnn3ing-oss.networkconnect';
const REPO = 'unnn3ing-oss/NetworkConnect';
const PAUSE_MS = 30 * 60 * 1000;
const STATUS_REFRESH_MS = 30 * 1000;
const UPDATE_FIRST_CHECK_MS = 30 * 1000;
const UPDATE_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = app.getAppPath();
const platform = process.platform;

// ---- userData：固定為 <appData>/NetworkConnect（規格 §9）；NC_DESKTOP_USER_DATA 供冒煙測試隔離 ----
app.setName('NetworkConnect');
app.setPath('userData', process.env.NC_DESKTOP_USER_DATA || path.join(app.getPath('appData'), 'NetworkConnect'));
if (platform === 'win32') app.setAppUserModelId(APP_ID);

const userData = app.getPath('userData');
const dataDir = resolveDataDir(userData, platform);
const logsDir = path.join(userData, 'logs');
const desktopLog = createFileLogger({ file: path.join(logsDir, 'desktop.log') });
const serverLog = createFileLogger({ file: path.join(logsDir, 'server.log') });
const log = {
  info: (m) => desktopLog.info(m),
  warn: (m) => desktopLog.warn(m),
  error: (m) => desktopLog.error(m),
};

// ---- 單一實例鎖 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---- 狀態 ----
let settings = loadDesktopSettings(userData);
let mainWindow = null;
let mobileWindow = null;
let currentPort = null;
let quitting = false;
let quitState = 'running'; // running → stopping → done
let sleepBlockerId = null;
let tray = null;
let refreshTimer = null;
let promptedLocalNetwork = false;
let updateTimer = null;
let updateBusy = false;
let availableUpdate = null; // 背景檢查發現的新版（系統匣選單顯示用）
let pendingInstall = null; // 結束流程最後要執行的安裝指令
const startHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;

const baseUrl = () => (currentPort ? `http://127.0.0.1:${currentPort}` : null);

// 主行程查詢伺服器 API：帶上啟動伺服器時給的隨機 token（設了存取密碼、視窗沒登入也能查），同時保留視窗 session 的 cookie
const desktopToken = crypto.randomBytes(32).toString('hex');
const sessionFetch = (url, init = {}) =>
  session.defaultSession.fetch(url, { ...init, credentials: 'include', headers: { ...(init.headers ?? {}), 'x-nc-desktop-token': desktopToken } });
const overview = createOverviewClient({ getBaseUrl: baseUrl, fetch: sessionFetch });

// ---- 伺服器行程 ----
const go2rtcPath = resolveGo2rtcPath({ platform, arch: process.arch, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot });

function forkServer() {
  const env = buildServerEnv({ baseEnv: process.env, dataDir, lanAccess: settings.lanAccess, go2rtcPath, port: settings.port, desktopToken });
  log.info(`啟動伺服器：dataDir=${dataDir} host=${env.NC_HOST} port=${env.NC_PORT ?? '(config)'} go2rtc=${go2rtcPath ?? '(未提供)'}`);
  const child = utilityProcess.fork(path.join(appRoot, 'server', 'cli.js'), [], {
    env,
    stdio: 'pipe',
    serviceName: 'NetworkConnect Server',
  });
  child.stdout?.on('data', (c) => serverLog.write(c));
  child.stderr?.on('data', (c) => serverLog.write(c));
  return child;
}

const notifier = createDesktopNotifier({ getDevice: (id) => overview.getDevice(id), onClick: () => openMain(), log });

const supervisor = createSupervisor({
  fork: forkServer,
  log,
  onReady({ port, restarted }) {
    currentPort = port;
    log.info(`伺服器就緒：port=${port}${restarted ? '（重啟後）' : ''}`);
    loadApp(restarted);
    refreshStatus();
  },
  onRestart: (n) => log.warn(`伺服器非預期結束，第 ${n} 次自動重啟`),
  onGaveUp(info) {
    currentPort = null;
    showErrorPage(`伺服器啟動失敗：${info.reason}`);
  },
  onEvent(name, payload) {
    if (name === 'status.changed') {
      notifier.handleStatusChanged(payload);
      refreshStatus();
    }
  },
});

// ---- 視窗 ----
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'NetworkConnect',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!startHidden || win.__shownOnce) win.show();
    win.__shownOnce = true;
  });
  // 關閉視窗＝隱藏到選單列／系統匣，偵測持續；真正結束只能從選單「結束 NetworkConnect」
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    noteFirstHide();
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

function noteFirstHide() {
  if (platform !== 'win32') return;
  const marker = path.join(userData, '.hide-notice-shown');
  if (fs.existsSync(marker)) return;
  try {
    fs.writeFileSync(marker, '');
  } catch {
    // 寫不進去就每次都提示，無妨
  }
  showInfoNotification('NetworkConnect 仍在背景執行', '視窗已隱藏到系統匣，偵測會持續進行。要結束請在系統匣圖示按右鍵，選「結束 NetworkConnect」。');
}

function loadApp(restarted) {
  if (!mainWindow) mainWindow = createMainWindow();
  mainWindow.loadURL(baseUrl()).catch((err) => log.error(`載入主控台失敗：${err.message}`));
  if (restarted && !mainWindow.isVisible() && !startHidden) mainWindow.show();
}

function showErrorPage(message) {
  log.error(message);
  if (!mainWindow) mainWindow = createMainWindow();
  mainWindow.__shownOnce = true;
  mainWindow.loadURL(toDataUrl(buildErrorPageHtml({ message }))).catch(() => {});
  if (mainWindow.isVisible() === false) mainWindow.show();
  tray?.update({ alert: true });
}

function openMain() {
  if (!mainWindow) {
    mainWindow = createMainWindow();
    mainWindow.__shownOnce = true;
    if (currentPort) mainWindow.loadURL(baseUrl()).catch(() => {});
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showMobile() {
  const html = buildMobilePageHtml({
    urls: currentPort ? buildMobileUrls({ interfaces: os.networkInterfaces(), port: currentPort, lanAccess: settings.lanAccess }) : [],
    lanAccess: settings.lanAccess,
  });
  if (mobileWindow) {
    mobileWindow.loadURL(toDataUrl(html));
    mobileWindow.show();
    mobileWindow.focus();
    return;
  }
  mobileWindow = new BrowserWindow({
    width: 460,
    height: 640,
    title: '手機連線',
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false, spellcheck: false },
  });
  mobileWindow.setMenuBarVisibility(false);
  mobileWindow.on('closed', () => {
    mobileWindow = null;
  });
  mobileWindow.loadURL(toDataUrl(html));
}

// ---- 導覽與外部連結安全（規格 §8.6）----
function handleAction(action) {
  if (action === 'open-logs') shell.openPath(logsDir);
  else if (action === 'restart') {
    supervisor.restart().catch((err) => log.error(`重新啟動失敗：${err.message}`));
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  const guard = (e, url) => {
    const isMain = mainWindow && contents.id === mainWindow.webContents.id;
    if (isMain) {
      const action = parseActionUrl(url);
      if (action) {
        e.preventDefault();
        handleAction(action);
        return;
      }
      if (isAppUrl(url, currentPort)) return;
    }
    e.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
});

function installSessionPolicy() {
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

ipcMain.on('nc:info', (e) => {
  e.returnValue = { version: app.getVersion() };
});
ipcMain.handle('nc:open-external', (e, url) => {
  // 只接受來自本機主控台頁面的請求，且只開 http／https
  if (!isAppUrl(e.senderFrame?.url ?? '', currentPort) || !isSafeExternalUrl(url)) return false;
  shell.openExternal(url);
  return true;
});

// ---- 設定：開機自動啟動、防止睡眠、區網連線 ----
function applyLoginItem() {
  if (!app.isPackaged) return; // 開發時不要把 electron 本體登錄成開機項目
  app.setLoginItemSettings({ openAtLogin: settings.autoLaunch, openAsHidden: true, args: ['--hidden'] });
}

function applySleepBlocker() {
  if (settings.preventSleep && sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!settings.preventSleep && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

function updateSettings(patch) {
  settings = saveDesktopSettings(userData, { ...settings, ...patch });
  return settings;
}

// ---- 檢查更新與 App 內更新 ----
const githubFetch = (url, init) => net.fetch(url, init);
const updateSuffix = installerSuffix(platform, process.arch);

function messageBox(options) {
  const parent = mainWindow?.isVisible() ? mainWindow : undefined;
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function isWritable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 背景檢查：只有發現新版時才通知，失敗不打擾 */
async function backgroundCheckUpdates() {
  if (updateBusy || quitting || !app.isPackaged) return;
  const r = await checkForUpdate({ currentVersion: app.getVersion(), repo: REPO, fetch: githubFetch, suffix: updateSuffix });
  if (r.status === 'error') log.warn(`背景檢查更新失敗：${r.message}`);
  if (r.status !== 'available' || availableUpdate?.latest === r.latest) return;
  availableUpdate = r;
  log.info(`發現新版本 ${r.latest}`);
  tray?.update({ updateVersion: r.latest });
  showInfoNotification(`NetworkConnect 有新版本 ${r.latest}`, '在選單列／系統匣圖示選「安裝新版本」即可更新。', () => checkUpdates());
}

async function checkUpdates() {
  if (updateBusy) return;
  updateBusy = true;
  try {
    const r = await checkForUpdate({ currentVersion: app.getVersion(), repo: REPO, fetch: githubFetch, suffix: updateSuffix });
    if (r.status === 'up-to-date') {
      availableUpdate = null;
      tray?.update({ updateVersion: null });
      await messageBox({ type: 'info', message: '目前已是最新版本', detail: `版本 ${app.getVersion()}`, buttons: ['好'] });
      return;
    }
    if (r.status === 'error') {
      await messageBox({ type: 'warning', message: '無法檢查更新', detail: r.message, buttons: ['好'] });
      return;
    }
    availableUpdate = r;
    tray?.update({ updateVersion: r.latest });
    const support = r.asset ? selfInstallSupport({ platform, exePath: app.getPath('exe'), isWritable }) : { ok: false, reason: '這個版本沒有提供可自動安裝的檔案' };
    const detail = [`目前版本 ${app.getVersion()}`, r.notes ? `\n更新內容：\n${r.notes}` : '', support.ok ? '' : `\n無法自動安裝：${support.reason}`].join('\n').trim();
    const buttons = support.ok ? ['下載並安裝', '查看更新內容', '稍後'] : ['前往下載頁', '稍後'];
    const { response } = await messageBox({ type: 'info', message: `有新版本 ${r.latest}`, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    const choice = buttons[response];
    if (choice === '查看更新內容' || choice === '前往下載頁') shell.openExternal(r.url);
    if (choice === '下載並安裝') await downloadAndInstall(r, support);
  } finally {
    updateBusy = false;
  }
}

async function downloadAndInstall(update, support) {
  const setProgress = (v) => mainWindow?.setProgressBar(v);
  let installer;
  try {
    log.info(`下載新版本 ${update.latest}：${update.asset.url}`);
    tray?.update({ updateVersion: update.latest, downloading: true });
    installer = await downloadInstaller({ asset: update.asset, dir: path.join(userData, 'updates'), fetch: githubFetch, onProgress: setProgress });
    log.info(`下載完成並通過 sha256 驗證：${installer}`);
  } catch (err) {
    log.error(`下載新版本失敗：${err.message}`);
    await messageBox({ type: 'warning', message: '下載新版本失敗', detail: err.message, buttons: ['好'] });
    return;
  } finally {
    setProgress(-1);
    tray?.update({ downloading: false });
  }
  const { response } = await messageBox({
    type: 'info',
    message: `新版本 ${update.latest} 已下載完成`,
    detail: 'NetworkConnect 會先結束、安裝新版，再自動重新開啟（約 10–30 秒）。設備、樓層與監視器設定都會保留。',
    buttons: ['立即安裝並重新開啟', '稍後'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return; // 已下載的檔案保留，下次選「安裝新版本」會直接沿用
  const cmd = buildInstallCommand({
    platform,
    installer,
    appPath: support.appPath,
    pid: process.pid,
    logFile: path.join(logsDir, 'update.log'),
    scriptFile: path.join(userData, 'updates', 'install.sh'),
  });
  if (cmd.script) fs.writeFileSync(cmd.args[0], cmd.script, { mode: 0o700 });
  pendingInstall = () => {
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => log.error(`啟動安裝程式失敗：${err.message}`));
    child.unref();
  };
  log.info(`結束後執行安裝：${cmd.command} ${cmd.args.join(' ')}`);
  app.quit();
}

// ---- 系統匣狀態 ----
async function refreshStatus() {
  if (quitting) return;
  try {
    const [summary, pausedUntil] = await Promise.all([overview.getSummary(), overview.getPausedUntil()]);
    const paused = pausedUntil !== null && pausedUntil > Date.now();
    tray?.update({ alert: summary?.alert ?? false, paused });
    if (!promptedLocalNetwork && looksLikeLocalNetworkDenied(summary, platform)) {
      promptedLocalNetwork = true;
      promptLocalNetwork();
    }
  } catch (err) {
    log.warn(`更新狀態失敗：${err.message}`);
  }
}

async function promptLocalNetwork() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: '偵測不到任何區網設備',
    detail: '如果 macOS 詢問「NetworkConnect 想要尋找並連接區域網路上的裝置」時按了「不允許」，所有設備都會顯示離線。請到「系統設定 → 隱私權與安全性 → 區域網路」開啟 NetworkConnect。',
    buttons: ['開啟系統設定', '稍後'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
}

const trayHandlers = () => ({
  openMain,
  showMobile,
  async pauseMonitoring() {
    await overview.setPausedUntil(new Date(Date.now() + PAUSE_MS).toISOString());
    refreshStatus();
  },
  async resumeMonitoring() {
    await overview.setPausedUntil(null);
    refreshStatus();
  },
  setAutoLaunch(v) {
    updateSettings({ autoLaunch: v });
    applyLoginItem();
    tray?.update();
  },
  setPreventSleep(v) {
    updateSettings({ preventSleep: v });
    applySleepBlocker();
    tray?.update();
  },
  async setLanAccess(v) {
    updateSettings({ lanAccess: v });
    tray?.update();
    try {
      await supervisor.restart(); // 綁定位址只在啟動時套用；就緒後 onReady 會重新載入視窗
    } catch (err) {
      log.error(`套用區網設定時重啟伺服器失敗：${err.message}`);
    }
  },
  checkUpdates,
  quit: () => app.quit(),
});

// ---- 生命週期 ----
app.on('second-instance', () => openMain());
app.on('activate', () => openMain());
app.on('window-all-closed', () => {
  // 關閉視窗只是隱藏；伺服器與系統匣繼續執行
});

app.on('before-quit', (e) => {
  quitting = true;
  if (quitState === 'done') return;
  e.preventDefault();
  if (quitState === 'stopping') return;
  quitState = 'stopping';
  clearInterval(refreshTimer);
  clearInterval(updateTimer);
  log.info('結束：送出 shutdown，最多等 5 秒');
  supervisor
    .stop()
    .then(({ forced }) => log.info(forced ? '伺服器未在時限內結束，已強制結束' : '伺服器已正常結束'))
    .catch((err) => log.error(`停止伺服器失敗：${err.message}`))
    .finally(() => {
      quitState = 'done';
      tray?.destroy();
      if (sleepBlockerId !== null) powerSaveBlocker.stop(sleepBlockerId);
      if (pendingInstall) {
        try {
          pendingInstall();
        } catch (err) {
          log.error(`啟動安裝程式失敗：${err.message}`);
        }
      }
      desktopLog.close();
      serverLog.close();
      app.quit();
    });
});

// 注意：ESM 主行程不要在頂層 await app.whenReady()，Electron 會等主模組執行完才發出 ready，造成死結
app.whenReady().then(() => {
  log.info(`NetworkConnect ${app.getVersion()} 啟動（Electron ${process.versions.electron}、Node ${process.versions.node}、${platform}-${process.arch}）`);
  installSessionPolicy();
  if (app.isPackaged && settings.autoLaunch !== app.getLoginItemSettings().openAtLogin) applyLoginItem();
  applySleepBlocker();
  tray = createTrayController({
    iconsDir: path.join(here, 'icons'),
    platform,
    version: app.getVersion(),
    onClick: openMain,
    getHandlers: trayHandlers,
    getSettings: () => settings,
  });
  refreshTimer = setInterval(refreshStatus, STATUS_REFRESH_MS);
  setTimeout(backgroundCheckUpdates, UPDATE_FIRST_CHECK_MS).unref?.();
  updateTimer = setInterval(backgroundCheckUpdates, UPDATE_CHECK_EVERY_MS);
  supervisor.start().catch((err) => log.error(`伺服器未能啟動：${err.message}`)); // 失敗畫面由 onGaveUp 負責
});
