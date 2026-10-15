// cameras 前端純邏輯（不需要瀏覽器）：分割、頻道清單、上限、網址目標、精靈表單驗證。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFixture } from '../../../contracts/index.js';
import {
  CUSTOM_URL_STARTER, applyBrand, applyLimit, clampLimit, clampQuality, clampSplit, connectionPayload, connectionSignature, describeTest, ensureChannels, flattenChannels,
  gridCols, newWizardState, pageCount, pageSlice, parseTarget, previewUrl, selectedKeys, stateFromNvr, streamName, validateChannels,
  validateConnection, wsPath,
} from '../../../web/modules/cameras/logic.js';
import { streamName as serverStreamName } from '../../../server/modules/nvr/templates.js';

const templates = readFixture('nvr-templates.json');
const nvrs = readFixture('db.sample.json').nvrs;

describe('串流名稱（前後端一致）', () => {
  test('前端 streamName 與後端 streamName 相同', () => {
    for (const id of ['nvr_main', 'nvr_V1StGXR8_Z']) for (const kind of ['main', 'sub']) assert.equal(streamName(id, 3, kind), serverStreamName(id, 3, kind));
  });
  test('wsPath 帶編碼過的 stream 參數', () => {
    assert.equal(wsPath('nvr_nvr_main_1_sub'), '/api/nvr/ws?stream=nvr_nvr_main_1_sub');
    assert.equal(wsPath('a b&c'), '/api/nvr/ws?stream=a%20b%26c');
  });
});

describe('分割與上限', () => {
  test('分割數 → 欄數；非法值回到 4', () => {
    assert.deepEqual([1, 4, 9, 16].map(gridCols), [1, 2, 3, 4]);
    assert.equal(clampSplit(9), 9);
    assert.equal(clampSplit('16'), 16);
    assert.equal(clampSplit(5), 4);
    assert.equal(clampSplit(undefined), 4);
  });
  test('同時串流上限：預設 9、範圍 1–16', () => {
    assert.equal(clampLimit(undefined), 9);
    assert.equal(clampLimit('abc'), 9);
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(99), 16);
    assert.equal(clampLimit('5'), 5);
    assert.equal(clampLimit(4.9), 4);
  });
  test('applyLimit：前 N 個連線，其餘「已達上限」', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
    const r = applyLimit(keys, 9);
    assert.equal(r.streaming.length, 9);
    assert.deepEqual(r.limited, ['k9', 'k10', 'k11']);
    assert.deepEqual(applyLimit(keys.slice(0, 4), 9), { streaming: keys.slice(0, 4), limited: [] });
    assert.deepEqual(applyLimit(keys, 0).streaming, ['k0']);
  });
  test('分頁', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    assert.equal(pageCount(10, 4), 3);
    assert.equal(pageCount(0, 4), 1);
    assert.deepEqual(pageSlice(keys, 4, 0).keys, ['k0', 'k1', 'k2', 'k3']);
    assert.deepEqual(pageSlice(keys, 4, 2).keys, ['k8', 'k9']);
    assert.equal(pageSlice(keys, 4, 99).page, 2, '超出範圍時夾到最後一頁');
    assert.equal(pageSlice(keys, 4, -3).page, 0);
  });
});

describe('頻道清單', () => {
  test('flattenChannels：只含啟用的頻道、依頻道編號排序', () => {
    const list = flattenChannels([{ id: 'nvr_a', name: 'A', channels: [{ ch: 2, name: '二', enabled: true, deviceId: 'dev_x' }, { ch: 1, name: '', enabled: true }, { ch: 3, name: '三', enabled: false }] }]);
    assert.deepEqual(list, [
      { key: 'nvr_a:1', nvrId: 'nvr_a', nvrName: 'A', ch: 1, name: '頻道 1', deviceId: null },
      { key: 'nvr_a:2', nvrId: 'nvr_a', nvrName: 'A', ch: 2, name: '二', deviceId: 'dev_x' },
    ]);
    assert.deepEqual(flattenChannels(undefined), []);
  });
  test('fixture：8 個啟用頻道', () => {
    const list = flattenChannels(nvrs);
    assert.equal(list.length, 8);
    assert.equal(list[0].key, 'nvr_main:1');
  });
  test('selectedKeys：存的是取消勾選的；新頻道預設顯示', () => {
    const list = flattenChannels(nvrs);
    assert.equal(selectedKeys(null, list).length, 8);
    assert.deepEqual(selectedKeys(['nvr_main:2', 'nvr_gone:1'], list).slice(0, 2), ['nvr_main:1', 'nvr_main:3']);
    assert.equal(selectedKeys(list.map((c) => c.key), list).length, 0);
  });
});

