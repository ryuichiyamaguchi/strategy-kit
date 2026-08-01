// content script for perplexity.ai
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'perplexity',
    selectors: [
      '#ask-input[contenteditable="true"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="質問"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
