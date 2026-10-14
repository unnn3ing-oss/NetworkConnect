// 區網 IP 挑選：純函式，輸入 os.networkInterfaces() 的結果。
// 規則：只取 IPv4；排除 loopback、169.254.x.x（link-local）、虛擬網卡；私有網段優先（192.168 > 10 > 172.16–31 > 其他）。

/** 常見虛擬網卡名稱（Docker、VM、VPN、macOS 系統介面、WSL／Hyper-V） */
const VIRTUAL_NAME = new RegExp(
  [
    '^(lo\\d*$|docker|br-|veth|virbr|vmnet|vboxnet|utun|awdl|llw|anpi|ap\\d|gif|stf|bridge\\d|tun|tap|ppp|zt|wg)',
    'vethernet',
    'vmware',
    'virtualbox',
    'hyper-v',
    'tailscale',
    'zerotier',
    'wsl',
    'loopback',
    'bluetooth',
  ].join('|'),
  'i',
);

const isIPv4 = (a) => a && (a.family === 'IPv4' || a.family === 4);

function privateRank(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * @param {Record<string, Array<{address: string, family: string|number, internal?: boolean}>|undefined>} interfaces
 * @returns {Array<{name: string, address: string}>} 依優先級排序
 */
export function pickLanAddresses(interfaces) {
  const seen = new Set();
  const out = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    if (!Array.isArray(list) || VIRTUAL_NAME.test(name)) continue;
    for (const a of list) {
      if (!isIPv4(a) || a.internal) continue;
      if (a.address.startsWith('169.254.') || a.address.startsWith('127.') || a.address === '0.0.0.0') continue;
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      out.push({ name, address: a.address, rank: privateRank(a.address) });
    }
  }
  // Array.prototype.sort 為穩定排序，同優先級維持原順序
  out.sort((x, y) => x.rank - y.rank);
  return out.map(({ name, address }) => ({ name, address }));
}

/** @returns {string|null} */
export function pickPrimaryLanIp(interfaces) {
  return pickLanAddresses(interfaces)[0]?.address ?? null;
}

/** 手機連線網址；關閉區網連線（只綁 127.0.0.1）時沒有可用網址。 */
export function buildMobileUrls({ interfaces, port, lanAccess }) {
  if (!lanAccess) return [];
  return pickLanAddresses(interfaces).map((a) => `http://${a.address}:${port}`);
}
