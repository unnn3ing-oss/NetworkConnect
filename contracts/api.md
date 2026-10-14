# REST API 契約

> 來源：規格 §6.1。Phase 1 開始後凍結；需要變更請走 Change Request。
> schema 位於 `contracts/schemas/`，用 `contracts/index.js` 的 `createValidator()` 驗證，ref 寫法 `檔名#定義`（例 `api-inventory#DeviceCreate`）。

## 0. 通則

| 項目 | 規則 |
|---|---|
| 編碼 | 請求與回應皆為 UTF-8 JSON（`Content-Type: application/json`），除非另有說明（multipart、圖檔、SSE、WebSocket） |
| id | `<前綴>_<識別字>`：`flr_` `room_` `grp_` `cat_` `dev_` `nvr_`；系統產生的識別字為 nanoid 10 碼（`dev_V1StGXR8_Z`），內建／範例資料用可讀固定字串（`cat_router`、`flr_1`） |
| 時間 | ISO 8601 UTC，一律 `Z` 結尾（`2026-10-14T08:30:00.000Z`） |
| 成功碼 | `GET`／`PATCH`／`PUT` 回 200＋JSON；`POST` 建立回 201＋完整紀錄；`DELETE` 回 204 無內容 |
| 列表 | 一律回傳**純陣列**（不包物件）；排序規則在各路由註明 |
| PATCH | 部分更新：只改請求有帶的欄位（淺層合併；`uplink`、`monitor` 以整個物件取代）；未知欄位 → 400 `VALIDATION`；回傳完整更新後紀錄 |
| 請求驗證 | 失敗一律 400 `VALIDATION`，`error.details` 為 ajv 錯誤陣列 |
| 認證 | 未設存取密碼時全部開放；已設定時，除 `/api/auth/*` 與 `GET /api/system/health` 外，所有 `/api/*` 需要有效的 `nc_session` cookie，否則 401 `UNAUTHORIZED` |
| 寫入事件 | 資料異動後由擁有者模組發出對應事件（見 `events.md`），其他模組與前端靠事件刷新 |

### 錯誤格式（schema：`api-common#ErrorResponse`）

```json
{ "error": { "code": "NOT_FOUND", "message": "找不到設備", "details": null } }
```

| code | HTTP | 使用時機 |
|---|---|---|
| `VALIDATION` | 400 | 請求格式或欄位不合法、引用的外鍵不存在（例：`roomId` 不存在、房間不屬於 `floorId`） |
| `UNAUTHORIZED` | 401 | 需要登入或密碼錯誤 |
| `NOT_FOUND` | 404 | 路徑上的資源不存在（含不存在的 `/api/*` 路由） |
| `CONFLICT` | 409 | 刪除仍被引用的資源、編號重複、內建類別不可刪／不可改 |
| `CYCLE` | 422 | 上游設備形成迴圈 |
| `INTERNAL` | 500 | 未預期錯誤（訊息固定為「伺服器發生錯誤」，細節只寫入日誌） |
| `UPSTREAM` | 502 | 外部依賴失敗（go2rtc 不可用等）；模組被標記為 `failed` 時其路由回 503 `UPSTREAM` |

---

## 1. system（A0）

### `GET /api/system/health`
- 免認證。回 200 `{ ok: true, version, uptime }`（`api-system#Health`；`uptime` 為秒）。

### `GET /api/system/modules`
- 回 200 純陣列 `[{ name, state: 'ok'|'failed'|'disabled', error? }]`（`api-system#ModuleList`），順序：system、inventory、io、monitor、floorplan、nvr。
- `failed`：`check()`、`register()` 或 `start()` 丟錯（`error` 為訊息）。`disabled`：`config.json` 的 `modules.<name>` 為 `false`。

