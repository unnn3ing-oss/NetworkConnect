// 契約入口：載入 contracts/schemas 下所有 JSON Schema，提供驗證器。
// 前後端、測試與各模組都從這裡取得 schema，避免各自重複載入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMAS_DIR = path.join(here, 'schemas');
export const FIXTURES_DIR = path.join(here, 'fixtures');
export const SEED_DIR = path.join(here, 'seed');
export const SCHEMA_BASE = 'https://networkconnect.local/schemas/';

/** collection 名稱 → schema 名稱（單筆紀錄） */
export const COLLECTION_SCHEMAS = Object.freeze({
  floors: 'floor',
  rooms: 'room',
  groups: 'group',
  categories: 'category',
  devices: 'device',
  plans: 'plan',
  placements: 'placement',
  statusHistory: 'status-history',
  nvrs: 'nvr',
});

/** 所有 schema 檔的絕對路徑（依檔名排序） */
export function listSchemaFiles() {
  return fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((f) => path.join(SCHEMAS_DIR, f));
}

/** 讀入所有 schema 物件 */
export function loadSchemas() {
  return listSchemaFiles().map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
}

/**
 * 建立驗證器。
 * ref 寫法：'device'（整份 schema）或 'api-inventory#DeviceCreate'（該檔 $defs 內的定義）。
 * 回傳 { ajv, validate(ref, data) → {valid, errors}, assert(ref, data) }。
 */
export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  for (const s of loadSchemas()) ajv.addSchema(s);

  const resolve = (ref) => {
    const [file, def] = String(ref).split('#');
    const id = `${SCHEMA_BASE}${file}.schema.json${def ? `#/$defs/${def}` : ''}`;
    const fn = ajv.getSchema(id);
    if (!fn) throw new Error(`找不到 schema：${ref}`);
    return fn;
  };

  return {
    ajv,
    validate(ref, data) {
      const fn = resolve(ref);
      const valid = fn(data) === true;
      return { valid, errors: valid ? [] : [...fn.errors] };
    },
    assert(ref, data) {
      const r = this.validate(ref, data);
      if (!r.valid) {
        const err = new Error(`資料不符合 ${ref}：${ajv.errorsText(r.errors)}`);
        err.errors = r.errors;
        throw err;
      }
    },
  };
}

/** 讀取 fixtures / seed 的 JSON */
export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}
export function readSeed(name) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
}
