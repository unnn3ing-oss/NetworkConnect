import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../../contracts/index.js';

const v = createValidator();
const ok = (ref, data) => assert.equal(v.validate(ref, data).valid, true, JSON.stringify(v.validate(ref, data).errors));
const bad = (ref, data) => assert.equal(v.validate(ref, data).valid, false, JSON.stringify(data));

describe('api-system#Settings / SettingsUpdate', () => {
  const full = { lanAccess: true, port: 8780, modules: { inventory: true, io: true, monitor: true, floorplan: true, nvr: true }, restartRequired: false };

  test('Settings：完整回應', () => {
    ok('api-system#Settings', full);
    bad('api-system#Settings', { ...full, restartRequired: undefined });
    bad('api-system#Settings', { ...full, port: 0 });
    bad('api-system#Settings', { ...full, modules: { ...full.modules, system: true } });
  });

  test('SettingsUpdate：欄位全為選填，modules 可只帶部分', () => {
    ok('api-system#SettingsUpdate', {});
    ok('api-system#SettingsUpdate', { lanAccess: false });
    ok('api-system#SettingsUpdate', { port: 9000, modules: { nvr: false } });
    bad('api-system#SettingsUpdate', { port: 65536 });
    bad('api-system#SettingsUpdate', { modules: { system: false } });
    bad('api-system#SettingsUpdate', { restartRequired: true });
    bad('api-system#SettingsUpdate', { go2rtcPath: '/usr/bin/go2rtc' });
  });
});
