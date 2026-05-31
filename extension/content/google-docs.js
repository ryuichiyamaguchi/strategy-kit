// content script for docs.google.com (Google Docs本文への直接挿入はしない)
// Google Docsは編集面が iframe＋canvas のためDOM挿入できない。
// 代替策: クリップボードコピー＋Cmd/Ctrl+Vで貼付するワークフローを案内する。
(function () {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'STRATEGY_KIT_INSERT') return false;
    window.STRATEGY_KIT_HELPERS.copyToClipboardFallback(msg.text).then((ok) => {
      window.STRATEGY_KIT_HELPERS.showToast(
        ok
          ? 'Google Docs用にクリップボードへコピーしました。本文の貼付したい位置にカーソルを置いてCmd+V / Ctrl+Vで貼り付けてください。'
          : 'コピーに失敗しました。手動でコピーしてください。',
        { error: !ok, duration: 5000 }
      );
      sendResponse({ ok, site: 'google-docs', via: 'clipboard' });
    });
    return true;
  });
})();
