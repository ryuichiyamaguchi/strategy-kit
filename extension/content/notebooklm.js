// content script for Gemini Notebook (formerly NotebookLM)
(function () {
  window.STRATEGY_KIT_HELPERS.registerInsertionHandler({
    site: 'notebooklm',
    selectors: [
      'textarea[aria-label*="質問"]',
      'textarea[aria-label*="Ask"]',
      'textarea[placeholder*="質問"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
  });
})();
