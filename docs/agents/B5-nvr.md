# B5 NVR 監視畫面（nvr＋cameras）

## 必讀
- 規格 §3（go2rtc）、§4、§5、§6.1（nvr 列）、§6.2、§7（nvrs、secrets）、§8.4（含 8 項已知地雷，務必全部處理）、§11
- `contracts/`、`web/ui/README.md`、`server/core/` 與 `web/core/` 函式簽名、`web/vendor/VERSIONS.md`、`test/helpers/fake-go2rtc.js`
- go2rtc 官方 README 中「API」與「video-rtc／video-stream 前端元件」兩節（只查這兩節）

## 可修改
`server/modules/nvr/` `web/modules/cameras/` `test/unit/nvr/` `test/contract/nvr*.test.js` `test/helpers/fake-go2rtc.js`（可擴充）

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
### 後端
1. `templates.js`：讀 `contracts/fixtures/nvr-templates.json`，`buildUrl(template, {u, p, host, port, ch, stream})`；**u、p 一律 `encodeURIComponent`**；`{ch:02}` 補零語法。
2. `go2rtc-process.js`：依 `config.go2rtcPath` 啟動 go2rtc（`spawn`，Windows 加 `windowsHide:true`），先在資料夾產生 `go2rtc.yaml`（`api.listen: 127.0.0.1:1984`、`rtsp.listen: ""`、`webrtc.listen: ""`，並關閉 go2rtc 自己的網頁介面以外的對外監聽）；寫 pid 檔，啟動前清掉上次殘留的行程；非預期結束時自動重啟最多 3 次；`stop()` 確實結束行程（Windows 用 `taskkill /pid <pid> /T /F`）。沒有 `go2rtcPath` 時跳過啟動、直接連 `go2rtcUrl`。
2b. `go2rtc-client.js`：`upsertStream(name, src)`、`removeStream(name)`、`probe(name)`（後端以 WebSocket 連 `/api/ws?src=`，送出 MSE 請求，最多 8 秒內收到 codec 字串即回傳 `{ok, codec}`，然後關閉；確切訊息格式以 go2rtc 文件為準）；逾時與錯誤轉成 `UPSTREAM`。**不使用 `/api/frame.jpeg`**（需要 ffmpeg，App 不內附）。
3. nvrs CRUD：密碼寫入 `secrets`（`nvr:<id>`），GET 永遠只回 `hasPassword`；建立／修改後重新註冊所有頻道的 main／sub 串流；刪除時移除。啟動（`start`）時重新註冊全部（go2rtc 重啟後串流會消失）。
4. `POST /api/nvrs/:id/test`：註冊第 1 頻道子碼流 → `probe` → 回傳 `{ok, codec, warning?}`；codec 為 `hvc1`／`hev1`（H.265）時 `warning` 提示「請將子碼流改為 H.264」；失敗時區分「連不到主機」「帳密錯誤（RTSP 401）」「逾時」。
5. `GET /api/nvr/status`：go2rtc 是否在執行、版本、已註冊串流數。
6. `GET /api/nvr/ws?stream=`（`@fastify/websocket`）：只允許本系統註冊過的串流名稱（白名單，防止被當成任意 RTSP 代理），雙向轉送到 go2rtc `/api/ws?src=`；任一端關閉就關另一端。
7. `check()`：連不到 go2rtc 時模組仍啟用，但 `/api/system/modules` 顯示「串流服務未啟動」，前端顯示對應提示。
### 前端
8. NVR 設定精靈（推播精靈風格）5 步：品牌（選項卡）→ 連線（主機、埠預設 554、帳號、密碼、頻道數）→ 測試（成功時直接播放第 1 頻道子碼流 3 秒並擷取一張縮圖；失敗時顯示原因：帳密錯／連不到／逾時／H.265 警告）→ 頻道（逐一命名、啟用、連結到 IP 攝影機設備〔下拉自 `/api/devices?categoryId=<camera>`〕）→ 確認。附「怎麼找 RTSP 設定」的全螢幕說明（`guide` 元件）。
9. 監視器頁：分割 1／4／9／16（segmented）、頻道列表可勾選、使用 vendored `video-stream` 元件連 `/api/nvr/ws?stream=<sub>`；雙擊格子 → 該頻道主碼流全螢幕，關閉時切回子碼流；同時串流上限（預設 9，可在頁面設定）；`visibilitychange` 隱藏時關閉全部串流、回來再開；`unmount` 時全部關閉。
10. 支援 `#/cameras?device=<deviceId>` 與 `#/cameras?ch=<nvrId>:<ch>` 直接開單一畫面。
11. 每格顯示頻道名稱、連線中／失敗狀態與「重試」。

## 驗收
1. 單元測試：四個品牌模板 × 主／子碼流 URL 正確；帳密含 `@#:/ ` 被正確編碼；GET 不回傳密碼；WS 白名單拒絕未註冊名稱；go2rtc 逾時轉為 `UPSTREAM`；產生的 `go2rtc.yaml` 不含任何對外監聽；`stop()` 後子行程確實結束（用一個假的長駐子行程測試，不需真的 go2rtc）。
2. 契約測試以 `fake-go2rtc` 跑完整流程：建立 NVR → 測試（fake 回傳 H.264 與 H.265 各一次）→ WS 收到資料 → 刪除後串流移除。
3. `dev:mock` 下監視器頁 4 分割顯示 fake 畫面（假串流即可），切換分頁後串流確實關閉（以 fake-go2rtc 的連線數驗證）。
4. 回報中列出「需要使用者實機驗證」：真實 NVR 品牌型號、主／子碼流、iPhone Safari、同時 9 路的 CPU 與頻寬。
