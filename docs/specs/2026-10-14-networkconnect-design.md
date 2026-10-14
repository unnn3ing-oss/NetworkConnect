# NetworkConnect 家用網路設備主控台 — 架構設計規格

日期：2026-10-14　狀態：規劃定稿，尚未實作

## 0. 一句話

在家中區網跑一台小主機，提供網頁介面：**手動登錄設備 → 自動畫架構圖 → 定時偵測連線狀態 → 在樓層平面圖上看到每台設備的位置與燈號 → 直接看 NVR 監視器畫面**，並可依樓層／房間／組別／類別篩選。

## 1. 範圍

### 要做（v1）

| # | 功能 | 說明 |
|---|---|---|
| F1 | 設備登錄 | 手動新增／編輯／刪除；精靈式新增流程；CSV 匯入（相容舊 Google Sheet「設備清單」欄位） |
| F2 | 分類維度 | 樓層、房間（隸屬樓層）、組別（多對多標籤）、設備類別；全站共用篩選列 |
| F3 | 架構圖 | 依每台設備的「上游設備＋埠」自動畫樹狀拓樸，燈號同步連線狀態，可依樓層分群 |
| F4 | 連線狀態 | 背景定時偵測（ICMP／TCP 埠／HTTP），連續 3 次失敗才判定離線；即時推播到前端 |
| F5 | 樓層平面圖 | 每層樓上傳一張平面圖，把設備拖放到實際位置，可縮放平移，點燈號開設備資訊 |
| F6 | NVR 監視畫面 | 精靈式設定 NVR（品牌模板＋測試快照），1／4／9／16 分割即時畫面，點兩下看主碼流 |
| F7 | 首次使用導覽 | 全螢幕導覽（同 QPT「全螢幕安裝教學」）：建樓層 → 平面圖 → 房間 → 設備 → NVR |
| F8 | 備份 | 一鍵匯出／匯入 JSON（預設不含密碼） |

### 不做（v1，列入 §12 後續）

自動掃描網段、SNMP 流量、告警推播（LINE）、NVR 回放、房間多邊形繪製、PDF 平面圖、多使用者權限、外網直連。

## 2. 為什麼一定要有「本地主機」

| 需求 | 純網頁（GitHub Pages／Apps Script）做得到嗎 | 原因 |
|---|---|---|
| Ping 區網設備 | ❌ | 瀏覽器不能發 ICMP，也不能任意連區網 IP（CORS／Private Network Access） |
| 看 NVR 畫面 | ❌ | NVR 輸出 RTSP，瀏覽器不能直接播放，需要轉成 WebRTC／MSE |
| 存帳密 | ❌ 不安全 | NVR 帳密不能出現在前端 |

**結論**：架構為「區網小主機（Docker）＋ 瀏覽器前端」。舊專案 `visual-network-topology-dashboard`（Apps Script）只能做到靜態架構圖，這也是它無法擴充成狀態監測的根本原因。

## 3. 技術選型（已定案，實作時不再比較）

| 層 | 選擇 | 版本規則 | 選它的理由 |
|---|---|---|---|
| 執行環境 | Node.js | 22 LTS | 與 hottopic 等既有專案一致；`node:test` 內建測試 |
| 後端框架 | Fastify | 5.x 鎖定次版號 | **plugin 封裝＝模組隔離**；路由直接吃 JSON Schema 驗證，契約即程式 |
| 儲存 | JSON 檔（原子寫入）＋ Repository 介面 | — | 家用 < 300 台設備綽綽有餘；備份就是複製檔案；之後要換 SQLite 只改一個檔 |
| 串流轉換 | go2rtc（sidecar 容器） | 鎖定確切版本（實作時取最新穩定版） | 單一執行檔，RTSP → MSE／WebRTC，自帶快照 API 與 ffmpeg |
| 前端 | 原生 ES Modules，無建置步驟 | — | 與 QPT／hottopic 一致；agent 不需處理打包問題，試錯最少 |
| 架構圖 | Cytoscape.js（vendored） | 鎖定確切版本 | 內建 `breadthfirst` 樹狀排版，不需額外外掛；canvas 繪製不違反 CSP |
| 平面圖 | 自製（CSS transform＋pointer events） | — | 需求單純，不引入函式庫 |
| 測試 | `node:test`、ajv（契約驗證）、Playwright（E2E） | Chromium 已預裝於 `/opt/pw-browsers` | |
| 部署 | Docker Compose，`network_mode: host` | — | ICMP、ARP、連 NVR 都需要主機網路 |

