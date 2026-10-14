// 匯入／匯出子頁：JSON 備份下載與還原、CSV 匯入精靈（上傳 → 預覽報告 → 確認寫入）。
import { h } from './dom.js';

const COLLECTION_LABELS = { floors: '樓層', rooms: '房間', groups: '組別', categories: '類別', devices: '設備', plans: '平面圖', placements: '落點', nvrs: 'NVR', statusHistory: '狀態歷史' };
const MAX_LISTED = 50;

/** 匯入報告（CsvImportReport）的畫面：數量、略過的列、未對應的類別、警告 */
export function renderCsvReport(report) {
  const { created, skipped, unmatchedCategories, warnings } = report;
  const list = (items, render) => {
    const shown = items.slice(0, MAX_LISTED).map((x) => h('li', {}, render(x)));
    if (items.length > MAX_LISTED) shown.push(h('li', { class: 'dv-muted' }, `…還有 ${items.length - MAX_LISTED} 筆`));
    return h('ul', { class: 'dv-report-list' }, shown);
  };
  return h(
    'div',
    { class: 'dv-report' },
    h('p', { class: 'dv-report-sum' }, `${report.dryRun ? '將新增' : '已新增'} ${created.devices} 台設備、${created.floors} 個樓層、${created.rooms} 個房間。`),
    skipped.length ? h('div', {}, h('h4', { class: 'dv-sub-title' }, `略過 ${skipped.length} 列`), list(skipped, (s) => `第 ${s.row} 列：${s.reason}`)) : null,
    unmatchedCategories.length
      ? h('div', {}, h('h4', { class: 'dv-sub-title' }, `${unmatchedCategories.length} 台設備的類別對不到，已歸入「其他」`), list(unmatchedCategories, (u) => `第 ${u.row} 列「${u.name}」：類別欄是「${u.category || '（空白）'}」`))
      : null,
    warnings.length ? h('div', {}, h('h4', { class: 'dv-sub-title' }, `提醒 ${warnings.length} 則`), list(warnings, (w) => w)) : null,
  );
}

/**
 * @returns {Promise<{destroy(): void}>}
 */
