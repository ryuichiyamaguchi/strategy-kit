// content script for genspark.ai
(function () {
  const SELECTORS = [
    'textarea[placeholder]',
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
        window.STRATEGY_KIT_HELPERS.copyToClipboardFallback(msg.text).then(
          (ok) => {
            window.STRATEGY_KIT_HELPERS.showToast(
              ok
                ? '入力欄が見つからなかったため、クリップボードにコピーしました。Gensparkの入力欄に貼り付けてください。'
                : '挿入もコピーも失敗しました。手動でコピーしてください。',
              { error: !ok, duration: 4000 }
            );
          }
        );
        sendResponse({ ok: false, error: 'no-target-fallback-clipboard', site: 'genspark' });
        return;
      }
      const ok = window.STRATEGY_KIT_HELPERS.insertSmart(target, msg.text);
      window.STRATEGY_KIT_HELPERS.showToast(
        ok
          ? 'プロンプトを挿入しました（送信は手動で行ってください）'
          : '挿入に失敗しました',
        { error: !ok }
      );
      sendResponse({ ok, site: 'genspark' });
    } catch (e) {
      window.STRATEGY_KIT_HELPERS.showToast('エラー: ' + e.message, {
        error: true,
      });
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });
})();
