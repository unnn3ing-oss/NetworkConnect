// mock 模式（NC_MOCK=1）：從 contracts/fixtures 載入資料到 dataDir（預設 data-mock/），
// 並提供假 prober、假 go2rtc。不碰真實的 data/。
// 假 prober／假 go2rtc 放在 test/helpers（測試與 mock 共用）；只有 mock 模式才會動態載入它們。
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, readFixture } from '../../contracts/index.js';

/** 把 fixtures 整批寫入 store、複製平面圖、寫入 NVR 假密碼。每次啟動都重置。 */
export async function seedMock({ store, secrets, dataDir }) {
  const db = readFixture('db.sample.json');
  await store.restore(db);
  await store.flush();

  const plansDir = path.join(dataDir, 'plans');
  fs.rmSync(plansDir, { recursive: true, force: true });
  fs.mkdirSync(plansDir, { recursive: true });
  for (const plan of db.plans) {
    fs.copyFileSync(path.join(FIXTURES_DIR, 'plan.sample.png'), path.join(plansDir, plan.file));
  }
  for (const nvr of db.nvrs) await secrets.set(`nvr:${nvr.id}`, 'mock-password');
  return db;
}

/** 啟動 mock 需要的假服務；呼叫端負責在 stop 時呼叫 go2rtc.close() */
export async function startMockServices(db) {
  const { createMockProber } = await import('../../test/helpers/fake-prober.js');
  const { createFakeGo2rtc } = await import('../../test/helpers/fake-go2rtc.js');
  const prober = createMockProber(db.devices, readFixture('status.sample.json'));
  const go2rtc = await createFakeGo2rtc();
  return { prober, go2rtc };
}
