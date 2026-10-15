# NetworkConnect 開發計畫與 Agent 分工

規格：`docs/specs/2026-10-14-networkconnect-design.md`（以下簡稱「規格」）
各 agent 任務書：`docs/agents/*.md`

## 1. 總覽

```
Phase 0（地基，2 個 agent 並行）     Phase 1（功能，6 個 agent 並行）          Phase 2（整合，1 個 agent）
┌──────────────┐                ┌ B1 設備與分類（inventory＋io＋devices）┐
│ A0 核心＋契約 │──┐             ├ B2 連線狀態（monitor＋status）        │
└──────────────┘  │             ├ B3 架構圖（topology）                 │
                  ├─► 閘門 G0 ──►├ B4 平面圖（floorplan）                ├─► 閘門 G1 ──► C1 整合 ──► 閘門 G2 ──► 主控審查
┌──────────────┐  │             ├ B5 NVR 監視（nvr＋cameras）          │              （總覽、導覽、
│ A1 UI 元件庫 │──┘             └ D1 桌面 App（Electron＋打包＋CI）     ┘               設定、E2E）
└──────────────┘
```

| Agent | 範圍 | 只能修改 | 依賴 | 規模 |
|---|---|---|---|---|
| A0 | 專案骨架、契約、後端 core、`startServer()` 啟動入口、前端 shell、測試框架、mock 模式 | `contracts/` `server/index.js` `server/cli.js` `server/core/` `server/modules/system/` `web/index.html` `web/app.js` `web/core/` `web/vendor/` `test/contract/` `test/helpers/` 根目錄設定檔（不含 `electron-builder.yml`） | 無 | 大 |
| A1 | UI 元件庫與設計 token | `web/ui/` `test/unit/ui/` | 無（只看設計來源） | 中 |
| B1 | 設備、樓層、房間、組別、類別 CRUD；CSV／JSON 匯入匯出；設備列表、新增精靈、設備抽屜 | `server/modules/inventory/` `server/modules/io/` `web/modules/devices/` `test/unit/inventory/` `test/unit/io/` `test/contract/inventory*` | G0 | 大 |
| B2 | 背景偵測、狀態歷史、SSE 推播、狀態頁 | `server/modules/monitor/` `web/modules/status/` `test/unit/monitor/` `test/contract/monitor*` | G0 | 中 |
| B3 | 拓樸圖 | `web/modules/topology/` `test/unit/topology/` | G0（用 fixtures，不需等 B1/B2） | 中 |
| B4 | 平面圖上傳、設備落點 | `server/modules/floorplan/` `web/modules/floorplan/` `test/unit/floorplan/` `test/contract/floorplan*` | G0 | 中 |
| B5 | go2rtc 整合、NVR 精靈、分割畫面 | `server/modules/nvr/` `web/modules/cameras/` `test/unit/nvr/` `test/contract/nvr*` `test/helpers/fake-go2rtc.js` | G0 | 大 |
| D1 | Electron 主行程、選單列／系統匣、通知、QR Code、go2rtc 下載與打包、三平台 CI、安裝教學頁 | `desktop/` `scripts/` `electron-builder.yml` `.github/workflows/` `test/unit/desktop/` `test/desktop/` `docs/install/`；`package.json` 只加 Electron 相關欄位 | G0（只依賴 `startServer()` 與 SSE 契約） | 大 |
| C1 | 總覽、首次導覽、設定頁、E2E、README、手動驗證清單 | `web/modules/dashboard/` `web/modules/onboarding/` `web/modules/settings/` `test/e2e/` `README.md` `docs/manual-checklist.md` | G1 | 中 |

**為什麼這樣切**：每個 agent 的檔案範圍互不重疊 → 平行開發零合併衝突；跨模組只靠 A0 先寫好的契約與 fixtures → Phase 1 不需要等別人完成。

## 2. 閘門（每道都要主控 agent 實際跑指令確認，不看 agent 自述）

