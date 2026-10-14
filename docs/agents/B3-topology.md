# B3 架構圖（topology）

## 必讀
- 規格 §5.2、§6.2、§7（devices.uplink、categories.tier）、§8.2、§10
- `contracts/`（只讀 devices、floors、categories schema 與 `fixtures/db.sample.json`、`status.sample.json`）
- `web/ui/README.md`、`web/core/` 函式簽名、`web/vendor/VERSIONS.md`

## 可修改
`web/modules/topology/` `test/unit/topology/`

## 技能
`superpowers:test-driven-development`、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
1. `graph.js`（純函式，可在 Node 測試）：`buildElements(devices, categories, floors, statusMap, {groupByFloor, filters})` → Cytoscape elements；根節點判定；被篩選掉的節點加 `faded` class 而非移除；uplink 指向不存在設備時視為根節點並標警告。
2. `style.js`：Cytoscape 樣式，顏色從 CSS 變數讀（`getComputedStyle`），主題切換時重套；邊依 medium：ethernet／fiber 實線、wifi／mesh 虛線、poe 實線加標記；邊標籤 `port ↔ localPort`（縮放太小時隱藏）。
3. `view.js`：`breadthfirst`（directed、roots）；工具列：依樓層分群開關、重新排版、適合畫面、匯出 PNG（`cy.png()`）；點節點 → `bus.emit('device.open')`；訂閱 `status.changed` 只更新該節點 class，`inventory.changed` 重建圖；`unmount` 時 `cy.destroy()` 並解除所有監聽。
4. 空狀態：沒有設備時顯示 `empty` 卡，按鈕導向 `#/devices`。

## 驗收
1. `graph.js` 單元測試：多根、斷鏈、篩選淡化、依樓層分群的 compound 結構。
2. `npm run dev:mock` 下 25 台 fixtures 排版清楚、無重疊邊標籤遮蔽節點（截圖存 `docs/screenshots/topology.png`）。
3. 來回切換分頁 10 次無記憶體洩漏跡象（監聽數不增加）。
