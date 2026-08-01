// content script for genspark.ai
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'genspark',
    selectors: [
      'textarea[placeholder]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
