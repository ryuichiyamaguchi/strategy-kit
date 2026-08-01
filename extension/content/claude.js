// content script for claude.ai
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'claude',
    selectors: [
      'div[contenteditable="true"][data-testid="chat-input"]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
