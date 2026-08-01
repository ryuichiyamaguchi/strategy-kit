const DEFAULT_RETRY_ATTEMPTS = 30;
const DEFAULT_RETRY_DELAY_MS = 300;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableTabMessageError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('The message port closed') ||
    message.includes('No tab with id')
  );
}

export function isNoTargetTabMessageError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('The message port closed') ||
    message.includes('message channel closed before a response was received')
  );
}

export function shouldRecoverTabMessageResponse(response) {
  return (
    response == null ||
    (response.ok === false && response.error === 'no-target')
  );
}

/**
 * Newly-created AI tabs do not have their content script immediately.
 * Retry connection/readiness failures. When retryResponseFn is supplied,
 * a content-script readiness response (no-target / no response yet) can also
 * be retried while a SPA or embedded frame finishes rendering its input.
 */
export async function sendTabMessageWithRetry({
  tabsApi,
  tabId,
  message,
  attempts = DEFAULT_RETRY_ATTEMPTS,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  waitFn = wait,
  retryResponseFn = null,
}) {
  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await tabsApi.sendMessage(tabId, message);
      const shouldRetryResponse =
        typeof retryResponseFn === 'function' && retryResponseFn(response);
      if (!shouldRetryResponse || attempt === maxAttempts) return response;
      await waitFn(delayMs);
    } catch (error) {
      lastError = error;
      if (!isRetryableTabMessageError(error) || attempt === maxAttempts) {
        throw error;
      }
      await waitFn(delayMs);
    }
  }

  throw lastError || new Error('AIタブへ接続できませんでした。');
}

/**
 * 拡張機能の再読み込み前から開いていたタブには content script が存在しない。
 * そのタブを再読み込みすると未送信の入力を失うため、接続エラーの場合だけ
 * recoverTab() で新しいAIタブを作り、そちらへ挿入する。
 */
export async function sendTabMessageWithRecovery({
  tabsApi,
  tabId,
  message,
  recoverTab,
  initialAttempts = 4,
  initialDelayMs = 200,
  recoveredAttempts = DEFAULT_RETRY_ATTEMPTS,
  recoveredDelayMs = DEFAULT_RETRY_DELAY_MS,
  waitFn = wait,
}) {
  let initialResponse = null;
  try {
    initialResponse = await sendTabMessageWithRetry({
      tabsApi,
      tabId,
      message,
      attempts: initialAttempts,
      delayMs: initialDelayMs,
      waitFn,
      retryResponseFn: shouldRecoverTabMessageResponse,
    });
    if (!shouldRecoverTabMessageResponse(initialResponse)) return initialResponse;
  } catch (error) {
    if (!isRetryableTabMessageError(error) || typeof recoverTab !== 'function') {
      throw error;
    }
  }
  if (typeof recoverTab !== 'function') return initialResponse;
  const recoveredTab = await recoverTab();
  if (!recoveredTab?.id) return initialResponse || { ok: false, error: 'recovery-tab-not-created' };
  const response = await sendTabMessageWithRetry({
    tabsApi,
    tabId: recoveredTab.id,
    message,
    attempts: recoveredAttempts,
    delayMs: recoveredDelayMs,
    waitFn,
    retryResponseFn: shouldRecoverTabMessageResponse,
  });
  if (!response || typeof response !== 'object') {
    return { ok: !!response, recoveredConnection: true, tabId: recoveredTab.id };
  }
  return { ...response, recoveredConnection: true, tabId: recoveredTab.id };
}