**主機建議**：Linux 小主機／樹莓派 4 以上／支援 Docker 的 NAS。Windows／macOS 的 Docker 不支援 host network，若用 Windows 請改用 `npm start` 直接跑（go2rtc 用 Windows 執行檔）。

## 4. 系統架構

```
 瀏覽器（手機／電腦，區網內）
   │  HTTPS 或 HTTP :8080（同源）
   ▼
┌──────────────── NetworkConnect 主程式（Node／Fastify）────────────────┐
│ core：config・store・events(SSE)・auth(存取密碼)・module-loader・static │
│ ┌──────────┐┌─────────┐┌───────────┐┌─────────┐┌──────┐┌────────┐ │
│ │inventory ││ monitor ││ floorplan ││   nvr   ││  io  ││ system │ │
│ │設備/分類  ││狀態偵測  ││平面圖/落點 ││NVR/頻道  ││匯入出 ││健康/模組│ │
│ └────┬─────┘└────┬────┘└─────┬─────┘└────┬────┘└──┬───┘└────────┘ │
│      └───────────┴───── store（JSON Repository）──┘                │
└───────────────────────────────────────┬────────────────────────────┘
                                         │ 127.0.0.1:1984（只給主程式用）
                                   ┌─────▼─────┐   RTSP   ┌──────┐
                                   │  go2rtc   │◄────────►│ NVR  │
                                   └───────────┘          └──────┘
   monitor ──ICMP／TCP／HTTP──► 區網內各設備
```

- 瀏覽器**只連主程式一個埠**。串流走 `/api/nvr/ws` 由主程式反向代理到 go2rtc，帳密只存在主機端。
- 前端與後端都採「**核心＋獨立模組**」：模組之間不互相 import，只透過 §6 的契約（REST、事件、路由連結）溝通。

## 5. 模組隔離規則（「改一個功能不影響其他功能」的具體做法）

1. **目錄所有權**：每個模組只能改自己的目錄（見 §9）。`core/`、`ui/`、`contracts/` 由基礎層負責，功能模組不得修改。
2. **資料所有權**：每個 store collection 只有一個模組能寫入（見 §7 表格的「擁有者」欄）。其他模組只讀，或呼叫擁有者的 API。
3. **跨模組只走三種管道**：
   - REST API（契約定義於 `contracts/api.md`）
   - 事件（`contracts/events.md`；後端 → SSE → 前端 bus）
   - 路由連結（例：新增設備後導向 `#/floorplan?place=<deviceId>`）
4. **故障隔離**：
   - 後端 module-loader 逐一 `import()` 並呼叫模組的 `check()`；失敗的模組標記為 `failed`，其他照常啟動，`GET /api/system/modules` 可看到原因。
   - 前端 shell 以 try/catch 包住每個模組的 `mount()`；失敗時該分頁顯示「此功能暫時無法載入」卡片，其他分頁不受影響。
   - `data/config.json` 的 `modules` 可個別停用模組（例如 NVR 壞了先關掉）。
5. **契約變更流程**：功能模組發現契約不夠用時，**停下來回報**（Change Request），不可自行修改契約或核心。

### 5.1 後端模組介面

```js
// server/modules/<name>/index.js
export default {
  name: 'monitor',
  owns: ['statusHistory'],            // 可寫入的 collections
  async check(ctx) {},                // 啟動前自我檢查，丟錯＝此模組停用
  async register(app, ctx) {},        // Fastify plugin，路由前綴 /api/<name 或資源名>
  async start(ctx) {}, async stop() {} // 背景工作（如輪詢）
};
// ctx = { config, store, events, log, secrets }
```

### 5.2 前端模組介面

```js
// web/modules/<name>/index.js
export default {
  id: 'topology', title: '架構圖', icon: 'topology', route: '#/topology', order: 30,
  async mount(el, ctx) {},   // ctx = { api, bus, filters, ui, router, modules }
  unmount() {}               // 必須解除所有事件監聽、計時器、串流
};
```

