// 顯示用文字（繁中）。
export const MEDIUM_LABELS = Object.freeze({ ethernet: '有線', wifi: 'Wi-Fi', mesh: 'Mesh', poe: 'PoE', fiber: '光纖', other: '其他' });
export const METHOD_LABELS = Object.freeze({ icmp: 'Ping（ICMP）', tcp: 'TCP 埠', http: 'HTTP', none: '不偵測' });
export const TIER_LABELS = Object.freeze({ core: '核心', distribution: '匯聚', access: '接取', endpoint: '終端' });

export const ICON_LABELS = Object.freeze({
  modem: '數據機', router: '路由器', mesh: 'Mesh', switch: '交換器', 'poe-switch': 'PoE 交換器', ap: '基地台', nvr: 'NVR', camera: '攝影機',
  computer: '電腦', phone: '手機', tv: '電視', 'smart-home': '智慧家電', printer: '印表機', nas: 'NAS', other: '其他',
});

/** 偵測設定的一行摘要，例：「HTTP :8080/status · 每 30 秒 · 關鍵設備」 */
export function monitorSummary(m) {
  if (!m || m.method === 'none') return METHOD_LABELS.none;
  let head = METHOD_LABELS[m.method] ?? m.method;
  if (m.method === 'tcp') head = `TCP 埠 ${m.port ?? ''}`.trim();
  if (m.method === 'http') head = `HTTP ${m.port ? `:${m.port}` : ''}${m.path || '/'}`;
  return [head, `每 ${m.intervalSec} 秒`, m.critical ? '關鍵設備' : null].filter(Boolean).join(' · ');
}

/** 上游連線的一行摘要，例：「LAN1 ↔ WAN · 有線 · 1G」 */
export function uplinkSummary(u) {
  if (!u) return '';
  const ports = u.port || u.localPort ? `${u.port || '—'} ↔ ${u.localPort || '—'}` : '';
  return [ports, MEDIUM_LABELS[u.medium] ?? u.medium, u.speed].filter(Boolean).join(' · ');
}
