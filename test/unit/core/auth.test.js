import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createAuth, hashPassword, verifyPassword } from '../../../server/core/auth.js';
import { createSecrets } from '../../../server/core/secrets.js';
import { createValidatorFn } from '../../../server/core/validate.js';
import { installErrorHandler } from '../../../server/core/errors.js';
import { makeTmpDir, cleanupAllTmpDirs } from '../../helpers/tmp.js';

afterEach(cleanupAllTmpDirs);

async function boot(opts = {}) {
  const secrets = createSecrets(makeTmpDir());
  const auth = createAuth({ secrets, validate: createValidatorFn(), failDelayMs: 0, ...opts });
  const app = Fastify();
  installErrorHandler(app);
  await auth.register(app);
  app.get('/api/secret', async () => ({ data: 1 }));
  app.get('/api/system/health', async () => ({ ok: true }));
  app.get('/index.html', async () => 'html');
  await app.ready();
  return { app, auth, secrets };
}

const cookieOf = (res) => {
  const c = res.headers['set-cookie'];
  const line = Array.isArray(c) ? c[0] : c;
  return line ? line.split(';')[0] : null;
};

describe('密碼雜湊', () => {
  test('scrypt 雜湊可驗證，錯誤密碼與格式錯誤的雜湊都回 false', async () => {
    const h = await hashPassword('correct horse');
    assert.match(h, /^scrypt\$/);
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifyPassword('wrong', h), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.notEqual(await hashPassword('correct horse'), h, '每次 salt 不同');
  });
});

describe('未設密碼：全開', () => {
  test('所有 /api/* 免登入；status 為 enabled:false、authenticated:true', async () => {
    const { app } = await boot();
    assert.equal((await app.inject('/api/secret')).statusCode, 200);
    assert.deepEqual((await app.inject('/api/auth/status')).json(), { enabled: false, authenticated: true });
    await app.close();
  });
});

describe('已設密碼', () => {
  async function bootWithPassword() {
    const ctx = await boot();
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'secret-pw' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, enabled: true });
    return ctx;
  }

  test('未登入存取 /api/* 回 401 UNAUTHORIZED；health、auth、靜態檔例外', async () => {
    const { app } = await bootWithPassword();
    const r = await app.inject('/api/secret');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'UNAUTHORIZED');
    assert.equal((await app.inject('/api/system/health')).statusCode, 200);
    assert.equal((await app.inject('/index.html')).statusCode, 200);
    assert.deepEqual((await app.inject('/api/auth/status')).json(), { enabled: true, authenticated: false });
    await app.close();
  });

  test('登入成功發 HttpOnly cookie，帶 cookie 後可存取', async () => {
    const { app } = await bootWithPassword();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret-pw' } });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /nc_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = cookieOf(login);
    const ok = await app.inject({ url: '/api/secret', headers: { cookie } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/auth/status', headers: { cookie } })).json(), { enabled: true, authenticated: true });
    await app.close();
  });

  test('密碼錯誤回 401，不發 cookie', async () => {
    const { app } = await bootWithPassword();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers['set-cookie'], undefined);
    await app.close();
  });

  test('竄改或過期的 cookie 無效', async () => {
    let t = 1_000_000;
    const { app } = await (async () => {
      const ctx = await boot({ now: () => t, sessionMs: 1000 });
      await ctx.app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'secret-pw' } });
      return ctx;
    })();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret-pw' } });
    const cookie = cookieOf(login);
    assert.equal((await app.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 200);
    const tampered = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    assert.equal((await app.inject({ url: '/api/secret', headers: { cookie: tampered } })).statusCode, 401);
    t += 5000;
    assert.equal((await app.inject({ url: '/api/secret', headers: { cookie } })).statusCode, 401, '過期');
    await app.close();
  });

  test('logout 清除 cookie', async () => {
    const { app } = await bootWithPassword();
    const r = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['set-cookie']), /nc_session=;/);
    await app.close();
  });

  test('改密碼：要帶 current；成功後舊 cookie 失效、回傳新 cookie', async () => {
    const { app } = await bootWithPassword();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret-pw' } });
    const oldCookie = cookieOf(login);
    const noCurrent = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: oldCookie }, payload: { password: 'new-pass' } });
    assert.equal(noCurrent.statusCode, 401);
    const wrong = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: oldCookie }, payload: { password: 'new-pass', current: 'bad' } });
    assert.equal(wrong.statusCode, 401);
    const ok = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: oldCookie }, payload: { password: 'new-pass', current: 'secret-pw' } });
    assert.equal(ok.statusCode, 200);
    const newCookie = cookieOf(ok);
    assert.equal((await app.inject({ url: '/api/secret', headers: { cookie: newCookie } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/secret', headers: { cookie: oldCookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret-pw' } })).statusCode, 401);
    await app.close();
  });

  test('password:null 取消保護（需要 current）', async () => {
    const { app, secrets } = await bootWithPassword();
    const r = await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: null, current: 'secret-pw' } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, enabled: false });
    assert.equal(secrets.has('auth'), false);
    assert.equal((await app.inject('/api/secret')).statusCode, 200);
    await app.close();
  });

  test('雜湊存在 secrets 的 auth 欄位，不存明文', async () => {
    const { app, secrets } = await bootWithPassword();
    assert.match(secrets.get('auth'), /^scrypt\$/);
    assert.ok(!JSON.stringify(secrets.all()).includes('secret-pw'));
    await app.close();
  });
});

describe('請求格式驗證', () => {
  test('密碼太短回 400 VALIDATION；缺 password 回 400', async () => {
    const { app } = await boot();
    const short = await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { password: 'abc' } });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error.code, 'VALIDATION');
    const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    assert.equal(missing.statusCode, 400);
    await app.close();
  });
});