`ctx.filters` 是全站共用的篩選狀態（樓層／房間／組別／類別／關鍵字），同步到網址 query，所有列表型模組都必須遵守，這樣「切換樓層」在每個分頁的行為一致。

## 6. 契約（由 A0 在 `contracts/` 實作，Phase 1 開始後凍結）

### 6.1 REST API

| 擁有者 | 方法與路徑 | 說明 |
|---|---|---|
| system | `GET /api/system/health` | `{ok, version, uptime}` |
| system | `GET /api/system/modules` | 各模組 `{name, state: ok\|failed\|disabled, error?}` |
| core/auth | `POST /api/auth/login`、`POST /api/auth/logout` | 選用的存取密碼（未設定則免登入） |
| inventory | `GET/POST /api/floors`、`PATCH/DELETE /api/floors/:id` | 刪除樓層時若仍有房間或設備 → 409 |
| inventory | `GET/POST /api/rooms`、`PATCH/DELETE /api/rooms/:id` | 同上 |
| inventory | `GET/POST /api/groups`、`PATCH/DELETE /api/groups/:id` | 刪組別會從設備的 `groupIds` 移除 |
| inventory | `GET/POST /api/categories`、`PATCH/DELETE /api/categories/:id` | 內建類別 `builtin:true` 不可刪 |
| inventory | `GET /api/devices?floorId&roomId&groupId&categoryId&q` | |
| inventory | `GET/POST /api/devices`、`GET/PATCH/DELETE /api/devices/:id` | 上游設備不可形成迴圈 → 422 |
| monitor | `GET /api/status` | 所有設備目前狀態 |
| monitor | `GET /api/status/:deviceId/history?hours=24` | |
| monitor | `POST /api/status/:deviceId/check` | 立即檢查一次 |
| monitor | `GET/PUT /api/monitor/settings` | 預設間隔、並發數、逾時 |
| floorplan | `GET /api/plans`、`PUT /api/plans/:floorId`（multipart）、`GET /api/plans/:floorId/image`、`DELETE /api/plans/:floorId` | |
| floorplan | `GET /api/placements?floorId`、`PUT /api/placements/:deviceId`、`DELETE /api/placements/:deviceId` | 座標為 0–1 比例 |
| nvr | `GET /api/nvr/templates` | 品牌 RTSP 模板 |
| nvr | `GET/POST /api/nvrs`、`PATCH/DELETE /api/nvrs/:id` | 密碼為寫入專用，讀取只回 `hasPassword` |
| nvr | `POST /api/nvrs/:id/test` | 取第 1 頻道快照，回傳成功與否 |
| nvr | `GET /api/nvrs/:id/channels/:ch/snapshot.jpg` | |
| nvr | `GET(WS) /api/nvr/ws?stream=<name>` | 反向代理 go2rtc 的 MSE WebSocket |
| io | `GET /api/export?secrets=0`、`POST /api/import`、`POST /api/import/csv` | |
| core | `GET /api/events` | SSE |

錯誤格式統一：`{ error: { code: 'NOT_FOUND'|'CONFLICT'|'VALIDATION'|'CYCLE'|'UPSTREAM'|'INTERNAL', message: '<繁中訊息>', details? } }`。

### 6.2 事件（SSE `event:` 名稱 → 前端 `bus` 同名）

| 事件 | payload | 發出者 |
|---|---|---|
| `inventory.changed` | `{collection, op: 'create'\|'update'\|'delete', id}` | inventory |
| `status.changed` | `{deviceId, from, to, rttMs, at}` | monitor |
| `status.snapshot` | `{items:[...]}`（SSE 連線建立時送一次） | monitor |
| `placement.changed` | `{deviceId, floorId}` | floorplan |
| `plan.changed` | `{floorId}` | floorplan |
| `nvr.changed` | `{id}` | nvr |
| 前端限定 `device.open` | `{id}` | 任何模組 → devices 模組開啟設備抽屜 |
| 前端限定 `filters.changed` | `{...filters}` | shell |

## 7. 資料模型

