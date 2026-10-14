# B2 連線狀態（monitor＋status 頁）

## 必讀
- 規格 §5、§6.1（monitor 列）、§6.2、§7（devices.monitor、statusHistory）、§8.1、§3（主機與 NET_RAW）
- `contracts/`、`web/ui/README.md`
- `server/core/`、`web/core/` 只讀函式簽名與註解；`test/helpers/fake-prober.js`

## 可修改
`server/modules/monitor/` `web/modules/status/` `test/unit/monitor/` `test/contract/monitor*.test.js`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`

## 工作項目
1. `probers/`：`icmp.js`（`execFile('ping', ['-c','1','-W','1', ip])`，解析 rtt；**不得用 shell 字串拼接**，IP 先驗證格式）、`tcp.js`（`net.connect`，1500ms 逾時）、`http.js`（`fetch`＋AbortController，狀態碼 < 500 為 up）。統一介面 `probe(device) → {ok, rttMs, error?}`。
2. `scheduler.js`：每台依 `intervalSec`（最小 15）＋0–20% 抖動；全域並發上限（設定值，預設 16）；設備新增／修改／刪除時（`inventory.changed`）重新排程；`stop()` 清乾淨所有計時器。時間與 prober 皆可注入，測試用假時鐘。
3. `state.js`：狀態機 up／down／unknown／disabled，連續 3 次失敗才 down；變化時發 `status.changed`；SSE 新連線時送 `status.snapshot`。
4. 歷史：每台環狀保留 1440 筆，寫入 store 採批次（最多每 30 秒落檔一次）。
5. API：`GET /api/status`、`GET /api/status/:id/history`、`POST /api/status/:id/check`、`GET/PUT /api/monitor/settings`。
6. `check()`：偵測 `ping` 指令是否可用、是否有權限；沒有時模組仍啟用，但 icmp 設備標 `unknown` 並在 `/api/system/modules` 的訊息中說明（「需要 NET_RAW 權限」）。
7. 前端 status 頁：上方統計（上線／離線／未知／未偵測），下方依樓層分組的設備燈號格，離線的關鍵設備置頂；點設備 → `device.open`；單台 24 小時可用率迷你條（純 CSS／SVG，不引函式庫）。

## 驗收
1. 單元測試（假時鐘＋假 prober）：3 次失敗才 down、一次成功即 up、並發上限、設備刪除後不再排程、`stop()` 後無殘留計時器、method=none → disabled。
2. icmp prober 對 `127.0.0.1` 實測成功（容器內若無 ping 權限則測試自動 skip 並註明）。
3. 惡意 IP 字串（如 `1.1.1.1;rm -rf /`）被拒絕的測試。
