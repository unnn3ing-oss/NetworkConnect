// RTSP 相容代理：SDP 修正、網址改寫、回應解析（分段到達、影像資料原樣轉送），以及實際 TCP 代理。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createResponseRewriter, createRtspFixProxy, fixSdpDirections, routeThroughProxy } from '../../../server/modules/nvr/rtsp-fix-proxy.js';

const SDP = 'v=0\r\no=- 0 0 IN IP4 10.0.0.5\r\ns=x\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\na=sendonly\r\na=control:track1\r\nm=audio 0 RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\na=sendrecv\r\na=control:track2\r\n';
const describeResponse = (sdp, cseq = 2) => `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`;

describe('fixSdpDirections／routeThroughProxy', () => {
  test('拿掉 sendonly／sendrecv，其他行不動', () => {
    const out = fixSdpDirections(SDP);
    assert.doesNotMatch(out, /sendonly|sendrecv/);
    assert.match(out, /a=rtpmap:96 H265\/90000\r\na=control:track1/);
    assert.equal(fixSdpDirections('v=0\r\na=recvonly\r\n'), 'v=0\r\na=recvonly\r\n');
  });

  test('改寫主機與埠，帳密（含編碼字元）與路徑保留；預設埠 554；rtsps 與壞網址不適用', () => {
    const r = routeThroughProxy('rtsp://admin:p%40ss@192.168.1.20:8554/chID=1&streamType=main&linkType=tcp');
    assert.deepEqual(r.target, { host: '192.168.1.20', port: 8554 });
    assert.equal(r.build(40000), 'rtsp://admin:p%40ss@127.0.0.1:40000/chID=1&streamType=main&linkType=tcp#backchannel=0');
    assert.deepEqual(routeThroughProxy('rtsp://nvr.local/live').target, { host: 'nvr.local', port: 554 });
    assert.equal(routeThroughProxy('rtsp://nvr.local/live').build(1), 'rtsp://127.0.0.1:1/live#backchannel=0');
    assert.deepEqual(routeThroughProxy('rtsp://[fe80::1]:554/a').target, { host: 'fe80::1', port: 554 });
    assert.equal(routeThroughProxy('rtsps://10.0.0.5/x'), null);
    assert.equal(routeThroughProxy('http://10.0.0.5/x'), null);
  });
});

describe('createResponseRewriter', () => {
  const run = (chunks, shouldFix = () => true) => {
    const out = [];
    const feed = createResponseRewriter((b) => out.push(Buffer.from(b)), shouldFix);
    for (const c of chunks) feed(Buffer.from(c, 'latin1'));
    return Buffer.concat(out).toString('latin1');
  };

  test('DESCRIBE 回應的 SDP 被修正，Content-Length 跟著更新；其他回應原樣', () => {
    const options = 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: DESCRIBE\r\n\r\n';
    const out = run([options + describeResponse(SDP)]);
    const fixed = fixSdpDirections(SDP);
    assert.equal(out, options + describeResponse(fixed));
  });

  test('一個位元組一個位元組到達也一樣；收到 $ 影像資料後原樣轉送（即使內容看起來像 SDP）', () => {
    const rtp = '$\x00\x00\x04abcd' + describeResponse(SDP);
    const all = describeResponse(SDP) + 'RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n' + rtp;
    const out = run([...all]);
    assert.equal(out, describeResponse(fixSdpDirections(SDP)) + 'RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n' + rtp);
  });

  test('shouldFix 為 false（要求 ONVIF 對講）時不修改', () => {
    assert.equal(run([describeResponse(SDP)], () => false), describeResponse(SDP));
  });
});

describe('createRtspFixProxy（實際 TCP）', () => {
  const proxy = createRtspFixProxy();
  const closers = [];
  after(async () => {
    await proxy.close();
    for (const c of closers) await c();
  });

  /** 假 NVR：收到 DESCRIBE 回 SDP（帶 sendonly），收到 PLAY 回 200 並送出一段 RTP；記錄收到的請求 */
  async function fakeNvr() {
    const requests = [];
    const server = net.createServer((s) => {
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString('latin1');
        let i;
        while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
          const req = buf.slice(0, i);
          buf = buf.slice(i + 4);
          requests.push(req);
          const cseq = /CSeq: (\d+)/.exec(req)[1];
          if (req.startsWith('DESCRIBE')) s.write(describeResponse(SDP, cseq));
          else if (req.startsWith('PLAY')) s.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n$\x00\x00\x03xyz`);
        }
      });
      s.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => server.close(r)));
    return { port: server.address().port, requests };
  }

  function talk(port, messages, expectEnding) {
    return new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      let got = '';
      c.on('connect', () => c.write(messages));
      c.on('data', (d) => {
        got += d.toString('latin1');
        if (got.endsWith(expectEnding)) {
          c.destroy();
          resolve(got);
        }
      });
      c.on('error', reject);
    });
  }

  test('go2rtc → 代理 → NVR：請求原樣送達，SDP 被修正，影像資料原樣回來', async () => {
    const nvr = await fakeNvr();
    const port = await proxy.portFor({ host: '127.0.0.1', port: nvr.port });
    assert.equal(await proxy.portFor({ host: '127.0.0.1', port: nvr.port }), port, '同一個 NVR 共用一個代理埠');
    const describe = `DESCRIBE rtsp://127.0.0.1:${port}/chID=1&streamType=sub RTSP/1.0\r\nCSeq: 2\r\nAuthorization: Digest username="admin", uri="rtsp://127.0.0.1:${port}/chID=1&streamType=sub"\r\n\r\n`;
    const play = `PLAY rtsp://127.0.0.1:${port}/chID=1&streamType=sub RTSP/1.0\r\nCSeq: 3\r\n\r\n`;
    const got = await talk(port, describe + play, 'xyz');
    assert.equal(got, describeResponse(fixSdpDirections(SDP), 2) + 'RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n$\x00\x00\x03xyz');
    assert.equal(nvr.requests[0] + '\r\n\r\n', describe, '請求（含 Digest 驗證）必須原樣轉送');
  });

  test('用戶端要求 ONVIF 對講時不修改 SDP', async () => {
    const nvr = await fakeNvr();
    const port = await proxy.portFor({ host: '127.0.0.1', port: nvr.port });
    const describe = `DESCRIBE rtsp://127.0.0.1:${port}/a RTSP/1.0\r\nCSeq: 2\r\nRequire: www.onvif.org/ver20/backchannel\r\n\r\n`;
    const got = await talk(port, describe, 'control:track2\r\n');
    assert.equal(got, describeResponse(SDP, 2));
  });

  test('NVR 連不上：代理關閉連線，不會卡住', async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const deadPort = s.address().port;
    await new Promise((r) => s.close(r));
    const port = await proxy.portFor({ host: '127.0.0.1', port: deadPort });
    await new Promise((resolve) => {
      const c = net.connect({ host: '127.0.0.1', port }, () => c.write('OPTIONS rtsp://x RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
      c.on('close', resolve);
      c.on('error', () => {});
    });
  });
});
