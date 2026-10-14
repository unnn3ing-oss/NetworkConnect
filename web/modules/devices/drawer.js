// 設備抽屜：完整資訊、狀態、上下游設備連結、編輯／刪除。
// 由 service.openDrawer() 在第一次需要時才載入。抽屜開著的期間 retain() service，確保資料與狀態是即時的。
import { h } from './dom.js';
import { categoryIconName, locationLabel, statusFor } from './logic.js';
import { monitorSummary, uplinkSummary } from './labels.js';

const fmtTime = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('zh-TW', { hour12: false });
};

export async function createDeviceDrawer(service) {
  const { createDrawer, createStatusDot, icon, iconNames } = await service.ui();
  const { state } = service;

  let opened = false;
  let currentId = null;
  let unsubscribe = null;
  let dot = null; // 目前顯示中的狀態燈（狀態事件只更新它，不重畫整個抽屜）

  const drawer = createDrawer({
    title: '設備',
    content: h('div'),
    onClose() {
      if (!opened) return;
      opened = false;
      currentId = null;
      dot = null;
      unsubscribe?.();
      unsubscribe = null;
      service.release();
    },
  });
  const isOpen = () => (typeof drawer.isOpen === 'function' ? drawer.isOpen() : Boolean(drawer.isOpen));

  const kvRow = (label, value) => [h('dt', {}, label), h('dd', {}, value || value === 0 ? value : h('span', { class: 'dv-muted' }, '—'))];

  function deviceLink(device, meta) {
    return h(
      'button',
      { type: 'button', class: 'dv-link', onclick: () => service.openDrawer(device.id).catch(service.reportError) },
      h('span', { class: 'dv-link-name' }, device.code ? `${device.code}　${device.name}` : device.name),
      meta ? h('span', { class: 'dv-link-meta' }, meta) : null,
    );
  }

  function statusNode(device) {
    const s = statusFor(device, state.status, state.monitorAvailable);
    if (s.na) {
      dot = null;
      return h('span', { class: 'dv-na', title: '尚未啟用連線偵測' }, '—');
    }
    dot = createStatusDot({ status: s.state, critical: s.critical, showLabel: true });
    return dot;
  }

  function build(device) {
    const category = state.categories.find((c) => c.id === device.categoryId);
    const groups = device.groupIds.map((id) => state.groups.find((g) => g.id === id)).filter(Boolean);
    const upstream = device.uplink ? state.devices.find((d) => d.id === device.uplink.deviceId) : null;
    const downstream = state.devices.filter((d) => d.uplink?.deviceId === device.id);

    const tags = groups.length
      ? h('span', { class: 'dv-tags' }, groups.map((g) => {
          const tag = h('span', { class: 'dv-tag' }, g.name);
          tag.style.setProperty('--tag', g.color);
          return tag;
        }))
      : null;

    const upstreamNode = !device.uplink
      ? h('span', { class: 'dv-muted' }, '無（根節點）')
      : upstream
        ? deviceLink(upstream, uplinkSummary(device.uplink))
        : h('span', { class: 'dv-muted' }, `找不到上游設備（${device.uplink.deviceId}）`);

    return h(
      'div',
      { class: 'dv-drawer' },
      h(
        'div',
        { class: 'dv-d-head' },
        h('span', { class: 'dv-d-icon' }, icon(categoryIconName(category, iconNames), { size: 28 })),
        h('div', { class: 'dv-d-title' }, h('div', { class: 'dv-d-cat' }, category?.name ?? '未知類別'), h('div', { class: 'dv-d-status' }, statusNode(device))),
      ),
      h(
        'dl',
        { class: 'dv-kv' },
        kvRow('編號', device.code),
        kvRow('位置', locationLabel(device, state.floors, state.rooms)),
        kvRow('組別', tags),
        kvRow('IP', device.ip),
        kvRow('MAC', device.mac),
        kvRow('主機名稱', device.hostname),
        kvRow('廠牌型號', [device.vendor, device.model].filter(Boolean).join(' ')),
        kvRow('偵測', monitorSummary(device.monitor)),
        kvRow('說明', device.notes ? h('span', { class: 'dv-notes' }, device.notes) : ''),
        kvRow('建立／更新', [fmtTime(device.createdAt), fmtTime(device.updatedAt)].filter(Boolean).join('　／　')),
      ),
      h('h3', { class: 'dv-d-sub' }, '上游設備'),
      h('div', { class: 'dv-d-links' }, upstreamNode),
      h('h3', { class: 'dv-d-sub' }, `下游設備（${downstream.length}）`),
      h(
        'div',
        { class: 'dv-d-links' },
        downstream.length ? downstream.map((d) => deviceLink(d, uplinkSummary(d.uplink))) : h('span', { class: 'dv-muted' }, '沒有下游設備'),
      ),
      h(
        'div',
        { class: 'dv-d-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => service.openWizard({ device }).catch(service.reportError) }, '編輯'),
        h('button', { type: 'button', class: 'btn', onclick: () => service.placeOnPlan(device.id) }, '放到平面圖'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            onclick: async () => {
              if (await service.deleteDevice(device.id)) drawer.close();
            },
          },
          '刪除',
        ),
      ),
    );
  }

  function render() {
    const device = state.devices.find((d) => d.id === currentId);
    if (!device) {
      dot = null;
      drawer.setTitle('設備');
      drawer.setContent(
        h('div', { class: 'dv-drawer' }, h('p', {}, '找不到這台設備，可能已被刪除。'), h('button', { type: 'button', class: 'btn', onclick: () => drawer.close() }, '關閉')),
      );
      return;
    }
    drawer.setTitle(device.name);
    drawer.setContent(build(device));
  }

  return {
    isOpen,
    open(id) {
      currentId = id;
      if (!opened) {
        opened = true;
        service.retain();
        unsubscribe = service.subscribe((kind, deviceId) => {
          if (kind === 'status') {
            const device = state.devices.find((d) => d.id === currentId);
            if (!device || !dot || (deviceId && deviceId !== currentId)) return;
            const s = statusFor(device, state.status, state.monitorAvailable);
            if (!s.na) dot.update({ status: s.state, critical: s.critical });
            return;
          }
          render();
        });
      }
      render();
      if (!isOpen()) drawer.open();
    },
    close() {
      if (isOpen()) drawer.close();
    },
  };
}
