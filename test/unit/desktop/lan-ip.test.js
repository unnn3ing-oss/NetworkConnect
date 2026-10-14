import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLanAddresses, pickPrimaryLanIp, buildMobileUrls } from '../../../desktop/lib/lan-ip.js';

const v4 = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`, ...extra });
const v6 = (address) => ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: `${address}/64`, scopeid: 0 });

test('只取 IPv4，並排除 loopback、IPv6、169.254.x.x', () => {
  const ifaces = {
    lo0: [v4('127.0.0.1', { internal: true }), v6('::1')],
    en0: [v6('fe80::1'), v4('192.168.1.20'), v4('169.254.10.5')],
  };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['192.168.1.20']);
});

test('排除虛擬網卡（docker、vmnet、utun、vEthernet、tailscale…）', () => {
  const ifaces = {
    docker0: [v4('172.17.0.1')],
    'br-1a2b3c': [v4('172.18.0.1')],
    veth12ab: [v4('172.19.0.1')],
    vmnet8: [v4('192.168.233.1')],
    vboxnet0: [v4('192.168.56.1')],
    utun3: [v4('10.8.0.2')],
    'vEthernet (WSL)': [v4('172.28.0.1')],
    'VMware Network Adapter VMnet1': [v4('192.168.100.1')],
    Tailscale: [v4('100.101.102.103')],
    tailscale0: [v4('100.64.0.9')],
    awdl0: [v4('10.0.0.9')],
    'Wi-Fi': [v4('192.168.0.15')],
  };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['192.168.0.15']);
});

test('Windows／macOS 常見的實體網卡名稱不會被誤判為虛擬', () => {
  const ifaces = {
    'Local Area Connection': [v4('192.168.1.5')],
    'Ethernet 2': [v4('10.0.0.5')],
    en0: [v4('172.16.0.5')],
  };
  assert.equal(pickLanAddresses(ifaces).length, 3);
});

test('私有網段優先順序：192.168 > 10 > 172.16–31 > 其他', () => {
  const ifaces = {
    en3: [v4('203.0.113.7')],
    en2: [v4('172.20.1.5')],
    en1: [v4('10.0.0.8')],
    en0: [v4('192.168.1.2')],
  };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['192.168.1.2', '10.0.0.8', '172.20.1.5', '203.0.113.7']);
});

test('172.32 以上不算私有網段（排在 172.16–31 之後）', () => {
  const ifaces = { a: [v4('172.32.0.1')], b: [v4('172.31.0.1')] };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['172.31.0.1', '172.32.0.1']);
});

test('同一優先級保持原本順序，且相同位址只出現一次', () => {
  const ifaces = { en0: [v4('192.168.1.2')], en5: [v4('192.168.1.9'), v4('192.168.1.2')] };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['192.168.1.2', '192.168.1.9']);
});

test('支援舊版 Node 的 family 數字 4，並容忍空值', () => {
  const ifaces = { en0: [{ address: '192.168.1.2', family: 4, internal: false }], bad: undefined, empty: [] };
  assert.deepEqual(pickLanAddresses(ifaces).map((a) => a.address), ['192.168.1.2']);
  assert.deepEqual(pickLanAddresses(undefined), []);
});

test('pickPrimaryLanIp：無可用網卡時回 null', () => {
  assert.equal(pickPrimaryLanIp({ lo0: [v4('127.0.0.1', { internal: true })] }), null);
  assert.equal(pickPrimaryLanIp({ en0: [v4('10.1.1.1'), v4('192.168.5.5')] }), '192.168.5.5');
});

test('buildMobileUrls：組出手機網址；關閉區網連線時回空陣列', () => {
  const ifaces = { en0: [v4('192.168.1.2')], en1: [v4('10.0.0.3')] };
  assert.deepEqual(buildMobileUrls({ interfaces: ifaces, port: 8780, lanAccess: true }), ['http://192.168.1.2:8780', 'http://10.0.0.3:8780']);
  assert.deepEqual(buildMobileUrls({ interfaces: ifaces, port: 8780, lanAccess: false }), []);
});
