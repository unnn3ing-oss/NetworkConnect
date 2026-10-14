# desktop — Electron 桌面 App（D1）

規格見 `docs/specs/2026-10-14-networkconnect-design.md` §8.6。Mac 只支援 Apple 晶片（arm64），Windows 為 x64。

## 目錄

| 路徑 | 說明 |
|---|---|
| `main.js` | 主行程：單一實例鎖、啟動伺服器（`utilityProcess`）、視窗、結束流程、導覽安全 |
| `preload.cjs` | 只暴露 `ncDesktop.{version, platform, openExternal}`（sandbox 要求 CommonJS） |
| `tray.js`、`notify.js` | 選單列／系統匣、系統通知（Electron 端的薄封裝） |
| `lib/` | **所有可測邏輯（純函式）**：IP 挑選、通知節流、semver、路徑組合、伺服器監督、設定檔、QR 與頁面、選單內容。`npm test` 在 Linux 容器內執行 |
| `vendor/` | 鎖版本的第三方檔，見 `vendor/VERSIONS.md` |
| `icons/` | App 與系統匣圖示（由 `scripts/make-icons.js` 產生，已提交） |

## 開發

```bash
npm ci
npm run fetch:go2rtc          # 下載 go2rtc 到 build/go2rtc/<平台>-<架構>/（不進 git；Linux 開發可略過）
npm run desktop               # 以原始碼啟動 Electron；加上環境變數 NC_MOCK=1 可用 mock 資料
npm test                      # 單元＋契約測試（不開視窗，三平台 CI 都跑）
npm run test:desktop          # Electron 冒煙測試（會開視窗，只在 CI 的 package job 跑）
```

環境變數（開發／測試用）：

| 變數 | 作用 |
|---|---|
| `NC_DESKTOP_USER_DATA` | 覆寫 userData 資料夾（預設 `<appData>/NetworkConnect`）。冒煙測試用它隔離資料並避開單一實例鎖 |
| `NC_PORT` | 指定伺服器埠（`0`＝系統分配）。沒設時由伺服器自己用 `config.json` 的 `port`（預設 8780）並在被佔用時往後找 |
| `NC_MOCK` | 傳給伺服器，使用 mock 資料 |

資料與紀錄：`<userData>/data/`（伺服器資料）、`<userData>/desktop-settings.json`（桌面設定：開機啟動、防止睡眠、區網連線）、`<userData>/logs/desktop.log`、`server.log`（錯誤頁「查看紀錄」開啟這個資料夾）。

在沒有桌面的 Linux 上跑冒煙測試（本機驗證用）：

```bash
NC_SMOKE_ARGS="--no-sandbox --disable-gpu" xvfb-run -a npm run test:desktop
```

## 圖示

所有圖示由 `scripts/lib/icon-art.js` 以程式繪製，沒有外部相依。需要換圖樣就改它，再執行：

```bash
npm run icons     # = node scripts/make-icons.js
```

會產生 `icons/icon-1024.png`（1024px 原圖）、`icon.icns`、`icon.ico`，以及系統匣用的 `trayTemplate*.png`／`trayAlertTemplate*.png`（macOS template image）與 `tray*.png`（Windows）。
想改用設計師提供的 1024px PNG：把它放成 `icons/icon-1024.png`，用任何 PNG→icns／ico 工具（例如 `npx png2icons icons/icon-1024.png icons/icon -icns -ico`）轉出 `icon.icns` 與 `icon.ico` 即可，其他檔案不需要動。

## go2rtc

版本只寫在 `package.json` 的 `config.go2rtcVersion`。`scripts/fetch-go2rtc.js` 依它下載 `darwin_arm64`、`windows_amd64` 兩個壓縮檔，比對 `scripts/go2rtc-checksums.json` 的 sha256（對**下載到的 zip**），不符就失敗；Mac 版會設定可執行權限。

**升級 go2rtc**：改 `config.go2rtcVersion` → 下載該版本的 `go2rtc_mac_arm64.zip`、`go2rtc_win64.zip` → `sha256sum` → 在 `scripts/go2rtc-checksums.json` 新增該版本的兩筆。上游沒有提供官方 checksum 檔，所以這份清單是第一次下載時的「信任首次使用」記錄。

`--dry-run` 只列出網址與目的地，不下載。

## 打包

```bash
npm run dist:mac    # 只能在 Apple 晶片的 Mac 上執行 → dist/*.dmg（arm64）
npm run dist:win    # 只能在 Windows 上執行 → dist/*.exe（NSIS，x64，免系統管理員）
```

- 設定在根目錄 `electron-builder.yml`。`go2rtc` 以 `extraResources` 放到 `<resources>/go2rtc/`，主行程以 `process.resourcesPath` 組出 `NC_GO2RTC_PATH`（`lib/paths.js`）。
- macOS 沒有 Apple Developer 憑證時使用 **ad-hoc 簽章**（`identity: "-"`），electron-builder 會把 Resources 內的 Mach-O（含 go2rtc）一併簽入；`Info.plist` 含 `NSLocalNetworkUsageDescription`。有憑證後改用：`npm run dist:mac -- -c.mac.identity=<憑證名稱> -c.mac.hardenedRuntime=true`。
- 平台行為（簽章、安裝、區域網路權限、防火牆）一律以 CI 的 macos／windows runner 為準，不要在 Linux 容器模擬。

## CI

| 檔案 | 觸發 | 內容 |
|---|---|---|
| `.github/workflows/ci.yml` | 任何分支 push、PR | job `test`（ubuntu／macos-latest／windows-latest：`npm ci && npm test`）→ job `package`（呼叫 `package.yml`） |
| `.github/workflows/package.yml` | 只被呼叫 | job `package (mac-arm64)`、`package (win-x64)`：下載 go2rtc → 打包 → 檢查 go2rtc 已隨附（Mac 另驗簽章與 Info.plist）→ Electron 冒煙測試 → 上傳 workflow artifacts（不建立 Release） |
| `.github/workflows/release.yml` | 只有 `v*` tag | 驗證 tag＝`package.json` 版本 → 測試 → 打包 → 建立 Release **草稿**（不自動發布） |

## 安裝教學頁

`docs/install/index.html`（Mac／Windows 兩條路線，使用 `web/ui` 的 token 與 guide 元件）。頁面以相對路徑引用 `../../web/ui/`，所以 GitHub Pages 要從**儲存庫根目錄**發布，網址即 `…/docs/install/`。

## 已知限制

- Electron 鎖在 44.7.2（官方支援期內的最新主版本）：實測 `process.versions.node` 為 **24.21.0**，與 `.nvmrc`、`engines.node`（>=24）一致。升級 Electron 時請重新實測內建 Node 版本（`ELECTRON_RUN_AS_NODE=1 npx electron -e "console.log(process.versions.node)"`）並同步 `.nvmrc`；`test/unit/desktop/builder-config.test.js` 的對照表也要一起更新。
- 查詢設備資料（通知需要 `critical` 與名稱）與系統匣狀態圖示使用視窗 session 的 cookie 呼叫 REST API；設了存取密碼但尚未在視窗登入時，通知與圖示警示不會運作。
- 冒煙測試的「沒有殘留 go2rtc」在 nvr 模組尚未設定任何 NVR 時不會真的啟動 go2rtc，需要 B5 合併後以真實設定補強。