### G0：地基完成（Phase 1 開工條件）

- [ ] `npm test` 全綠（含 contract 測試框架自身的測試）
- [ ] `npm run dev:mock` 可啟動，瀏覽器看到 shell：頂欄、主導覽、全站篩選列、每個模組分頁顯示 stub 卡片
- [ ] 故意讓一個 stub 模組 `check()` 丟錯，其他模組仍正常（後端與前端各驗一次）
- [ ] `contracts/` 完整：schemas、api.md、events.md、fixtures（含 ≥ 25 台設備、3 層樓、1 台 NVR 8 頻道的範例資料）
- [ ] `web/ui/demo.html` 可看到所有 UI 元件，淺色／深色皆正常
- [ ] `node server/cli.js --data-dir <暫存資料夾> --port 0` 可啟動並在 stdout 印出實際埠號；`startServer()` 回傳 `{port, url, stop}`，`stop()` 後行程可正常結束
- [ ] 主控 agent 審閱契約後**凍結**（之後改契約需走 Change Request）

> ✅ **G0 已通過（2026-10-14）**：261 項測試全綠、故障隔離與啟動入口經主控實測。`contracts/` 自 commit `b132646` 起**凍結**，修改一律走 Change Request。

### G1：功能完成（Phase 2 開工條件）

- [ ] 六個分支各自 `npm test` 全綠，依序合併後整體 `npm test` 仍全綠
- [ ] 合併順序：B1 → B2 → B4 → B3 → B5 → D1（資料源先進，消費者後進，外殼最後）
- [ ] GitHub Actions `ci.yml` 在 ubuntu／macos／windows 三平台全綠（含各平台真實 ping `127.0.0.1` 測試）
- [ ] `release.yml` 手動觸發可產出 `.dmg`（arm64）與 `.exe`，並通過 Electron 冒煙測試（App 啟動 → 視窗載入 → `/api/system/health` 正常 → 結束後無殘留 go2rtc 行程）
- [ ] `npm run dev:mock` 下五個分頁都能操作；停用任一模組其他仍正常

> ✅ **G1 已通過（2026-10-15）**：B1–B5、D1 全部合併於 `aaa83f5`，`npm test` 946/946；CI run 38671879673 三平台測試＋mac-arm64／win-x64 打包與 Electron 冒煙測試全綠（`release.yml` 與 CI 共用 `package.yml`，正式發版時再手動觸發以免產生多餘的 Release 草稿）。主控以 Chromium 實測五個分頁，並逐一停用 inventory／io／monitor／floorplan／nvr：只有依賴該模組的分頁顯示錯誤卡，其他分頁正常、無 pageerror。

### G2：整合完成

- [ ] E2E 全綠（Playwright，Chromium 路徑 `/opt/pw-browsers`）
- [ ] 全程無 `pageerror`、無 CSP 違規
- [ ] 主控 agent 跑 `code-review`（high）並處理所有阻擋性問題
- [ ] 交給使用者依 `docs/manual-checklist.md` 在家實機驗證（Mac 與 Windows 各安裝一次、真實 ping、真實 NVR、手機連線）

## 3. 派工方式

- 模型：`sonnet`；推理強度：`high`（使用者指定）。
- Phase 0 與 Phase 1 的 agent 用 `isolation: "worktree"` 各自一份工作樹，各自 commit；主控 agent 負責合併到 `claude/lucid-clarke-kaj7ym`。
- Phase 0：A0、A1 同時派出。Phase 1：B1–B5 同時派出。Phase 2：C1 單獨派出。

**派工 prompt 範本**（刻意極短，細節都在任務書裡，避免重複傳 token）：

```
你是 NetworkConnect 專案的 <代號> agent。
1. 讀 docs/agents/<代號>.md，完全依照它執行；它列出的「必讀」以外的檔案不要讀。
2. 只修改任務書「可修改」範圍內的檔案。需要改範圍外的檔案或契約時，停止並在回報中提出 Change Request。
3. 完成後依任務書「回報格式」回覆，不要貼程式碼。
```

