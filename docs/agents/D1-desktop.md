# D1 桌面 App（Electron 外殼、打包、三平台 CI）

## 必讀
- 規格 §2、§3、§4、§8.6（含 5 項已知地雷）、§11（`docs/specs/2026-10-14-networkconnect-design.md`）
- 規格 §8.4 地雷 6–8（go2rtc 行程，由 B5 實作，你只負責下載與打包執行檔）
- `server/index.js` 的 `startServer()` 與 parentPort 訊息格式（A0 任務書第 9 項）；`contracts/events.md` 的 `status.changed`
- `web/ui/README.md`（只用在安裝教學頁）
- Electron 官方文件中 `utilityProcess`、`Tray`、`Notification`、`app.setLoginItemSettings`、`powerSaveBlocker`、安全性檢查清單（只查這幾頁）；electron-builder 的 mac／win／nsis／extraResources 設定頁

## 可修改
`desktop/` `scripts/` `electron-builder.yml` `.github/workflows/` `test/unit/desktop/` `test/desktop/` `docs/install/`（安裝教學頁）；`package.json` 只能新增 `main`、`build` 相關 scripts 與 Electron／electron-builder 的 devDependencies（衝突時以 Change Request 告知主控）

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`（只在做安裝教學頁時用）

## 工作項目
1. **版本**：選內建 Node 版本與 `.nvmrc` 相同主版本的 Electron 穩定版，鎖確切版本；electron-builder 也鎖確切版本。
2. **主行程 `desktop/main.js`**，依規格 §8.6：
   - 單一實例鎖；資料夾 `app.getPath('userData')/data`；`utilityProcess.fork(server/cli.js 或 server 入口)`，以環境變數傳 `NC_DATA_DIR`、`NC_PORT`、`NC_HOST`、`NC_GO2RTC_PATH`（打包後指向 `process.resourcesPath` 內對應平台的執行檔，開發時指向 `scripts/` 下載的位置或留空）。
   - 等 `{type:'ready', port}` 後開視窗；伺服器非預期結束時自動重啟（最多 3 次，之後在視窗顯示錯誤頁與「查看紀錄」）。
   - 結束流程：送 `{type:'shutdown'}` → 等最多 5 秒 → 強制結束；確保 go2rtc 不殘留。
   - 視窗安全設定、外部連結交給系統瀏覽器、preload 只暴露 `ncDesktop.{version, platform, openExternal}`。
3. **選單列／系統匣 `desktop/tray.js`**：狀態圖示（正常／有關鍵設備離線，Mac 用 template image）、規格 §8.6 的選單項目；「手機連線」開小視窗顯示區網網址與 QR Code（QR 產生用 vendored 的小型函式庫，鎖版本，記錄於 `desktop/vendor/VERSIONS.md`）。取得區網 IP 的邏輯寫成純函式（`os.networkInterfaces()` 過濾虛擬網卡、IPv6、169.254.x.x，優先取私有網段）。
4. **系統通知 `desktop/notify.js`**：接收伺服器轉送的 `status.changed`，只通知 `critical:true` 的設備；同一台 5 分鐘內最多一次（節流寫成純函式並測試）。
5. **設定**：開機自動啟動、防止閒置睡眠、允許區網連線（改變時重啟伺服器）存在 `desktop-settings.json`；與伺服器 config 分開，避免動到 A0 的 core。
6. **檢查更新**：呼叫 GitHub Releases API 取最新 tag，與 `app.getVersion()` 比較（semver 比較寫成純函式），有新版時開下載頁。
7. **go2rtc 下載 `scripts/fetch-go2rtc.js`**：依 `package.json` 的 `config.go2rtcVersion` 下載 `darwin_arm64`、`windows_amd64` 兩個執行檔（**不支援 Intel Mac**）到 `build/go2rtc/<platform>-<arch>/`，比對 `scripts/go2rtc-checksums.json` 的 sha256，不符就失敗；Mac 版設定可執行權限。執行檔不進 git。
8. **打包 `electron-builder.yml`**：
   - mac：`dmg`，只打 arm64；`extraResources` 只放 `darwin_arm64` 的 go2rtc；`Info.plist` 加 `NSLocalNetworkUsageDescription`（繁中說明「用來偵測家中網路設備的連線狀態與讀取監視器畫面」）；未提供簽章憑證時使用 ad-hoc 簽章，且 go2rtc 要列入簽章範圍。
   - win：`nsis`，x64，`oneClick:true`、`perMachine:false`（不需系統管理員）。
   - App 名稱 `NetworkConnect`，`appId` `io.github.unnn3ing-oss.networkconnect`；圖示 `desktop/icons/`（mac `.icns`、win `.ico`，由一張 1024px PNG 產生，產生指令寫在 README 開發段落）。
9. **CI `.github/workflows/`**：
   - `ci.yml`：push／PR 時在 `ubuntu-latest`、`macos-latest`、`windows-latest` 跑 `npm ci && npm test`。
   - `release.yml`：`workflow_dispatch` 與 `v*` tag 觸發；macos runner（Apple 晶片 runner，如 `macos-latest`／`macos-14` 以上）打 arm64 dmg、windows runner 打 exe；打包後跑 `test/desktop/smoke.spec.js`（Playwright `_electron.launch`：App 啟動 → 視窗載入完成 → `/api/system/health` 回 ok → 結束 → 檢查沒有殘留的 go2rtc 行程）；產物上傳為 Release 草稿（不自動發布）。
10. **安裝教學頁 `docs/install/index.html`**（全螢幕安裝教學風格，用 A1 的 `guide` 元件與 token）：分 Mac／Windows 兩條路線，每步有示意 SVG：下載 → 放行未簽章 App → 允許區域網路（Mac）→ 允許防火牆 → 用手機掃 QR Code。可放到 GitHub Pages。

## 驗收
1. 單元測試：區網 IP 挑選、通知節流、semver 比較、`NC_GO2RTC_PATH` 依平台／架構組出的路徑。
2. `node scripts/fetch-go2rtc.js` 在 Linux 容器內可下載兩個平台檔案並通過 sha256 驗證（下載被代理擋住時改用 `--dry-run` 驗證網址與檔名，並在回報中註明）。
3. `ci.yml` 三平台全綠、`release.yml` 手動觸發成功產出兩個安裝檔且冒煙測試通過；回報附 Actions run 連結。
4. 回報中列出「需要使用者實機驗證」：Mac（Apple 晶片）與 Windows 各安裝一次、放行流程、區域網路權限、防火牆詢問、開機自動啟動、通知、睡眠恢復。

## 注意
- 雲端容器是 Linux，無法實際開啟 Mac／Windows 視窗；平台行為一律以 CI 結果為準，不要在容器內嘗試模擬 macOS／Windows。
- 不修改 `server/`、`web/`；需要伺服器多提供資訊時走 Change Request。
