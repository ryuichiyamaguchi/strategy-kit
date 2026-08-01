// content script for chatgpt.com
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'chatgpt',
    selectors: [
      '#prompt-textarea',
      'div[contenteditable="true"][data-testid="prompt-textarea"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
