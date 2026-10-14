// io 模組（B1）：JSON 匯出入與 CSV 匯入（contracts/api.md §7）。
// io 不擁有任何 collection：整批匯入走 ctx.store.restore()（規格 §7 唯一例外），先全部驗證、再一次寫入。
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { validation } from '../../core/errors.js';
import { planCsvImport } from './csv.js';
import { checkIntegrity, mergeBuiltinCategories } from './integrity.js';

const EXPORT_COLLECTIONS = ['floors', 'rooms', 'groups', 'categories', 'devices', 'plans', 'placements', 'nvrs'];
const INVENTORY_COLLECTIONS = ['floors', 'rooms', 'groups', 'categories', 'devices'];
const NVR_SECRET_KEY = /^nvr:(nvr_[A-Za-z0-9_-]+)$/;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const isSafeFileName = (f) => typeof f === 'string' && f !== '.' && f !== '..' && path.basename(f) === f;

export default {
  name: 'io',
  owns: [],
  async check(ctx) {},

  async register(app, ctx) {
    const plansDir = path.join(ctx.dataDir, 'plans');
    const list = (name) => ctx.store.collection(name).list();

    // ---------------------------------------------------------------- 匯出
    app.get('/api/export', async (req, reply) => {
      const { secrets: secretsFlag = '0', ...rest } = req.query ?? {};
      if (Object.keys(rest).length || !['0', '1'].includes(secretsFlag)) throw validation('secrets 只能是 0 或 1');
      const withSecrets = secretsFlag === '1';

      const collections = {};
      for (const name of EXPORT_COLLECTIONS) collections[name] = await list(name);

      // 平面圖檔以 base64 內嵌；圖檔遺失的 plan 無法備份，略過並記錄
      const planFiles = {};
      collections.plans = collections.plans.filter((plan) => {
        try {
          if (!isSafeFileName(plan.file)) throw new Error('檔名不合法');
          planFiles[plan.file] = fs.readFileSync(path.join(plansDir, plan.file)).toString('base64');
          return true;
        } catch (err) {
          ctx.log.warn(`匯出時找不到 ${plan.floorId} 的平面圖檔（${plan.file}）：${err.message}`);
          return false;
        }
      });

      const out = { format: 'networkconnect-export', version: 1, exportedAt: new Date().toISOString(), includesSecrets: withSecrets, collections, planFiles };
      if (withSecrets) {
        out.secrets = Object.fromEntries(Object.entries(ctx.secrets.all()).filter(([k]) => !k.startsWith('auth')));
      }
      reply.header('Content-Disposition', `attachment; filename="networkconnect-${localDate()}.json"`);
      return out;
    });

    // ---------------------------------------------------------------- 匯入（整批）
    app.post('/api/import', async (req) => {
      const body = req.body;
      ctx.validate('api-io#Export', body); // schema 錯誤：details 為所有 ajv 錯誤
      const data = { ...body, collections: { ...body.collections, categories: mergeBuiltinCategories(body.collections.categories) } };
      const problems = checkIntegrity(data);
      if (problems.length) throw validation(`匯入資料有 ${problems.length} 處錯誤，未寫入任何資料`, problems);

      const before = {
        plans: await list('plans'),
        floors: await list('floors'),
        nvrs: await list('nvrs'),
        statusHistory: await list('statusHistory'),
      };

      const snapshot = {};
      for (const name of EXPORT_COLLECTIONS) snapshot[name] = data.collections[name];
      // 備份預設不含狀態歷史：保留仍存在設備的歷史，避免還原後歷史全空
      const deviceIds = new Set(snapshot.devices.map((d) => d.id));
      snapshot.statusHistory = data.collections.statusHistory ?? before.statusHistory.filter((h) => deviceIds.has(h.deviceId));

      // 圖檔先寫到暫存資料夾，store 寫入成功後才搬到定位；失敗就整個丟掉
      fs.mkdirSync(plansDir, { recursive: true });
      const stage = path.join(plansDir, `.import-${nanoid(8)}`);
      fs.mkdirSync(stage);
      try {
        for (const plan of snapshot.plans) fs.writeFileSync(path.join(stage, plan.file), Buffer.from(data.planFiles[plan.file], 'base64'));
        await ctx.store.restore(snapshot);
        for (const plan of snapshot.plans) fs.renameSync(path.join(stage, plan.file), path.join(plansDir, plan.file));
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
      const keep = new Set(snapshot.plans.map((p) => p.file));
      for (const old of before.plans) {
        if (!keep.has(old.file) && isSafeFileName(old.file)) fs.rmSync(path.join(plansDir, old.file), { force: true });
      }

      // 密碼：含 secrets 時寫入 nvr:*（忽略 auth 類）；已不存在的 NVR 其密碼一併清掉
      const nvrIds = new Set(snapshot.nvrs.map((n) => n.id));
      for (const key of Object.keys(ctx.secrets.all())) {
        const m = NVR_SECRET_KEY.exec(key);
        if (m && !nvrIds.has(m[1])) await ctx.secrets.delete(key);
      }
      if (data.includesSecrets && data.secrets) {
        for (const [key, value] of Object.entries(data.secrets)) {
          const m = NVR_SECRET_KEY.exec(key);
          if (m && nvrIds.has(m[1])) await ctx.secrets.set(key, value);
        }
      }

      for (const collection of INVENTORY_COLLECTIONS) ctx.events.emit('inventory.changed', { collection, op: 'update', id: '*' });
      const floorIds = new Set([...before.floors.map((f) => f.id), ...snapshot.floors.map((f) => f.id)]);
      for (const floorId of floorIds) ctx.events.emit('plan.changed', { floorId });
      ctx.events.emit('nvr.changed', { id: '*' });

      return { ok: true, counts: Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, v.length])) };
    });

    // ---------------------------------------------------------------- 匯入 CSV
    app.post('/api/import/csv', async (req) => {
      const { dryRun: dryRunFlag = '0', ...rest } = req.query ?? {};
      if (Object.keys(rest).length || !['0', '1'].includes(dryRunFlag)) throw validation('dryRun 只能是 0 或 1');
      const dryRun = dryRunFlag === '1';

      if (!req.isMultipart()) throw validation('請以 multipart/form-data 上傳 CSV 檔（欄位名稱 file）');
      const part = await req.file();
      if (!part || part.fieldname !== 'file') throw validation('找不到上傳的檔案（欄位名稱必須是 file）');
      const buffer = await part.toBuffer();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw validation('檔案不是 UTF-8 編碼，請另存為 UTF-8 的 CSV');
      }

      // 以一份快照為基準規劃，規劃完立刻整批寫回（中間沒有 await，避免與其他寫入交錯）
      const snap = await ctx.store.snapshot();
      const plan = planCsvImport(
        text,
        { floors: snap.floors, rooms: snap.rooms, devices: snap.devices, categories: mergeBuiltinCategories(snap.categories) },
        { now: new Date().toISOString(), newId: (prefix) => `${prefix}_${nanoid(10)}` },
      );
      const report = { dryRun, ...plan.report };
      if (dryRun || plan.devices.length + plan.floors.length + plan.rooms.length === 0) return report;

      snap.floors.push(...plan.floors);
      snap.rooms.push(...plan.rooms);
      snap.devices.push(...plan.devices);
      await ctx.store.restore(snap);

      for (const [collection, docs] of [['floors', plan.floors], ['rooms', plan.rooms], ['devices', plan.devices]]) {
        for (const doc of docs) ctx.events.emit('inventory.changed', { collection, op: 'create', id: doc.id });
      }
      return report;
    });
  },

  async start(ctx) {},
  async stop() {},
};
