// 前端事件匯流排（EventTarget）。伺服器事件經 SSE（/api/events）轉發進來，斷線自動重連。

/** 伺服器透過 SSE 送出的事件（契約：contracts/events.md） */
export const SERVER_EVENTS = Object.freeze([
  'inventory.changed',
  'status.changed',
  'status.snapshot',
  'placement.changed',
  'plan.changed',
  'nvr.changed',
]);

const EVENT_SOURCE_CLOSED = 2;

export function createBus({ onError = (err) => console.error('bus 訂閱者發生錯誤', err) } = {}) {
  const target = new EventTarget();
  const wrappers = new Map(); // 事件名稱 -> Map(使用者的 fn -> 實際註冊的 wrapper)，off() 需要它

  let clearTimer = (t) => clearTimeout(t);
  let es = null;
  let timer = null;
  let attempt = 0;
  let closed = false;

  const bus = {
    /** 訂閱；回傳取消訂閱函式 */
    on(name, fn) {
      const wrapper = (e) => {
        try {
          fn(e.detail);
        } catch (err) {
          onError(err);
        }
      };
      if (!wrappers.has(name)) wrappers.set(name, new Map());
      wrappers.get(name).set(fn, wrapper);
      target.addEventListener(name, wrapper);
      return () => bus.off(name, fn);
    },
    off(name, fn) {
      const wrapper = wrappers.get(name)?.get(fn);
      if (!wrapper) return;
      target.removeEventListener(name, wrapper);
      wrappers.get(name).delete(fn);
    },
    emit(name, payload) {
      target.dispatchEvent(new CustomEvent(name, { detail: payload }));
    },

    /** 連線到 SSE；之後伺服器事件會以同名事件出現在 bus 上 */
    connectSse({
      url = '/api/events',
      EventSourceImpl = globalThis.EventSource,
      reconnectBaseMs = 1000,
      reconnectMaxMs = 15_000,
      setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
      clearTimeoutImpl = (t) => clearTimeout(t),
    } = {}) {
      closed = false;
      const open = () => {
        timer = null;
        es = new EventSourceImpl(url);
        es.onopen = () => {
          attempt = 0;
          bus.emit('sse.connected', {});
        };
        es.onerror = () => {
          bus.emit('sse.disconnected', {});
          // 瀏覽器會自己重連（CONNECTING）；已被關閉（HTTP 錯誤、401 等）才由我們退避重連
          if (es.readyState === EVENT_SOURCE_CLOSED && !closed) {
            es.close();
            const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt++);
            timer = setTimeoutImpl(open, delay);
          }
        };
        for (const name of SERVER_EVENTS) {
          es.addEventListener(name, (e) => {
            let payload;
            try {
              payload = JSON.parse(e.data);
            } catch {
              return;
            }
            bus.emit(name, payload);
          });
        }
      };
      clearTimer = clearTimeoutImpl; // close() 取消重連計時器時使用同一組函式
      open();
    },

    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      es?.close();
      es = null;
    },
  };
  return bus;
}
