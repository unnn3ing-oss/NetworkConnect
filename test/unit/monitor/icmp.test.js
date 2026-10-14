import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pingArgs, parsePing, isValidIp, probe, detectPing } from '../../../server/modules/monitor/probers/icmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

describe('pingArgs：依平台組參數（規格 §8.1）', () => {
  test('Windows：-n 1 -w 1000', () => {
    assert.deepEqual(pingArgs('win32', '192.168.1.1'), ['-n', '1', '-w', '1000', '192.168.1.1']);
  });
  test('macOS：-c 1 -W 1000（毫秒）', () => {
    assert.deepEqual(pingArgs('darwin', '192.168.1.1'), ['-c', '1', '-W', '1000', '192.168.1.1']);
  });
  test('Linux：-c 1 -W 1（秒）', () => {
    assert.deepEqual(pingArgs('linux', '192.168.1.1'), ['-c', '1', '-W', '1', '192.168.1.1']);
  });
  test('未知平台比照 Linux', () => {
    assert.deepEqual(pingArgs('freebsd', '10.0.0.1'), ['-c', '1', '-W', '1', '10.0.0.1']);
  });
  test('惡意 IP 字串一律丟錯，不產生參數', () => {
    for (const bad of ['1.1.1.1;rm -rf /', '1.1.1.1 && calc', '$(reboot)', '-f', '--help', '1.1.1.1\n2.2.2.2', '1.1.1.1|id', '`id`', 'example.com', '999.1.1.1', '1.1.1', '', null, undefined, 42, '::1']) {
      for (const platform of ['win32', 'darwin', 'linux']) {
        assert.throws(() => pingArgs(platform, bad), /IP/, `${platform} ${JSON.stringify(bad)}`);
      }
    }
  });
});

describe('isValidIp', () => {
  test('只接受標準 IPv4 字串', () => {
    assert.equal(isValidIp('192.168.1.1'), true);
    assert.equal(isValidIp('127.0.0.1'), true);
    assert.equal(isValidIp('1.1.1.1;rm -rf /'), false);
    assert.equal(isValidIp(' 1.1.1.1'), false);
    assert.equal(isValidIp('01.1.1.1'), false);
  });
});

describe('parsePing：三平台真實輸出樣本', () => {
  test('Windows 中文成功：有 TTL=，延遲取「時間=3ms」', () => {
    assert.deepEqual(parsePing('win32', sample('win-zh-success.txt'), 0), { ok: true, rttMs: 3 });
  });
  test('Windows 英文成功：time<1ms 取 1', () => {
    assert.deepEqual(parsePing('win32', sample('win-en-success.txt'), 0), { ok: true, rttMs: 1 });
  });
  test('Windows 中文逾時（結束碼 1）→ 失敗', () => {
    assert.deepEqual(parsePing('win32', sample('win-zh-timeout.txt'), 1), { ok: false, rttMs: null });
  });
  test('Windows 中文「目的地主機無法連線」結束碼 0 也不算成功（已知地雷）', () => {
    assert.deepEqual(parsePing('win32', sample('win-zh-unreachable.txt'), 0), { ok: false, rttMs: null });
  });
  test('Windows 英文 Destination host unreachable（結束碼 0）→ 失敗', () => {
    assert.deepEqual(parsePing('win32', sample('win-en-unreachable.txt'), 0), { ok: false, rttMs: null });
  });
  test('Windows：即使輸出有 TTL= 但結束碼非 0 仍以輸出為準（成功）', () => {
    assert.equal(parsePing('win32', sample('win-zh-success.txt'), 1).ok, true);
  });
  test('macOS 成功：結束碼 0，延遲 2.845', () => {
    assert.deepEqual(parsePing('darwin', sample('mac-success.txt'), 0), { ok: true, rttMs: 2.845 });
  });
  test('macOS 逾時／無路由 → 失敗', () => {
    assert.deepEqual(parsePing('darwin', sample('mac-timeout.txt'), 2), { ok: false, rttMs: null });
    assert.deepEqual(parsePing('darwin', sample('mac-no-route.txt'), 68), { ok: false, rttMs: null });
  });
  test('Linux 成功：結束碼 0，延遲 0.412', () => {
    assert.deepEqual(parsePing('linux', sample('linux-success.txt'), 0), { ok: true, rttMs: 0.412 });
  });
  test('Linux 逾時／主機不可達 → 失敗', () => {
    assert.deepEqual(parsePing('linux', sample('linux-timeout.txt'), 1), { ok: false, rttMs: null });
    assert.deepEqual(parsePing('linux', sample('linux-unreachable.txt'), 1), { ok: false, rttMs: null });
  });
  test('macOS／Linux 結束碼 0 但沒有延遲數字 → ok 但 rttMs 為 null', () => {
    assert.deepEqual(parsePing('linux', 'whatever', 0), { ok: true, rttMs: null });
  });
});

/** 假 execFile：記錄呼叫並依腳本回應 */
function fakeExec(reply) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const r = reply(file, args, opts);
    queueMicrotask(() => {
      if (r.error) cb(Object.assign(new Error(r.error.message ?? 'x'), r.error), r.stdout ?? '', r.stderr ?? '');
      else cb(null, r.stdout ?? '', r.stderr ?? '');
    });
    return { kill() {} };
  };
  fn.calls = calls;
  return fn;
}

