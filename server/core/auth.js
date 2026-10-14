// 選用的存取密碼：未設定則全開；有設定則 scrypt 驗證 + HttpOnly cookie，保護 /api/*
import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import { unauthorized } from './errors.js';

const COOKIE = 'nc_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const scrypt = (password, salt, params) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** 格式：scrypt$N$r$p$<salt base64>$<hash base64> */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [tag, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (tag !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

const PUBLIC_API = (path) => path === '/api/system/health' || path.startsWith('/api/auth/');

export function createAuth({ secrets, validate, now = Date.now, sessionMs = 30 * 24 * 3600 * 1000, failDelayMs = 400 }) {
  const isEnabled = () => secrets.has('auth');

  const sign = (exp) => crypto.createHmac('sha256', secrets.get('auth:key') ?? '').update(String(exp)).digest('hex');
  const makeToken = () => {
    const exp = now() + sessionMs;
    return `${exp}.${sign(exp)}`;
  };
  function tokenValid(token) {
    if (typeof token !== 'string' || !secrets.has('auth:key')) return false;
    const [expStr, mac] = token.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp <= now() || !mac) return false;
    const expected = Buffer.from(sign(exp));
    const got = Buffer.from(mac);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  }
  const isAuthenticated = (req) => !isEnabled() || tokenValid(req.cookies?.[COOKIE]);

  const setSessionCookie = (reply) =>
    reply.setCookie(COOKIE, makeToken(), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: Math.floor(sessionMs / 1000) });

  return {
    isEnabled,
    isAuthenticated,

    async register(app) {
      await app.register(cookie);

      app.addHook('onRequest', async (req) => {
        const path = req.url.split('?')[0];
        if (!path.startsWith('/api/') || PUBLIC_API(path)) return;
        if (!isAuthenticated(req)) throw unauthorized('需要登入');
      });

      app.get('/api/auth/status', async (req) => ({ enabled: isEnabled(), authenticated: isAuthenticated(req) }));

      app.post('/api/auth/login', async (req, reply) => {
        validate('api-auth#LoginRequest', req.body);
        if (!isEnabled()) return { ok: true };
        if (!(await verifyPassword(req.body.password, secrets.get('auth')))) {
          if (failDelayMs) await new Promise((r) => setTimeout(r, failDelayMs));
          throw unauthorized('密碼錯誤');
        }
        setSessionCookie(reply);
        return { ok: true };
      });

      app.post('/api/auth/logout', async (req, reply) => {
        reply.clearCookie(COOKIE, { path: '/' });
        return { ok: true };
      });

      app.put('/api/auth/password', async (req, reply) => {
        validate('api-auth#PasswordRequest', req.body);
        const { password, current } = req.body;
        if (isEnabled()) {
          if (typeof current !== 'string' || !(await verifyPassword(current, secrets.get('auth')))) {
            throw unauthorized('目前密碼不正確');
          }
        }
        if (password === null) {
          await secrets.delete('auth');
          await secrets.delete('auth:key');
          reply.clearCookie(COOKIE, { path: '/' });
          return { ok: true, enabled: false };
        }
        await secrets.set('auth', await hashPassword(password));
        await secrets.set('auth:key', crypto.randomBytes(32).toString('base64')); // 換金鑰＝所有舊 cookie 失效
        setSessionCookie(reply);
        return { ok: true, enabled: true };
      });
    },
  };
}
