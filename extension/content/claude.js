// content script for claude.ai
// セレクタ候補は2026-04時点のDOM構造をもとにフォールバック型で定義
(function () {
  const SELECTORS = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[contenteditable="true"].ProseMirror',
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
          'チャット入力欄が見つかりません。Claudeのチャット画面を開いてください。',
          { error: true }
        );
        sendResponse({ ok: false, error: 'no-target', site: 'claude' });
        return;
      }
      const ok = window.STRATEGY_KIT_HELPERS.insertSmart(target, msg.text);
      window.STRATEGY_KIT_HELPERS.showToast(
        ok
          ? 'プロンプトを挿入しました（送信は手動で行ってください）'
          : '挿入に失敗しました',
        { error: !ok }
      );
      sendResponse({ ok, site: 'claude' });
    } catch (e) {
      window.STRATEGY_KIT_HELPERS.showToast('エラー: ' + e.message, {
        error: true,
      });
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });
})();
