// 播放器：繼承 vendored 的 VideoRTC（/vendor/video-rtc.js），不直接用 video-stream 元件。
// 原因：video-stream 的 oninit() 用 innerHTML 塞 <style>，會被 CSP style-src 'self' 擋掉（見 web/vendor/VERSIONS.md），
// 而且它的資訊列文字不符合本頁的狀態顯示。連線、MSE、回退邏輯全部沿用 VideoRTC。
//
// 與預設的差異：
//  - mode 不含 webrtc／hls：伺服器只代理 WebSocket（/api/nvr/ws），go2rtc 的 WebRTC 與 HTTP 都不對外。
//    沒有 MSE 的瀏覽器（iPhone Safari 16 以前）會依 VideoRTC 的順序回退到 mp4（走同一條 WebSocket），最後 mjpeg。
//  - background=true：不註冊 VideoRTC 對 document 的 visibilitychange 監聽（它不會移除，會洩漏），
//    由本頁的 viewer 統一在分頁隱藏時關閉全部串流。
//  - 只要求影像（media='video'），畫面牆不需要聲音，省頻寬與 CPU。
import { VideoRTC } from '/vendor/video-rtc.js';

const TAG = 'nc-video';

export class NcVideo extends VideoRTC {
  constructor() {
    super();
    this.mode = 'mse,mp4,mjpeg';
    this.media = 'video';
    this.background = true;
    this.visibilityCheck = false;
    /** @type {((state: 'connecting'|'live'|'error', detail?: string) => void)|null} */
    this.onstate = null;
    this.stopped = false;
    /** 重連也不會成功的錯誤（串流不存在、瀏覽器不支援編碼）：不自動重連，等使用者按重試 */
    this.fatal = false;
  }

  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
    this.video.disablePictureInPicture = true;
  }

  emit(state, detail) {
    if (this.stopped) return;
    try {
      this.onstate?.(state, detail);
    } catch (err) {
      console.error('player 狀態回呼發生錯誤', err);
    }
  }

  onconnect() {
    const started = super.onconnect();
    if (!started) return started;
    this.emit('connecting');
    const ws = this.ws;
    let gotData = false;
    this.fatal = false;
    ws.addEventListener('message', (ev) => {
      if (this.fatal) return;
      if (typeof ev.data !== 'string') {
        if (!gotData) {
          gotData = true;
          this.emit('live');
        }
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'error') this.emit('error', String(msg.value ?? ''));
      } catch {
        // 不是 JSON 的文字訊息：忽略
      }
    });
    ws.addEventListener('close', (ev) => {
      if (this.stopped) return;
      if (ev.code === 4404) {
        // 伺服器說找不到這個串流：重連沒有意義
        this.fatal = true;
        this.emit('error', '找不到這個頻道的串流（請確認 NVR 設定）');
      }
      if (this.fatal) {
        clearTimeout(this.reconnectTID);
        this.reconnectTID = 0;
      } else {
        this.emit('error', gotData ? '連線中斷，重新連線中…' : '連不上串流，稍後自動重試');
      }
    });
    return started;
  }

  /**
   * VideoRTC 的 MSE 處理在瀏覽器不支援該編碼時（例：沒有 H.265 解碼器）會在 addSourceBuffer 丟出未處理的例外，
   * 之後的影像資料又因為 ondata 沒設定而再丟一次。這裡接住它，改成在格子上顯示說明。
   */
  onmse() {
    super.onmse();
    const handler = this.onmessage.mse;
    this.onmessage.mse = (msg) => {
      try {
        handler(msg);
      } catch (err) {
        console.warn('[nc-video] 瀏覽器無法播放此影像編碼：', msg?.value, err?.message);
        this.fatal = true;
        this.ondata = () => {};
        this.emit('error', '這個瀏覽器無法播放此影像編碼。請到 NVR 把子碼流改成 H.264。');
        this.ws?.close();
      }
    };
  }

  /** 立刻重連（使用者按「重試」）。 */
  retry() {
    if (this.stopped) return;
    this.fatal = false;
    this.emit('connecting');
    if (this.ws) {
      // 還連著（或連線中）：關掉它，讓 VideoRTC 自己的 onclose 重連；connectTS=0 代表「不必再等」
      this.connectTS = 0;
      this.ws.close();
    } else {
      clearTimeout(this.reconnectTID);
      this.reconnectTID = 0;
      this.onconnect();
    }
  }

  /** 結束串流並移出 DOM。呼叫後這個元件不可再使用。 */
  stop() {
    this.stopped = true;
    this.onstate = null;
    clearTimeout(this.reconnectTID);
    clearTimeout(this.disconnectTID);
    this.reconnectTID = 0;
    this.disconnectTID = 0;
    // 不呼叫 VideoRTC.ondisconnect()：它把 video.src 設成空字串，瀏覽器會因此觸發 error 事件，
    // 而 VideoRTC 會把它當成播放錯誤印到 console。這裡改成移除屬性再 load()，不會觸發 error。
    this.wsState = WebSocket.CLOSED;
    this.pcState = WebSocket.CLOSED;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pc) {
      for (const sender of this.pc.getSenders()) sender.track?.stop();
      this.pc.close();
      this.pc = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.srcObject = null;
      this.video.load();
    }
    this.remove();
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, NcVideo);

/**
 * 建立一個播放器。
 * @param {string} path  例：/api/nvr/ws?stream=nvr_nvr_main_1_sub
 * @param {(state: string, detail?: string) => void} onState
 * @returns {NcVideo} 尚未放進 DOM；請先 append 再呼叫 play()
 */
export function createPlayer(onState) {
  const el = document.createElement(TAG);
  el.onstate = onState;
  el.className = 'cam-player';
  return el;
}

/** 放進 DOM 之後再指定來源才會連線 */
export function connectPlayer(el, path) {
  el.src = path; // VideoRTC 的 setter：相對路徑會補成 ws(s)://host，並呼叫 onconnect()
}

/** 從 <video> 擷取一張縮圖（JPEG data URL）；還沒有畫面時回傳空字串 */
export function captureThumbnail(el, { maxWidth = 320, quality = 0.7 } = {}) {
  const video = el?.video;
  if (!video || !video.videoWidth || !video.videoHeight) return '';
  try {
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return '';
  }
}
