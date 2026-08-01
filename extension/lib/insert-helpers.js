// 共通: テキストエリア / contenteditable へプロンプトを挿入するヘルパー
// 仕様: 自動送信は行わない。挿入のみ。送信判断は人間に委ねる。
// グローバル window.STRATEGY_KIT_HELPERS に登録（content script から呼ぶ）

(function () {
  if (window.STRATEGY_KIT_HELPERS) return;

  function _setNativeValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    const proto = Object.getPrototypeOf(element);
    const protoSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (protoSetter && setter !== protoSetter) {
      protoSetter.call(element, value);
    } else if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function insertIntoTextarea(textarea, text) {
    if (!textarea) return false;
    textarea.focus();
    _setNativeValue(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function _clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function insertIntoContentEditable(el, text) {
    if (!el) return false;
    el.focus();

    // contenteditable はDOM APIのみで構築（XSS耐性確保）
    _clearChildren(el);
    const lines = String(text).split('\n');
    lines.forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });

    // 入力イベント発火（Reactなどがstate反映するため）
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      })
    );
    return true;
  }

  function insertSmart(target, text) {
    if (!target) return false;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      return insertIntoTextarea(target, text);
    }
    if (
      target.isContentEditable ||
      target.getAttribute('contenteditable') === 'true'
    ) {
      return insertIntoContentEditable(target, text);
    }
    return false;
  }

  function isUsableTarget(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findFirstMatching(selectors) {
    for (const sel of selectors) {
      const candidates = document.querySelectorAll(sel);
      for (const el of candidates) {
        if (isUsableTarget(el)) return el;
      }
    }
    return null;
  }

  /**
   * AIごとの入力欄を同じ規約で扱う。
   *
   * 対象が無いフレームは応答しない。tabs.sendMessage は全フレームの
   * content script に届くため、入力欄を持つ埋め込みフレームだけが
   * 成功応答を返せるようにする。入力欄がまだ描画されていない場合は
   * background 側が短時間再試行し、最終的な no-target を判定する。
   */
  function registerInsertionHandler({ site, selectors }) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type !== 'STRATEGY_KIT_INSERT') return false;
      const target = findFirstMatching(selectors);
      if (!target) return false;

      try {
        const ok = insertSmart(target, msg.text);
        showToast(
          ok
            ? 'プロンプトを挿入しました（送信は手動で行ってください）'
            : '挿入に失敗しました',
          { error: !ok }
        );
        sendResponse({
          ok,
          site,
          ...(ok ? {} : { error: 'insert-failed' }),
        });
      } catch (error) {
        showToast('エラー: ' + error.message, { error: true });
        sendResponse({
          ok: false,
          error: error?.message || String(error),
          site,
        });
      }
      return true;
    });
  }

  function showToast(message, opts = {}) {
    const id = '__strategy_kit_toast__';
    document.getElementById(id)?.remove();
    const div = document.createElement('div');
    div.id = id;
    div.textContent = message;
    Object.assign(div.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: 2147483647,
      background: opts.error ? '#b91c1c' : '#0f172a',
      color: '#fff',
      padding: '10px 14px',
      borderRadius: '8px',
      fontSize: '13px',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.25)',
      maxWidth: '320px',
      lineHeight: '1.5',
    });
    document.body.appendChild(div);
    setTimeout(() => div.remove(), opts.duration || 2400);
  }

  function copyToClipboardFallback(text) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => false);
  }

  window.STRATEGY_KIT_HELPERS = {
    insertSmart,
    insertIntoTextarea,
    insertIntoContentEditable,
    findFirstMatching,
    isUsableTarget,
    registerInsertionHandler,
    showToast,
    copyToClipboardFallback,
  };
})();
