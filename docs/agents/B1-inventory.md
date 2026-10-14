# B1 設備與分類（inventory＋io＋devices 頁）

## 必讀
- 規格 §1 F1／F2／F8、§5、§6.1（inventory、io 列）、§6.2、§7、§8.3 最後兩點（放置連結）
- `contracts/`（schemas、api.md、events.md、fixtures）
- `web/ui/README.md`（UI 元件 API；不要讀 web/ui 原始碼）
- `server/core/` 與 `web/core/` 只讀函式簽名與註解

## 可修改
`server/modules/inventory/` `server/modules/io/` `web/modules/devices/` `test/unit/inventory/` `test/unit/io/` `test/contract/inventory*.test.js` `test/contract/io*.test.js`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
### 後端 inventory
1. floors／rooms／groups／categories／devices CRUD，路由用 contracts 的 schema 驗證。
2. 規則：刪樓層／房間時仍被引用 → 409；刪組別 → 從設備 `groupIds` 移除；內建類別不可刪；`roomId` 必須屬於 `floorId`；**uplink 不可形成迴圈 → 422 `CYCLE`**（含自己連自己）；刪除設備時，下游設備的 `uplink` 設為 null 並在回應中列出受影響設備。
3. 首次啟動時寫入內建類別（規格 §7）。
4. 每次變更發 `inventory.changed`。
5. `GET /api/devices` 支援 `floorId`、`roomId`、`groupId`、`categoryId`、`q`（名稱、編號、IP、MAC 模糊比對）。
### 後端 io
6. `GET /api/export?secrets=0|1`（含 floorplan、nvr 的 collection，透過 store 唯讀；平面圖檔以 base64 內嵌）、`POST /api/import`（先驗證全部，再用 `store.restore()` 一次寫入，任何錯誤整批不寫）。
7. `POST /api/import/csv`：規格 §7「舊表相容」欄位對應與類別關鍵字規則；回傳匯入報告 `{created, skipped:[{row, reason}], unmappedCategories}`；支援 `dryRun=1` 預覽。
### 前端 devices 頁
8. 列表：卡片／表格兩種檢視（segmented 切換）、依全站篩選、排序（名稱／編號／IP／狀態）、每列顯示狀態燈（訂閱 `status.snapshot`／`status.changed`；monitor 模組停用時顯示「—」）。
9. 新增／編輯精靈（推播精靈風格），6 步：類別（選項卡＋圖示）→ 基本資料（名稱、編號、IP、MAC、廠牌型號）→ 位置（樓層、房間、組別）→ 連線（上游設備下拉＋可搜尋、上游埠、本機埠、媒介、速率）→ 偵測（依類別帶預設、關鍵設備勾選）→ 確認（`kv` 清單）。儲存後 toast 提供「放到平面圖」按鈕 → `#/floorplan?place=<id>`。
10. 設備抽屜：監聽 `device.open`，顯示完整資訊、狀態、上下游設備連結、編輯／刪除（刪除前用 `confirm`，列出會被斷開的下游設備）。
11. 分類管理子頁：樓層（可排序）、房間、組別（顏色）、類別的增刪改。
12. 匯入子頁：CSV 匯入精靈（上傳 → 預覽報告 → 確認寫入）、JSON 匯出／匯入。

## 驗收
1. 單元＋契約測試涵蓋：迴圈偵測（直接、間接、自我）、409 規則、刪除設備的下游處理、CSV 對應（用 fixtures 中的範例 CSV，請自行建在 `test/unit/io/fixtures/`）、匯入失敗不寫入。
2. `npm run dev:mock` 下可完整走完新增精靈、編輯、刪除、篩選。
3. 手機 390px 可用。