### `GET /api/system/settings`、`PUT /api/system/settings`
- 讀寫 `<dataDir>/config.json` 的 `lanAccess`、`port`、`modules`（schema：`api-system#Settings`、`api-system#SettingsUpdate`；需認證）。
- `GET` 回 200 `{lanAccess, port, modules:{inventory,io,monitor,floorplan,nvr}, restartRequired}`，內容是**已儲存**的值。
- `PUT` 欄位皆選填，只更新有帶的欄位（`modules` 內也只更新有帶的模組），回 200 完整 `Settings`。
- 三項設定都在伺服器啟動時才套用：已儲存的值與「啟動當下的值」不同時 `restartRequired:true`（改回原值則回到 `false`）。重新啟動由呼叫端負責（桌面 App 由主行程重啟伺服器，無介面模式請手動重啟）。
- 錯誤：400 `VALIDATION`（`port` 不在 1–65535、型別錯誤、未知欄位、`modules` 含 `system`，或結果會讓**所有**功能模組都停用）。`system` 模組永遠啟用，因此不在 `modules` 內。

## 2. core/auth（A0）

> 規格 §6.1 已補列 `GET /api/auth/status` 與 `PUT /api/auth/password`。

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/auth/status` | — | 200 `AuthStatus`（`api-auth`）`{enabled, authenticated}` | — |
| `POST /api/auth/login` | `LoginRequest` `{password}` | 200 `{ok:true}`＋`Set-Cookie: nc_session=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=30 天`（未設密碼時也回 200 但不發 cookie） | 401 `UNAUTHORIZED` 密碼錯誤 |
| `POST /api/auth/logout` | — | 200 `{ok:true}`，清除 cookie | — |
| `PUT /api/auth/password` | `PasswordRequest` `{password: string(4–128)\|null, current?}` | 200 `{ok:true, enabled}`；成功後回新的 cookie（使用者維持登入）；`password:null` 取消保護 | 401 已設密碼但 `current` 缺少或錯誤；400 密碼長度不合 |

雜湊：scrypt，存於 `secrets.json` 的 `auth`；工作階段 cookie 為「到期時間＋HMAC」，金鑰存於 `secrets.json` 的 `auth:key`，改密碼時重新產生（使所有舊 cookie 失效）。

## 3. inventory（B1）

回應 schema＝各 collection schema（`floor`、`room`、`group`、`category`、`device`）；請求 schema 見 `api-inventory`。

### 樓層 `/api/floors`
| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/floors` | — | 200 `Floor[]`（依 `order`、`name`） | — |
| `POST /api/floors` | `FloorCreate` `{name, order?}` | 201 `Floor` | 400 |
| `PATCH /api/floors/:id` | `FloorPatch` | 200 `Floor` | 400、404 |
| `DELETE /api/floors/:id` | — | 204 | 404；**409** 仍有房間或設備（`details: {rooms: n, devices: n}`） |

### 房間 `/api/rooms`
| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/rooms?floorId=` | query：`floorId?` | 200 `Room[]`（依樓層 `order`、房間 `order`） | 400 |
| `POST /api/rooms` | `RoomCreate` `{floorId, name, order?}` | 201 `Room` | 400（樓層不存在） |
| `PATCH /api/rooms/:id` | `RoomPatch` | 200 `Room`；改 `floorId` 時房間內設備的 `floorId` 一併更新 | 400、404 |
| `DELETE /api/rooms/:id` | — | 204 | 404；**409** 仍有設備 |

### 組別 `/api/groups`
| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/groups` | — | 200 `Group[]`（依 `name`） | — |
| `POST /api/groups` | `GroupCreate` `{name, color?}` | 201 `Group` | 400 |
| `PATCH /api/groups/:id` | `GroupPatch` | 200 `Group` | 400、404 |
| `DELETE /api/groups/:id` | — | 204；**會**從所有設備的 `groupIds` 移除該組別（每台受影響設備發 `inventory.changed`） | 404 |

