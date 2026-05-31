// content script for perplexity.ai
(function () {
  const SELECTORS = [
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="質問"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
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
          '入力欄が見つかりません。Perplexityのトップ画面/スレッド画面を開いてください。',
          { error: true }
        );
        sendResponse({ ok: false, error: 'no-target', site: 'perplexity' });
        return;
      }
      const ok = window.STRATEGY_KIT_HELPERS.insertSmart(target, msg.text);
      window.STRATEGY_KIT_HELPERS.showToast(
        ok
          ? 'プロンプトを挿入しました（送信は手動で行ってください）'
          : '挿入に失敗しました',
        { error: !ok }
      );
      sendResponse({ ok, site: 'perplexity' });
    } catch (e) {
      window.STRATEGY_KIT_HELPERS.showToast('エラー: ' + e.message, {
        error: true,
      });
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });
})();
