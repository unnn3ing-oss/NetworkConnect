# A1 UI 元件庫

## 必讀
- 規格 §10、§11 的 CSP 一行（`docs/specs/2026-10-14-networkconnect-design.md`）
- 設計來源（公開 repo，`git clone --depth 1` 到暫存目錄，**只讀以下檔案**）：
  - `unnn3ing-oss/hottopic`：`docs/superpowers/specs/2026-10-14-ui-redesign-design.md` 第 4 節、`web/app.css` 前 80 行（token）
  - `unnn3ing-oss/QuickPatterntool`：`deploy.css`（全螢幕安裝教學 `.ds-*`）、`segmented.css`、`index.html` 第 388–460 行（`.ds-*` 結構範例）
  - `unnn3ing-oss/LinePushPatternTool`：`index.html` 中 `.lw-*` 與 `.s8-steps` 相關的 CSS 規則與第 1680–1720 行結構（推播精靈）

## 可修改
`web/ui/` `test/unit/ui/`

## 技能
`superpowers:test-driven-development`（只用於元件的 JS 行為）、`superpowers:verification-before-completion`、`anthropic-skills:frontend-design`

## 工作項目
所有元件為原生 ES Module＋對應 CSS，前綴 `nc-`，不依賴框架，不用行內樣式。
1. `tokens.css`：沿用 hottopic token（淺／深色）＋燈號 token：`--st-up`、`--st-down`、`--st-offline`（灰，非關鍵設備離線）、`--st-unknown`（黃）、`--st-disabled`。
2. `base.css`：字型、按鈕三種 pill（`.btn`、`.btn.primary`、`.btn.danger`）、`.btn.small`、chips、輸入框、卡片、頁面背景、頂欄、`[hidden]`。
3. `guide.js/.css`（全螢幕導覽，視覺同 QPT `.ds-*`）：`createGuide({title, subtitle, steps:[{label, art: SVGElement|string(靜態 SVG 字串), body: Node, onEnter?, canNext?}] , onClose})`；步驟點列可點選、上一步／下一步、`步驟 n／N`、Esc 關閉（先確認）、焦點陷阱、`prefers-reduced-motion`。
4. `wizard.js/.css`（精靈，視覺同推播精靈 `.lw-*`）：`createWizard({title, steps:[{id, label, render(state) → Node, validate(state) → string|null}], onSubmit(state), onCancel})`；附屬元件：選項卡群組 `opGroup({options, value, onChange})`（`role=radiogroup`，鍵盤左右）、資訊框 `box(title, node)`、確認清單 `kv(pairs)`。驗證失敗時在步驟內顯示訊息、不得前進。
5. `toast.js`、`dialog.js`（`confirm({title, message, danger})` 回傳 Promise，取代原生對話框）、`drawer.js`（右側抽屜，手機改全螢幕）、`segmented.js`（膠囊分段，同 QPT `.func-switch`）、`chips.js`（篩選 chip 群組，可多選）、`status-dot.js`（依狀態＋critical 決定顏色與文字）、`empty.js`（空狀態卡：圖示、說明、主要按鈕）、`icons.js`（靜態 inline SVG 圖示集，含所有內建設備類別與主導覽圖示）。
6. `demo.html`：展示所有元件與兩種主題切換（`data-theme`），供 G0 目視檢查。
7. `README.md`（web/ui 內）：每個元件的 API 與最小範例，≤ 150 行。**B 組 agent 只會讀這份，不會讀你的原始碼**，所以 API 說明要完整。

## 驗收
1. `test/unit/ui/` 以 jsdom 或純函式測試覆蓋：精靈驗證擋前進、guide 步驟切換、opGroup 鍵盤操作、dialog Promise 結果。（若用 jsdom，加入 devDependencies 並鎖版本。）
2. `demo.html` 用 Playwright 截圖淺／深色各一張，存到 `docs/screenshots/ui-kit-*.png`。
3. 手機寬度 390px 無水平捲動。