### 類別 `/api/categories`
| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/categories` | — | 200 `Category[]`（內建在前，依種子順序；自訂在後依 `name`） | — |
| `POST /api/categories` | `CategoryCreate` `{name, tier, icon?, defaultMonitor?}` | 201 `Category`（`builtin:false`） | 400 |
| `PATCH /api/categories/:id` | `CategoryPatch` | 200 `Category`；內建類別只能改 `defaultMonitor` | 400、404；**409** 內建類別改其他欄位 |
| `DELETE /api/categories/:id` | — | 204 | 404；**409** `builtin:true`，或仍有設備使用 |

inventory 在 `start()`／首次載入時，若 `categories` 為空，以 `contracts/seed/categories.json` 寫入 15 個內建類別（id 固定）。

### 設備 `/api/devices`
| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/devices` | query `DeviceQuery`：`floorId? roomId? groupId? categoryId? q?`（AND；`q` 不分大小寫子字串，比對 code、name、ip、mac、hostname、vendor、model、notes） | 200 `Device[]`（依 `code` 自然排序，無 code 者依 `name`） | 400 |
| `POST /api/devices` | `DeviceCreate`（必填 `name`、`categoryId`，其餘見 `device.schema.json#/$defs/Editable` 的預設值） | 201 `Device`（缺的欄位補預設值；`monitor.method` 預設取類別 `defaultMonitor`） | 400（外鍵不存在、房間不屬於樓層、`code` 重複 → 409）、**422 `CYCLE`** |
| `GET /api/devices/:id` | — | 200 `Device` | 404 |
| `PATCH /api/devices/:id` | `DevicePatch` | 200 `Device`，`updatedAt` 更新 | 400、404、409（`code` 重複）、**422 `CYCLE`**（上游鏈含自己，或 `uplink.deviceId` 等於自己） |
| `DELETE /api/devices/:id` | — | 204；以它為上游的設備其 `uplink` 設為 `null`（變成根節點） | 404 |

資料異動後發 `inventory.changed`。monitor、floorplan、nvr 收到 `devices` 的 `delete` 後各自清理自己的資料。

## 4. monitor（B2）

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/status` | — | 200 `StatusItem[]`（`api-monitor#StatusList`，每台設備一筆，含 `disabled`） | — |
| `GET /api/status/:deviceId/history?hours=24` | query `hours`：1–24，預設 24 | 200 `HistoryResponse`：`{deviceId, hours, samples:[{at, up, rttMs}]}`，由舊到新 | 400、404（設備不存在） |
| `POST /api/status/:deviceId/check` | — | 200 `StatusItem`（立即檢查一次；結果照常寫入歷史並可能發 `status.changed`） | 404；`method=none` 時回目前狀態（`disabled`）不檢查 |
| `GET /api/monitor/settings` | — | 200 `MonitorSettings`：`{defaultIntervalSec:60, concurrency:16, timeoutMs:1500, pausedUntil:null}` | — |
| `PUT /api/monitor/settings` | `MonitorSettingsUpdate`（欄位皆選填，只更新有帶的） | 200 完整 `MonitorSettings` | 400 |

> `pausedUntil` 是為桌面 App「暫停偵測 30 分鐘」補充的欄位（列入 A0 回報）。

偵測規則（判定 up／down、間隔、並發、逾時）見規格 §8.1。

