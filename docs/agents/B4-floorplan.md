# B4 樓層平面圖（floorplan）

## 必讀
- 規格 §5、§6.1（floorplan 列）、§6.2、§7（plans、placements）、§8.3、§11
- `contracts/`、`web/ui/README.md`、`server/core/` 與 `web/core/` 函式簽名

## 可修改
`server/modules/floorplan/` `web/modules/floorplan/` `test/unit/floorplan/` `test/contract/floorplan*.test.js`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
### 後端
1. `PUT /api/plans/:floorId`（multipart，≤ 10MB，以檔頭 magic bytes 判斷 PNG／JPEG／WebP，SVG 以文字開頭判斷）；讀出寬高（PNG／JPEG／WebP 解析檔頭，SVG 讀 viewBox／width／height，不引入影像處理套件）；存 `data/uploads/plans/<floorId>.<ext>`；換圖時保留 placements。
2. `GET /api/plans/:floorId/image` 回傳圖檔並加 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`、`X-Content-Type-Options: nosniff`。
3. placements CRUD，座標夾在 0–1；樓層被刪除（`inventory.changed` floors delete）→ 刪除該樓層 plan 與 placements；設備被刪除 → 刪除其 placement。
4. 發 `plan.changed`、`placement.changed`。
### 前端
5. 樓層切換（segmented，跟全站篩選的樓層同步）。
6. 畫布：圖片＋設備點圖層，CSS `transform` 縮放平移；滾輪縮放以游標為中心、雙指縮放、拖曳平移、「適合畫面」按鈕；縮放範圍 0.2–8。座標換算寫成純函式 `screenToPlan`／`planToScreen` 並單元測試。
7. 設備點：類別圖示＋狀態燈（訂閱狀態事件）＋名稱標籤（縮放太小時隱藏）；點擊 → `device.open`；攝影機類別多一個「看畫面」按鈕 → `#/cameras?device=<deviceId>`。
8. 編輯模式：左側「本層未放置設備」清單（依全站篩選），拖到圖上放置；拖曳既有點移動；長按／右鍵移除（用 `confirm`）。支援 `#/floorplan?place=<deviceId>`。
9. 沒有平面圖時：空狀態卡＋上傳按鈕；也提供「無平面圖的格狀檢視」（依房間分格列出設備）。

## 驗收
1. 後端測試：檔案類型偽裝（副檔名 png 內容為 html）被拒絕、超過 10MB 被拒絕、寬高解析正確（三種格式各一）、刪樓層連帶清除。
2. 座標換算純函式測試（含縮放與平移後的來回換算誤差 < 0.001）。
3. `dev:mock` 下可上傳 fixtures 的平面圖、拖放 5 台設備、重新整理後位置不變；手機可雙指縮放（Playwright 模擬觸控或手動註明）。
