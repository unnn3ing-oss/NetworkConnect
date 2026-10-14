// ICMP（呼叫系統 ping）。規格 §8.1 的跨平台規則：
//   Windows  ping -n 1 -w 1000 <ip>   輸出含 TTL= 才算成功（結束碼 0 不可靠）；時間用 [=<](\d+)ms 擷取
//   macOS    ping -c 1 -W 1000 <ip>   結束碼 0；-W 單位是毫秒
//   Linux    ping -c 1 -W 1    <ip>   結束碼 0；-W 單位是秒
// 一律使用 execFile（參數陣列，不經 shell），IP 先驗證成標準 IPv4。
import { execFile as nodeExecFile } from 'node:child_process';
import net from 'node:net';

/** 只接受標準 IPv4（四段十進位、無前導 0）。其他字串（含任何 shell 字元）一律拒絕。 */
export function isValidIp(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  return ip.split('.').every((p) => p === String(Number(p)));
}

/** 依平台組出 ping 參數（純函式）。IP 不合法時丟錯。 */
export function pingArgs(platform, ip) {
  if (!isValidIp(ip)) throw new TypeError(`IP 格式不正確：${JSON.stringify(ip)}`);
  if (platform === 'win32') return ['-n', '1', '-w', '1000', ip];
  if (platform === 'darwin') return ['-c', '1', '-W', '1000', ip];
  return ['-c', '1', '-W', '1', ip];
}

/** macOS 的 GUI 程式 PATH 可能很精簡，用絕對路徑最穩 */
export function pingCommand(platform) {
  return platform === 'darwin' ? '/sbin/ping' : 'ping';
}

const TIME_WIN = /[=<]\s*(\d+(?:\.\d+)?)\s*ms/i;
const TIME_UNIX = /time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i;

/**
 * 解析 ping 輸出（純函式）→ {ok, rttMs}。rttMs 無法解析時為 null。
 * Windows：只看輸出有沒有 TTL=（路由器回「目的地主機無法連線」時結束碼仍為 0，但輸出沒有 TTL）。
 */
export function parsePing(platform, stdout, exitCode) {
  const text = String(stdout ?? '');
  if (platform === 'win32') {
    if (!/TTL=/i.test(text)) return { ok: false, rttMs: null };
    const m = TIME_WIN.exec(text);
    return { ok: true, rttMs: m ? Number(m[1]) : null };
  }
  if (exitCode !== 0) return { ok: false, rttMs: null };
  const m = TIME_UNIX.exec(text);
  return { ok: true, rttMs: m ? Number(m[1]) : null };
}

const PERMISSION = /operation not permitted|permission denied|not permitted|access is denied|socket:/i;

/**
 * @param {{host: string, timeoutMs?: number}} req
 * @param {{platform?: string, execFile?: Function, now?: () => number}} [deps]
 * @returns {Promise<{ok: boolean, rttMs: number|null, error?: string}>}
 *   error 只在「檢查本身出錯」時出現（指令不存在、沒有權限、IP 不合法）；對方沒回應是 ok:false 無 error。
 */
export async function probe(req, { platform = process.platform, execFile = nodeExecFile, now = Date.now } = {}) {
  let args;
  try {
    args = pingArgs(platform, req?.host);
  } catch (err) {
    return { ok: false, rttMs: null, error: err.message };
  }
  const started = now();
  return new Promise((resolve) => {
    const opts = { timeout: Math.max(3000, (req.timeoutMs ?? 1000) + 2000), windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 };
    execFile(pingCommand(platform), args, opts, (err, stdout = '', stderr = '') => {
      if (err && err.code === 'ENOENT') {
        resolve({ ok: false, rttMs: null, error: '找不到 ping 指令，無法使用 ICMP 偵測' });
        return;
      }
      const exitCode = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const out = `${stdout}\n${stderr}`;
      const parsed = parsePing(platform, stdout, exitCode);
      if (parsed.ok) {
        resolve({ ok: true, rttMs: parsed.rttMs ?? Math.max(0, now() - started) });
        return;
      }
      if (err && !err.killed && PERMISSION.test(out)) {
        resolve({ ok: false, rttMs: null, error: `ping 無法執行（${out.trim().split('\n')[0]}）` });
        return;
      }
      resolve({ ok: false, rttMs: null });
    });
  });
}

/** 偵測本機是否能執行 ping（對 127.0.0.1 試一次）。 */
export async function detectPing(deps = {}) {
  const r = await probe({ host: '127.0.0.1', timeoutMs: 1000 }, deps);
  return r.error ? { available: false, reason: r.error } : { available: true };
}