所有 id 為 `<前綴>_<nanoid 10 碼>`（例 `dev_V1StGXR8_Z`）。時間一律 ISO 8601 UTC 字串。

| Collection | 擁有者 | 欄位 |
|---|---|---|
| `floors` | inventory | `id, name, order, createdAt, updatedAt` |
| `rooms` | inventory | `id, floorId, name, order` |
| `groups` | inventory | `id, name, color` |
| `categories` | inventory | `id, name, icon, tier: core\|distribution\|access\|endpoint, builtin, defaultMonitor` |
| `devices` | inventory | 見下方 |
| `plans` | floorplan | `floorId, file, mime, width, height, updatedAt` |
| `placements` | floorplan | `deviceId, floorId, x(0–1), y(0–1)` |
| `statusHistory` | monitor | `deviceId, samples:[{at, up, rttMs}]`（每台保留最近 1440 筆，環狀） |
| `nvrs` | nvr | `id, deviceId?, name, brand, host, port, username, channelCount, streamMain, streamSub, channels:[{ch, name, deviceId?, enabled}]` |
| `secrets`（獨立檔 `data/secrets.json`，權限 600） | nvr／core | `{ 'nvr:<id>': '<password>', 'auth': '<hash>' }` |

**唯一例外**：io 模組的「匯入」可透過 `store.restore(snapshot)` 整批覆寫所有 collection（先全部驗證、再一次寫入），完成後發 `inventory.changed`、`plan.changed`、`nvr.changed` 讓各模組重新載入。匯出 JSON 內含平面圖檔（base64）。

**devices**

```jsonc
{
  "id": "dev_xxx", "code": "R01",           // code：自訂編號，相容舊表
  "name": "客廳 Mesh 主節點", "categoryId": "cat_router",
  "floorId": "flr_1", "roomId": "room_living", "groupIds": ["grp_family"],
  "ip": "192.168.1.1", "mac": "AA:BB:CC:DD:EE:FF", "hostname": "", "vendor": "Zyxel", "model": "",
  "uplink": { "deviceId": "dev_modem", "port": "LAN1", "localPort": "WAN",
              "medium": "ethernet|wifi|mesh|poe|fiber|other", "speed": "1G" },  // null＝根節點
  "monitor": { "method": "icmp|tcp|http|none", "port": null, "path": "/", "intervalSec": 60, "critical": false },
  "notes": "", "createdAt": "...", "updatedAt": "..."
}
```

**內建類別**（`builtin:true`）：數據機、路由器、Mesh 節點、交換器、PoE 交換器、無線基地台、NVR、IP 攝影機、電腦、手機／平板、電視／機上盒、智慧家電、印表機、NAS、其他。手機／平板的 `defaultMonitor` 為 `none`（休眠會被誤判離線）。

**舊表相容**：`POST /api/import/csv` 接受舊 Google Sheet「設備清單」B–P 欄：編號、名稱、類別、上游編號、位置、連線方式、IP、MAC、速率、說明、分區（→樓層）、階層、定位編號、上游端口、下游端口。類別以關鍵字對應（同舊 `Code.gs` 規則），對不到者歸「其他」並列在匯入報告。

## 8. 各功能規格重點

### 8.1 連線狀態（monitor）

- 狀態值：`up`、`down`、`unknown`（尚未檢查或檢查本身出錯）、`disabled`（method=none）。
- 判定：成功一次即 `up`；**連續 3 次失敗**才 `down`（沿用 netwatch 規則）。
- 方法：`icmp` 呼叫系統 `ping -c 1 -W 1`（容器需 `NET_RAW`）；`tcp` 連線指定埠，逾時 1500ms；`http` GET，狀態碼 < 500 視為 up。
- 排程：每台依自己的 `intervalSec`（最小 15 秒），整體並發上限 16；每台加 0–20% 隨機延遲避免同時爆量。
- 前端燈號：`critical:false` 的設備離線顯示灰色「離線」，`critical:true` 才顯示紅色警示。
- 可測試性：prober 以依賴注入，測試用假 prober，不需真實網路。

### 8.2 架構圖（topology）

