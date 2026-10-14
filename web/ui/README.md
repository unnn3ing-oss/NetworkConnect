# NetworkConnect UI 元件庫（web/ui）

原生 ES Module＋CSS，無框架、無行內樣式（符合 CSP `style-src 'self'`）。所有文字一律以純文字插入，不會被當成 HTML。
範例頁：`demo.html`（淺／深色切換）。測試：`node --test "test/unit/ui/*.test.mjs"`。

## 載入
```html
<link rel="stylesheet" href="/ui/tokens.css"><link rel="stylesheet" href="/ui/base.css">
<link rel="stylesheet" href="/ui/components.css">  <!-- icon／segmented／chips／status／empty／toast／dialog／drawer -->
<link rel="stylesheet" href="/ui/guide.css"><link rel="stylesheet" href="/ui/wizard.css">  <!-- 用到才載入 -->
```
```js
import { toast, confirm, createWizard, icon } from '/ui/index.js';   // 也可逐檔：'/ui/toast.js'
```
主題：預設跟隨系統；`document.documentElement.dataset.theme = 'light' | 'dark'` 強制切換。顏色一律用 token（`--accent --text --muted --border --surface --danger --ok`…），不要寫死色碼。
燈號 token：`--st-up --st-down --st-offline --st-unknown --st-disabled`。

## 基礎 class（base.css）
- 按鈕（只有三種 pill）：`.btn` 次要、`.btn.primary` 主要、`.btn.danger` 危險；`.btn.small`；`disabled` 屬性即停用。
- `.chip`（`aria-pressed="true"` 為選中）、`.input`（`.input.pill`、`select.input`、`textarea.input`）、`.card`、`.topbar`（sticky 頂欄，內放 `.brand`／`.grow`／`.tools`）。
- 欄位：`<label class="nc-field"><span class="nc-field-label">名稱</span><input class="input"><small class="nc-field-hint">提示</small></label>`
- `[hidden]` 一律隱藏；`.visually-hidden` 只給螢幕閱讀器。

## icons.js
`icon(name, {size=20, title?})` → `<svg>`（有 `title` 時 `role=img`，否則 `aria-hidden`）；`iconSvg(name, size)` → 字串；`iconNames`；`categoryIcons`；`navIcons`。未知名稱退回 `other`。
- 設備類別（對應 builtin categories）：`modem router mesh switch poe-switch ap nvr camera computer phone tv smart-home printer nas other`
- 主導覽：`overview topology floorplan inventory monitor status settings home import`（別名 `devices`=inventory、`cameras`=monitor、`gear`=settings）
- 通用：`plus close search check alert info chevron-left chevron-right chevron-down trash edit refresh filter menu wifi play sun moon link lock layers external`

## toast.js
`toast(message, {type:'info'|'ok'|'warn'|'error', duration})` → `{dismiss()}`。預設 3～6 秒，`duration:0` 不自動消失；同時最多 4 則；`error` 使用 `role=alert`。捷徑：`toast.success / .error / .warn / .info(message, opts)`。

## dialog.js（取代原生對話框）
`await confirm({title, message, danger=false, okText='確定', cancelText='取消'})` → `true|false`（Esc、點遮罩、取消皆為 false）。`danger:true` 用紅色按鈕且預設焦點在取消。
`await alert({title, message, okText})` → 關閉後 resolve。範例：`if (await confirm({title:'刪除設備？', danger:true, okText:'刪除'})) …`

## drawer.js（右側抽屜；≤820px 全螢幕）
`const d = createDrawer({title, content: Node, onClose})` → `{open(), close(), isOpen, setContent(node), setTitle(text), el}`。Esc／點遮罩／✕ 關閉，焦點回到開啟前的元素。

## segmented.js（膠囊分段，用於主導覽、分割數）
`const s = createSegmented({options:[{value,label,icon?:Node,disabled?}], value, onChange(v), ariaLabel, role:'radiogroup'|'tablist'})`
→ `{el, value, setValue(v, {silent=true}), destroy()}`。方向鍵／Home／End 移動並選取。`el` 放進頁面後才會量測圓塊位置；容器隱藏時顯示後呼叫一次 `setValue(s.value)` 重新量測。

