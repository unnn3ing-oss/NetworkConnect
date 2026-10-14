// 設定：<dataDir>/config.json（schema 見 contracts/schemas/config.schema.json）
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  port: 8780,
  lanAccess: true,
  modules: Object.freeze({ inventory: true, io: true, monitor: true, floorplan: true, nvr: true }),
  go2rtcPath: null,
  go2rtcUrl: 'http://127.0.0.1:1984',
});

/**
 * 決定資料夾：startServer({dataDir}) > 環境變數 NC_DATA_DIR > <cwd>/data（mock 模式為 <cwd>/data-mock）
 */
export function resolveDataDir({ dataDir, env = process.env, cwd = process.cwd(), mock = false } = {}) {
  const chosen = dataDir || env.NC_DATA_DIR || path.join(cwd, mock ? 'data-mock' : 'data');
  return path.resolve(cwd, chosen);
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_CONFIG;
  const modules = { ...d.modules };
  if (src.modules && typeof src.modules === 'object') {
    for (const k of Object.keys(modules)) if (typeof src.modules[k] === 'boolean') modules[k] = src.modules[k];
  }
  return {
    port: Number.isInteger(src.port) && src.port >= 0 && src.port <= 65535 ? src.port : d.port,
    lanAccess: typeof src.lanAccess === 'boolean' ? src.lanAccess : d.lanAccess,
    modules,
    go2rtcPath: typeof src.go2rtcPath === 'string' && src.go2rtcPath ? src.go2rtcPath : null,
    go2rtcUrl: typeof src.go2rtcUrl === 'string' && src.go2rtcUrl ? src.go2rtcUrl : d.go2rtcUrl,
  };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 讀取設定；不存在就用預設值建立。損毀時改名備份並回到預設值。 */
export function loadConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let raw;
  let exists = true;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      exists = false;
    } else {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      exists = false;
    }
  }
  const cfg = normalize(raw);
  if (!exists) writeAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function saveConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  writeAtomic(path.join(dataDir, 'config.json'), JSON.stringify(normalize(config), null, 2) + '\n');
}
