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

  async function loadMasterAppendDeps() {
    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const driveUrl = chrome.runtime.getURL('phase0/drive-client.js');
    const appenderUrl = chrome.runtime.getURL('phase0/master-research-appender.js');
    const [docsClient, driveClient, masterResearchAppender] = await Promise.all([
      import(docsUrl),
      import(driveUrl),
      import(appenderUrl),
    ]);
    return { docsClient, driveClient, masterResearchAppender };
  }

  // DOM要素参照（初期化後に設定）
  let _noInput, _typeSelect, _titleInput, _contentArea, _resultArea, _folderUrl;
  let _saveBtn, _appendBtn;

  function buildUI(slot) {
    const { el } = window.SK_CORE;
    const state = window.SK_CORE.getState();

    slot.classList.remove('hidden');

    // タイトル
    slot.appendChild(el('h2', { class: 'card-title', text: '統合結果の保存・マスター追記' }));
    slot.appendChild(el('p', {
      class: 'muted-note',
      text: '最終ステップの統合結果を貼り付けます。「選択フェーズへ追記」は既存章を残し、そのフェーズの末尾だけに追加します。',
    }));

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
      _typeSelect.appendChild(el('option', {
        value: t.value,
        text: t.label,
        selected: t.value === 'integrated',
      }));
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
    _contentArea.className = 'rs-content-area';
    slot.appendChild(_contentArea);

    // ボタン行
    const btnRow = el('div', { class: 'form-row' });
    Object.assign(btnRow.style, { marginTop: '8px', gap: '8px', display: 'flex', flexWrap: 'wrap' });

    _appendBtn = el('button', {
      class: 'btn',
      text: '選択フェーズへ追記',
      attrs: { id: 'rs-append-master' },
    });
    _appendBtn.addEventListener('click', handleAppendToMaster);
    btnRow.appendChild(_appendBtn);

    _saveBtn = el('button', { class: 'btn btn-ghost', text: 'Driveにだけ保存' });
    _saveBtn.addEventListener('click', handleSave);
    btnRow.appendChild(_saveBtn);

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
      setBusy(true);
      const result = await saveResearchRecord({ no, type, content, title });
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
    } finally {
      setBusy(false);
    }
  }

  async function handleAppendToMaster() {
    const { showToast } = window.SK_CORE;
    const content = _contentArea.value.trim();
    if (!content) {
      showToast('テキストが空です。統合結果を貼り付けてください', true);
      return;
    }

    const phaseSelect = document.getElementById('research-phase-link');
    const selectedOption = phaseSelect && phaseSelect.selectedOptions && phaseSelect.selectedOptions[0];
    const phaseNo = selectedOption && selectedOption.dataset ? selectedOption.dataset.phaseNo : '';
    if (!phaseNo) {
      showToast('上の「関連フェーズ」で追記先を選んでください', true, 5000);
      if (phaseSelect) phaseSelect.focus({ preventScroll: true });
      return;
    }

    const phase = (window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [])
      .find(function (item) { return String(item.no) === String(phaseNo); });
    const phaseTitle = phase && phase.title ? String(phase.title) : '';
    const researchTopic = (document.getElementById('research-topic')?.value || '').trim();
    const title = _titleInput.value.trim() || researchTopic || phaseTitle || '深掘りリサーチ';
    const no = _noInput.value.trim() || 'NN';
    const type = _typeSelect.value || 'integrated';
    const ok = window.confirm(
      'マスターの「§' + phaseNo + ' ' + phaseTitle + '」の末尾に追記します。\n\n' +
      '既存の章本文と他のフェーズは変更しません。実行しますか？'
    );
    if (!ok) return;

    setBusy(true);
    try {
      showToast('リサーチ原本をDriveに保存中…');
      const researchResult = await saveResearchRecord({ no, type, content, title });
      if (!researchResult || !researchResult.ok) {
        throw new Error('リサーチ原本をDriveに保存できませんでした');
      }
      if (researchResult.folderUrl) _folderUrl = researchResult.folderUrl;

      showToast('マスターをバックアップして §' + phaseNo + ' へ追記中…');
      const { docsClient, driveClient, masterResearchAppender } = await loadMasterAppendDeps();
      const result = await masterResearchAppender.appendResearchToMaster({
        docsClient,
        driveClient,
        storageArea: chrome.storage.sync,
        phaseKey: phaseNo,
        phaseTitle,
        researchNo: no,
        title,
        content,
        researchFileUrl: researchResult.fileUrl || '',
      });

      showAppendSuccess({ result, researchResult, phaseNo, phaseTitle });
      if (result.action === 'duplicate') {
        showToast('同じ内容はすでに §' + phaseNo + ' へ追記済みです。二重追記はしませんでした', false, 5000);
      } else {
        showToast('§' + phaseNo + ' だけに追加リサーチを追記しました', false, 5000);
        if (window.SK_CORE.emit) window.SK_CORE.emit('master-doc-changed');
      }
    } catch (e) {
      console.error('[STRATEGY-KIT] リサーチのマスター追記エラー:', e);
      showToast('マスター追記に失敗: ' + (e.message || String(e)), true, 7000);
    } finally {
      setBusy(false);
    }
  }

  async function saveResearchRecord({ no, type, content, title }) {
    const researchStore = await loadResearchStore();
    return await researchStore.saveResearchMarkdown({ no, type, content, title });
  }

  function setBusy(busy) {
    if (_saveBtn) _saveBtn.disabled = !!busy;
    if (_appendBtn) {
      _appendBtn.disabled = !!busy;
      _appendBtn.textContent = busy ? '保存・追記中…' : '選択フェーズへ追記';
    }
  }

  function showResultSuccess(result) {
    const { el, clearChildren } = window.SK_CORE;
    clearChildren(_resultArea);

    const wrapper = el('div', { class: 'rs-result rs-result-success' });

    const label = el('span', { class: 'rs-result-label', text: '保存完了: ' });
    wrapper.appendChild(label);

    if (result.fileUrl) {
      const link = el('a', { class: 'rs-result-link', text: result.fileName || 'ファイルを開く' });
      link.href = '#';
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

  function showAppendSuccess({ result, researchResult, phaseNo, phaseTitle }) {
    const { el, clearChildren } = window.SK_CORE;
    clearChildren(_resultArea);
    const duplicate = result.action === 'duplicate';
    const wrapper = el('div', {
      class: 'rs-result ' + (duplicate ? 'rs-result-warning' : 'rs-result-success'),
    });
    wrapper.appendChild(el('strong', {
      class: 'rs-result-label',
      text: duplicate
        ? '二重追記を防止しました'
        : '§' + phaseNo + ' ' + phaseTitle + ' への追記完了',
    }));

    const links = el('div', { class: 'rs-result-links' });
    if (result.masterDocUrl) {
      links.appendChild(buildOpenLink('マスターを開く', result.masterDocUrl));
    }
    if (researchResult.fileUrl) {
      links.appendChild(buildOpenLink('リサーチ原本を開く', researchResult.fileUrl));
    }
    if (result.backup && result.backup.docUrl) {
      links.appendChild(buildOpenLink('追記前バックアップ', result.backup.docUrl));
    }
    wrapper.appendChild(links);
    _resultArea.appendChild(wrapper);
  }

  function buildOpenLink(label, url) {
    const link = window.SK_CORE.el('a', { class: 'rs-result-link', text: label });
    link.href = '#';
    link.addEventListener('click', function (event) {
      event.preventDefault();
      chrome.tabs.create({ url });
    });
    return link;
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
        link.className = 'rs-result-link';
        link.style.wordBreak = 'break-all';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          if (file.url) chrome.tabs.create({ url: file.url });
        });
        li.appendChild(link);

        if (file.updated) {
          const meta = el('span', { text: ' — ' + file.updated });
          meta.className = 'rs-file-meta';
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