describe('網址目標', () => {
  const channels = flattenChannels(nvrs);
  test('沒有參數 → all', () => assert.deepEqual(parseTarget({}, channels), { mode: 'all' }));
  test('?device=<deviceId> → 對應的頻道', () => {
    assert.deepEqual(parseTarget({ device: 'dev_cam3' }, channels), { mode: 'single', key: 'nvr_main:3' });
  });
  test('?ch=<nvrId>:<ch> → 指定頻道', () => {
    assert.deepEqual(parseTarget({ ch: 'nvr_main:5' }, channels), { mode: 'single', key: 'nvr_main:5' });
  });
  test('ch 優先於 device', () => {
    assert.deepEqual(parseTarget({ ch: 'nvr_main:1', device: 'dev_cam3' }, channels), { mode: 'single', key: 'nvr_main:1' });
  });
  test('找不到 → missing 並帶說明', () => {
    assert.equal(parseTarget({ ch: 'nvr_main:99' }, channels).mode, 'missing');
    assert.match(parseTarget({ ch: 'nvr_main:99' }, channels).reason, /找不到頻道/);
    assert.match(parseTarget({ device: 'dev_router' }, channels).reason, /尚未連結/);
  });
});

describe('精靈表單', () => {
  test('新增初始值：預設品牌、埠、碼流取自第一個模板', () => {
    const s = newWizardState(templates);
    assert.equal(s.brand, 'hikvision');
    assert.equal(s.port, '554');
    assert.equal(s.streamSub, '2');
    assert.equal(s.nvrId, null);
  });

  test('applyBrand：帶入模板預設值', () => {
    const s = newWizardState(templates);
    applyBrand(s, templates.find((t) => t.id === 'reolink'));
    assert.deepEqual([s.brand, s.streamMain, s.streamSub], ['reolink', 'main', 'sub']);
    applyBrand(s, templates.find((t) => t.id === 'custom'));
    s.urlTemplate = 'rtsp://x';
    applyBrand(s, templates.find((t) => t.id === 'dahua'));
    assert.equal(s.urlTemplate, '', '離開自訂品牌時清掉自訂 URL');
  });

  test('applyBrand：改選自訂時帶入剛才品牌的網址與碼流代號；已輸入的自訂網址不覆蓋', () => {
    const t = (id) => templates.find((x) => x.id === id);
    const s = newWizardState(templates);
    applyBrand(s, t('hisharp'));
    applyBrand(s, t('custom'), t('hisharp'));
    assert.deepEqual([s.urlTemplate, s.streamMain, s.streamSub], [t('hisharp').urlTemplate, 'main', 'sub']);
    s.urlTemplate = 'rtsp://{u}:{p}@{host}:{port}/mine/{ch}';
    applyBrand(s, t('custom'), t('custom'));
    assert.equal(s.urlTemplate, 'rtsp://{u}:{p}@{host}:{port}/mine/{ch}');
    const fresh = newWizardState(templates);
    applyBrand(fresh, t('custom'));
    assert.equal(fresh.urlTemplate, CUSTOM_URL_STARTER);
    assert.deepEqual([fresh.streamMain, fresh.streamSub], ['0', '1']);
  });

  test('stateFromNvr：編輯時密碼留空、沿用 hasPassword', () => {
    const s = stateFromNvr({ ...nvrs[0], hasPassword: true }, templates);
    assert.equal(s.nvrId, 'nvr_main');
    assert.equal(s.password, '');
    assert.equal(s.hasPassword, true);
    assert.equal(s.channels.length, 8);
    assert.equal(s.port, '554');
  });

  const base = () => ({ ...newWizardState(templates), host: '192.168.1.20', username: 'admin', password: 'pw', channelCount: '8' });

  test('validateConnection：必填與格式', () => {
    assert.equal(validateConnection(base()), null);
    assert.match(validateConnection({ ...base(), host: '' }), /IP/);
    assert.match(validateConnection({ ...base(), host: 'rtsp://1.2.3.4' }), /格式/);
    assert.match(validateConnection({ ...base(), host: '1.2.3.4/x' }), /格式/);
    assert.match(validateConnection({ ...base(), port: '0' }), /埠/);
    assert.match(validateConnection({ ...base(), port: '70000' }), /埠/);
    assert.match(validateConnection({ ...base(), port: 'abc' }), /埠/);
    assert.match(validateConnection({ ...base(), username: ' ' }), /帳號/);
    assert.match(validateConnection({ ...base(), password: '' }), /密碼/);
    assert.equal(validateConnection({ ...base(), password: '' }, { editing: true }), null, '編輯時密碼可留空');
    assert.match(validateConnection({ ...base(), channelCount: '0' }), /頻道數/);
    assert.match(validateConnection({ ...base(), channelCount: '65' }), /頻道數/);
    assert.match(validateConnection({ ...base(), channelCount: '2.5' }), /頻道數/);
  });

  test('validateConnection：自訂品牌需要 rtsp:// 開頭的 URL 與碼流代號', () => {
    const custom = { ...base(), brand: 'custom', urlTemplate: '', streamMain: '0', streamSub: '1' };
    assert.match(validateConnection(custom), /rtsp:\/\//);
    assert.match(validateConnection({ ...custom, urlTemplate: 'http://x/{ch}' }), /rtsp:\/\//);
    assert.match(validateConnection({ ...custom, urlTemplate: 'exec:ffmpeg' }), /rtsp:\/\//);
    assert.equal(validateConnection({ ...custom, urlTemplate: 'rtsp://{u}:{p}@{host}/{ch}/{s}' }), null);
    assert.match(validateConnection({ ...custom, urlTemplate: 'rtsp://x', streamSub: '' }), /碼流/);
  });

  test('connectionPayload：轉型、trim；自訂才帶 urlTemplate；密碼空字串不送', () => {
    const p = connectionPayload({ ...base(), host: ' 10.0.0.1 ', port: '8554', channelCount: '4', name: ' 我的 NVR ' });
    assert.deepEqual(p, { name: '我的 NVR', brand: 'hikvision', host: '10.0.0.1', port: 8554, username: 'admin', channelCount: 4, streamMain: '1', streamSub: '2', password: 'pw' });
    assert.ok(!('password' in connectionPayload({ ...base(), password: '' })));
    const c = connectionPayload({ ...base(), brand: 'custom', urlTemplate: ' rtsp://x/{ch} ' });
    assert.equal(c.urlTemplate, 'rtsp://x/{ch}');
    assert.ok(!('urlTemplate' in p));
  });

  test('connectionSignature：連線設定任何一項改變，簽章就不同（名稱、頻道設定不影響）', () => {
    const a = base();
    const sig = connectionSignature(a);
    assert.equal(connectionSignature({ ...a, name: '別的名稱' }), sig);
    for (const [k, v] of Object.entries({ host: '10.0.0.2', port: '8554', username: 'x', password: 'other', channelCount: '4', brand: 'dahua', urlTemplate: 'rtsp://z', streamSub: '9' })) {
      assert.notEqual(connectionSignature({ ...a, [k]: v }), sig, k);
    }
  });

  test('ensureChannels：補到 N、保留已填、驗證至少啟用一個', () => {
    const s = { channelCount: '3', channels: [{ ch: 2, name: '客廳', deviceId: null, enabled: false }] };
    ensureChannels(s);
    assert.deepEqual(s.channels.map((c) => [c.ch, c.name, c.enabled]), [[1, '頻道 1', true], [2, '客廳', false], [3, '頻道 3', true]]);
    assert.equal(validateChannels(s), null);
    for (const c of s.channels) c.enabled = false;
    assert.match(validateChannels(s), /至少/);
    s.channelCount = '2';
    ensureChannels(s);
    assert.equal(s.channels.length, 2);
  });

  test('previewUrl：密碼以 **** 代替；自訂品牌用自己的範本', () => {
    const s = { ...base(), host: '10.0.0.1' };
    assert.equal(previewUrl(s, templates[0]), 'rtsp://admin:****@10.0.0.1:554/Streaming/Channels/102');
    assert.equal(previewUrl(s, templates[0], 'main', 3), 'rtsp://admin:****@10.0.0.1:554/Streaming/Channels/301');
    assert.equal(previewUrl({ ...s, brand: 'reolink', streamSub: 'sub' }, templates[3]), 'rtsp://admin:****@10.0.0.1:554/h264Preview_01_sub');
    assert.equal(previewUrl({ ...s, brand: 'custom', urlTemplate: 'rtsp://{host}/{ch:02}/{s}', streamSub: 'x' }, templates[4]), 'rtsp://10.0.0.1/01/x');
    assert.equal(previewUrl({ ...s, brand: 'custom', urlTemplate: '' }, templates[4]), '');
    assert.ok(!previewUrl({ ...s, password: 'secret' }, templates[0]).includes('secret'));
  });

  test('describeTest：成功、H.265 警告、失敗', () => {
    assert.equal(describeTest(null), null);
    assert.equal(describeTest({ ok: true, codec: 'h264' }).kind, 'ok');
    assert.match(describeTest({ ok: true, codec: 'h264' }).text, /H\.264/);
    const w = describeTest({ ok: true, codec: 'h265', warning: '改成 H.264' });
    assert.equal(w.kind, 'warn');
    assert.match(w.title, /H265/);
    assert.equal(describeTest({ ok: false, error: '帳號或密碼錯誤' }).kind, 'error');
    assert.equal(describeTest({ ok: false, error: '帳號或密碼錯誤' }).text, '帳號或密碼錯誤');
  });
});

test('clampQuality：只有 main 是主碼流，其他（含舊設定、亂填）一律子碼流', () => {
  assert.equal(clampQuality('main'), 'main');
  for (const v of ['sub', '', null, undefined, 'MAIN', 'hd']) assert.equal(clampQuality(v), 'sub');
});
