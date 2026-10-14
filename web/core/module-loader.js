// 前端模組載入（規格 §5.2）：逐一 import；失敗的模組標記 error，其他照常。
// 掛載時以 try/catch 包住 mount()，失敗只在該分頁顯示錯誤卡。
import { renderErrorCard } from './cards.js';

/** 前端模組（規格 §9）；目錄為 /modules/<id>/index.js */
export const DEFAULT_MODULES = Object.freeze(['dashboard', 'devices', 'topology', 'floorplan', 'cameras', 'status', 'settings', 'onboarding']);

/** 模組檔案本身載入失敗時，導覽列仍需要的標題與路由 */
const FALLBACK = {
  dashboard: { title: '總覽', order: 10 },
  devices: { title: '設備', order: 20 },
  topology: { title: '架構圖', order: 30 },
  floorplan: { title: '平面圖', order: 40 },
  cameras: { title: '監視器', order: 50 },
  status: { title: '狀態', order: 60 },
  settings: { title: '設定', order: 90 },
  onboarding: { title: '首次導覽', order: 99 },
};

const defaultImporter = (id) => import(`/modules/${id}/index.js`);

function validate(id, mod) {
  if (!mod || typeof mod !== 'object') throw new Error('模組沒有 default export');
  if (mod.id !== id) throw new Error(`模組 id「${mod.id}」與目錄名稱「${id}」不符`);
  if (typeof mod.mount !== 'function') throw new Error('模組必須實作 mount(el, ctx)');
  if (typeof mod.route !== 'string' || !/^#\/[\w-]+$/.test(mod.route)) throw new Error(`route 格式必須是 "#/名稱"（收到 ${mod.route}）`);
}

/**
 * @returns {Promise<Array<{id: string, title: string, icon: string, route: string, order: number, nav: boolean, showFilters: boolean, requires: string[], mod: object|null, error: Error|null}>>}
 */
export async function loadFrontModules({ ids = DEFAULT_MODULES, importer = defaultImporter } = {}) {
  const entries = [];
  for (const id of ids) {
    const fb = FALLBACK[id] ?? { title: id, order: 100 };
    try {
      const imported = await importer(id);
      const mod = imported?.default;
      validate(id, mod);
      entries.push({
        id,
        title: mod.title ?? fb.title,
        icon: mod.icon ?? id,
        route: mod.route,
        order: Number.isFinite(mod.order) ? mod.order : fb.order,
        nav: mod.nav !== false,
        showFilters: mod.showFilters !== false,
        requires: Array.isArray(mod.requires) ? mod.requires : [],
        mod,
        error: null,
      });
    } catch (err) {
      entries.push({
        id, title: fb.title, icon: id, route: `#/${id}`, order: fb.order,
        nav: id !== 'onboarding', showFilters: false, requires: [], mod: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return entries.sort((a, b) => a.order - b.order);
}

/** 模組宣告的 requires（後端模組名稱）有 failed／disabled 時回傳原因，否則 null；拿不到後端狀態時不擋 */
export function findBackendProblem(requires, backend) {
  for (const name of requires ?? []) {
    const b = backend.find((m) => m.name === name);
    if (!b) continue;
    if (b.state === 'failed') return `後端模組 ${name} 載入失敗：${b.error ?? '未知原因'}`;
    if (b.state === 'disabled') return `後端模組 ${name} 已停用（可在 config.json 的 modules 重新開啟）`;
  }
  return null;
}

/**
 * 掛載一個模組到 el。任何失敗都只在 el 內顯示錯誤卡，不丟出例外。
 * @returns {Promise<{unmount: () => void}>}
 */
export async function mountEntry(entry, el, ctx, { backend = [], onRetry, log = console } = {}) {
  const none = { unmount() {} };
  if (entry.error) {
    log.error(`模組 ${entry.id} 載入失敗`, entry.error);
    renderErrorCard(el, { title: entry.title, message: `載入失敗：${entry.error.message}`, error: entry.error, onRetry });
    return none;
  }
  const problem = findBackendProblem(entry.requires, backend);
  if (problem) {
    renderErrorCard(el, { title: entry.title, message: problem, onRetry });
    return none;
  }
  try {
    await entry.mod.mount(el, ctx);
  } catch (err) {
    log.error(`模組 ${entry.id} mount 失敗`, err);
    try {
      entry.mod.unmount?.(); // 清掉可能已經註冊一半的監聽與計時器
    } catch {
      // 清理失敗不必再報
    }
    renderErrorCard(el, { title: entry.title, message: err?.message ?? String(err), error: err, onRetry });
    return none;
  }
  return {
    unmount() {
      try {
        entry.mod.unmount?.();
      } catch (err) {
        log.error(`模組 ${entry.id} unmount 失敗`, err);
      }
    },
  };
}
