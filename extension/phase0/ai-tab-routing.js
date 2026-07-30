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

/**
 * Newly-created AI tabs do not have their content script immediately.
 * Retry only connection/readiness failures; a real content-script response
 * such as { ok:false, error:'no-target' } must be returned to the caller.
 */
export async function sendTabMessageWithRetry({
  tabsApi,
  tabId,
  message,
  attempts = DEFAULT_RETRY_ATTEMPTS,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  waitFn = wait,
}) {
  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await tabsApi.sendMessage(tabId, message);
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
