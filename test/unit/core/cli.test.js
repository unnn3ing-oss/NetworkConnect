import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../../../server/core/cli-args.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server', 'cli.js');

describe('parseCliArgs', () => {
  test('--data-dir --port --host --mock', () => {
    assert.deepEqual(parseCliArgs(['--data-dir', '/tmp/x', '--port', '0', '--host', '127.0.0.1', '--mock']), {
      dataDir: '/tmp/x', port: 0, host: '127.0.0.1', mock: true, help: false,
    });
  });
  test('--key=value 形式；沒給的參數不出現在結果中', () => {
    const r = parseCliArgs(['--port=9000']);
    assert.equal(r.port, 9000);
    assert.equal('dataDir' in r, false);
    assert.equal('mock' in r, false);
  });
  test('--port 不是 0–65535 的整數時丟錯', () => {
    assert.throws(() => parseCliArgs(['--port', 'abc']), /port/);
    assert.throws(() => parseCliArgs(['--port', '70000']), /port/);
  });
  test('未知參數丟錯', () => {
    assert.throws(() => parseCliArgs(['--nope']), /nope/);
  });
});

describe('server/cli.js', () => {
  function run(args) {
    const child = fork(CLI, args, { silent: true, env: { ...process.env, NC_MOCK: '', NC_DATA_DIR: '', NC_PORT: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const line = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`逾時；stdout=${out} stderr=${err}`)), 10_000);
      child.stdout.on('data', () => {
        const m = out.match(/NetworkConnect listening on (http:\/\/\S+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('exit', () => { clearTimeout(t); reject(new Error(`提前結束；stdout=${out} stderr=${err}`)); });
    });
    return { child, line, exited, output: () => ({ out, err }) };
  }

  test('--port 0 啟動後印出 "NetworkConnect listening on <url>"（含實際埠號），收到 shutdown 訊息後正常結束', async () => {
    const dataDir = makeTmpDir();
    const r = run(['--data-dir', dataDir, '--port', '0', '--host', '127.0.0.1']);
    const url = await r.line;
    assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    const res = await fetch(`${url}/api/system/health`, { headers: { connection: 'close' } });
    assert.equal((await res.json()).ok, true);
    r.child.send({ type: 'shutdown' });
    const { code } = await r.exited;
    assert.equal(code, 0);
  });

  test('--mock 載入 fixtures（不碰真實 data/）', async () => {
    const dataDir = makeTmpDir();
    const r = run(['--data-dir', dataDir, '--port', '0', '--host', '127.0.0.1', '--mock']);
    const url = await r.line;
    const devices = await (await fetch(`${url}/api/system/modules`, { headers: { connection: 'close' } })).json();
    assert.ok(devices.every((m) => m.state === 'ok'));
    r.child.send({ type: 'shutdown' });
    assert.equal((await r.exited).code, 0);
  });

  test('參數錯誤時以非 0 結束並輸出訊息', async () => {
    const r = run(['--port', 'abc']);
    r.line.catch(() => {}); // 這個情境不會印出網址
    const { code } = await r.exited;
    assert.notEqual(code, 0);
    assert.match(r.output().err, /port/);
  });
});
