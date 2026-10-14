// 機密資料：<dataDir>/secrets.json（{ 'nvr:<id>': '<password>', 'auth': '<hash>', ... }）
// 非 Windows 平台權限 600；Windows 靠使用者個人資料夾的 ACL。
import fs from 'node:fs';
import path from 'node:path';

export function createSecrets(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'secrets.json');
  const isWin = process.platform === 'win32';
  /** @type {Record<string, string>} */
  let map = {};

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
    else throw new Error('內容不是物件');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      map = {};
    }
  }

  let chain = Promise.resolve();
  function persist() {
    const json = JSON.stringify(map, null, 2) + '\n';
    chain = chain
      .catch(() => {})
      .then(async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, json, isWin ? undefined : { mode: 0o600 });
        if (!isWin) await fs.promises.chmod(tmp, 0o600); // 不受 umask 影響
        await fs.promises.rename(tmp, file);
      });
    return chain;
  }

  return {
    get: (key) => map[key],
    has: (key) => Object.prototype.hasOwnProperty.call(map, key),
    all: () => ({ ...map }),
    async set(key, value) {
      if (typeof value !== 'string') throw new TypeError('機密值必須是字串');
      map[key] = value;
      await persist();
    },
    async delete(key) {
      if (!(key in map)) return false;
      delete map[key];
      await persist();
      return true;
    },
  };
}
