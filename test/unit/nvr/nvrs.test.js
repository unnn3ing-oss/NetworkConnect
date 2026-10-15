// nvrs 服務：錯誤訊息（連不到主機／帳密錯誤／逾時）、頻道補齊，與注入假 client 時 test() 的行為。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createNvrService, describeProbeFailure, normalizeChannels } from '../../../server/modules/nvr/nvrs.js';
import { upstream } from '../../../server/core/errors.js';

const nvr = { id: 'nvr_t', host: '10.0.0.5', port: 554 };

describe('describeProbeFailure', () => {
  test('三種失敗原因的文字各不相同，且帶有可行動的建議', () => {
    const auth = describeProbeFailure({ reason: 'auth', error: 'x' }, nvr);
    const unreachable = describeProbeFailure({ reason: 'unreachable', error: 'x' }, nvr);
    const timeout = describeProbeFailure({ reason: 'timeout', error: 'x' }, nvr);
    assert.match(auth, /帳號或密碼錯誤.*401/);
    assert.match(unreachable, /連不到主機 10\.0\.0\.5:554/);
    assert.match(timeout, /逾時.*8 秒/);
    assert.equal(new Set([auth, unreachable, timeout]).size, 3);
  });

  test('其他錯誤附上 go2rtc 的訊息（帳密已遮蔽）', () => {
    const msg = describeProbeFailure({ reason: 'error', error: 'bad rtsp://admin:pw@10.0.0.5/x' }, nvr);
    assert.match(msg, /無法取得影像/);
    assert.doesNotMatch(msg, /pw@/);
  });
});

describe('normalizeChannels', () => {
  test('補到 N 個、保留既有設定、移除超過 N 的', () => {
    const existing = [{ ch: 1, name: '前門', deviceId: 'dev_a', enabled: false }, { ch: 5, name: '多的', deviceId: null, enabled: true }];
    assert.deepEqual(normalizeChannels(existing, 3), [
      { ch: 1, name: '前門', deviceId: 'dev_a', enabled: false },
      { ch: 2, name: '頻道 2', deviceId: null, enabled: true },
      { ch: 3, name: '頻道 3', deviceId: null, enabled: true },
    ]);
    assert.equal(normalizeChannels(undefined, 2).length, 2);
  });
});

describe('test()（注入假 client）', () => {
  function make(client) {
    const record = { id: 'nvr_t', brand: 'hikvision', host: '10.0.0.5', port: 554, username: 'a', streamMain: '1', streamSub: '2', urlTemplate: null, channels: [{ ch: 1, name: '', deviceId: null, enabled: true }] };
    const ctx = {
      config: { go2rtcPath: null },
      secrets: { get: () => 'pw', has: () => true },
      events: { emit() {} },
      store: { collection: () => ({ get: async (id) => (id === 'nvr_t' ? record : undefined), list: async () => [record] }) },
    };
    return createNvrService({ ctx, client });
  }

  test('probe 逾時 → ok:false 並說明逾時', async () => {
    const svc = make({ upsertStream: async () => {}, probe: async () => ({ ok: false, reason: 'timeout', error: '逾時' }) });
    const r = await svc.test('nvr_t', 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /逾時/);
  });

  test('go2rtc 逾時（UPSTREAM）會往外丟，由路由轉成 502', async () => {
    const svc = make({ upsertStream: async () => { throw upstream('串流服務（go2rtc）沒有回應，請稍後再試'); }, probe: async () => ({ ok: true, codec: 'h264' }) });
    await assert.rejects(svc.test('nvr_t', 1), (err) => err.code === 'UPSTREAM' && err.status === 502);
    const svc2 = make({ upsertStream: async () => {}, probe: async () => { throw upstream('x'); } });
    await assert.rejects(svc2.test('nvr_t', 1), (err) => err.code === 'UPSTREAM');
  });

  test('只註冊並探測「子碼流」，URL 帶入密碼', async () => {
    const calls = [];
    const svc = make({ upsertStream: async (n, s) => calls.push(['upsert', n, s]), probe: async (n) => (calls.push(['probe', n]), { ok: true, codec: 'h264' }) });
    assert.deepEqual(await svc.test('nvr_t', 1), { ok: true, codec: 'h264' });
    assert.deepEqual(calls, [
      ['upsert', 'nvr_nvr_t_1_sub', 'rtsp://a:pw@10.0.0.5:554/Streaming/Channels/102'],
      ['probe', 'nvr_nvr_t_1_sub'],
    ]);
  });
});
