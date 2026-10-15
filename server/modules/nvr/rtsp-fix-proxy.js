// RTSP 相容代理：go2rtc ⇄ 本機代理 ⇄ NVR。只修正 DESCRIBE 回應的 SDP，其餘位元組原樣轉送。
//
// 為什麼需要：部分 NVR（實測回報：昇銳 HiSharp）把影像、聲音軌標成 a=sendonly。
// go2rtc 依字面把 sendonly 當成「要送給攝影機的對講軌」，於是沒有任何可播放的軌，
// 錯誤為「streams: codecs not matched:  => video:H264, …」（箭頭左邊是空的）。
// go2rtc 1.9.14 只對 SDP origin 為 CV-RTSPHandler 的攝影機強制修正（pkg/rtsp/helpers.go），沒有設定可以開啟。
//
// 修正方式：拿掉 a=sendonly／a=sendrecv，go2rtc 會把沒有方向的軌當成一般影像來源。
// go2rtc 預設會要求 ONVIF 對講軌（Require: www.onvif.org/ver20/backchannel），那時 sendonly 才是真的對講軌；
// 本 App 沒有對講功能，所以經由代理的來源一律加上 #backchannel=0（go2rtc 的來源參數），代理也只在沒有要求對講時修改。
import net from 'node:net';

const BACKCHANNEL = 'www.onvif.org/ver20/backchannel';
const MAX_HEADER = 64 * 1024;
const MAX_BODY = 256 * 1024;

/** 拿掉 SDP 的 a=sendonly／a=sendrecv 行 */
export function fixSdpDirections(sdp) {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !/^a=(sendonly|sendrecv)\s*$/i.test(line))
    .join('\r\n');
}

/**
 * 解析 RTSP 網址的 NVR 位址，並提供「換成本機代理埠」的網址；回傳 null 表示不適用（rtsps 加密連線、網址無法解析）。
 * 帳密與路徑原樣保留，並加上 #backchannel=0（不要求對講軌，見檔案開頭說明）。
 * @returns {{target: {host: string, port: number}, build: (proxyPort: number) => string} | null}
 */
export function routeThroughProxy(url) {
  const m = /^rtsp:\/\/([^/?#]*@)?(\[[^\]]+\]|[^/:?#@]+)(?::(\d+))?(.*)$/i.exec(url);
  if (!m) return null;
  const host = m[2].replace(/^\[|\]$/g, '');
  const port = m[3] ? Number(m[3]) : 554;
  if (!host || port < 1 || port > 65535) return null;
  return { target: { host, port }, build: (proxyPort) => `rtsp://${m[1] ?? ''}127.0.0.1:${proxyPort}${m[4]}#backchannel=0` };
}

/**
 * 處理 NVR → go2rtc 方向：逐一解析 RTSP 回應並修正 SDP；遇到 '$'（RTP over TCP）後改為原樣轉送。
 * @param {(chunk: Buffer) => void} write
 * @param {() => boolean} shouldFix
 */
export function createResponseRewriter(write, shouldFix) {
  let buf = Buffer.alloc(0);
  let raw = false;
  return (chunk) => {
    if (raw) return write(chunk);
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!buf.length) return;
      if (buf[0] === 0x24) {
        // 開始收影像資料：之後不再解析
        raw = true;
        write(buf);
        buf = Buffer.alloc(0);
        return;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEADER) return giveUp();
        return;
      }
      const head = buf.subarray(0, end).toString('latin1');
      const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      if (len > MAX_BODY) return giveUp();
      const total = end + 4 + len;
      if (buf.length < total) return;
      const body = buf.subarray(end + 4, total);
      const rest = buf.subarray(total);
      if (len && /\r\ncontent-type:\s*application\/sdp/i.test(head) && shouldFix()) {
        const fixed = Buffer.from(fixSdpDirections(body.toString('utf8')), 'utf8');
        const newHead = head.replace(/(\r\ncontent-length:\s*)\d+/i, `$1${fixed.length}`);
        write(Buffer.concat([Buffer.from(`${newHead}\r\n\r\n`, 'latin1'), fixed]));
      } else {
        write(buf.subarray(0, total));
      }
      buf = rest;
    }
  };

  function giveUp() {
    // 看不懂的內容：不再解析，原樣轉送
    raw = true;
    write(buf);
    buf = Buffer.alloc(0);
  }
}

/**
 * 每個 NVR 位址（host:port）一個只聽 127.0.0.1 的代理埠。
 * @param {{log?: object, connectTimeoutMs?: number}} [opts]
 */
export function createRtspFixProxy({ log, connectTimeoutMs = 8000 } = {}) {
  const servers = new Map(); // key → Promise<{server, port}>
  const sockets = new Set();

  function track(s) {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  }

  function handle(client, target) {
    track(client);
    client.pause();
    const upstream = net.connect({ host: target.host, port: target.port });
    track(upstream);
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('連線逾時')));
    let backchannel = false;
    const rewrite = createResponseRewriter((b) => client.write(b), () => !backchannel);

    upstream.on('connect', () => {
      upstream.setTimeout(0);
      client.resume();
    });
    client.on('data', (d) => {
      if (!backchannel && d.includes(BACKCHANNEL)) backchannel = true;
      upstream.write(d);
    });
    upstream.on('data', rewrite);
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    const fail = (err) => {
      if (err) log?.debug?.(`RTSP 相容代理 ${target.host}:${target.port}：${err.message}`);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', fail);
    upstream.on('error', fail);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  }

  return {
    /** 取得某個 NVR 位址對應的本機代理埠（第一次呼叫時建立） */
    portFor(target) {
      const key = `${target.host}|${target.port}`;
      if (!servers.has(key)) {
        const p = new Promise((resolve, reject) => {
          const server = net.createServer((c) => handle(c, target));
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
        });
        p.catch(() => servers.delete(key));
        servers.set(key, p);
      }
      return servers.get(key).then((s) => s.port);
    },

    async close() {
      const all = await Promise.allSettled([...servers.values()]);
      servers.clear();
      for (const s of sockets) s.destroy();
      await Promise.all(all.filter((r) => r.status === 'fulfilled').map(({ value }) => new Promise((r) => value.server.close(() => r()))));
    },
  };
}
