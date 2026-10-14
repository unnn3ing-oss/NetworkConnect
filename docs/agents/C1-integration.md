# C1 整合：總覽、首次導覽、設定、E2E、文件

## 必讀
- 規格 §1、§5.2、§8.5、§10、§11、§13
- 計畫 §2 G2
- `contracts/`、`web/ui/README.md`、`web/core/` 函式簽名
- 各模組只讀其 `index.js` 的匯出與路由名稱，不讀實作

## 可修改
`web/modules/dashboard/` `web/modules/onboarding/` `web/modules/settings/` `test/e2e/` `playwright.config.js` `README.md` `docs/manual-checklist.md`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
1. **總覽（首頁）**：狀態統計卡、離線的關鍵設備清單、各樓層設備數與上線率、快速入口（新增設備、看監視器）；任何依賴的模組停用時該卡片隱藏。
2. **首次導覽**：用 `guide` 元件實作規格 §8.5 六步，每步左側靜態 SVG 示意（畫出對應頁面的簡化樣子），右側說明與按鈕（開對應模組的精靈或導向路由）；資料庫為空時自動開啟；步驟完成狀態依實際資料判斷（例如已有樓層就打勾）。
3. **設定頁**：存取密碼設定／移除、各模組開關與狀態（`/api/system/modules`）、偵測預設值（`/api/monitor/settings`）、重新開啟導覽、備份入口（連到 devices 匯入子頁）、版本資訊。
4. **E2E**（Playwright，`executablePath: '/opt/pw-browsers/chromium'` 或依環境變數）：
   - 空資料庫 → 導覽自動出現 → 建樓層 → 建房間 → 新增路由器 → 新增 3 台下游設備 → 架構圖出現 4 個節點
   - 平面圖上傳並放置設備、重新整理位置不變
   - 篩選樓層後設備列表、架構圖、平面圖三處一致
   - 偵測狀態變化（mock prober 切換）→ 列表、架構圖、平面圖燈號同步變色
   - NVR 精靈（fake go2rtc）→ 監視器 4 分割 → 離開頁面串流關閉
   - 停用 nvr 模組後其他頁面全部正常
   - 手機 390×844 主要流程可操作
   - 全程無 `pageerror`、無原生對話框、無 CSP 違規
5. **README.md**：功能介紹、硬體需求、Docker 安裝（Linux）、Windows `npm start` 路徑、go2rtc 說明、NVR 子碼流設 H.264 提醒、Tailscale 外出查看建議、備份方式。
6. **docs/manual-checklist.md**：使用者在家實機驗證清單（真實 ping、手機休眠設備、每個 NVR 品牌、iPhone Safari、9 路同看的 CPU／頻寬、深色模式、斷電重開機後自動恢復）。

## 驗收
`npm test` 與 `npm run test:e2e` 全綠，並附上 E2E 摘要輸出。
