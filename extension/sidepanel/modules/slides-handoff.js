// slides-handoff.js — Wave 5 NotebookLM Handoff Workbench
// 役割: スライドタブの初期化・イベントバインド・chrome.storage 永続化

(function () {
  'use strict';

  var STORAGE_KEY = 'slides_handoff_v1';
  var NBM_URL = 'https://notebook.google.com/';

  var STAGES = [
    { id: 1, label: '戦略整理',            note: 'Chat · source 効く',    warn: false },
    { id: 2, label: 'アウトライン確認',    note: 'Chat · source 効く',    warn: false },
    { id: 3, label: '初回 Slide Deck',     note: 'Studio · source 効く',  warn: false },
    { id: 4, label: 'デザイン / Revision', note: '⚠ source は効かない',   warn: true  },
    { id: 5, label: '読み上げ原稿（任意）', note: 'Chat · source 効く',    warn: false },
    { id: 6, label: '最終調整',            note: 'NotebookLM 外',         warn: false },
  ];

  var CHECKLIST = [
    { id: 'cl1', label: 'Source を 3 つ追加した' },
    { id: 'cl2', label: 'Slide Deck をクリックした' },
    { id: 'cl3', label: 'Detailed / Presenter を選んだ' },
    { id: 'cl4', label: 'プロンプトを貼り付けた' },
    { id: 'cl5', label: 'PPTX / PDF をダウンロードした' },
  ];

  var _state = { checklist: {}, stage: 1 };
  var _playbookText = null;
  var _guideText = null;
  var _masterDocUrl = '';
  var _initialized = false;

  // ── ストレージ ──────────────────────────────────────
  function _loadState(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY], function (result) {
          if (result && result[STORAGE_KEY]) {
            _state = Object.assign({ checklist: {}, stage: 1 }, result[STORAGE_KEY]);
          }
          if (cb) cb();
        });
        return;
      }
    } catch (e) { /* noop */ }
    if (cb) cb();
  }

  function _saveState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var payload = {};
        payload[STORAGE_KEY] = _state;
        chrome.storage.local.set(payload);
      }
    } catch (e) { /* noop */ }
  }

  // ── md ファイル fetch ───────────────────────────────
  function _fetchMd(filename, cb) {
    var url;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        url = chrome.runtime.getURL('sidepanel/modules/' + filename);
      } else {
        url = 'modules/' + filename;
      }
    } catch (e) {
      url = 'modules/' + filename;
    }
    fetch(url)
      .then(function (r) { return r.text(); })
      .then(function (t) { cb(null, t); })
      .catch(function (e) { cb(e, null); });
  }

  // ── ステージプロンプト抽出 ──────────────────────────
  function _extractPrompt(text, stageNo) {
    if (!text) return '(プロンプトを読み込めませんでした)';
    var marker = '## ステージ ' + stageNo + ':';
    var start = text.indexOf(marker);
    if (start === -1) return '(ステージ ' + stageNo + ' が見つかりません)';
    var nextMarker = text.indexOf('\n## ステージ ', start + 1);
    var block = nextMarker === -1 ? text.slice(start) : text.slice(start, nextMarker);
    // --- 区切り以降が本文
    var parts = block.split('\n---\n');
    if (parts.length < 2) return block.trim();
    // 末尾の --- を除去
    var body = parts.slice(1).join('\n---\n');
    var endMark = body.lastIndexOf('\n---');
    if (endMark !== -1) body = body.slice(0, endMark);
    return body.trim();
  }

  // ── ★置換 ──────────────────────────────────────────
  function _applyStarReplace(text) {
    try {
      if (typeof state !== 'undefined' && state && state.settings) {
        var store = state.settings.storeName || '★店舗名★';
        var industry = state.settings.industryLabel || '★業種★';
        return text.replace(/★店舗名★/g, store).replace(/★業種★/g, industry);
      }
    } catch (e) { /* noop */ }
    return text;
  }

  // ── マスタードキュメント URL ────────────────────────
  // 正本は chrome.storage.sync の sk_master_doc_v012.docUrl（diagram.js と同一ソース）。
  // state.settings.masterDocUrl は設定されないため参照しない（旧実装の不具合）。
  function _fetchMasterDocUrl(cb) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(['sk_master_doc_v012'], function (result) {
          var info = (result && result.sk_master_doc_v012) || null;
          var url = '';
          if (info && info.documentId) {
            url = info.docUrl
              || 'https://docs.google.com/document/d/' + encodeURIComponent(info.documentId) + '/edit';
          }
          if (cb) cb(url);
        });
        return;
      }
    } catch (e) { /* noop */ }
    if (cb) cb('');
  }

  function _getMasterDocUrl() {
    if (_masterDocUrl) return _masterDocUrl;
    try {
      if (typeof state !== 'undefined' && state && state.settings && state.settings.masterDocUrl) {
        return state.settings.masterDocUrl;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  // ── クリップボードコピー ────────────────────────────
  function _copy(text, btn) {
    var origText = btn ? btn.textContent : '';
    navigator.clipboard.writeText(text || '').then(function () {
      if (!btn) return;
      btn.textContent = 'コピーしました';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = origText; btn.disabled = false; }, 1600);
    }).catch(function () {
      if (!btn) return;
      btn.textContent = '手動でコピー →';
      setTimeout(function () { btn.textContent = origText; btn.disabled = false; }, 2400);
    });
  }

  // ── Blob ダウンロード ───────────────────────────────
  function _download(filename, text) {
    if (!text) return;
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 2000);
  }

  // ── Hero CTA ────────────────────────────────────────
  function _bindHeroCta() {
    var btn = document.getElementById('slides-open-nbm');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // 1. NotebookLM を新規タブで開く
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          chrome.tabs.create({ url: NBM_URL });
        } else {
          window.open(NBM_URL, '_blank');
        }
      } catch (e) {
        window.open(NBM_URL, '_blank');
      }
      // 2. マスタードキュメント URL をクリップボードへ
      var masterUrl = _getMasterDocUrl();
      if (masterUrl) {
        navigator.clipboard.writeText(masterUrl).catch(function () {});
      }
      // 3. チェックリスト先頭アイテムへスクロール
      var firstItem = document.querySelector('.slides-cl-item');
      if (firstItem) firstItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // ── Source Pack ─────────────────────────────────────
  function _bindSourcePack() {
    // マスタードキュメント URL コピー
    var copyUrl = document.getElementById('slides-copy-master-url');
    if (copyUrl) {
      copyUrl.addEventListener('click', function () {
        var url = _getMasterDocUrl();
        _copy(url || '(URL 未設定 — 設定タブで追加してください)', copyUrl);
      });
    }
    // Playbook コピー
    var copyPb = document.getElementById('slides-copy-playbook');
    if (copyPb) {
      copyPb.addEventListener('click', function () {
        _copy(_playbookText || '(読み込み中…)', copyPb);
      });
    }
    // Playbook DL
    var dlPb = document.getElementById('slides-dl-playbook');
    if (dlPb) {
      dlPb.addEventListener('click', function () {
        _download('slides-playbook.md', _playbookText);
      });
    }
    // Design Guide コピー
    var copyGd = document.getElementById('slides-copy-guide');
    if (copyGd) {
      copyGd.addEventListener('click', function () {
        _copy(_guideText || '(読み込み中…)', copyGd);
      });
    }
    // Design Guide DL
    var dlGd = document.getElementById('slides-dl-guide');
    if (dlGd) {
      dlGd.addEventListener('click', function () {
        _download('slides-design-guide.md', _guideText);
      });
    }
  }

  // ── Studio Prompt コピー ────────────────────────────
  function _bindPromptCopy() {
    STAGES.forEach(function (stage) {
      var btn = document.getElementById('slides-prompt-copy-' + stage.id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        var raw = _extractPrompt(_playbookText, stage.id);
        var text = _applyStarReplace(raw);
        _copy(text, btn);
        // 現在ステージを更新
        _state.stage = stage.id;
        _saveState();
        _renderStageHighlight();
      });
    });
  }

  // ── Checklist 描画 ──────────────────────────────────
  function _renderChecklist() {
    var list = document.getElementById('slides-checklist-list');
    if (!list) return;
    // 既存 li を全消去してから再描画
    while (list.firstChild) list.removeChild(list.firstChild);

    CHECKLIST.forEach(function (item) {
      var checked = !!_state.checklist[item.id];

      var li = document.createElement('li');
      li.className = 'slides-cl-item' + (checked ? ' is-done' : '');

      var label = document.createElement('label');
      label.className = 'slides-cl-label';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.className = 'slides-cl-check';

      var span = document.createElement('span');
      span.className = 'slides-cl-text';
      span.textContent = item.label;

      label.appendChild(cb);
      label.appendChild(span);
      li.appendChild(label);
      list.appendChild(li);

      cb.addEventListener('change', (function (id, liEl) {
        return function () {
          _state.checklist[id] = cb.checked;
          liEl.classList.toggle('is-done', cb.checked);
          _saveState();
        };
      }(item.id, li)));
    });
  }

  // ── Checklist リセット ──────────────────────────────
  function _bindChecklist() {
    var reset = document.getElementById('slides-cl-reset');
    if (!reset) return;
    reset.addEventListener('click', function (e) {
      e.preventDefault();
      _state.checklist = {};
      _state.stage = 1;
      _saveState();
      _renderChecklist();
      _renderStageHighlight();
    });
  }

  // ── ステージハイライト ──────────────────────────────
  function _renderStageHighlight() {
    var rows = document.querySelectorAll('.slides-prompt-row');
    rows.forEach(function (row) {
      var sid = parseInt(row.getAttribute('data-stage'), 10);
      row.classList.toggle('is-current', sid === _state.stage);
    });
  }

  // ── 公開 init ───────────────────────────────────────
  function init() {
    if (_initialized) {
      _renderChecklist();
      _renderStageHighlight();
      // タブを開き直すたびに最新のマスタードキュメント URL を取り込む
      // （作成・連携後に開いた場合に空のままにならないように）。
      _fetchMasterDocUrl(function (url) { _masterDocUrl = url || ''; });
      return;
    }
    _initialized = true;

    _loadState(function () {
      _renderChecklist();
      _renderStageHighlight();
      _bindHeroCta();
      _bindSourcePack();
      _bindPromptCopy();
      _bindChecklist();
    });

    // md ファイルを非同期 fetch（初回のみ）
    _fetchMd('slides-playbook.md', function (err, text) {
      _playbookText = err ? '' : text;
    });
    _fetchMd('slides-design-guide.md', function (err, text) {
      _guideText = err ? '' : text;
    });
    // マスタードキュメント URL を非同期取得（sk_master_doc_v012.docUrl）
    _fetchMasterDocUrl(function (url) { _masterDocUrl = url || ''; });
  }

  window.SlidesHandoff = { init: init };
})();