- 節點＝設備，邊＝`uplink`。沒有 uplink 的是根節點（通常是數據機）。
- 排版 Cytoscape `breadthfirst`（directed、roots＝根節點）；選項「依樓層分群」用 compound node。
- 邊樣式：有線實線、Wi-Fi／Mesh 虛線、PoE 加閃電標記；邊標籤顯示 `port ↔ localPort`。
- 節點顏色跟 `status.changed` 即時更新；點節點 → `bus.emit('device.open')`。
- 遵守全站篩選；被篩掉的節點淡化而非移除，保持樹的完整。

### 8.3 樓層平面圖（floorplan）

- 每層樓一張圖：PNG／JPG／WebP／SVG，≤ 10MB；SVG 只以 `<img>` 顯示（不執行腳本）。
- 座標存 0–1 比例，換圖或縮放都不會跑位。
- 操作：滾輪／雙指縮放、拖曳平移、「放置模式」從左側未放置清單拖設備上圖、拖曳既有點移動、右鍵／長按移除。
- 支援 `#/floorplan?place=<deviceId>`：自動切到該設備樓層並進入放置模式。
- 燈號跟狀態同步；攝影機點可直接開即時畫面（`#/cameras?ch=<nvrId>:<ch>`）。

### 8.4 NVR 監視畫面（nvr）

- 主程式透過 go2rtc REST API 動態註冊串流：每頻道兩個名稱 `nvr_<id>_<ch>_main`、`nvr_<id>_<ch>_sub`。
- **品牌模板**（`contracts/fixtures/nvr-templates.json`，需實機驗證）：

| 品牌 | 範本（`{ch}` 頻道、`{s}` 碼流） |
|---|---|
| Hikvision 海康 | `rtsp://{u}:{p}@{host}:{port}/Streaming/Channels/{ch}0{s}`（s：1 主、2 子） |
| Dahua 大華（含 Imou、Amcrest） | `rtsp://{u}:{p}@{host}:{port}/cam/realmonitor?channel={ch}&subtype={s}`（s：0 主、1 子） |
| Uniview 宇視 | `rtsp://{u}:{p}@{host}:{port}/unicast/c{ch}/s{s}/live`（s：0 主、1 子） |
| Reolink | `rtsp://{u}:{p}@{host}:{port}/h264Preview_{ch:02}_{s}`（s：main／sub） |
| 自訂 | 使用者自行輸入完整 URL，可用上述佔位符 |

- **已知地雷（先寫進規格，避免試錯）**：
  1. 帳密含特殊字元（`@ # : /`）必須 `encodeURIComponent`。
  2. 瀏覽器對 H.265 支援不穩：**子碼流請在 NVR 設為 H.264**；精靈的測試步驟偵測到 H.265 時要提示。
  3. 分割畫面一律用子碼流，點兩下才切主碼流，避免頻寬與 NVR 連線數爆掉。
  4. 分頁隱藏（`visibilitychange`）或離開監視器頁時要關閉所有串流。
  5. iPhone Safari 不支援一般 MSE；使用 go2rtc 前端元件的自動回退機制，並列入實機手動驗證。
- 前端：分割 1／4／9／16，頻道名稱浮標，雙擊全螢幕；同時串流上限可設定（預設 9）。
- 測試：用假 go2rtc（小型 HTTP 模擬伺服器）驗證註冊、快照、WS 代理；真實 NVR 由使用者依手動清單驗證。

### 8.5 首次導覽（onboarding）

資料庫為空時自動開啟，之後可從「設定」重新開啟。6 步：建立樓層 → 上傳平面圖（可略過）→ 建立房間 → 新增核心設備（數據機／路由器）→ 新增其他設備或匯入 CSV → 設定 NVR（可略過）。每步左側 SVG 示意動畫、右側說明與動作按鈕，按鈕開啟對應模組的精靈。

## 9. 目錄結構與所有權

