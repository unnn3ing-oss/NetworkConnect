// fetch 包裝：統一的 JSON 請求與錯誤（契約：contracts/api.md 的錯誤格式）

export class ApiError extends Error {
  /**
   * @param {{status: number, code: string, message: string, details?: unknown}} p
   */
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const CODE_BY_STATUS = { 400: 'VALIDATION', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'CYCLE' };

function toQueryString(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === '' || v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * @param {{fetchImpl?: typeof fetch, onUnauthorized?: () => void}} [opts]
 */
export function createApi({ fetchImpl = (...a) => globalThis.fetch(...a), onUnauthorized } = {}) {
  async function request(method, path, { query, body, formData } = {}) {
    const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
    if (formData) {
      init.body = formData; // 讓瀏覽器自己帶 multipart boundary
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchImpl(`${path}${toQueryString(query)}`, init);
    } catch {
      throw new ApiError({ status: 0, code: 'NETWORK', message: '無法連線到伺服器，請確認程式仍在執行' });
    }

    if (res.status === 204) return null;
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    let data = null;
    if (isJson) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const e = data?.error;
      const err = new ApiError({
        status: res.status,
        code: e?.code ?? CODE_BY_STATUS[res.status] ?? (res.status >= 500 ? 'INTERNAL' : 'VALIDATION'),
        message: e?.message ?? `伺服器回應錯誤（HTTP ${res.status}）`,
        details: e?.details,
      });
      if (res.status === 401) onUnauthorized?.();
      throw err;
    }
    return data;
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body) => request('POST', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    delete: (path) => request('DELETE', path),
    /** multipart 上傳（預設 PUT，例：平面圖） */
    upload: (path, formData, method = 'PUT') => request(method, path, { formData }),
    /** 組出網址，給 <img src> 之類不經過 fetch 的地方 */
    url: (path, query) => `${path}${toQueryString(query)}`,
  };
}
