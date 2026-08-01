// content script for gemini.google.com
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'gemini',
    selectors: [
      'rich-textarea div.ql-editor',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