## chips.js（篩選 chip，可多選）
`const c = createChips({options:[{value,label,count?}], value:[], multiple=true, allLabel?, onChange(values[]), ariaLabel})`
→ `{el, value（陣列）, setValue(arr), setOptions(options)}`。沒選任何項 = 不篩選；給 `allLabel`（如「全部」）會多一顆代表此狀態的 chip，點它清空選取。`multiple:false` 為單選。

## status-dot.js（燈號）
`createStatusDot({status, critical=false, showLabel=true})` → `<span class="nc-status">`，帶 `.update({status, critical})`。
`statusInfo(status, critical)` → `{state, label}`：`up`→綠「正常」；`down`＋`critical`→紅「離線警示」；`down`＋非關鍵→灰「離線」（`state:'offline'`）；`unknown`→黃「未知」；`disabled`→「未監控」。`showLabel:false` 時只顯示圓點（自動加 `aria-label`）。

## empty.js（空狀態卡）
`createEmpty({icon:'inventory', title, description?, actionLabel?, onAction?})` → `<div class="nc-empty">`；有 `actionLabel` 才出現主要按鈕。

## guide.js（全螢幕導覽）
```js
const g = createGuide({
  title: '開始使用', subtitle: '約 3 分鐘',
  steps: [{ label: '建立樓層', art: '<svg viewBox="0 0 480 300">…</svg>' /* 或 SVGElement */, body: node,
            onEnter(i) {}, canNext(i) { return true /* false 擋住；字串＝擋住並顯示該提示 */ } }],
  onClose({completed}) {},          // 最後一步按「完成」→ completed:true；中途離開 → false
});
g.open();   // → {el, open(), close()（不詢問）, goTo(i), next(), prev(), index}
```
步驟點列可點（往後跳會逐步檢查 `canNext`）；Esc／✕ 會先用 `confirm` 詢問；焦點被限制在導覽內；`prefers-reduced-motion` 時無動畫。
`art` 字串會被淨化（移除 `<script>`／`foreignObject`／`on*`／`style`／外部連結），所以 SVG 不能用行內 style；請用 class 上色：`sv-surface sv-soft sv-track sv-acc sv-ok sv-edge sv-line sv-ico sv-t(.m .w)`（見 guide.css 末段）。
`body` 內可用：`<ol class="nc-do"><li>…</li></ol>` 編號步驟、`<p class="nc-tip">` 提示框、`<code>`、`<kbd>`。

## wizard.js（精靈）
```js
const w = createWizard({
  title: '新增設備', initialState: { cat: 'router' },
  steps: [{ id: 'info', label: '基本資料',
            render(state) { return node; },                 // 每次進入該步都會重畫
            validate(state) { return state.name ? null : '請輸入名稱'; } }],   // 回傳字串＝擋住並顯示在步驟內
  async onSubmit(state) { await api.post(state); },        // 丟錯 → 顯示 error.message 並留在最後一步
  onCancel() {},
});
w.open();   // 以遮罩彈出；或 container.append(w.el) 內嵌。成功送出會自動 close()
```
`w` → `{el, state, index, open(), close(), goTo(i), next(), prev(), submit()→Promise<boolean>, refresh()}`。`state` 是共用物件，欄位自己寫入。往回不驗證；往後必須逐步通過；最後一步按鈕為「送出」；Esc／取消呼叫 `onCancel`。使用者修改任何欄位會清掉錯誤訊息。
附屬元件：
- `opGroup({options:[{value,label,hint?,disabled?}], value, onChange(v), ariaLabel})` → `{el, value, setValue(v)}`：`role=radiogroup`，左右／上下鍵切換（頭尾循環、略過停用項）。
- `box(title, node)` → 資訊框；`kv([['名稱','客廳 AP'],['IP','192.168.1.2']])` → 確認清單 `<dl>`（值可為字串或 Node，空值顯示「—」）。
- `field(state, {name,label,type='text'|'number'|'password'|'textarea'|'select',placeholder,hint,options,rows,required})` → 綁定 `state[name]` 的欄位（值一律為字串）。
- 步驟內排版可用 `.nc-stack`（垂直間距 16px）、`.nc-section-title`。

## 注意
- 不要對元件加 `style` 屬性或 `<style>`；要調整就寫在自己的 CSS 檔，用 token。
- 元件各自管理焦點與 Esc；同時開多層（精靈＋確認對話框）時，Esc 只會關最上層。
- 所有互動元件預設可鍵盤操作；自訂按鈕請用 `<button type="button">`。
