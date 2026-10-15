// NVR 設定精靈（5 步）：品牌 → 連線 → 測試 → 頻道 → 確認。
//
// 「測試」需要一台已存在的 NVR（POST /api/nvrs/:id/test），所以進入測試時才建立（或更新）NVR 紀錄；
// 測試成功會直接播放第 1 頻道子碼流 3 秒並擷取一張縮圖。中途取消時，這次新建的 NVR 會被刪除。
import { h, sleep } from './dom.js';
import { connectPlayer, captureThumbnail, createPlayer } from './player.js';
import {
  applyBrand, connectionPayload, connectionSignature, describeTest, ensureChannels, newWizardState, previewUrl, stateFromNvr,
  streamName, validateChannels, validateConnection, wsPath,
} from './logic.js';
import { createRtspGuide } from './guide.js';

const PREVIEW_MS = 3000;
const CAMERA_CATEGORY = 'cat_camera';
const NVR_CATEGORY = 'cat_nvr';

const deviceLabel = (d) => [d.code, d.name, d.ip].filter(Boolean).join('　');

/**
 * @param {object} ctx  shell 的 ctx
 * @param {object} uiLib ctx.ui.load() 的結果
 * @param {{nvr?: object|null, onDone?: (nvr: object) => void, onClose?: () => void}} [opts]
 */
