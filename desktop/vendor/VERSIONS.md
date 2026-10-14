# desktop/vendor — 鎖版本的第三方檔

| 檔案 | 套件 | 版本 | 授權 | 來源 | 用途 |
|---|---|---|---|---|---|
| `qrcode-generator.mjs` | [qrcode-generator](https://www.npmjs.com/package/qrcode-generator)（Kazuhiko Arase） | 2.0.4 | MIT（檔頭附授權聲明） | npm tarball 內的 `dist/qrcode.mjs`，未修改 | 「手機連線」視窗的 QR Code |

- 檔案 sha256：`ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`
- npm tarball integrity：`sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`
- 更新方式：`npm pack qrcode-generator@<新版本>`，取出 `package/dist/qrcode.mjs` 覆蓋，同步更新本表與 sha256，並重跑 `npm test`。
- 只在主行程使用（產生 SVG 字串），不會載入到 App 視窗或手機瀏覽器。