export async function mountIo(host, service) {
  const { ctx } = service;
  const { api } = ctx;
  const { confirm, toast, createWizard, box, kv } = await service.ui();

  const resultBox = h('div', { class: 'dv-result', 'aria-live': 'polite' });
  const showResult = (title, node) => resultBox.replaceChildren(h('section', { class: 'card dv-sec' }, h('h3', { class: 'dv-sec-title' }, title), node));

  // ------------------------------------------------------------ 匯出
  const withSecrets = h('input', { type: 'checkbox', onchange: syncLink });
  const link = h('a', { class: 'btn primary', download: '' }, '下載備份（JSON）');
  function syncLink() {
    link.href = api.url('/api/export', { secrets: withSecrets.checked ? 1 : 0 });
  }
  syncLink();

  // ------------------------------------------------------------ 匯入 JSON
  const jsonFile = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '選擇備份檔' });
  const jsonButton = h('button', { type: 'button', class: 'btn danger', onclick: () => importJson().catch(service.reportError) }, '還原備份…');

  async function importJson() {
    const file = jsonFile.files?.[0];
    if (!file) {
      toast.warn('請先選擇備份檔（.json）');
      return;
    }
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error('這不是有效的 JSON 檔案');
      return;
    }
    const sums = Object.entries(data?.collections ?? {})
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${COLLECTION_LABELS[k] ?? k} ${v.length}`)
      .join('、');
    const ok = await confirm({
      title: '用這份備份取代目前所有資料？',
      message: `備份內容：${sums || '（無法辨識）'}。${data?.includesSecrets ? '備份含 NVR 密碼。' : ''}匯入前會先完整檢查，有任何錯誤都不會寫入；成功後現有的設備、樓層、平面圖等資料會被取代。`,
      danger: true,
      okText: '取代並匯入',
    });
    if (!ok) return;
    jsonButton.disabled = true;
    try {
      const r = await api.post('/api/import', data);
      toast.success('備份已匯入');
      showResult('備份已匯入', h('p', {}, Object.entries(r.counts).map(([k, n]) => `${COLLECTION_LABELS[k] ?? k} ${n}`).join('、')));
      await service.load();
    } catch (err) {
      const details = Array.isArray(err.details) ? err.details : [];
      showResult(
        '匯入失敗，沒有寫入任何資料',
        h(
          'div',
          {},
          h('p', {}, err.message),
          details.length
            ? h('ul', { class: 'dv-report-list' }, [
                ...details.slice(0, MAX_LISTED).map((d) => h('li', {}, `${d.instancePath || '/'} ${d.message ?? ''}`.trim())),
                details.length > MAX_LISTED ? h('li', { class: 'dv-muted' }, `…還有 ${details.length - MAX_LISTED} 筆`) : null,
              ])
            : null,
        ),
      );
    } finally {
      jsonButton.disabled = false;
    }
  }

  // ------------------------------------------------------------ CSV 精靈
  function openCsvWizard() {
    const upload = (file, dryRun) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      return api.upload(`/api/import/csv?dryRun=${dryRun ? 1 : 0}`, fd, 'POST');
    };

    const wizard = createWizard({
      title: 'CSV 匯入',
      initialState: { file: null, report: null, reportError: '', previewing: false },
      steps: [
        {
          id: 'upload',
          label: '上傳',
          render(state) {
            const name = h('p', { class: 'dv-muted' }, state.file ? `已選擇：${state.file.name}` : '尚未選擇檔案');
            const input = h('input', {
              type: 'file', accept: '.csv,text/csv', 'aria-label': '選擇 CSV 檔',
              onchange: (e) => {
                state.file = e.target.files?.[0] ?? null;
                state.report = null;
                state.reportError = '';
                name.textContent = state.file ? `已選擇：${state.file.name}` : '尚未選擇檔案';
              },
            });
            return h(
              'div',
              { class: 'nc-stack' },
              box(
                '支援舊 Google Sheet「設備清單」',
                h('div', {}, h('p', {}, '第一列必須是標題列，欄位順序不拘；至少要有「名稱」。可用欄位：編號、名稱、類別、上游編號、位置、連線方式、IP、MAC、速率、說明、分區、階層、定位編號、上游端口、下游端口。'), h('p', {}, '檔案請存成 UTF-8 編碼。只會新增設備，不會修改或覆蓋現有設備；編號已存在的列會略過。')),
              ),
              input,
              name,
            );
          },
          validate: (state) => (state.file ? null : '請選擇要匯入的 CSV 檔'),
        },
        {
          id: 'preview',
          label: '預覽',
          render(state) {
            const out = h('div', { class: 'nc-stack' });
            const paint = () => {
              if (state.report) out.replaceChildren(renderCsvReport(state.report));
              else if (state.reportError) out.replaceChildren(h('p', { class: 'dv-error' }, state.reportError));
              else out.replaceChildren(h('p', { class: 'dv-muted' }, '分析檔案中…'));
            };
            paint();
            if (!state.report && !state.previewing) {
              state.previewing = true;
              state.reportError = '';
              upload(state.file, true)
                .then((r) => { state.report = r; })
                .catch((err) => { state.reportError = err.message; })
                .finally(() => {
                  state.previewing = false;
                  paint();
                });
            }
            return out;
          },
          validate(state) {
            if (state.previewing) return '正在分析檔案，請稍候';
            if (state.reportError) return `${state.reportError}（請回到上一步更換檔案）`;
            if (!state.report) return '尚未取得預覽';
            const c = state.report.created;
            return c.devices + c.floors + c.rooms === 0 ? '沒有可匯入的內容（請檢查略過的原因）' : null;
          },
        },
        {
          id: 'confirm',
          label: '確認',
          render(state) {
            const r = state.report;
            return h(
              'div',
              { class: 'nc-stack' },
              kv([
                ['檔案', state.file?.name ?? ''],
                ['新增設備', `${r.created.devices} 台`],
                ['新增樓層', `${r.created.floors} 個`],
                ['新增房間', `${r.created.rooms} 個`],
                ['略過', `${r.skipped.length} 列`],
                ['類別歸入「其他」', `${r.unmatchedCategories.length} 台`],
              ]),
              h('p', { class: 'dv-muted' }, '按「送出」後才會真正寫入。'),
            );
          },
        },
      ],
      async onSubmit(state) {
        const report = await upload(state.file, false);
        toast.success(`已匯入 ${report.created.devices} 台設備`);
        showResult('CSV 匯入完成', renderCsvReport(report));
        await service.load();
      },
    });
    wizard.open();
    return wizard;
  }

  host.replaceChildren(
    h(
      'div',
      { class: 'dv-manage' },
      h(
        'section',
        { class: 'card dv-sec' },
        h('h3', { class: 'dv-sec-title' }, 'CSV 匯入'),
        h('p', { class: 'dv-muted' }, '從舊的設備清單（Google Sheet 匯出的 CSV）一次建立多台設備；匯入前會先預覽報告，不會直接寫入。'),
        h('div', { class: 'dv-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: openCsvWizard }, '開始 CSV 匯入')),
      ),
      h(
        'section',
        { class: 'card dv-sec' },
        h('h3', { class: 'dv-sec-title' }, '備份（JSON）'),
        h('p', { class: 'dv-muted' }, '匯出全部資料（設備、樓層、房間、組別、類別、平面圖、NVR 設定）。預設不含密碼。'),
        h('label', { class: 'dv-check' }, withSecrets, h('span', {}, '包含 NVR 密碼（備份檔要妥善保管）')),
        h('div', { class: 'dv-actions' }, link),
        h('hr', { class: 'dv-hr' }),
        h('p', { class: 'dv-muted' }, '還原備份會取代目前所有資料，建議先下載一份目前的備份。'),
        h('div', { class: 'dv-actions' }, jsonFile, jsonButton),
      ),
      resultBox,
    ),
  );

  return {
    destroy() {
      host.replaceChildren();
    },
  };
}