## 5. floorplan（B4）

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/plans` | — | 200 `Plan[]` | — |
| `PUT /api/plans/:floorId` | `multipart/form-data`，檔案欄位名 `file`；PNG／JPG／WebP／SVG，≤ 10 MB | 200 `Plan`（取代舊圖，舊圖檔刪除）；發 `plan.changed` | 400（格式不符、超過 10 MB、內容與副檔名不符）、404（樓層不存在） |
| `GET /api/plans/:floorId/image` | — | 200 圖檔本體，`Content-Type` 為 `plan.mime`；SVG 加 `Content-Security-Policy: sandbox`／`X-Content-Type-Options: nosniff`，前端只能以 `<img>` 顯示 | 404 |
| `DELETE /api/plans/:floorId` | — | 204（落點 `placements` 保留）；發 `plan.changed` | 404 |
| `GET /api/placements?floorId=` | query `floorId?` | 200 `Placement[]` | 400 |
| `PUT /api/placements/:deviceId` | `PlacementPut` `{floorId, x, y}`（x、y 為 0–1） | 200 `Placement`（不存在則建立）；發 `placement.changed` | 400、404（設備或樓層不存在） |
| `DELETE /api/placements/:deviceId` | — | 204；發 `placement.changed` | 404 |

圖檔實體存放於 `<dataDir>/plans/<plan.file>`。收到 `inventory.changed`（`floors`／`devices` 的 `delete`）時，floorplan 清掉對應的 plan／placement 與圖檔。

## 6. nvr（B5）

密碼為**寫入專用**：只存在 `secrets.json` 的 `nvr:<id>`，任何回應都不含密碼，只回 `hasPassword`。

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/nvr/templates` | — | 200 `Template[]`（`api-nvr#TemplateList`；內容＝`contracts/fixtures/nvr-templates.json`） | — |
| `GET /api/nvrs` | — | 200 `NvrPublic[]`（`nvr` 紀錄＋`hasPassword`） | — |
| `POST /api/nvrs` | `NvrCreate`（必填 `name brand host username password channelCount`；`brand:"custom"` 另需 `urlTemplate`；省略 `port`／`streamMain`／`streamSub` 取品牌模板預設；省略 `channels` 自動產生 1..N） | 201 `NvrPublic`；發 `nvr.changed` | 400 |
| `PATCH /api/nvrs/:id` | `NvrPatch`（`password` 字串＝更新、`null`＝刪除、省略＝不變） | 200 `NvrPublic`；發 `nvr.changed` | 400、404 |
| `DELETE /api/nvrs/:id` | — | 204；同時刪除密碼；發 `nvr.changed` | 404 |
| `POST /api/nvrs/:id/test` | `NvrTestRequest` `{channel?: 1}` | 200 `NvrTestResult` `{ok, codec?, warning?, error?}`：短暫連線該頻道**子碼流**（最多 8 秒），收到 codec 即 `ok:true`；`hvc1`／`hev1` 時 `codec:"h265"` 並帶 `warning`；串流失敗為 `ok:false`＋`error` | 404；502 `UPSTREAM`（go2rtc 本身不可用） |
| `GET /api/nvr/status` | — | 200 `NvrStatus` `{running, version, mode?}` | — |
| `GET /api/nvr/ws?stream=<name>`（WebSocket） | query `stream`：`nvr_<id>_<ch>_(main\|sub)` | 反向代理 go2rtc 的 MSE WebSocket（二進位與文字訊息原樣轉送） | 串流名稱不存在或 NVR 不存在：伺服器以 close code 4404 關閉 |

URL 範本與佔位符見 `Template.urlTemplate`；`{u}`、`{p}` 代入前必須 `encodeURIComponent`。

## 7. io（B1）

| 路由 | 請求 | 回應 | 錯誤 |
|---|---|---|---|
| `GET /api/export?secrets=0` | query `secrets`：`0`（預設）或 `1` | 200 `Export`（`api-io#Export`，含平面圖 base64）；`Content-Disposition: attachment; filename="networkconnect-YYYYMMDD.json"`；`secrets=1` 時 `includesSecrets:true` 並附 `secrets`（不含 `auth`、`auth:key`） | — |
| `POST /api/import` | `Export` JSON（本文上限 128 MB）；先全部驗證（schema＋外鍵完整性）再用 `store.restore()` 一次寫入 | 200 `ImportResult` `{ok:true, counts:{…}}`；完成後發 `inventory.changed`、`plan.changed`、`nvr.changed`（`id:"*"`）；匯入含 `secrets` 時一併寫入 | 400（任何驗證失敗，**完全不寫入**，`details` 列出所有錯誤） |
| `POST /api/import/csv?dryRun=0` | `multipart/form-data`，欄位 `file`（UTF-8，容許 BOM；標題列必須存在）；`dryRun=1` 只回報不寫入 | 200 `CsvImportReport` | 400（不是 CSV、缺必要欄位） |

CSV 欄位（相容舊 Google Sheet「設備清單」B–P 欄，以標題列文字對應，欄位順序不拘）：

