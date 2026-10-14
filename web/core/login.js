// 存取密碼登入畫面（只有伺服器設定了存取密碼才會出現）

/**
 * 在 overlay 內顯示登入表單；登入成功後呼叫 onSuccess。
 * @param {HTMLElement} overlay
 * @param {{post(path: string, body: unknown): Promise<unknown>}} api
 * @param {() => void} onSuccess
 */
export function showLogin(overlay, api, onSuccess) {
  const doc = overlay.ownerDocument;
  const make = (tag, className, text) => {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const backdrop = make('div', 'nc-login-backdrop');
  const form = make('form', 'card nc-login');
  form.setAttribute('aria-label', '登入');
  const input = make('input', 'input');
  input.type = 'password';
  input.required = true;
  input.autocomplete = 'current-password';
  input.setAttribute('aria-label', '存取密碼');
  const submit = make('button', 'btn primary', '登入');
  submit.type = 'submit';
  const error = make('p', 'nc-login-error');
  error.setAttribute('role', 'alert');
  form.append(make('h2', 'nc-card-title', 'NetworkConnect'), make('p', 'nc-card-text', '請輸入存取密碼'), input, submit, error);
  backdrop.append(form);
  overlay.replaceChildren(backdrop);
  overlay.hidden = false;
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      await api.post('/api/auth/login', { password: input.value });
      overlay.replaceChildren();
      overlay.hidden = true;
      onSuccess();
    } catch (err) {
      error.textContent = err?.message ?? '登入失敗';
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
}
