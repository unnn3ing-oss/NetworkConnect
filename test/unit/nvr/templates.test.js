// nvr 模板與 URL 組裝：四個品牌 × 主／子碼流、帳密編碼、串流名稱。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFixture } from '../../../contracts/index.js';
import {
  buildStreamUrl, buildUrl, getTemplate, isRtspTemplate, isValidHost, loadTemplates, parseStreamName, redactUrls, streamName,
} from '../../../server/modules/nvr/templates.js';

const base = { u: 'admin', p: 'secret', host: '192.168.1.20', port: 554 };

describe('buildUrl：四個品牌 × 主／子碼流', () => {
  const cases = [
    { brand: 'hikvision', ch: 1, main: 'rtsp://admin:secret@192.168.1.20:554/Streaming/Channels/101', sub: 'rtsp://admin:secret@192.168.1.20:554/Streaming/Channels/102' },
    { brand: 'hikvision', ch: 12, main: 'rtsp://admin:secret@192.168.1.20:554/Streaming/Channels/1201', sub: 'rtsp://admin:secret@192.168.1.20:554/Streaming/Channels/1202' },
    { brand: 'dahua', ch: 3, main: 'rtsp://admin:secret@192.168.1.20:554/cam/realmonitor?channel=3&subtype=0', sub: 'rtsp://admin:secret@192.168.1.20:554/cam/realmonitor?channel=3&subtype=1' },
    { brand: 'uniview', ch: 2, main: 'rtsp://admin:secret@192.168.1.20:554/unicast/c2/s0/live', sub: 'rtsp://admin:secret@192.168.1.20:554/unicast/c2/s1/live' },
    { brand: 'reolink', ch: 1, main: 'rtsp://admin:secret@192.168.1.20:554/h264Preview_01_main', sub: 'rtsp://admin:secret@192.168.1.20:554/h264Preview_01_sub' },
    { brand: 'reolink', ch: 11, main: 'rtsp://admin:secret@192.168.1.20:554/h264Preview_11_main', sub: 'rtsp://admin:secret@192.168.1.20:554/h264Preview_11_sub' },
  ];
  for (const c of cases) {
    test(`${c.brand} 頻道 ${c.ch}`, () => {
      const tpl = getTemplate(c.brand);
      assert.equal(buildUrl(tpl, { ...base, ch: c.ch, stream: tpl.streamMain }), c.main);
      assert.equal(buildUrl(tpl, { ...base, ch: c.ch, stream: tpl.streamSub }), c.sub);
    });
  }

  test('模板清單與契約 fixture 一致，且涵蓋四個品牌＋自訂', () => {
    assert.deepEqual(loadTemplates(), readFixture('nvr-templates.json'));
    assert.deepEqual(loadTemplates().map((t) => t.id), ['hikvision', 'dahua', 'uniview', 'reolink', 'custom']);
  });

  test('{ch:02} 補零；可傳字串模板', () => {
    assert.equal(buildUrl('rtsp://h/{ch:02}/{ch}/{s}', { ...base, ch: 7, stream: 'sub' }), 'rtsp://h/07/7/sub');
    assert.equal(buildUrl('rtsp://h/{ch:03}', { ...base, ch: 7, stream: 'x' }), 'rtsp://h/007');
  });

  test('自訂品牌沒有 urlTemplate 時丟錯', () => {
    assert.throws(() => buildUrl(getTemplate('custom'), { ...base, ch: 1, stream: '0' }), /自訂/);
  });
});

describe('帳密編碼', () => {
  test('帳密含 @ # : / 空白 時一律 encodeURIComponent', () => {
    const url = buildUrl(getTemplate('hikvision'), { u: 'ad min@x', p: 'p@ss:w/rd#1 ?', host: '10.0.0.1', port: 554, ch: 1, stream: '2' });
    assert.equal(url, 'rtsp://ad%20min%40x:p%40ss%3Aw%2Frd%231%20%3F@10.0.0.1:554/Streaming/Channels/102');
    const parsed = new URL(url);
    assert.equal(decodeURIComponent(parsed.username), 'ad min@x');
    assert.equal(decodeURIComponent(parsed.password), 'p@ss:w/rd#1 ?');
    assert.equal(parsed.host, '10.0.0.1:554');
  });

  test('buildStreamUrl：用 NVR 紀錄的 streamMain／streamSub 與密碼', () => {
    const nvr = { brand: 'dahua', host: 'nvr.local', port: 8554, username: 'a@b', streamMain: '0', streamSub: '1', urlTemplate: null };
    assert.equal(buildStreamUrl(nvr, 'p:q', 4, 'sub'), 'rtsp://a%40b:p%3Aq@nvr.local:8554/cam/realmonitor?channel=4&subtype=1');
    assert.equal(buildStreamUrl(nvr, 'p:q', 4, 'main'), 'rtsp://a%40b:p%3Aq@nvr.local:8554/cam/realmonitor?channel=4&subtype=0');
  });

  test('自訂範本：只允許 rtsp:// 開頭（不可變成 exec: 等 go2rtc 來源）', () => {
    const nvr = { brand: 'custom', host: 'h', port: 554, username: 'u', streamMain: '0', streamSub: '1', urlTemplate: 'exec:ffmpeg -i x' };
    assert.throws(() => buildStreamUrl(nvr, 'p', 1, 'sub'), /rtsp/);
    assert.equal(isRtspTemplate('rtsp://{u}:{p}@{host}:{port}/{ch}'), true);
    assert.equal(isRtspTemplate('RTSPS://x'), true);
    assert.equal(isRtspTemplate('http://x'), false);
    assert.equal(isRtspTemplate('exec:foo'), false);
  });

  test('IPv6 主機自動加方括號', () => {
    assert.equal(buildUrl('rtsp://{host}:{port}/x', { host: 'fe80::1', port: 554, ch: 1, stream: '0' }), 'rtsp://[fe80::1]:554/x');
  });

  test('isValidHost', () => {
    for (const ok of ['192.168.1.20', 'nvr.local', 'my-nvr', 'fe80::1', '[::1]']) assert.equal(isValidHost(ok), true, ok);
    for (const bad of ['', 'a b', 'h/x', 'h?x', 'h#x', 'u@h', 'h:554/x', '-x']) assert.equal(isValidHost(bad), false, bad);
  });

  test('redactUrls 遮掉 RTSP 帳密', () => {
    assert.equal(redactUrls('dial rtsp://admin:pw%40@10.0.0.1:554/x failed'), 'dial rtsp://***@10.0.0.1:554/x failed');
  });
});

describe('串流名稱', () => {
  test('streamName／parseStreamName 互逆（id 本身含 nvr_ 前綴與底線）', () => {
    for (const id of ['nvr_main', 'nvr_V1StGXR8_Z', 'nvr_a-b']) {
      for (const kind of ['main', 'sub']) {
        const name = streamName(id, 7, kind);
        assert.equal(name, `nvr_${id}_7_${kind}`);
        assert.deepEqual(parseStreamName(name), { nvrId: id, ch: 7, kind });
      }
    }
  });

  test('不合格式的名稱一律 null', () => {
    for (const bad of ['', undefined, 'nvr_main_1_sub', 'nvr_nvr_main_x_sub', 'nvr_nvr_main_1_other', 'rtsp://x', '../x', 'nvr_nvr_main_1_sub/../..', 'camera1']) {
      assert.equal(parseStreamName(bad), null, String(bad));
    }
  });
});
