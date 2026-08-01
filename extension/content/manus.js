// content script for manus.im
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'manus',
    selectors: [
      'textarea[data-testid="prompt-input"]',
      'textarea[placeholder*="タスク"]',
      'textarea[placeholder*="メッセージ"]',
      'textarea[placeholder*="Message"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
