// 假 prober：monitor 模組的偵測以依賴注入取得 prober（ctx.prober），測試與 mock 模式不需要真實網路。
//
// prober 介面：probe({method, host, port?, path?, timeoutMs?}) → Promise<{up: boolean, rttMs: number|null}>
//   - 偵測失敗（對方沒回應）→ resolve {up:false, rttMs:null}
//   - 檢查本身出錯（指令不存在、權限不足）→ reject（monitor 會把狀態設為 unknown）

export function createFakeProber({ down = [], errorHosts = [], rttMs = 3, delayMs = 0 } = {}) {
  const downSet = new Set(down);
  const errorSet = new Set(errorHosts);
  const calls = [];
  return {
    calls,
    setDown(host, isDown = true) {
      if (isDown) downSet.add(host);
      else downSet.delete(host);
    },
    setError(host, isError = true) {
      if (isError) errorSet.add(host);
      else errorSet.delete(host);
    },
    async probe(req) {
      calls.push({ ...req });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (errorSet.has(req.host)) throw new Error(`fake prober：模擬 ${req.host} 檢查出錯`);
      if (downSet.has(req.host)) return { up: false, rttMs: null };
      return { up: true, rttMs };
    },
  };
}

/**
 * mock 模式用：依 fixtures 的 status.sample.json，讓狀態為 down 的設備偵測失敗、
 * unknown（且有 error）的設備偵測出錯，其餘成功。
 */
export function createMockProber(devices, statusList) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const down = [];
  const errorHosts = [];
  for (const s of statusList) {
    const ip = byId.get(s.deviceId)?.ip;
    if (!ip) continue;
    if (s.state === 'down') down.push(ip);
    else if (s.state === 'unknown' && s.error) errorHosts.push(ip);
  }
  return createFakeProber({ down, errorHosts });
}
