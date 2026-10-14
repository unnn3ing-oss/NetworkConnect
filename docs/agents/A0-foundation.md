# A0 地基：骨架、契約、核心、shell

## 必讀
- 規格 §3、§4、§5、§6、§7、§9、§11（`docs/specs/2026-10-14-networkconnect-design.md`）
- 計畫 §2 G0（`docs/plans/2026-10-14-networkconnect-plan.md`）

## 可修改
`package.json` `.gitignore` `.editorconfig` `contracts/` `server/index.js` `server/core/` `server/modules/system/` `server/modules/*/index.js`（只建 stub）`web/index.html` `web/app.js` `web/core/` `web/vendor/` `web/modules/*/index.js`（只建 stub）`test/contract/` `test/helpers/` `test/unit/core/` `deploy/`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`

## 工作項目
1. **骨架**：Node 22、ESM（`"type":"module"`）。npm scripts：`start`、`dev`（`--watch`）、`dev:mock`（`NC_MOCK=1`，載入 fixtures、用假 prober、假 go2rtc）、`test`（`node --test test/unit test/contract`）、`test:e2e`。依賴鎖確切版本：`fastify`、`@fastify/static`、`@fastify/multipart`、`@fastify/websocket`、`@fastify/cookie`、`ajv`、`nanoid`；dev：`@playwright/test`。
2. **契約 `contracts/`**：
   - `schemas/`：規格 §7 每個 collection 一個 JSON Schema（draft 2020-12）＋各 API 的 request／response schema＋錯誤格式。
   - `api.md`：規格 §6.1 每條路由的 request、response、錯誤碼。
   - `events.md`：規格 §6.2。
   - `fixtures/`：`db.sample.json`（3 層樓、9 個房間、3 個組別、內建類別、≥ 25 台設備含完整 uplink 樹與 Wi-Fi／PoE／Mesh 各種 medium、1 台 8 頻道 NVR）、`status.sample.json`（混合 up／down／unknown／disabled）、`nvr-templates.json`（規格 §8.4 表格）、`plan.sample.png`（簡單平面圖）。
   - `test/contract/schemas.test.js`：所有 fixtures 都通過對應 schema。
3. **後端 core**：
   - `config.js`：讀 `data/config.json`（不存在就用預設並建立），含 `port`、`modules`（各模組開關）、`go2rtcUrl`。
   - `store.js`：Repository 介面 `collection(name)` → `list(filter)/get(id)/insert/update/remove`；記憶體＋JSON 檔，寫入採「寫暫存檔→rename」並 debounce 200ms；寫入時檢查呼叫模組是否為該 collection 的擁有者（模組 `owns` 欄位），不是就丟錯；另提供只開放給 io 模組的 `restore(snapshot)`（規格 §7 唯一例外）。
   - `secrets.js`：`data/secrets.json`，建立時權限 600。
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
7. **vendor**：下載並鎖版 `cytoscape.min.js`、go2rtc 的 `video-rtc.js`／`video-stream.js`（版本需與 deploy 的 go2rtc 映像一致），記錄於 `web/vendor/VERSIONS.md`（版本、來源 URL、sha256）。
8. **mock 模式**：`NC_MOCK=1` 時 store 從 fixtures 載入到 `data-mock/`（不碰真實 `data/`）；提供 `test/helpers/fake-prober.js`、`test/helpers/fake-go2rtc.js`（後者可由 B5 擴充；先實作 `PUT /api/streams`、`GET /api/frame.jpeg` 回固定 JPEG、`/api/ws` 回固定訊息）。
9. **部署**：`deploy/Dockerfile`（node:22-slim＋iputils-ping）、`deploy/docker-compose.yml`（app 與 go2rtc 都 `network_mode: host`、app 加 `cap_add: [NET_RAW]`、go2rtc 映像鎖確切版本且 API 只綁 127.0.0.1:1984、volume `./data`）、`deploy/go2rtc.yaml`。

## 驗收（＝計畫 G0）
1. `npm test` 全綠。
2. `npm run dev:mock` 啟動後 `curl /api/system/modules` 列出所有模組為 `ok`。
3. 測試證明：讓某 stub 的 `check()` 丟錯 → 該模組 `failed`，其他 `ok`，伺服器仍啟動。
4. 測試證明：非擁有者寫入 collection 會被拒絕。
5. 前端 shell 載入無 console 錯誤；某前端模組 `mount` 丟錯時只有該分頁顯示錯誤卡。
6. 所有 fixtures 通過 schema 驗證。

## 注意
- 不實作任何功能模組的業務邏輯。
- 契約是 Phase 1 五個 agent 唯一的共同語言：每個欄位都要寫清楚型別、必填、預設值、範例。
