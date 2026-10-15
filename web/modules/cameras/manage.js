// NVR 管理抽屜：列出已設定的 NVR，可編輯（開啟精靈）或刪除。
import { h } from './dom.js';

/**
 * @param {object} ctx
 * @param {object} uiLib
 * @param {{onEdit: (nvr: object) => void, onAdd: () => void, onChanged: () => void}} hooks
 */
export async function openManager(ctx, uiLib, { onEdit, onAdd, onChanged }) {
  const { api } = ctx;
  const { createDrawer, confirm, toast } = uiLib;
  const list = h('div', { class: 'cam-mgr-list' });
  const drawer = createDrawer({
    title: 'NVR 管理',
    content: h('div', { class: 'cam-mgr' }, list, h('button', { type: 'button', class: 'btn primary', 'data-action': 'mgr-add', onclick: () => { drawer.close(); onAdd(); } }, '新增 NVR')),
  });

  async function paint() {
    let nvrs;
    try {
      nvrs = await api.get('/api/nvrs');
    } catch (err) {
      list.replaceChildren(h('p', { class: 'cam-error' }, err?.message ?? String(err)));
      return;
    }
    if (!nvrs.length) {
      list.replaceChildren(h('p', { class: 'cam-muted' }, '還沒有設定任何 NVR。'));
      return;
    }
    list.replaceChildren(...nvrs.map((nvr) => h('section', { class: 'cam-mgr-item card', 'data-id': nvr.id },
      h('div', { class: 'cam-mgr-main' },
        h('strong', {}, nvr.name),
        h('small', { class: 'cam-muted' }, `${nvr.host}:${nvr.port} · ${nvr.channels.filter((c) => c.enabled).length}/${nvr.channelCount} 頻道 · ${nvr.hasPassword ? '已設定密碼' : '尚未設定密碼'}`)),
      h('div', { class: 'cam-mgr-actions' },
        h('button', { type: 'button', class: 'btn small', 'data-action': 'mgr-edit', onclick: () => { drawer.close(); onEdit(nvr); } }, '編輯'),
        h('button', {
          type: 'button', class: 'btn small danger', 'data-action': 'mgr-delete',
          onclick: async () => {
            const ok = await confirm({ title: `刪除「${nvr.name}」？`, message: '會一併刪除這台 NVR 儲存的密碼與頻道設定。設備清單中的設備不受影響。', danger: true, okText: '刪除' });
            if (!ok) return;
            try {
              await api.delete(`/api/nvrs/${nvr.id}`);
              toast?.success?.('已刪除');
              onChanged();
              await paint();
            } catch (err) {
              toast?.error?.(err?.message ?? String(err));
            }
          },
        }, '刪除')))));
  }

  await paint();
  drawer.open();
  return drawer;
}
