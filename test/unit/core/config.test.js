import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, resolveDataDir, loadConfig, saveConfig } from '../../../server/core/config.js';
import { createValidator } from '../../../contracts/index.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

describe('resolveDataDir', () => {
  test('startServer 傳入的 dataDir 優先於環境變數', () => {
    const d = resolveDataDir({ dataDir: makeTmpDir(), env: { NC_DATA_DIR: '/should/not/use' } });
    assert.ok(path.isAbsolute(d));
    assert.ok(!d.includes('should'));
  });
  test('沒有 dataDir 時用 NC_DATA_DIR', () => {
    const env = { NC_DATA_DIR: path.join(makeTmpDir(), 'from-env') };
    assert.equal(resolveDataDir({ env }), env.NC_DATA_DIR);
  });
  test('都沒有時預設為 <cwd>/data；mock 模式預設為 <cwd>/data-mock', () => {
    assert.equal(resolveDataDir({ env: {}, cwd: '/x' }), path.resolve('/x', 'data'));
    assert.equal(resolveDataDir({ env: {}, cwd: '/x', mock: true }), path.resolve('/x', 'data-mock'));
  });
  test('相對路徑會轉成絕對路徑', () => {
    assert.ok(path.isAbsolute(resolveDataDir({ dataDir: 'rel/dir', env: {} })));
  });
});

describe('loadConfig', () => {
  test('config.json 不存在：建立資料夾與預設設定檔，並符合 config schema', () => {
    const dataDir = path.join(makeTmpDir(), 'nested', 'data');
    const cfg = loadConfig(dataDir);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(cfg.port, 8780);
    assert.equal(cfg.lanAccess, true);
    assert.deepEqual(Object.keys(cfg.modules).sort(), ['floorplan', 'inventory', 'io', 'monitor', 'nvr']);
    assert.equal(cfg.go2rtcPath, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), DEFAULT_CONFIG);
    createValidator().assert('config', cfg);
  });

  test('回傳的是複本，不會污染 DEFAULT_CONFIG', () => {
    const cfg = loadConfig(makeTmpDir());
    cfg.modules.nvr = false;
    assert.equal(DEFAULT_CONFIG.modules.nvr, true);
  });

  test('已存在的設定與預設值合併（缺的補預設、巢狀 modules 也補）', () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 9000, modules: { nvr: false } }));
    const cfg = loadConfig(dataDir);
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.lanAccess, true);
    assert.deepEqual(cfg.modules, { inventory: true, io: true, monitor: true, floorplan: true, nvr: false });
  });

  test('型別錯誤的欄位回到預設值；未知欄位被丟棄', () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 'abc', lanAccess: 'yes', unknown: 1 }));
    const cfg = loadConfig(dataDir);
    assert.equal(cfg.port, 8780);
    assert.equal(cfg.lanAccess, true);
    assert.equal('unknown' in cfg, false);
  });

  test('config.json 損毀：改名備份並使用預設值', () => {
    const dataDir = makeTmpDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{ oops');
    const cfg = loadConfig(dataDir);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('config.json.corrupt-')));
  });

  test('saveConfig 原子寫入並可再讀回', () => {
    const dataDir = makeTmpDir();
    const cfg = loadConfig(dataDir);
    saveConfig(dataDir, { ...cfg, port: 8790 });
    assert.equal(loadConfig(dataDir).port, 8790);
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), []);
  });
});
