# NetworkConnect

家用網路設備主控台。macOS／Windows 桌面 App，手機在家裡的 Wi-Fi 下也能用瀏覽器開啟。

- **設備登錄**：手動登錄數據機、路由器、交換器、基地台、攝影機等設備（樓層、房間、組別、IP／MAC、上游連線），也能從舊的 Google Sheet 匯出 CSV 一次匯入。
- **架構圖**：依上游關係自動畫出網路樹狀圖，可依樓層分群、匯出 PNG。
- **連線狀態**：定期偵測（ping／TCP／HTTP），連續 3 次失敗才判定離線；關鍵設備離線時發系統通知。
- **樓層平面圖**：上傳平面圖，把設備放在圖上（手機可雙指縮放，長按移除，點清單再點圖放置）。
- **NVR 監視畫面**：支援 Hikvision、Dahua、Uniview、Reolink 與自訂 RTSP，1／4／9／16 分割即時觀看。
- **首次導覽**：第一次開啟時有六步驟導覽，帶你建立樓層、房間與第一批設備。

所有資料都存在你自己的電腦，不會上傳到任何雲端。

## 電腦需求

這台電腦就是「伺服器」，手機只是用瀏覽器連過來看，所以：

- **要常開**：電腦關機或睡眠時，偵測與通知都會停止（桌面版提供「防止電腦閒置睡眠」選項）。
- **建議使用有線網路**：Wi-Fi 省電或斷線會造成誤判離線。
- macOS（Apple 晶片）或 Windows 10／11（64 位元）。

## 安裝

> 完整的圖解步驟請開啟 [`docs/install/index.html`](docs/install/index.html)（安裝教學頁，Mac 與 Windows 各一條路線）。要自己打包、修改程式，請看 [`desktop/README.md`](desktop/README.md)（開發與打包）。

安裝檔目前**沒有付費簽章**，第一次開啟系統會擋一次，照下面放行即可。

### macOS

1. 下載 `.dmg`，把 NetworkConnect 拖進「應用程式」。
2. 第一次開啟會被擋：到「系統設定 → 隱私權與安全性」，捲到最下面按「**強制打開**」（macOS 15 之後無法再用右鍵開啟）。
3. 如果顯示「已損毀，無法打開」，打開「終端機」執行：`xattr -cr /Applications/NetworkConnect.app`，再開一次。
4. 第一次偵測區網設備時，macOS 會詢問「區域網路」權限，請按**允許**；若按錯，到「系統設定 → 隱私權與安全性 → 區域網路」打開 NetworkConnect。拒絕時所有設備都會顯示離線。
5. 想用手機連線時，防火牆若詢問「是否允許傳入連線」，請按允許。

### Windows

1. 下載安裝程式（`.exe`）並執行。
2. 出現 SmartScreen「Windows 已保護您的電腦」時，按「**其他資訊 → 仍要執行**」。
3. 第一次啟動時 Windows 防火牆會詢問，請勾選「私人網路」並允許存取，手機才連得進來。
4. 關閉視窗不會結束程式，它會縮到系統匣繼續偵測；要結束請在系統匣圖示按右鍵選「結束 NetworkConnect」。

### 手機連線

電腦與手機要在**同一個 Wi-Fi／路由器**下。在電腦的選單列（Mac）或系統匣（Windows）圖示選「手機連線」，會顯示網址（例如 `http://192.168.1.10:8780`）與 QR Code，手機掃描或輸入網址即可。可以把網頁加到手機主畫面。

建議到「設定」設定**存取密碼**，尤其是有設定 NVR 時。

## NVR 提醒

- 請把 NVR 每個頻道的**子碼流編碼設為 H.264**。瀏覽器（特別是 Chrome）對 H.265 支援不穩，會黑畫面；設定精靈的測試步驟偵測到 H.265 會提醒你。
- 分割畫面一律使用子碼流，雙擊單一畫面才切換主碼流，避免 NVR 連線數與頻寬爆掉。
- 帳號密碼含特殊字元（`@ # : /`）也能使用，程式會自動編碼。

## 外出時查看

**不建議**在路由器開 port 對外公開。要在外面查看，請在家裡這台電腦與手機都安裝 [Tailscale](https://tailscale.com/) 之類的 VPN，連上後直接用電腦的 Tailscale 位址開啟（同樣建議設定存取密碼）。

## 備份

所有資料存在這台電腦的資料夾（桌面版為使用者資料夾下的 `NetworkConnect/data`）。定期備份的最簡單方式：「設定 → 前往匯入／匯出」匯出 JSON（內含平面圖；預設不含 NVR 密碼，要連密碼一起備份請勾選含密碼，並妥善保管檔案）。換電腦時安裝後在同一頁匯入即可還原。

## 開發者

需要 Node.js 24。

```
npm ci
npm start               # 無介面模式，預設 http://127.0.0.1:8780（資料放在 ./data）
npm run dev:mock        # 範例資料＋假偵測＋假 go2rtc（資料放在 ./data-mock，不碰 ./data）
npm test                # 單元與契約測試
npm run test:e2e        # 端到端測試（Playwright／Chromium，用 NC_CHROMIUM_PATH 指定瀏覽器）
npm run desktop         # 用 Electron 開桌面版
```

| 文件 | 內容 |
|---|---|
| [docs/specs/2026-10-14-networkconnect-design.md](docs/specs/2026-10-14-networkconnect-design.md) | 架構設計規格（技術選型、模組隔離、契約、資料模型、各功能規格） |
| [docs/plans/2026-10-14-networkconnect-plan.md](docs/plans/2026-10-14-networkconnect-plan.md) | 開發計畫（階段、閘門、agent 分工） |
| [docs/agents/](docs/agents/) | 各 agent 任務書 |
| [docs/manual-checklist.md](docs/manual-checklist.md) | 需要在家用真實設備驗證的清單 |
| [docs/install/index.html](docs/install/index.html) | 安裝教學頁 |
| [desktop/README.md](desktop/README.md) | 桌面 App 的開發與打包 |