## 4. 減少試錯的機制

| 機制 | 作用 |
|---|---|
| 技術選型與版本在規格中定案 | agent 不再比較方案、不探索 |
| 契約先行＋JSON Schema 驗證 | 前後端各自開發，介面不對的話測試當場失敗 |
| fixtures＋`dev:mock` | 不需要真實網路、NVR 就能開發與測試前端 |
| 假 prober、假 go2rtc | 偵測與串流邏輯可在雲端容器內單元測試 |
| 已知地雷寫進規格（H.265、帳密編碼、iOS MSE、手機休眠） | 避免踩已知的坑 |
| TDD（`superpowers:test-driven-development`） | 每個行為先有失敗測試再實作 |
| 完成前驗證（`superpowers:verification-before-completion`） | 回報前必須貼出實際指令輸出摘要 |
| 每道閘門由主控親自跑指令 | 不信任自述，問題不往下游傳 |

## 5. 減少 token 的規則

1. **任務書自帶所需資訊**：每份任務書只指定規格中該模組需要的章節，並列「必讀檔案」白名單；agent 不讀整份規格、不讀其他模組的程式碼。
2. **不重新設計**：設計已完成，agent 不使用 brainstorming 類技能，也不重寫規格。
3. **技能只載入必要的**：所有 agent 用 `superpowers:test-driven-development`、`superpowers:verification-before-completion`；畫面類 agent（A1、B1、B3、B4、B5、C1、D1）另加 `anthropic-skills:frontend-design`（只在做視覺時參考）。不載入其他技能。
4. **參考 repo 只讀指定檔案**：設計來源只讀 hottopic 規範 §4、QPT `deploy.css`、LinePushPatternTool 的 `.lw-*` 段落（限 A1）。
5. **回報精簡**：固定格式 ≤ 20 行，不貼程式碼；主控只在閘門時讀 diff。
6. **出錯時**：同一個測試連續修 3 次仍失敗 → 停下來回報，不要繼續猜（`superpowers:systematic-debugging` 才在此時載入）。

## 6. 回報格式（所有 agent 共用）

```
## <代號> 回報
狀態：完成 / 部分完成 / 阻擋
分支：<branch>　commit：<sha>
測試：<指令> → <通過數>/<總數>
完成項目：（對應任務書的驗收清單編號）
未完成／偏離規格：
Change Request：（無則寫「無」）
需要使用者實機驗證：
```

## 7. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| NVR 品牌模板不符 | 看不到畫面 | 自訂 URL＋測試連線步驟；使用者回報型號後補模板（Q1） |
| 雲端開發容器是 Linux，無法直接跑 Mac／Windows | 平台問題晚發現 | 三平台 CI 是 G1 必要條件；平台差異（ping、路徑、行程結束）寫成純函式並以真實輸出樣本測試 |
| 未付費簽章 | 使用者第一次開啟被系統擋 | README＋全螢幕安裝教學逐步說明；之後再評估 Apple Developer 方案（年費 99 美元） |
| 電腦睡眠或關機 | 偵測中斷 | 規格 §3 寫明要常開的電腦；提供防止閒置睡眠選項；恢復後狀態全部重測 |
| macOS 區域網路權限被拒 | ping 全失敗 | 偵測並引導使用者到系統設定開啟（規格 §8.6） |
| 雲端開發容器沒有真實區網與 NVR | 無法端對端驗證 | 假 prober／假 go2rtc＋使用者實機清單 |
| 契約在 Phase 1 才發現不足 | 多個 agent 卡住 | G0 由主控審閱；Change Request 由主控統一修改後通知受影響 agent |
| 第三方前端檔版本漂移 | 行為不一致 | 全部 vendored 並在 `web/vendor/VERSIONS.md` 記錄版本與來源 |
