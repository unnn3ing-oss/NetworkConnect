// 平面圖頁的資料整理（純函式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unplacedDevices, placedOnFloor, groupByRoom, pickFloor } from '../../../web/modules/floorplan/model.js';

const devices = [
  { id: 'dev_a', name: 'A', floorId: 'flr_1', roomId: 'room_x', categoryId: 'cat_ap', groupIds: [] },
  { id: 'dev_b', name: 'B', floorId: 'flr_1', roomId: 'room_y', categoryId: 'cat_camera', groupIds: [] },
  { id: 'dev_c', name: 'C', floorId: 'flr_1', roomId: null, categoryId: 'cat_ap', groupIds: [] },
  { id: 'dev_d', name: 'D', floorId: 'flr_2', roomId: 'room_z', categoryId: 'cat_ap', groupIds: [] },
];
const rooms = [
  { id: 'room_y', floorId: 'flr_1', name: 'Y', order: 2 },
  { id: 'room_x', floorId: 'flr_1', name: 'X', order: 1 },
  { id: 'room_z', floorId: 'flr_2', name: 'Z', order: 1 },
];
const placements = [{ deviceId: 'dev_a', floorId: 'flr_1', x: 0.1, y: 0.1 }, { deviceId: 'dev_gone', floorId: 'flr_1', x: 0, y: 0 }];

test('unplacedDevices：只列本層、未放置、符合全站篩選的設備', () => {
  assert.deepEqual(unplacedDevices(devices, placements, 'flr_1').map((d) => d.id), ['dev_b', 'dev_c']);
  assert.deepEqual(unplacedDevices(devices, placements, 'flr_1', { categoryId: 'cat_camera' }).map((d) => d.id), ['dev_b']);
  assert.deepEqual(unplacedDevices(devices, placements, 'flr_1', { floorId: 'flr_2', q: 'c' }).map((d) => d.id), ['dev_c'], '顯示中的樓層優先於篩選的樓層');
  assert.deepEqual(unplacedDevices(devices, [], 'flr_2').map((d) => d.id), ['dev_d']);
});

test('placedOnFloor：略過找不到設備的落點與其他樓層', () => {
  assert.deepEqual(placedOnFloor(devices, placements, 'flr_1').map((x) => x.device.id), ['dev_a']);
  assert.deepEqual(placedOnFloor(devices, placements, 'flr_2'), []);
});

test('groupByRoom：依房間 order 分組，沒有房間的放最後，空房間不列', () => {
  const g = groupByRoom(devices, rooms, 'flr_1');
  assert.deepEqual(g.map((x) => [x.room?.id ?? null, x.devices.map((d) => d.id)]), [['room_x', ['dev_a']], ['room_y', ['dev_b']], [null, ['dev_c']]]);
  assert.deepEqual(groupByRoom(devices, rooms, 'flr_2').map((x) => x.room.id), ['room_z']);
});

test('pickFloor', () => {
  const floors = [{ id: 'flr_1' }, { id: 'flr_2' }];
  assert.equal(pickFloor(floors, 'flr_2'), 'flr_2');
  assert.equal(pickFloor(floors, ''), 'flr_1');
  assert.equal(pickFloor(floors, 'flr_x'), 'flr_1');
  assert.equal(pickFloor([], ''), '');
});