describe('probe（注入 execFile）', () => {
  test('使用 execFile 且參數為陣列；Windows 帶 windowsHide:true', async () => {
    const exec = fakeExec(() => ({ stdout: sample('win-zh-success.txt') }));
    const r = await probe({ host: '192.168.1.1' }, { platform: 'win32', execFile: exec });
    assert.deepEqual(r, { ok: true, rttMs: 3 });
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].file, 'ping');
    assert.ok(Array.isArray(exec.calls[0].args));
    assert.equal(exec.calls[0].opts.windowsHide, true);
    assert.ok(exec.calls[0].opts.timeout > 0);
  });

  test('惡意 IP：不呼叫 execFile，回報 error', async () => {
    const exec = fakeExec(() => ({ stdout: '' }));
    const r = await probe({ host: '1.1.1.1;rm -rf /' }, { platform: 'linux', execFile: exec });
    assert.equal(r.ok, false);
    assert.match(r.error, /IP/);
    assert.equal(exec.calls.length, 0);
  });

  test('macOS 使用絕對路徑 /sbin/ping', async () => {
    const exec = fakeExec(() => ({ stdout: sample('mac-success.txt') }));
    await probe({ host: '192.168.1.1' }, { platform: 'darwin', execFile: exec });
    assert.equal(exec.calls[0].file, '/sbin/ping');
  });

  test('結束碼非 0 的 ping（對方沒回應）→ ok:false 且沒有 error', async () => {
    const exec = fakeExec(() => ({ error: { code: 1 }, stdout: sample('linux-timeout.txt') }));
    const r = await probe({ host: '192.168.1.250' }, { platform: 'linux', execFile: exec });
    assert.deepEqual(r, { ok: false, rttMs: null });
  });

  test('Windows 目的地主機無法連線（結束碼 0）→ ok:false 且沒有 error', async () => {
    const exec = fakeExec(() => ({ stdout: sample('win-zh-unreachable.txt') }));
    const r = await probe({ host: '192.168.1.250' }, { platform: 'win32', execFile: exec });
    assert.deepEqual(r, { ok: false, rttMs: null });
  });

  test('找不到 ping（ENOENT）→ 檢查本身出錯（error）', async () => {
    const exec = fakeExec(() => ({ error: { code: 'ENOENT' } }));
    const r = await probe({ host: '192.168.1.1' }, { platform: 'linux', execFile: exec });
    assert.equal(r.ok, false);
    assert.match(r.error, /ping/);
  });

  test('沒有權限（Operation not permitted）→ 檢查本身出錯', async () => {
    const exec = fakeExec(() => ({ error: { code: 2 }, stderr: sample('linux-no-permission.txt') }));
    const r = await probe({ host: '192.168.1.1' }, { platform: 'linux', execFile: exec });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test('execFile 逾時被終止 → 視為對方沒回應', async () => {
    const exec = fakeExec(() => ({ error: { code: null, killed: true, signal: 'SIGTERM' } }));
    const r = await probe({ host: '192.168.1.1' }, { platform: 'linux', execFile: exec });
    assert.deepEqual(r, { ok: false, rttMs: null });
  });

  test('成功但無法解析延遲時，以實際耗時補上', async () => {
    let t = 1000;
    const exec = fakeExec(() => {
      t += 7;
      return { stdout: '' };
    });
    const r = await probe({ host: '192.168.1.1' }, { platform: 'linux', execFile: exec, now: () => t });
    assert.equal(r.ok, true);
    assert.equal(typeof r.rttMs, 'number');
  });
});

describe('detectPing', () => {
  test('ping 指令存在 → available', async () => {
    const exec = fakeExec(() => ({ stdout: sample('linux-success.txt') }));
    assert.deepEqual(await detectPing({ platform: 'linux', execFile: exec }), { available: true });
  });
  test('找不到 ping → unavailable 並說明原因', async () => {
    const exec = fakeExec(() => ({ error: { code: 'ENOENT' } }));
    const r = await detectPing({ platform: 'linux', execFile: exec });
    assert.equal(r.available, false);
    assert.match(r.reason, /ping/);
  });
});

// ---- 真實 ping（會在 D1 的 CI 於 macOS／Windows 再跑一次；不可寫死 Linux 行為）----
const loopback = await probe({ host: '127.0.0.1' }, { platform: process.platform });
const skipReal = loopback.error ? `本機無法使用 ping，略過：${loopback.error}` : !loopback.ok ? '本機 ping 127.0.0.1 不通（沙箱限制？），略過' : false;
describe('真實 ping 127.0.0.1', { skip: skipReal }, () => {
  test('成功且有延遲數字', async () => {
    const r = await probe({ host: '127.0.0.1' }, { platform: process.platform });
    assert.equal(r.error, undefined);
    assert.equal(r.ok, true);
    assert.equal(typeof r.rttMs, 'number');
    assert.ok(r.rttMs >= 0);
  });
});
