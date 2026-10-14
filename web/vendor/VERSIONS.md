# 第三方前端檔版本紀錄

只能整檔替換並同步更新此表；不得手改 vendored 檔案內容。

| 檔案 | 版本 | 來源 URL | sha256 |
|---|---|---|---|
| `cytoscape.min.js` | 3.34.3 | https://registry.npmjs.org/cytoscape/-/cytoscape-3.34.3.tgz（`package/dist/cytoscape.min.js`） | `5f3b5b529546d5af1fc5628590af033b74511a5b6f789f5f4682845863228b91` |
| `video-rtc.js` | go2rtc v1.9.14（＝`package.json` 的 `config.go2rtcVersion`） | https://raw.githubusercontent.com/AlexxIT/go2rtc/v1.9.14/www/video-rtc.js | `d48ce627baf7c341a92c0f5844a3c546431f9db873ff21489671aba2ecfe64fb` |
| `video-stream.js` | go2rtc v1.9.14 | https://raw.githubusercontent.com/AlexxIT/go2rtc/v1.9.14/www/video-stream.js | `86b4b69001242c3c71f9aedceabff06a6bc58155d8a0fe27970834aefc670b16` |

前端路徑：`/vendor/<檔名>`。

## 給 B5（cameras）的注意

- `video-stream.js` 的 `oninit()` 會用 `innerHTML` 塞入 `<style>`，會被 CSP `style-src 'self'` 擋掉（不影響播放，但 `video-stream { position: relative }` 與資訊列樣式會失效）。建議直接繼承 `video-rtc.js` 的 `VideoRTC` 自訂元件，樣式寫在 CSS 檔。
- 兩個檔案內有 `this.video.style.xxx = ...`（CSSOM 賦值），不受 CSP 影響。
- 版本升級：同時改 `package.json` 的 `config.go2rtcVersion`、本表、以及重新下載兩個檔案，並更新 sha256。
