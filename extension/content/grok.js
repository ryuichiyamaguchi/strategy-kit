// content script for grok.com
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'grok',
    selectors: [
      'textarea[placeholder*="Grok"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="質問"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
