// inventory 模組（B1）：樓層、房間、組別、類別、設備的 CRUD 與關聯規則（contracts/api.md §3）。
// 規則重點：刪樓層／房間受 409 保護、刪組別會清掉設備的 groupIds、內建類別不可刪、
// roomId 必須屬於 floorId、uplink 不可形成迴圈（422 CYCLE）、刪設備時下游設為根節點。
import { nanoid } from 'nanoid';
import { readSeed } from '../../../contracts/index.js';
import { conflict, cycle, notFound, validation } from '../../core/errors.js';
import { readDefaultIntervalSec } from '../../core/monitor-defaults.js';
import { buildDevice, downstreamIds, fillMonitor, fillUplink, filterDevices, findUplinkCycle, naturalCompare, sortDevices } from './rules.js';

const DEFAULT_GROUP_COLOR = '#64748b';
const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${nanoid(10)}`;

export default {
  name: 'inventory',
  owns: ['floors', 'rooms', 'groups', 'categories', 'devices'],

  async check(ctx) {},

  async register(app, ctx) {
    const col = (name) => ctx.store.collection(name);
    const emit = (collection, op, id) => ctx.events.emit('inventory.changed', { collection, op, id });
    const seedIds = readSeed('categories.json').map((c) => c.id);

    // 所有寫入請求依序執行：檢查（唯一性、外鍵）與寫入之間不會被別的請求插入
    let chain = Promise.resolve();
    const serial = (fn) => {
      const run = chain.then(fn);
      chain = run.catch(() => {});
      return run;
    };

    const devicesById = async () => new Map((await col('devices').list()).map((d) => [d.id, d]));

    // ---------------- 樓層 ----------------
    const floorSorted = (list) => [...list].sort((a, b) => a.order - b.order || naturalCompare(a.name, b.name));

    app.get('/api/floors', async () => floorSorted(await col('floors').list()));

    app.post('/api/floors', (req, reply) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#FloorCreate', req.body);
        const floors = await col('floors').list();
        const order = body.order ?? floors.reduce((m, f) => Math.max(m, f.order), 0) + 1;
        const now = nowIso();
        const floor = await col('floors').insert({ id: newId('flr'), name: body.name, order, createdAt: now, updatedAt: now });
        emit('floors', 'create', floor.id);
        return reply.code(201).send(floor);
      }),
    );

    app.patch('/api/floors/:id', (req) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#FloorPatch', req.body);
        if (!(await col('floors').get(req.params.id))) throw notFound('找不到樓層');
        const floor = await col('floors').update(req.params.id, { ...body, updatedAt: nowIso() });
        emit('floors', 'update', floor.id);
        return floor;
      }),
    );

    app.delete('/api/floors/:id', (req, reply) =>
      serial(async () => {
        const id = req.params.id;
        if (!(await col('floors').get(id))) throw notFound('找不到樓層');
        const rooms = (await col('rooms').list({ floorId: id })).length;
        const devices = (await col('devices').list({ floorId: id })).length;
        if (rooms || devices) throw conflict(`樓層仍有 ${rooms} 個房間、${devices} 台設備，無法刪除`, { rooms, devices });
        await col('floors').remove(id);
        emit('floors', 'delete', id);
        return reply.code(204).send();
      }),
    );

    // ---------------- 房間 ----------------
    app.get('/api/rooms', async (req) => {
      const { floorId } = req.query ?? {};
      if (floorId !== undefined) ctx.validate('common#FloorId', floorId);
      const [rooms, floors] = await Promise.all([col('rooms').list(floorId ? { floorId } : undefined), col('floors').list()]);
      const floorOrder = new Map(floors.map((f) => [f.id, f.order]));
      return rooms.sort(
        (a, b) => (floorOrder.get(a.floorId) ?? 0) - (floorOrder.get(b.floorId) ?? 0) || a.order - b.order || naturalCompare(a.name, b.name),
      );
    });

    app.post('/api/rooms', (req, reply) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#RoomCreate', req.body);
        if (!(await col('floors').get(body.floorId))) throw validation('樓層不存在', { floorId: body.floorId });
        const room = await col('rooms').insert({ id: newId('room'), floorId: body.floorId, name: body.name, order: body.order ?? 0 });
        emit('rooms', 'create', room.id);
        return reply.code(201).send(room);
      }),
    );

    app.patch('/api/rooms/:id', (req) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#RoomPatch', req.body);
        const existing = await col('rooms').get(req.params.id);
        if (!existing) throw notFound('找不到房間');
        if (body.floorId && !(await col('floors').get(body.floorId))) throw validation('樓層不存在', { floorId: body.floorId });
        const room = await col('rooms').update(existing.id, body);
        emit('rooms', 'update', room.id);
        if (body.floorId && body.floorId !== existing.floorId) {
          // 房間換樓層：房間內設備的 floorId 一併更新
          for (const d of await col('devices').list({ roomId: room.id })) {
            await col('devices').update(d.id, { floorId: room.floorId, updatedAt: nowIso() });
            emit('devices', 'update', d.id);
          }
        }
        return room;
      }),
    );

    app.delete('/api/rooms/:id', (req, reply) =>
      serial(async () => {
        const id = req.params.id;
        if (!(await col('rooms').get(id))) throw notFound('找不到房間');
        const devices = (await col('devices').list({ roomId: id })).length;
        if (devices) throw conflict(`房間仍有 ${devices} 台設備，無法刪除`, { devices });
        await col('rooms').remove(id);
        emit('rooms', 'delete', id);
        return reply.code(204).send();
      }),
    );

    // ---------------- 組別 ----------------
    app.get('/api/groups', async () => (await col('groups').list()).sort((a, b) => naturalCompare(a.name, b.name)));

    app.post('/api/groups', (req, reply) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#GroupCreate', req.body);
        const group = await col('groups').insert({ id: newId('grp'), name: body.name, color: body.color ?? DEFAULT_GROUP_COLOR });
        emit('groups', 'create', group.id);
        return reply.code(201).send(group);
      }),
    );

    app.patch('/api/groups/:id', (req) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#GroupPatch', req.body);
        if (!(await col('groups').get(req.params.id))) throw notFound('找不到組別');
        const group = await col('groups').update(req.params.id, body);
        emit('groups', 'update', group.id);
        return group;
      }),
    );

    app.delete('/api/groups/:id', (req, reply) =>
      serial(async () => {
        const id = req.params.id;
        if (!(await col('groups').get(id))) throw notFound('找不到組別');
        await col('groups').remove(id);
        emit('groups', 'delete', id);
        for (const d of await col('devices').list({ groupIds: id })) {
          await col('devices').update(d.id, { groupIds: d.groupIds.filter((g) => g !== id), updatedAt: nowIso() });
          emit('devices', 'update', d.id);
        }
        return reply.code(204).send();
      }),
    );

    // ---------------- 類別 ----------------
    app.get('/api/categories', async () => {
      const list = await col('categories').list();
      const rank = (c) => (seedIds.includes(c.id) ? seedIds.indexOf(c.id) : c.builtin ? seedIds.length : Infinity);
      return list.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra < rb ? -1 : 1;
        return ra === Infinity ? naturalCompare(a.name, b.name) : 0;
      });
    });

    app.post('/api/categories', (req, reply) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#CategoryCreate', req.body);
        const category = await col('categories').insert({
          id: newId('cat'),
          name: body.name,
          icon: body.icon ?? 'other',
          tier: body.tier,
          builtin: false,
          defaultMonitor: body.defaultMonitor ?? 'icmp',
        });
        emit('categories', 'create', category.id);
        return reply.code(201).send(category);
      }),
    );

    app.patch('/api/categories/:id', (req) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#CategoryPatch', req.body);
        const existing = await col('categories').get(req.params.id);
        if (!existing) throw notFound('找不到類別');
        if (existing.builtin && Object.keys(body).some((k) => k !== 'defaultMonitor')) {
          throw conflict('內建類別只能修改預設偵測方式');
        }
        const category = await col('categories').update(existing.id, body);
        emit('categories', 'update', category.id);
        return category;
      }),
    );

    app.delete('/api/categories/:id', (req, reply) =>
      serial(async () => {
        const id = req.params.id;
        const existing = await col('categories').get(id);
        if (!existing) throw notFound('找不到類別');
        if (existing.builtin) throw conflict('內建類別不可刪除');
        const devices = (await col('devices').list({ categoryId: id })).length;
        if (devices) throw conflict(`仍有 ${devices} 台設備使用此類別，無法刪除`, { devices });
        await col('categories').remove(id);
        emit('categories', 'delete', id);
        return reply.code(204).send();
      }),
    );

    // ---------------- 設備 ----------------
    /** 檢查本次寫入涉及的外鍵與關聯規則；patch 只檢查有帶的欄位 */
    async function checkDevice(next, changed, byId) {
      if (changed.has('categoryId') && !(await col('categories').get(next.categoryId))) {
        throw validation('設備類別不存在', { categoryId: next.categoryId });
      }
      if (changed.has('floorId') || changed.has('roomId')) {
        if (next.floorId && !(await col('floors').get(next.floorId))) throw validation('樓層不存在', { floorId: next.floorId });
        if (next.roomId) {
          const room = await col('rooms').get(next.roomId);
          if (!room) throw validation('房間不存在', { roomId: next.roomId });
          if (room.floorId !== next.floorId) throw validation('房間不屬於所選樓層', { floorId: next.floorId, roomId: next.roomId });
        }
      }
      if (changed.has('groupIds')) {
        const groups = new Set((await col('groups').list()).map((g) => g.id));
        const missing = next.groupIds.filter((g) => !groups.has(g));
        if (missing.length) throw validation('組別不存在', { groupIds: missing });
      }
      if (changed.has('code') && next.code) {
        const other = [...byId.values()].find((d) => d.id !== next.id && d.code === next.code);
        if (other) throw conflict(`編號 ${next.code} 已被「${other.name}」使用`, { code: next.code, deviceId: other.id });
      }
      if (changed.has('uplink') && next.uplink) {
        const up = next.uplink.deviceId;
        if (up === next.id) throw cycle('上游設備不可以是自己', { path: [next.id, next.id] });
        if (!byId.has(up)) throw validation('上游設備不存在', { uplink: { deviceId: up } });
        const loop = findUplinkCycle(byId, next.id, up);
        if (loop) throw cycle('上游設備不可形成迴圈', { path: loop });
      }
    }

    app.get('/api/devices', async (req) => {
      const query = ctx.validate('api-inventory#DeviceQuery', req.query ?? {});
      return sortDevices(filterDevices(await col('devices').list(), query));
    });

    app.post('/api/devices', (req, reply) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#DeviceCreate', req.body);
        const category = await col('categories').get(body.categoryId);
        if (!category) throw validation('設備類別不存在', { categoryId: body.categoryId });
        const device = buildDevice(body, { id: newId('dev'), category, now: nowIso(), defaultIntervalSec: readDefaultIntervalSec(ctx.dataDir) });
        const byId = await devicesById();
        await checkDevice(device, new Set(Object.keys(device)), byId);
        const saved = await col('devices').insert(device);
        emit('devices', 'create', saved.id);
        return reply.code(201).send(saved);
      }),
    );

    app.get('/api/devices/:id', async (req) => {
      const device = await col('devices').get(req.params.id);
      if (!device) throw notFound('找不到設備');
      return device;
    });

    app.patch('/api/devices/:id', (req) =>
      serial(async () => {
        const body = ctx.validate('api-inventory#DevicePatch', req.body);
        const existing = await col('devices').get(req.params.id);
        if (!existing) throw notFound('找不到設備');
        const next = { ...existing, ...body };
        if ('groupIds' in body) next.groupIds = [...body.groupIds];
        if ('uplink' in body) next.uplink = fillUplink(body.uplink);
        if ('monitor' in body) next.monitor = fillMonitor(body.monitor, await col('categories').get(next.categoryId), readDefaultIntervalSec(ctx.dataDir));
        next.updatedAt = nowIso();
        await checkDevice(next, new Set(Object.keys(body)), await devicesById());
        const saved = await col('devices').update(existing.id, next);
        emit('devices', 'update', saved.id);
        return saved;
      }),
    );

    app.delete('/api/devices/:id', (req, reply) =>
      serial(async () => {
        const id = req.params.id;
        if (!(await col('devices').get(id))) throw notFound('找不到設備');
        // 下游設備變成根節點；受影響的設備 id 以標頭回報（契約規定 DELETE 回 204，沒有本文）
        const detached = downstreamIds(await col('devices').list(), id, { directOnly: true });
        await col('devices').remove(id);
        emit('devices', 'delete', id);
        for (const childId of detached) {
          await col('devices').update(childId, { uplink: null, updatedAt: nowIso() });
          emit('devices', 'update', childId);
        }
        if (detached.length) reply.header('X-Detached-Devices', detached.join(','));
        return reply.code(204).send();
      }),
    );
  },

  /** 首次啟動：沒有任何類別時寫入內建類別（規格 §7） */
  async start(ctx) {
    const categories = ctx.store.collection('categories');
    if ((await categories.list()).length > 0) return;
    for (const c of readSeed('categories.json')) await categories.insert(c);
  },

  async stop() {},
};
