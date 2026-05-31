// STRATEGY-KIT — Phase 3: リサーチ保存モジュール
// AI出力テキストを Drive の research/ フォルダに保存する。

(function () {
  'use strict';

  const SLOT_ID = 'mod-research-saver-slot';

  async function isOAuthReady() {
    try {
      const authUrl = chrome.runtime.getURL('phase0/auth.js');
      const { getAuthToken } = await import(authUrl);
      const token = await getAuthToken({ interactive: false });
      return !!token;
    } catch (_) {
      return false;
    }
  }

  async function loadResearchStore() {
    const storeUrl = chrome.runtime.getURL('phase0/research-store.js');
    return await import(storeUrl);
  }

  // DOM要素参照（初期化後に設定）
  let _noInput, _typeSelect, _titleInput, _contentArea, _resultArea, _folderUrl;

  function buildUI(slot) {
    const { el } = window.SK_CORE;
    const state = window.SK_CORE.getState();

    slot.classList.remove('hidden');

    // タイトル
    slot.appendChild(el('h2', { class: 'card-title', text: 'リサーチ保存（Drive）' }));

    // 番号入力
    _noInput = el('input', {
      attrs: { type: 'text', placeholder: '例: 01', id: 'rs-no-input' },
      value: state.settings.researchNo || '01',
    });
    slot.appendChild(
      el('label', { class: 'form-row' },
        el('span', { class: 'form-label', text: 'リサーチ番号（NN）' }),
        _noInput
      )
    );

    // 種類セレクタ
    _typeSelect = el('select', { attrs: { id: 'rs-type-select' } });
    const types = [
      { value: 'primary', label: '1次調査（primary）' },
      { value: 'secondary', label: '2次調査（secondary）' },
      { value: 'factcheck', label: 'ファクトチェック（factcheck）' },
      { value: 'integrated', label: '統合（integrated）' },
      { value: 'note', label: 'メモ（note）' },
    ];
    for (const t of types) {
      _typeSelect.appendChild(el('option', { value: t.value, text: t.label }));
    }
    slot.appendChild(
      el('label', { class: 'form-row' },
        el('span', { class: 'form-label', text: '種類' }),
        _typeSelect
      )
    );

    // タイトル入力
    _titleInput = el('input', {
      attrs: { type: 'text', placeholder: '任意タイトル', id: 'rs-title-input' },
    });
    slot.appendChild(
      el('label', { class: 'form-row' },
        el('span', { class: 'form-label', text: 'タイトル（任意）' }),
        _titleInput
      )
    );

    // AI出力テキストエリア
    _contentArea = el('textarea', {
      attrs: {
        id: 'rs-content-area',
        placeholder: 'AIの返答テキストをここに貼り付けてください',
        rows: '8',
      },
    });
    Object.assign(_contentArea.style, {
      minHeight: '140px',
      width: '100%',
      boxSizing: 'border-box',
      display: 'block',
      marginTop: '8px',
      resize: 'vertical',
      fontFamily: 'inherit',
      fontSize: '12px',
      padding: '8px',
      border: '1px solid #e2e8f0',
      borderRadius: '6px',
    });
    slot.appendChild(_contentArea);

    // ボタン行
    const btnRow = el('div', { class: 'form-row' });
    Object.assign(btnRow.style, { marginTop: '8px', gap: '8px', display: 'flex', flexWrap: 'wrap' });

    const saveBtn = el('button', { class: 'btn', text: '保存' });
    saveBtn.addEventListener('click', handleSave);
    btnRow.appendChild(saveBtn);

    const folderBtn = el('button', { class: 'btn btn-ghost', text: '保存先フォルダを開く' });
    folderBtn.addEventListener('click', () => {
      if (_folderUrl) {
        chrome.tabs.create({ url: _folderUrl });
      } else {
        window.SK_CORE.showToast('フォルダURLが未取得です。一度保存するか一覧を開いてください', true);
      }
    });
    btnRow.appendChild(folderBtn);

    slot.appendChild(btnRow);

    // 直近の保存結果エリア
    _resultArea = el('div', { attrs: { id: 'rs-result-area' } });
    Object.assign(_resultArea.style, { marginTop: '8px', fontSize: '12px' });
    slot.appendChild(_resultArea);

    // 過去の保存一覧アコーディオン
    const details = el('details');
    Object.assign(details.style, { marginTop: '12px' });

    const summary = el('summary', { class: 'text-btn', text: '過去の保存一覧' });
    Object.assign(summary.style, { cursor: 'pointer', fontSize: '12px' });
    details.appendChild(summary);

    const listContainer = el('div', { attrs: { id: 'rs-list-container' } });
    Object.assign(listContainer.style, { marginTop: '8px' });
    details.appendChild(listContainer);

    details.addEventListener('toggle', async () => {
      if (details.open) {
        await loadFileList(listContainer);
      }
    });

    slot.appendChild(details);
  }

  async function handleSave() {
    const { showToast } = window.SK_CORE;
    const content = _contentArea.value.trim();

    if (!content) {
      showToast('テキストが空です。AI出力を貼り付けてください', true);
      return;
    }

    const no = _noInput.value.trim() || 'NN';
    const type = _typeSelect.value;
    const title = _titleInput.value.trim();

    try {
      const researchStore = await loadResearchStore();
      const result = await researchStore.saveResearchMarkdown({ no, type, content, title });
      if (result.ok) {
        if (result.folderUrl) _folderUrl = result.folderUrl;
        showResultSuccess(result);
        showToast('保存しました');
      } else {
        console.error('[STRATEGY-KIT] リサーチ保存エラー:', result.error);
        showToast('リサーチの保存に失敗しました。Google 連携を確認してください。', true);
      }
    } catch (e) {
      console.error('[STRATEGY-KIT] リサーチ保存エラー:', e);
      showToast('Driveへの保存に失敗しました。Google 連携とネットワーク接続を確認してください。', true);
    }
  }

  function showResultSuccess(result) {
    const { el, clearChildren } = window.SK_CORE;
    clearChildren(_resultArea);

    const wrapper = el('div');
    Object.assign(wrapper.style, {
      background: '#f0fdf4',
      border: '1px solid #86efac',
      borderRadius: '6px',
      padding: '8px 10px',
      fontSize: '12px',
    });

    const label = el('span', { text: '保存完了: ' });
    label.style.color = '#166534';
    wrapper.appendChild(label);

    if (result.fileUrl) {
      const link = el('a', { text: result.fileName || 'ファイルを開く' });
      link.href = '#';
      link.style.color = '#15803d';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: result.fileUrl });
      });
      wrapper.appendChild(link);
    } else if (result.fileName) {
      wrapper.appendChild(document.createTextNode(result.fileName));
    }

    _resultArea.appendChild(wrapper);
  }

  async function loadFileList(container) {
    const { el, clearChildren } = window.SK_CORE;
    clearChildren(container);

    const loading = el('p', { class: 'muted-note', text: '読み込み中...' });
    container.appendChild(loading);

    try {
      const researchStore = await loadResearchStore();
      const result = await researchStore.listResearchFiles();
      clearChildren(container);

      if (result.folderUrl) _folderUrl = result.folderUrl;

      if (!result.files || result.files.length === 0) {
        container.appendChild(el('p', { class: 'muted-note', text: '保存ファイルはまだありません' }));
        return;
      }

      const ul = el('ul');
      Object.assign(ul.style, {
        listStyle: 'none',
        padding: '0',
        margin: '0',
        fontSize: '12px',
      });

      for (const file of result.files) {
        const li = el('li');
        Object.assign(li.style, {
          padding: '4px 0',
          borderBottom: '1px solid #f1f5f9',
        });

        const link = el('a');
        link.textContent = file.name || file.id;
        link.href = '#';
        link.style.color = '#1d4ed8';
        link.style.wordBreak = 'break-all';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (file.url) chrome.tabs.create({ url: file.url });
        });
        li.appendChild(link);

        if (file.updated) {
          const meta = el('span', { text: ' — ' + file.updated });
          meta.style.color = '#94a3b8';
          li.appendChild(meta);
        }

        ul.appendChild(li);
      }

      container.appendChild(ul);
    } catch (e) {
      clearChildren(container);
      container.appendChild(el('p', { class: 'muted-note', text: 'エラー: ' + e.message }));
    }
  }

  // core-ready 後に初期化
  window.SK_CORE.on('core-ready', async () => {
    try {
      const configured = await isOAuthReady();
      if (!configured) return; // OAuth未連携時はスロットを hidden のまま維持

      const slot = document.getElementById(SLOT_ID);
      if (!slot) return;

      buildUI(slot);
    } catch (e) {
      // 初期化失敗は黙って無視（モジュール単独障害で全体を壊さない）
    }
  });
})();
