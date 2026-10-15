// floorplan 模組（B4）：樓層平面圖上傳／讀取與設備落點（contracts/api.md §5）。
// 圖檔存放於 <dataDir>/plans/<plan.file>（契約；任務書寫的 data/uploads/plans 以契約為準）。
import fs from 'node:fs';
import path from 'node:path';
import { notFound, validation } from '../../core/errors.js';
import { detectImage, extMatches, ImageError } from './image.js';

const MAX_BYTES = 10 * 1024 * 1024;
const FLOOR_ID = /^flr_[A-Za-z0-9_-]{1,32}$/;
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

let offs = [];
const clamp01 = (n) => Math.min(1, Math.max(0, n));

export default {
  name: 'floorplan',
  owns: ['plans', 'placements'],

  async check(ctx) {
    fs.mkdirSync(path.join(ctx.dataDir, 'plans'), { recursive: true });
  },

  async register(app, ctx) {
    const plansDir = path.join(ctx.dataDir, 'plans');
    const plans = ctx.store.collection('plans');
    const placements = ctx.store.collection('placements');
    const floors = ctx.store.collection('floors');
    const devices = ctx.store.collection('devices');

    const requireFloor = async (floorId) => {
      if (!FLOOR_ID.test(floorId) || !(await floors.get(floorId))) throw notFound('找不到樓層');
    };
    const unlinkQuiet = (file) => fs.promises.rm(path.join(plansDir, file), { force: true }).catch(() => {});

    // ---------------------------------------------------------------- 平面圖
    app.get('/api/plans', async () => (await plans.list()).sort((a, b) => a.floorId.localeCompare(b.floorId)));

    app.put('/api/plans/:floorId', async (req) => {
      const { floorId } = req.params;
      await requireFloor(floorId);
      if (!req.isMultipart()) throw validation('請以 multipart/form-data 上傳，檔案欄位名為 file');

      let part;
      let buf;
      try {
        part = await req.file();
        if (!part) throw validation('沒有收到檔案（欄位名 file）');
        if (part.fieldname !== 'file') throw validation('檔案欄位名必須是 file');
        buf = await part.toBuffer(); // 超過 10MB 會丟 FST_REQ_FILE_TOO_LARGE
      } catch (err) {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.code === 'FST_FILES_LIMIT') throw validation('檔案超過 10 MB 上限');
        throw err;
      }
      if (part.file?.truncated || buf.length > MAX_BYTES) throw validation('檔案超過 10 MB 上限');
      if (buf.length === 0) throw validation('檔案是空的');

      let info;
      try {
        info = detectImage(buf);
      } catch (err) {
        if (err instanceof ImageError) throw validation(err.message);
        throw err;
      }
      if (!extMatches(part.filename, info)) throw validation('檔案內容與副檔名不符');

      const file = `${floorId}.${info.ext}`;
      const old = await plans.get(floorId);
      const tmp = path.join(plansDir, `.${file}.${process.pid}.tmp`);
      await fs.promises.mkdir(plansDir, { recursive: true });
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, path.join(plansDir, file));
      const plan = await plans.upsert({ floorId, file, mime: info.mime, width: info.width, height: info.height, updatedAt: new Date().toISOString() });
      if (old && old.file !== file) await unlinkQuiet(old.file);
      ctx.events.emit('plan.changed', { floorId });
      return plan; // 換圖時 placements 不動（座標為比例）
    });

    app.get(
      '/api/plans/:floorId/image',
      {
        // 全域 onSend 會設定站台 CSP；路由層 hook 在它之後執行，所以這裡覆寫成圖檔專用的最嚴格設定
        onSend: async (req, reply) => {
          reply.header('Content-Security-Policy', IMAGE_CSP);
        },
      },
      async (req, reply) => {
        const plan = await plans.get(req.params.floorId);
        if (!plan) throw notFound('這個樓層沒有平面圖');
        let data;
        try {
          data = await fs.promises.readFile(path.join(plansDir, plan.file));
        } catch {
          throw notFound('平面圖檔案遺失，請重新上傳');
        }
        reply
          .header('Content-Type', plan.mime)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'no-cache')
          .header('Content-Security-Policy', IMAGE_CSP);
        return reply.send(data);
      },
    );

    app.delete('/api/plans/:floorId', async (req, reply) => {
      const { floorId } = req.params;
      const plan = await plans.get(floorId);
      if (!plan) throw notFound('這個樓層沒有平面圖');
      await plans.remove(floorId);
      await unlinkQuiet(plan.file);
      ctx.events.emit('plan.changed', { floorId });
      return reply.code(204).send();
    });

    // ---------------------------------------------------------------- 落點
    app.get('/api/placements', async (req) => {
      const q = ctx.validate('api-floorplan#PlacementQuery', req.query ?? {});
      return placements.list(q.floorId ? { floorId: q.floorId } : undefined);
    });

    app.put('/api/placements/:deviceId', async (req) => {
      const { deviceId } = req.params;
      const body = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
      // 座標夾在 0–1（拖到圖外緣時不報錯）
      if (body && typeof body === 'object') for (const k of ['x', 'y']) if (Number.isFinite(body[k])) body[k] = clamp01(body[k]);
      const data = ctx.validate('api-floorplan#PlacementPut', body);
      if (!(await devices.get(deviceId))) throw notFound('找不到設備');
      await requireFloor(data.floorId);
      const placement = await placements.upsert({ deviceId, floorId: data.floorId, x: data.x, y: data.y });
      ctx.events.emit('placement.changed', { deviceId, floorId: placement.floorId });
      return placement;
    });

    app.delete('/api/placements/:deviceId', async (req, reply) => {
      const { deviceId } = req.params;
      const cur = await placements.get(deviceId);
      if (!cur) throw notFound('這台設備沒有落點');
      await placements.remove(deviceId);
      ctx.events.emit('placement.changed', { deviceId, floorId: cur.floorId });
      return reply.code(204).send();
    });
  },

  async start(ctx) {
    const plans = ctx.store.collection('plans');
    const placements = ctx.store.collection('placements');
    const plansDir = path.join(ctx.dataDir, 'plans');

    async function dropPlacement(p) {
      await placements.remove(p.deviceId);
      ctx.events.emit('placement.changed', { deviceId: p.deviceId, floorId: p.floorId });
    }

    const devices = ctx.store.collection('devices');

    // 樓層被刪：刪除該層的 plan（含圖檔）與所有 placements；設備被刪：刪除其 placement；
    // 設備換樓層（直接改或因房間搬樓層）：舊樓層的 placement 已不對，刪掉讓它回到新樓層的「未放置」清單
    const onInventory = async (p) => {
      if (!p || p.id === '*') return;
      if (p.op === 'update' && p.collection === 'devices') {
        try {
          const pl = await placements.get(p.id);
          if (!pl) return;
          const d = await devices.get(p.id);
          if (d?.floorId && d.floorId !== pl.floorId) await dropPlacement(pl); // 沒指定樓層的設備不動
        } catch (err) {
          ctx.log.error({ err }, `floorplan 清理失敗：${err.message}`);
        }
        return;
      }
      if (p.op !== 'delete') return;
      try {
        if (p.collection === 'floors') {
          const plan = await plans.get(p.id);
          if (plan) {
            await plans.remove(p.id);
            await fs.promises.rm(path.join(plansDir, plan.file), { force: true });
            ctx.events.emit('plan.changed', { floorId: p.id });
          }
          for (const pl of await placements.list({ floorId: p.id })) await dropPlacement(pl);
        } else if (p.collection === 'devices') {
          const pl = await placements.get(p.id);
          if (pl) await dropPlacement(pl);
        }
      } catch (err) {
        ctx.log.error({ err }, `floorplan 清理失敗：${err.message}`);
      }
    };
    offs.push(ctx.events.on('inventory.changed', onInventory));
  },

  async stop() {
    for (const off of offs.splice(0)) off();
  },
};
