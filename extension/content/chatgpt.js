// content script for chatgpt.com / chat.openai.com
(function () {
  const SELECTORS = [
    '#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    'textarea[data-id="root"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'textarea',
  ];

  function locate() {
    return window.STRATEGY_KIT_HELPERS.findFirstMatching(SELECTORS);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'STRATEGY_KIT_INSERT') return false;
    try {
      const target = locate();
      if (!target) {
        window.STRATEGY_KIT_HELPERS.showToast(
          'チャット入力欄が見つかりません。ChatGPTのチャット画面を開いてください。',
          { error: true }
        );
        sendResponse({ ok: false, error: 'no-target', site: 'chatgpt' });
        return;
      }
      const ok = window.STRATEGY_KIT_HELPERS.insertSmart(target, msg.text);
      window.STRATEGY_KIT_HELPERS.showToast(
        ok
          ? 'プロンプトを挿入しました（送信は手動で行ってください）'
          : '挿入に失敗しました',
        { error: !ok }
      );
      sendResponse({ ok, site: 'chatgpt' });
    } catch (e) {
      window.STRATEGY_KIT_HELPERS.showToast('エラー: ' + e.message, {
        error: true,
      });
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });
})();