export async function openNvrWizard(ctx, uiLib, { nvr = null, onDone, onClose } = {}) {
  const { api } = ctx;
  const { createWizard, opGroup, box, kv, field, toast } = uiLib;
  const editing = Boolean(nvr);

  const [templates, cameras, nvrDevices] = await Promise.all([
    api.get('/api/nvr/templates'),
    api.get('/api/devices', { query: { categoryId: CAMERA_CATEGORY } }).catch(() => []),
    api.get('/api/devices', { query: { categoryId: NVR_CATEGORY } }).catch(() => []),
  ]);
  const templateOf = (id) => templates.find((t) => t.id === id);

  const initial = editing ? stateFromNvr(nvr, templates) : newWizardState(templates);
  let submitted = false;
  let previewPlayer = null;
  let closed = false;
  let testPanel = null;
  let runToken = 0;

  const stopPreview = () => {
    previewPlayer?.stop();
    previewPlayer = null;
  };

  // ------------------------------------------------------------ 步驟 1：品牌
  function renderBrand(state) {
    const note = h('p', { class: 'cam-wz-note' });
    const paintNote = () => {
      note.textContent = templateOf(state.brand)?.notes ?? '';
    };
    const group = opGroup({
      options: templates.map((t) => ({ value: t.id, label: t.name.replace(/（.*）/, '') })),
      value: state.brand,
      ariaLabel: '品牌',
      onChange: (id) => {
        applyBrand(state, templateOf(id), templateOf(state.brand));
        paintNote();
      },
    });
    paintNote();
    return h('div', { class: 'nc-stack' },
      h('p', { class: 'cam-muted' }, '選擇 NVR（或攝影機）的品牌，程式會帶入該品牌的 RTSP 路徑。不在清單內請選「自訂」。'),
      group.el,
      box('這個品牌要注意', note),
      guideButton());
  }

  function guideButton() {
    return h('button', {
      type: 'button', class: 'btn small cam-wz-guide', 'data-action': 'rtsp-guide',
      onclick: () => createRtspGuide(uiLib, templates).open(),
    }, '怎麼找 RTSP 設定？');
  }

  // ------------------------------------------------------------ 步驟 2：連線
  function renderConnect(state) {
    const preview = h('code', { class: 'cam-wz-preview' });
    const paintPreview = () => {
      preview.textContent = previewUrl(state, templateOf(state.brand), 'sub', 1) || '（請填入自訂 URL）';
    };
    const nodes = [
      field(state, { name: 'name', label: 'NVR 名稱', placeholder: '例：家用 NVR', required: true }),
      field(state, { name: 'host', label: '主機位址', placeholder: '192.168.1.20', hint: 'NVR 的 IP 或網域名稱（不含 rtsp://）', required: true }),
      field(state, { name: 'port', label: 'RTSP 埠', type: 'number', hint: '預設 554。如果你在 NVR 改過 RTSP 埠，請填改過的號碼（不是網頁或手機 App 用的埠）', required: true }),
      field(state, { name: 'username', label: '帳號', required: true }),
      field(state, {
        name: 'password', label: '密碼', type: 'password', required: !editing,
        hint: editing ? '留空代表不變更。密碼只存在這台電腦。' : '可含 @ # : / 等符號。密碼只存在這台電腦，不會顯示在網頁上。',
      }),
      field(state, { name: 'channelCount', label: '頻道數', type: 'number', hint: 'NVR 接了幾支攝影機（例如 8 路 NVR 填 8）', required: true }),
    ];
    if (state.brand === 'custom') {
      nodes.push(
        field(state, { name: 'urlTemplate', label: '自訂 RTSP 網址', placeholder: 'rtsp://{u}:{p}@{host}:{port}/路徑{ch}/{s}', hint: '已帶入剛才所選品牌的網址，只要改不同的地方。可用 {u} {p} {host} {port} {ch} {ch:02}（兩位數）{s}（碼流）', required: true }),
        field(state, { name: 'streamMain', label: '主碼流代號（{s}）', required: true }),
        field(state, { name: 'streamSub', label: '子碼流代號（{s}）', required: true }),
      );
    }
    if (nvrDevices.length) {
      nodes.push(field(state, {
        name: 'deviceId', label: '對應的 NVR 設備（選填）', type: 'select',
        options: [{ value: '', label: '（不連結）' }, ...nvrDevices.map((d) => ({ value: d.id, label: deviceLabel(d) }))],
        hint: '連結到設備清單中的 NVR，方便從設備頁跳到這裡。',
      }));
    }
    const form = h('div', { class: 'cam-wz-form' }, nodes);
    form.addEventListener('input', paintPreview);
    paintPreview();
    return h('div', { class: 'nc-stack' },
      form,
      box('預覽：第 1 頻道子碼流', h('div', {}, preview, h('small', { class: 'cam-muted' }, '（密碼以 **** 代替）'))),
      guideButton());
  }

  // ------------------------------------------------------------ 步驟 3：測試
  async function ensureDraft(state) {
    const body = connectionPayload(state);
    if (!state.nvrId) {
      const created = await api.post('/api/nvrs', body);
      state.nvrId = created.id;
      state.created = true;
      state.channels = created.channels;
      return created;
    }
    const patched = await api.patch(`/api/nvrs/${state.nvrId}`, body);
    state.channels = patched.channels;
    return patched;
  }

  async function playPreview(state, panel, token) {
    const box_ = panel.querySelector('.cam-test-video');
    stopPreview();
    const player = createPlayer(() => {});
    previewPlayer = player;
    box_.replaceChildren(player);
    connectPlayer(player, wsPath(streamName(state.nvrId, 1, 'sub')));
    await sleep(PREVIEW_MS);
    if (token !== runToken || closed) return;
    state.test.thumbnail = captureThumbnail(player);
    stopPreview();
    box_.replaceChildren();
    paintTest(state, panel);
  }

  function paintTest(state, panel) {
    const t = state.test;
    const info = t.status === 'done' ? describeTest(t.result) : null;
    const status = panel.querySelector('.cam-test-status');
    status.className = `cam-test-status ${info ? info.kind : t.status}`;
    status.replaceChildren(
      ...(t.status === 'running'
        ? [h('strong', {}, '測試中…'), h('span', {}, '正在建立連線並取得影像資訊（最多 8 秒）')]
        : info
          ? [h('strong', {}, info.title), h('span', {}, info.text)]
          : t.status === 'saved'
          ? [h('strong', {}, '沿用已儲存的設定'), h('span', {}, '連線設定沒有變更，可以直接下一步。想確認連線仍可用，按「開始測試」。')]
          : [h('strong', {}, '尚未測試'), h('span', {}, '按「開始測試」連線第 1 頻道的子碼流。')]),
    );
    const thumb = panel.querySelector('.cam-test-thumb');
    thumb.replaceChildren(t.thumbnail ? h('img', { src: t.thumbnail, alt: '第 1 頻道縮圖', class: 'cam-thumb' }) : '');
    thumb.hidden = !t.thumbnail;
    panel.querySelector('[data-action="run-test"]').disabled = t.status === 'running';
    panel.querySelector('[data-action="run-test"]').textContent = t.status === 'done' ? '重新測試' : '開始測試';
    const skip = panel.querySelector('.cam-test-skip');
    skip.hidden = !(t.status === 'done' && !t.result?.ok);
  }

  async function runTest(state, panel) {
    if (state.test.status === 'running') return;
    const token = ++runToken;
    const signature = connectionSignature(state);
    stopPreview();
    state.test = { status: 'running', result: null, thumbnail: '', signature };
    paintTest(state, panel);
    let result;
    try {
      await ensureDraft(state);
      result = await api.post(`/api/nvrs/${state.nvrId}/test`, { channel: 1 });
    } catch (err) {
      result = { ok: false, error: err?.message ?? String(err) };
    }
    if (token !== runToken || closed) return;
    state.test = { status: 'done', result, thumbnail: '', signature };
    state.hasPassword = true;
    paintTest(state, panel);
    if (result.ok) await playPreview(state, panel, token);
  }

  function renderTest(state) {
    const status = h('div', { class: 'cam-test-status idle', role: 'status' });
    const button = h('button', { type: 'button', class: 'btn primary', 'data-action': 'run-test', onclick: () => runTest(state, panel) }, '開始測試');
    const skip = h('label', { class: 'cam-check cam-test-skip', hidden: true },
      h('input', { type: 'checkbox', checked: state.skipTest, onchange: (e) => { state.skipTest = e.target.checked; } }),
      h('span', {}, '略過測試，仍要繼續（例如 NVR 目前沒開機）'));
    const panel = h('div', { class: 'nc-stack cam-test' },
      h('p', { class: 'cam-muted' }, '程式會短暫連線第 1 頻道的子碼流。成功時會播放 3 秒並擷取一張縮圖；失敗會告訴你原因。'),
      status,
      h('div', { class: 'cam-test-media' }, h('div', { class: 'cam-test-video cam-video' }), h('div', { class: 'cam-test-thumb', hidden: true })),
      h('div', { class: 'cam-test-actions' }, button, skip),
      guideButton());
    testPanel = panel;
    paintTest(state, panel);
    // 進入此步驟時，連線設定有變更（或還沒測過）就自動測一次
    if (state.test.status !== 'running' && state.test.signature !== connectionSignature(state)) queueMicrotask(() => runTest(state, panel));
    return panel;
  }

  function validateTest(state) {
    const t = state.test;
    if (t.status === 'running') return '測試進行中，請稍候';
    if (t.status === 'saved') return t.signature === connectionSignature(state) ? null : '連線設定已變更，請重新測試';
    if (t.status !== 'done') return '請先完成連線測試';
    if (t.signature !== connectionSignature(state)) return '連線設定已變更，請重新測試';
    if (!t.result?.ok && !state.skipTest) return '連線測試未通過。請回上一步修正，或勾選「略過測試，仍要繼續」';
    return null;
  }

  // ------------------------------------------------------------ 步驟 4：頻道
  function renderChannels(state) {
    ensureChannels(state);
    const rows = state.channels.map((c) => {
      const select = h('select', { class: 'input cam-ch-device', 'aria-label': `CH${c.ch} 連結的攝影機設備`, onchange: (e) => { c.deviceId = e.target.value || null; } },
        h('option', { value: '' }, '（不連結）'),
        ...cameras.map((d) => h('option', { value: d.id, selected: c.deviceId === d.id }, deviceLabel(d))));
      return h('tr', {},
        h('td', {}, h('input', { type: 'checkbox', checked: c.enabled, 'aria-label': `啟用 CH${c.ch}`, onchange: (e) => { c.enabled = e.target.checked; } })),
        h('td', { class: 'cam-ch-no' }, `CH${c.ch}`),
        h('td', {}, h('input', { class: 'input', value: c.name, maxlength: '100', 'aria-label': `CH${c.ch} 名稱`, oninput: (e) => { c.name = e.target.value; } })),
        cameras.length ? h('td', {}, select) : null);
    });
    return h('div', { class: 'nc-stack' },
      h('p', { class: 'cam-muted' }, '替每個頻道取名（例如「前門」），不想顯示的頻道可以取消勾選。連結到 IP 攝影機設備後，可以從設備頁或平面圖直接跳到該畫面。'),
      h('div', { class: 'cam-table-wrap' },
        h('table', { class: 'cam-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '啟用'), h('th', {}, '頻道'), h('th', {}, '名稱'), cameras.length ? h('th', {}, '攝影機設備') : null)),
          h('tbody', {}, rows))));
  }

  // ------------------------------------------------------------ 步驟 5：確認
  function renderConfirm(state) {
    const enabled = state.channels.filter((c) => c.enabled);
    const t = state.test;
    return h('div', { class: 'nc-stack' },
      kv([
        ['NVR 名稱', state.name],
        ['品牌', templateOf(state.brand)?.name ?? state.brand],
        ['位址', `${state.host.trim()}:${state.port}`],
        ['帳號', state.username],
        ['密碼', state.password || (state.hasPassword ? '（沿用已儲存的密碼）' : '')],
        ['頻道', `${state.channels.length} 個，顯示 ${enabled.length} 個：${enabled.map((c) => c.name).join('、')}`],
        ['連線測試', t.result?.ok ? `成功（${t.result.codec === 'h264' ? 'H.264' : t.result.codec}）` : t.status === 'saved' ? '未重新測試（沿用已儲存的設定）' : state.skipTest ? '未通過（已略過）' : '—'],
      ]),
      t.thumbnail ? h('img', { src: t.thumbnail, alt: '第 1 頻道縮圖', class: 'cam-thumb' }) : null,
      t.result?.warning ? h('p', { class: 'cam-wz-warn' }, t.result.warning) : null,
      h('p', { class: 'cam-muted' }, '按「送出」完成設定，監視器頁會立刻出現畫面。'));
  }

  // ------------------------------------------------------------ 精靈
  const wizard = createWizard({
    title: editing ? '編輯 NVR' : '新增 NVR',
    initialState: initial,
    steps: [
      { id: 'brand', label: '品牌', render: renderBrand },
      { id: 'connect', label: '連線', render: renderConnect, validate: (s) => validateConnection(s, { editing: editing || Boolean(s.nvrId) }) },
      { id: 'test', label: '測試', render: renderTest, validate: validateTest },
      { id: 'channels', label: '頻道', render: renderChannels, validate: validateChannels },
      { id: 'confirm', label: '確認', render: renderConfirm },
    ],
    async onSubmit(state) {
      const saved = await api.patch(`/api/nvrs/${state.nvrId}`, {
        name: state.name.trim() || '家用 NVR',
        deviceId: state.deviceId || null,
        channels: state.channels.map((c) => ({ ch: c.ch, name: c.name.trim() || `頻道 ${c.ch}`, deviceId: c.deviceId || null, enabled: c.enabled })),
      });
      submitted = true;
      toast?.success?.(editing ? 'NVR 設定已更新' : 'NVR 已新增');
      cleanup();
      onDone?.(saved);
    },
    async onCancel() {
      cleanup();
      // 新增流程中途取消：刪掉為了測試而建立的草稿 NVR
      const s = wizard.state;
      if (!submitted && s.created && s.nvrId) {
        await api.delete(`/api/nvrs/${s.nvrId}`).catch(() => {});
      }
      onClose?.();
    },
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    runToken++;
    stopPreview();
    testPanel = null;
  }

  // 編輯既有 NVR：連線設定沒變就視為已測試過，不強迫重測
  if (editing) {
    wizard.state.test = { status: 'saved', result: null, thumbnail: '', signature: connectionSignature(wizard.state) };
  }
  wizard.open();
  return {
    wizard,
    /** 外部（模組 unmount）強制關閉並清理 */
    async dispose() {
      if (closed) return;
      wizard.close();
      cleanup();
      const s = wizard.state;
      if (!submitted && s.created && s.nvrId) await api.delete(`/api/nvrs/${s.nvrId}`).catch(() => {});
    },
  };
}
