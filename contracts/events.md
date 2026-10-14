# 事件契約

> 來源：規格 §6.2。後端事件經 `GET /api/events`（SSE）送到前端，前端 shell 把同名事件轉發進 `bus`。
> payload schema：`contracts/schemas/events.schema.json`，`$defs` 名稱是事件名稱把「.」換成「_」（例：`status.changed` → `status_changed`）。

## SSE 格式

```
event: status.changed
data: {"deviceId":"dev_router","from":"up","to":"down","rttMs":null,"at":"2026-10-14T08:30:00.000Z"}

: ping
```

- `data` 一律是單行 JSON（payload 物件）。
- 每 25 秒送一行註解心跳（`: ping`），避免 proxy／瀏覽器判定閒置。
- 連線建立時先送一次 `status.snapshot`（由 monitor 負責）。
- 前端斷線會自動重連（指數退避，上限 15 秒）；重連成功會再收到一次 `status.snapshot`，各模組以它重建狀態。

## 事件清單

| 事件 | payload | 發出者 | 說明 |
|---|---|---|---|
| `inventory.changed` | `{collection: 'floors'\|'rooms'\|'groups'\|'categories'\|'devices', op: 'create'\|'update'\|'delete', id}` | inventory | 每筆異動一則；整批匯入（`store.restore`）時為 `id:"*"`、`op:"update"`，每個 collection 各一則 |
| `status.changed` | `{deviceId, from, to, rttMs, at}` | monitor | 狀態值改變時才發（`from !== to`）；`from`／`to` 為 `up\|down\|unknown\|disabled` |
| `status.snapshot` | `{items: StatusItem[]}` | monitor | SSE 連線建立時送一次；`items` 同 `GET /api/status` |
| `placement.changed` | `{deviceId, floorId}` | floorplan | 新增、移動、移除落點 |
| `plan.changed` | `{floorId}` | floorplan | 上傳、取代、刪除平面圖；整批匯入時各樓層各一則 |
| `nvr.changed` | `{id}` | nvr | NVR 或其頻道設定異動；整批匯入為 `id:"*"` |
| `device.open` | `{id}` | 任何前端模組 | **前端限定**。請 devices 模組開啟該設備的抽屜 |
| `filters.changed` | `{floorId, roomId, groupId, categoryId, q}` | shell | **前端限定**。全站篩選狀態改變（空字串＝未篩選） |
| `sse.connected` / `sse.disconnected` | `{}` | shell | **前端限定**。事件串流連線狀態，頂欄燈號使用 |

## 前端 bus 介面

```js
const off = ctx.bus.on('status.changed', (payload) => {});  // 回傳取消訂閱函式
ctx.bus.emit('device.open', { id });
ctx.bus.off('status.changed', handler);
```

模組的 `unmount()` 必須呼叫所有 `off()`。

## 桌面 App（utilityProcess）

`process.parentPort` 存在時，伺服器另把 `status.changed` 轉送給主行程：`{type:'event', name:'status.changed', payload}`；啟動完成送 `{type:'ready', port}`；收到 `{type:'shutdown'}` 時停止所有模組並結束行程。