```
NetworkConnect/
├─ contracts/          A0   schemas/*.json、api.md、events.md、fixtures/*.json
├─ server/
│  ├─ index.js         A0
│  ├─ core/            A0   config、store、events、auth、module-loader、errors
│  └─ modules/
│     ├─ system/       A0
│     ├─ inventory/    B1
│     ├─ io/           B1
│     ├─ monitor/      B2
│     ├─ floorplan/    B4
│     └─ nvr/          B5
├─ web/
│  ├─ index.html、app.js、core/   A0   shell、router、api、bus、filters、module-loader
│  ├─ ui/              A1   tokens.css、元件（guide、wizard、toast、dialog、drawer、segmented、chips）
│  ├─ vendor/          A0   鎖版本的第三方檔（cytoscape、go2rtc video-rtc）
│  └─ modules/
│     ├─ devices/      B1   列表、篩選、新增精靈、設備抽屜、分類管理
│     ├─ status/       B2   狀態總覽頁（Phase 2 併入 dashboard）
│     ├─ topology/     B3
│     ├─ floorplan/    B4
│     ├─ cameras/      B5
│     ├─ dashboard/    C1
│     ├─ onboarding/   C1
│     └─ settings/     C1
├─ test/
│  ├─ unit/<module>/   各模組自己的
│  ├─ contract/        A0 建立框架，各模組補自己的案例
│  └─ e2e/             C1
├─ deploy/             A0   Dockerfile、docker-compose.yml、go2rtc.yaml
├─ data/               （gitignore）db.json、secrets.json、config.json、uploads/
└─ docs/
```

## 10. 介面設計語言

**直接沿用** hottopic 已整理好的規範（`unnn3ing-oss/hottopic` 的 `docs/superpowers/specs/2026-10-14-ui-redesign-design.md` §4 與 `web/app.css` 開頭的 token）；來源為 QPT `deploy.css`（全螢幕安裝教學）、`segmented.css`，以及 LinePushPatternTool 的 `.lw-*`（推播精靈）。

| 元件 | 來源 | 用在哪 |
|---|---|---|
| 全螢幕導覽 `nc-guide`（步驟點列、左 SVG 示意右說明、底部上一步／下一步） | QPT `.ds-*` | 首次導覽、NVR 設定說明 |
| 精靈 `nc-wizard`（分步面板、選項卡 `lw-op`、資訊框 `lw-box`、確認頁 `lw-kv`） | LinePush `.lw-*`、`.s8-steps` | 新增設備、新增 NVR、CSV 匯入 |
| 頂欄 | hottopic `.topbar`（半透明模糊、sticky） | 全站 |
| 分頁切換 | QPT `.func-switch` 膠囊分段 | 主導覽、分割數切換 |
| 按鈕 | 三種 pill：次要、主要、危險 | 全站 |
| 篩選 chips | hottopic `.chip` | 全站篩選列 |
| 燈號 | `--ok` 綠、`--danger` 紅、`--muted` 灰、`--warn` 黃（unknown） | 列表、架構圖、平面圖 |

規則：所有樣式寫在 CSS 檔（CSP `style-src 'self'`，不用行內樣式）；淺色／深色雙主題；尊重 `prefers-reduced-motion`；手機 ≤ 820px 版面可用。

## 11. 安全

- 只在區網提供服務；**不建議路由器開 port**，要外出查看請用 Tailscale 等 VPN。
- 可選「存取密碼」（scrypt 雜湊、HttpOnly cookie）；有設 NVR 時，設定頁會提示建議開啟。
- go2rtc API 只綁 `127.0.0.1`。
- NVR 密碼只存在 `data/secrets.json`，API 永不回傳；匯出預設不含密碼。
- CSP：`default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; connect-src 'self'`。

## 12. 後續版本（Backlog）

自動掃描網段（ARP）建議新增、Zyxel／交換器 SNMP 流量、LINE 離線告警、NVR 回放、房間多邊形與熱區、PDF 平面圖、SQLite 儲存、多使用者。

## 13. 待你確認（不阻擋開工，先用預設值）

| # | 問題 | 預設 |
|---|---|---|
| Q1 | NVR 品牌／型號 | 先做 §8.4 四個模板＋自訂 |
| Q2 | 主機用什麼跑 | Linux 小主機／樹莓派 Docker；Windows 用 `npm start` |
| Q3 | 是否需要外網看監視器 | 不開放，建議 Tailscale |
| Q4 | 設備規模 | < 300 台 |
| Q5 | 舊 Google Sheet 設備清單要不要匯入 | 提供 CSV 匯入 |
