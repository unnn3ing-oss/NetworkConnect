# B2 連線狀態（monitor＋status 頁）

## 必讀
- 規格 §5、§6.1（monitor 列）、§6.2、§7（devices.monitor、statusHistory）、§8.1（含 ping 跨平台表）、§8.6 地雷 2（macOS 區域網路權限）
- `contracts/`、`web/ui/README.md`
- `server/core/`、`web/core/` 只讀函式簽名與註解；`test/helpers/fake-prober.js`

## 可修改
`server/modules/monitor/` `web/modules/status/` `test/unit/monitor/` `test/contract/monitor*.test.js`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`

## 工作項目
1. `probers/`：`icmp.js` 依規格 §8.1 的平台表組參數（`execFile`，**不得用 shell 字串拼接**，IP 先驗證格式；Windows 加 `windowsHide:true`）；平台參數與輸出解析拆成純函式 `pingArgs(platform, ip)`、`parsePing(platform, stdout, exitCode) → {ok, rttMs}`，測試以三平台真實輸出樣本（含中文 Windows 的成功、逾時、「目的地主機無法連線」三種）放在 `test/unit/monitor/fixtures/`；`tcp.js`（`net.connect`，1500ms 逾時）、`http.js`（`fetch`＋AbortController，狀態碼 < 500 為 up）。統一介面 `probe(device) → {ok, rttMs, error?}`。
2. `scheduler.js`：每台依 `intervalSec`（最小 15）＋0–20% 抖動；全域並發上限（設定值，預設 16）；設備新增／修改／刪除時（`inventory.changed`）重新排程；`stop()` 清乾淨所有計時器。時間與 prober 皆可注入，測試用假時鐘。
3. `state.js`：狀態機 up／down／unknown／disabled，連續 3 次失敗才 down；變化時發 `status.changed`；SSE 新連線時送 `status.snapshot`。
4. 歷史：每台環狀保留 1440 筆，寫入 store 採批次（最多每 30 秒落檔一次）。
5. API：`GET /api/status`、`GET /api/status/:id/history`、`POST /api/status/:id/check`、`GET/PUT /api/monitor/settings`。
6. `check()`：偵測 `ping` 指令是否可用；不可用時模組仍啟用，但 icmp 設備標 `unknown` 並在 `/api/system/modules` 說明原因。另外：若**所有** icmp 設備（≥ 3 台）同時失敗、但 `127.0.0.1` 可通，在 macOS 上提示「可能未允許區域網路權限」（`/api/monitor/settings` 回應帶 `hint` 欄位，由前端顯示）。
7. 從睡眠恢復：偵測到兩次排程間隔遠大於設定值（> 3 倍）時，視為電腦曾睡眠，清除失敗計數並立即全部重測，避免大量誤報離線。
8. 前端 status 頁：上方統計（上線／離線／未知／未偵測），下方依樓層分組的設備燈號格，離線的關鍵設備置頂；點設備 → `device.open`；單台 24 小時可用率迷你條（純 CSS／SVG，不引函式庫）。

## 驗收
1. 單元測試（假時鐘＋假 prober）：3 次失敗才 down、一次成功即 up、並發上限、設備刪除後不再排程、`stop()` 後無殘留計時器、method=none → disabled。
2. icmp prober 對 `127.0.0.1` 實測成功（無 ping 權限時自動 skip 並註明）；這個測試會在 D1 的 CI 上於 macOS／Windows 再跑一次，所以不能寫死 Linux 行為。
4. 睡眠恢復邏輯的假時鐘測試。
3. 惡意 IP 字串（如 `1.1.1.1;rm -rf /`）被拒絕的測試。
