// 錯誤格式（規格 §6.1）：{ error: { code, message, details? } }
export const ERROR_STATUS = Object.freeze({
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CYCLE: 422,
  INTERNAL: 500,
  UPSTREAM: 502,
});

export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_STATUS} code
   * @param {string} message 繁體中文訊息，可直接顯示給使用者
   * @param {{details?: unknown, status?: number}} [opts]
   */
  constructor(code, message, { details, status } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code] ?? 500;
    this.details = details;
  }
}

export const validation = (message = '請求內容不正確', details) => new AppError('VALIDATION', message, { details });
export const unauthorized = (message = '需要登入') => new AppError('UNAUTHORIZED', message);
export const notFound = (message = '找不到資源', details) => new AppError('NOT_FOUND', message, { details });
export const conflict = (message = '資料衝突', details) => new AppError('CONFLICT', message, { details });
export const cycle = (message = '上游設備不可形成迴圈', details) => new AppError('CYCLE', message, { details });
export const upstream = (message = '外部服務無法使用', details) => new AppError('UPSTREAM', message, { details });
export const internal = (message = '伺服器發生錯誤') => new AppError('INTERNAL', message);

/** 把任何錯誤轉成 { status, body }；INTERNAL 不洩漏原始訊息 */
export function toErrorResponse(err) {
  if (err instanceof AppError) {
    const error = { code: err.code, message: err.message };
    if (err.details !== undefined && err.details !== null) error.details = err.details;
    return { status: err.status, body: { error } };
  }
  if (err && err.validation) {
    return {
      status: 400,
      body: { error: { code: 'VALIDATION', message: '請求內容不正確', details: err.validation } },
    };
  }
  const status = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  if (status >= 400 && status < 500) {
    const code = status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : 'VALIDATION';
    return { status, body: { error: { code, message: status === 413 ? '內容太大' : '請求內容不正確' } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: '伺服器發生錯誤' } } };
}

/** 安裝 Fastify 的 error handler 與 404 handler */
export function installErrorHandler(app) {
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) req.log.error({ err }, '未處理的錯誤');
    reply.code(status).send(body);
  });
}
