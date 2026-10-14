// shell 自己用的小型 DOM 卡片（錯誤卡）。一律用 textContent，不使用 innerHTML。

function h(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 在 container 內顯示「此功能暫時無法載入」卡片。
 * @param {HTMLElement} container
 * @param {{title: string, message: string, error?: unknown, onRetry?: () => void}} opts
 */
export function renderErrorCard(container, { title, message, error, onRetry }) {
  const doc = container.ownerDocument;
  const card = h(doc, 'div', 'nc-card nc-error-card');
  card.setAttribute('role', 'alert');
  card.append(h(doc, 'h2', 'nc-card-title', '此功能暫時無法載入'));
  card.append(h(doc, 'p', 'nc-card-text', `「${title}」發生問題，其他功能不受影響。`));
  if (message) card.append(h(doc, 'p', 'nc-card-reason', message));
  const stack = error && typeof error === 'object' && 'stack' in error ? String(error.stack) : '';
  if (stack) {
    const details = h(doc, 'details', 'nc-card-details');
    details.append(h(doc, 'summary', '', '技術細節'));
    details.append(h(doc, 'pre', '', stack));
    card.append(details);
  }
  if (onRetry) {
    const btn = h(doc, 'button', 'btn nc-btn', '重試');
    btn.type = 'button';
    btn.addEventListener('click', onRetry);
    card.append(btn);
  }
  container.replaceChildren(card);
  return card;
}