| 標題 | 對應 |
|---|---|
| 編號 | `device.code` |
| 名稱 | `device.name`（必填，缺則該列略過並列入 `skipped`） |
| 類別 | 以關鍵字對應內建類別（沿用舊 `Code.gs` 規則）；對不到 → `cat_other` 並列入 `unmatchedCategories` |
| 上游編號 | 以 `code` 找上游設備 → `uplink.deviceId`；找不到 → 根節點並列入 `warnings` |
| 位置 | 房間名稱（必要時在該樓層下建立房間）→ `roomId` |
| 連線方式 | `uplink.medium`（有線→ethernet、Wi-Fi／無線→wifi、Mesh→mesh、PoE→poe、光纖→fiber，其餘 other） |
| IP、MAC、速率、說明 | `ip`、`mac`、`uplink.speed`、`notes` |
| 分區 | 樓層名稱（不存在則建立）→ `floorId` |
| 階層 | 僅參考（階層由類別 `tier` 決定），不匯入 |
| 定位編號 | 附加到 `notes`（`定位編號：xxx`） |
| 上游端口、下游端口 | `uplink.port`、`uplink.localPort` |

CSV 匯入只新增，不覆寫現有設備；`code` 已存在者略過並列入 `skipped`。

## 8. core（A0）

### `GET /api/events`
SSE，格式與事件清單見 `events.md`。需認證（同其他 `/api/*`）。

---

## 附：伺服器 ctx（模組介面補充）

規格 §5.1 的 `ctx = { config, store, events, log, secrets }` 之外，A0 另提供（皆為額外欄位，不改變原有介面）：

| 欄位 | 說明 |
|---|---|
| `ctx.dataDir` | 資料夾絕對路徑（floorplan 用於 `<dataDir>/plans/`） |
| `ctx.mock` | `true` 表示 `NC_MOCK=1` |
| `ctx.prober` | 僅 mock 模式提供（`test/helpers/fake-prober.js`）；介面 `probe({method, host, port, path, timeoutMs}) → Promise<{up, rttMs}>`。monitor 在 `ctx.prober` 存在時使用它，否則使用真實 prober |
| `ctx.modules.list()` | 目前各模組狀態（同 `/api/system/modules`） |
| `ctx.store` | 該模組專屬的 store 視圖：`collection(name)` 回傳 `{ list(filter?), get(id), insert(doc), update(id, patch), remove(id), upsert(doc) }`（皆 async）；對非自己 `owns` 的 collection，寫入方法 reject `NotOwnerError`；只有 io 模組有 `restore(snapshot)` |
| `ctx.events` | `emit(name, payload)`、`on(name, fn) → off`、`onSseConnect(fn)`（fn(send)：SSE 連線建立時呼叫，monitor 用來送 `status.snapshot`） |
| `ctx.secrets` | `get(key)`、`has(key)`、`all()` 同步；`set(key, value: string)`、`delete(key)` 回傳 Promise（寫檔完成才 resolve）。鍵：`nvr:<id>`（nvr 模組）、`auth`、`auth:key`（core，其他模組不得使用） |
| `ctx.validate(ref, data)` | 以 `contracts/schemas` 驗證資料（ref 寫法 `api-inventory#DeviceCreate`）；通過回傳 `data`，失敗丟 400 `VALIDATION`（`details` 為 ajv 錯誤）。請在路由裡用它驗證 `req.body`／`req.query`，回應也可在測試中用它驗證 |
| `ctx.startedAt` | 伺服器啟動時間（毫秒時間戳） |

寫入 store 時 core 會用 `contracts/schemas` 驗證每筆紀錄（collection → schema 對應見 `contracts/index.js` 的 `COLLECTION_SCHEMAS`），不符合時 insert／update／upsert 丟 400 `VALIDATION`，所以模組寫入的資料必須完整符合契約。

Fastify 已由 core 註冊：`@fastify/cookie`、`@fastify/multipart`（單檔上限 10 MB）、`@fastify/websocket`；請求本文上限 128 MB；錯誤統一轉成 §0 的格式。模組路由請直接寫完整路徑（`app.get('/api/floors', …)`），不要使用 prefix。
