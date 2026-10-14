# A0 地基：骨架、契約、核心、shell

## 必讀
- 規格 §3、§4、§5、§6、§7、§9、§11（`docs/specs/2026-10-14-networkconnect-design.md`）
- 計畫 §2 G0（`docs/plans/2026-10-14-networkconnect-plan.md`）

## 可修改
`package.json` `.gitignore` `.editorconfig` `.nvmrc` `contracts/` `server/index.js` `server/cli.js` `server/core/` `server/modules/system/` `server/modules/*/index.js`（只建 stub）`web/index.html` `web/app.js` `web/core/` `web/vendor/` `web/modules/*/index.js`（只建 stub）`test/contract/` `test/helpers/` `test/unit/core/`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`

## 工作項目
1. **骨架**：Node 版本與 D1 將採用的 Electron 內建 Node 對齊（寫入 `.nvmrc`）、ESM（`"type":"module"`）、**不使用任何原生模組**。`package.json` 加 `"config": {"go2rtcVersion": "<確切版本>"}`（全專案唯一的 go2rtc 版本來源）。npm scripts：`start`、`dev`（`--watch`）、`dev:mock`（`NC_MOCK=1`，載入 fixtures、用假 prober、假 go2rtc）、`test`（`node --test test/unit test/contract`）、`test:e2e`。依賴鎖確切版本：`fastify`、`@fastify/static`、`@fastify/multipart`、`@fastify/websocket`、`@fastify/cookie`、`ajv`、`nanoid`；dev：`@playwright/test`。
2. **契約 `contracts/`**：
   - `schemas/`：規格 §7 每個 collection 一個 JSON Schema（draft 2020-12）＋各 API 的 request／response schema＋錯誤格式。
   - `api.md`：規格 §6.1 每條路由的 request、response、錯誤碼。
   - `events.md`：規格 §6.2。
   - `fixtures/`：`db.sample.json`（3 層樓、9 個房間、3 個組別、內建類別、≥ 25 台設備含完整 uplink 樹與 Wi-Fi／PoE／Mesh 各種 medium、1 台 8 頻道 NVR）、`status.sample.json`（混合 up／down／unknown／disabled）、`nvr-templates.json`（規格 §8.4 表格）、`plan.sample.png`（簡單平面圖）。
   - `test/contract/schemas.test.js`：所有 fixtures 都通過對應 schema。
3. **後端 core**：
   - `config.js`：資料夾由 `startServer({dataDir})` 或環境變數 `NC_DATA_DIR` 決定（預設 `./data`）；讀 `<dataDir>/config.json`（不存在就用預設並建立），含 `port`（預設 8780）、`lanAccess`（預設 true）、`modules`（各模組開關）、`go2rtcPath`、`go2rtcUrl`。路徑一律用 `path.join`，不得寫死 `/`。
   - `store.js`：Repository 介面 `collection(name)` → `list(filter)/get(id)/insert/update/remove`；記憶體＋JSON 檔，寫入採「寫暫存檔→rename」並 debounce 200ms；寫入時檢查呼叫模組是否為該 collection 的擁有者（模組 `owns` 欄位），不是就丟錯；另提供只開放給 io 模組的 `restore(snapshot)`（規格 §7 唯一例外）。
   - `secrets.js`：`<dataDir>/secrets.json`，非 Windows 平台建立時權限 600。
   - `events.js`：發布／訂閱＋`GET /api/events` SSE（每 25 秒心跳）。
   - `auth.js`：未設密碼則全開；有設則 scrypt 驗證＋HttpOnly cookie，保護 `/api/*`（`/api/auth/*`、`/api/system/health` 除外）。
   - `errors.js`：規格 §6.1 錯誤格式與 Fastify error handler。
   - `module-loader.js`：依規格 §5.1 介面與故障隔離規則；`check()` 或 `register()` 失敗的模組標記 `failed` 並跳過。
   - CSP header 依規格 §11。
4. **system 模組**：`/api/system/health`、`/api/system/modules`。
5. **其他後端模組 stub**：inventory、io、monitor、floorplan、nvr 各建 `index.js`（`name`、`owns`、空的 `check/register/start/stop`），讓 B 組 agent 不必改 loader。
6. **前端 shell**：
   - `web/index.html`：頂欄（標題、主導覽、全站篩選列容器）、主內容區；只引用 `web/ui/*.css`（A1 產出，先放空檔佔位）與 `app.js`。
   - `web/core/`：`api.js`（fetch 包裝、統一錯誤）、`bus.js`（EventTarget，並把 SSE 事件轉發進 bus，斷線自動重連）、`router.js`（hash 路由＋query）、`filters.js`（樓層／房間／組別／類別／關鍵字，同步網址 query，變動時 emit `filters.changed`）、`module-loader.js`（依規格 §5.2，失敗顯示錯誤卡）。
   - 前端模組 stub：devices、status、topology、floorplan、cameras、dashboard、onboarding、settings，各自 `mount` 顯示「建置中」。
7. **vendor**：下載並鎖版 `cytoscape.min.js`、go2rtc 的 `video-rtc.js`／`video-stream.js`（版本取自 `package.json` 的 `config.go2rtcVersion`），記錄於 `web/vendor/VERSIONS.md`（版本、來源 URL、sha256）。
8. **mock 模式**：`NC_MOCK=1` 時 store 從 fixtures 載入到 `data-mock/`（不碰真實 `data/`）；提供 `test/helpers/fake-prober.js`、`test/helpers/fake-go2rtc.js`（後者可由 B5 擴充；先實作 `PUT /api/streams`、`GET /api/frame.jpeg` 回固定 JPEG、`/api/ws` 回固定訊息）。
9. **啟動入口**：
   - `server/index.js` 匯出 `startServer({dataDir, port, host, go2rtcPath, go2rtcUrl, mock}) → {port, url, stop}`；埠被佔用時往後找（最多 20 個），`port:0` 時由系統分配；`stop()` 依序停止所有模組並關閉 HTTP。
   - 在 Electron `utilityProcess` 中執行時（`process.parentPort` 存在），就緒後送 `{type:'ready', port}`；`status.changed` 事件同時轉送 `{type:'event', name, payload}` 給主行程（供 D1 發系統通知）；收到 `{type:'shutdown'}` 時呼叫 `stop()` 後結束。
   - `server/cli.js`：`--data-dir`、`--port`、`--host`、`--mock` 參數，啟動後印出 `NetworkConnect listening on <url>`。`npm start` 指向它。
   - **不做 Docker**（已移到規格 §12 後續版本）。

## 驗收（＝計畫 G0）
1. `npm test` 全綠。
2. `npm run dev:mock` 啟動後 `curl /api/system/modules` 列出所有模組為 `ok`。
3. 測試證明：讓某 stub 的 `check()` 丟錯 → 該模組 `failed`，其他 `ok`，伺服器仍啟動。
4. 測試證明：非擁有者寫入 collection 會被拒絕。
5. 前端 shell 載入無 console 錯誤；某前端模組 `mount` 丟錯時只有該分頁顯示錯誤卡。
6. 所有 fixtures 通過 schema 驗證。
7. `startServer()` 測試：`port:0` 啟動、`/api/system/health` 正常、`stop()` 後無殘留計時器與 socket；模擬 `parentPort` 時會送出 `ready` 訊息。
8. 測試在 Linux 通過；不得有寫死的路徑分隔符或只在 Linux 存在的指令（D1 的 CI 會在 macOS／Windows 再跑一次）。

## 注意
- 不實作任何功能模組的業務邏輯。
- 契約是 Phase 1 五個 agent 唯一的共同語言：每個欄位都要寫清楚型別、必填、預設值、範例。
