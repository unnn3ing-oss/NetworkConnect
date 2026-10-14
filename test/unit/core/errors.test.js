import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AppError, ERROR_STATUS, notFound, conflict, validation, cycle, upstream, unauthorized, internal, toErrorResponse, installErrorHandler } from '../../../server/core/errors.js';
import { createValidator } from '../../../contracts/index.js';

describe('errors：格式與狀態碼（規格 §6.1）', () => {
  test('每個 code 對應的 HTTP 狀態', () => {
    assert.deepEqual(ERROR_STATUS, { VALIDATION: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, CYCLE: 422, INTERNAL: 500, UPSTREAM: 502 });
  });

  test('工廠函式建立對應 code 的 AppError', () => {
    assert.equal(notFound('x').code, 'NOT_FOUND');
    assert.equal(conflict('x').status, 409);
    assert.equal(validation('x').status, 400);
    assert.equal(cycle('x').status, 422);
    assert.equal(upstream('x').status, 502);
    assert.equal(unauthorized('x').status, 401);
    assert.equal(internal().status, 500);
    assert.ok(notFound('x') instanceof Error);
  });

  test('toErrorResponse：AppError 照實輸出 code／message／details', () => {
    const r = toErrorResponse(conflict('樓層仍有房間', { rooms: 2 }));
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: { code: 'CONFLICT', message: '樓層仍有房間', details: { rooms: 2 } } });
  });

  test('toErrorResponse：沒有 details 就不輸出 details 欄位', () => {
    assert.deepEqual(toErrorResponse(notFound('找不到設備')).body, { error: { code: 'NOT_FOUND', message: '找不到設備' } });
  });

  test('toErrorResponse：未預期的錯誤變成 INTERNAL，且不洩漏原始訊息', () => {
    const r = toErrorResponse(new Error('secret path /home/x'));
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(r.body).includes('secret'));
  });

  test('toErrorResponse：Fastify 驗證錯誤 → 400 VALIDATION 並附 details', () => {
    const r = toErrorResponse(Object.assign(new Error('body must have required property name'), { validation: [{ keyword: 'required' }] }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
    assert.deepEqual(r.body.error.details, [{ keyword: 'required' }]);
  });

  test('輸出一律符合 contracts 的 ErrorResponse schema', () => {
    const v = createValidator();
    for (const e of [notFound('a'), conflict('b', { x: 1 }), validation('c'), cycle('d'), upstream('e'), unauthorized('f'), internal(), new Error('boom')]) {
      v.assert('api-common#ErrorResponse', toErrorResponse(e).body);
    }
  });
});

describe('errors：Fastify 整合', () => {
  async function boot() {
    const app = Fastify();
    installErrorHandler(app);
    app.get('/nf', async () => { throw notFound('找不到設備'); });
    app.get('/boom', async () => { throw new Error('kaboom'); });
    app.post('/json', async (req) => req.body);
    app.post('/schema', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async () => ({}));
    await app.ready();
    return app;
  }

  test('AppError、未預期錯誤、壞掉的 JSON、schema 驗證失敗都回統一格式', async () => {
    const app = await boot();
    const nf = await app.inject('/nf');
    assert.equal(nf.statusCode, 404);
    assert.equal(nf.json().error.message, '找不到設備');

    const boom = await app.inject('/boom');
    assert.equal(boom.statusCode, 500);
    assert.equal(boom.json().error.code, 'INTERNAL');

    const badJson = await app.inject({ method: 'POST', url: '/json', headers: { 'content-type': 'application/json' }, payload: '{ nope' });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().error.code, 'VALIDATION');

    const bad = await app.inject({ method: 'POST', url: '/schema', payload: {} });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'VALIDATION');
    assert.ok(Array.isArray(bad.json().error.details));
    await app.close();
  });
});
