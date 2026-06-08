// STRATEGY-KIT Phase 4 — 進捗トラッキングモジュール
// 役割:
//   Docs API で章ごとの埋まり具合を表示する。
//   フェーズグリッドの .phase-cell に .is-filled クラスを toggle する。
//   OAuth 未連携時はスロットを hidden のまま機能オフ。

(function () {
  // buildUI で構築した現在のスロットの「進捗再読込」処理を保持する。
  // master-doc-changed（マスタードキュメント新規作成・変更）から再実行できるようにする。
  let reloadActiveProgress = null;

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

  async function getProgressDocumentId() {
    const stored = await chrome.storage.sync.get([
      'sk_draft_doc_v012',
      'sk_chapter_doc_v012',
      'sk_master_doc_v012',
    ]);
    // 1軸化（進捗の正本はマスター本体）に合わせ master を最優先で読む。
    // sk_draft_doc_v012 / sk_chapter_doc_v012 は案件スコープを持たないグローバルキーで、
    // プロジェクト切替時にクリアされない。master を優先しないと、新規案件でマスターを作っても
    // 前案件の旧 draft/chapter を読んで最上部進捗が古いまま固まる（diagram.js は既に master 優先）。
    // master 未設定時のみ旧 draft/chapter へフォールバック（旧データの後方互換）。
    return (
      stored.sk_master_doc_v012?.documentId ||
      stored.sk_draft_doc_v012?.documentId ||
      stored.sk_chapter_doc_v012?.documentId ||
      null
    );
  }

  async function loadProgressFromDocs() {
    const documentId = await getProgressDocumentId();
    if (!documentId) throw new Error('DRAFT または章別記録 Docs が未作成です');

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const [docsMod, sectionsMod] = await Promise.all([import(docsUrl), import(sectionsUrl)]);
    const doc = await docsMod.getDocument(documentId);
    const phases = window.SK_CORE.getState()?.prompts?.phases || [];
    return sectionsMod.buildProgressSections(doc, phases);
  }

  // フェーズリストの各行に進捗状態を反映する（Wave 3: .phase-row + data-state）
  function applyProgressToGrid(filledNos, partialNos) {
    const filledSet = new Set(filledNos.map(String));
    const partialSet = new Set(partialNos.map(String).filter((no) => !filledSet.has(no)));
    // state に保存して renderPhaseList / contextbar ドット再描画時にも反映されるようにする
    window.SK_CORE.getState().progressFilledNos = Array.from(filledSet);
    window.SK_CORE.getState().progressPartialNos = Array.from(partialSet);

    // Wave 3: 縦リスト (.phase-row[data-phase=N]) に data-state を直接適用
    for (const row of document.querySelectorAll('.phase-row')) {
      const no = row.dataset.phase;
      if (no != null) {
        const state = filledSet.has(no) ? 'filled' : partialSet.has(no) ? 'partial' : 'todo';
        row.dataset.state = state;
      }
    }
  }

  // 進捗バーの width を更新（rate は 0-100 のパーセント値）
  function updateBar(barInner, rate) {
    const pct = Math.min(100, Math.max(0, Math.round(rate)));
    barInner.style.width = pct + '%';
    barInner.classList.toggle('is-complete', pct >= 100);
  }

  // 章リストを再描画
  function renderSectionList(listEl, sections) {
    const { el, clearChildren } = window.SK_CORE;
    clearChildren(listEl);

    for (const sec of sections) {
      const stateClass = sec.filled ? ' is-filled' : sec.partial ? ' is-partial' : '';
      const statusText = sec.filled ? '完了' : sec.partial ? '入力あり' : '未着手';
      const progressHint = sec.filled ? '読み返し可' : sec.partial ? '1〜2行の下書きあり' : '入力待ち';
      const item = el('div', {
        class: 'sk-progress-item' + stateClass,
      });

      // 章番号 (§N)
      item.appendChild(el('span', { class: 'sk-progress-item-no', text: '§' + sec.no }));

      // タイトル
      if (sec.title) {
        item.appendChild(el('span', { class: 'sk-progress-item-title', text: sec.title }));
      }

      // 状態
      const statusEl = el('span', {
        class: 'sk-progress-item-status',
        text: statusText,
      });
      item.appendChild(statusEl);

      item.appendChild(el('span', { class: 'sk-progress-item-meta', text: progressHint }));

      // 字数
      if (sec.charCount != null) {
        item.appendChild(el('span', { class: 'sk-progress-item-meta', text: sec.charCount + '字' }));
      }

      // 日付
      if (sec.lastUpdated) {
        item.appendChild(el('span', { class: 'sk-progress-item-meta', text: sec.lastUpdated }));
      }

      listEl.appendChild(item);
    }
  }

  // Docs からデータ取得して UI を更新
  async function loadProgress(barInner, listEl, summaryEl, reloadBtn) {
    reloadBtn.disabled = true;
    reloadBtn.textContent = '読込中…';

    try {
      const result = await loadProgressFromDocs();

      const sections = result.sections || [];
      const completionRate = result.completionRate != null ? result.completionRate : 0;
      const progressRate = result.progressRate != null ? result.progressRate : completionRate;
      const filledCount = result.filledCount ?? 0;
      const partialCount = result.partialCount ?? sections.filter((s) => s.partial).length;
      const total = result.totalChapters ?? sections.length;

      // サマリー更新（rate は既にパーセント値）— DOM API で <strong> 強調
      const { clearChildren, el } = window.SK_CORE;
      clearChildren(summaryEl);
      const strongEl = el('strong', { text: filledCount + ' / ' + total });
      summaryEl.appendChild(strongEl);
      summaryEl.appendChild(document.createTextNode(' 章完成'));
      if (partialCount > 0) {
        summaryEl.appendChild(document.createTextNode(' · 下書きあり ' + partialCount));
      }
      summaryEl.appendChild(document.createTextNode(' · 着手率 ' + Math.round(progressRate) + '%'));

      // バー更新
      updateBar(barInner, progressRate);

      // 章リスト再描画
      renderSectionList(listEl, sections);

      // filledNos を state に保存してグリッドに反映
      const filledNos = sections.filter((s) => s.filled).map((s) => String(s.no));
      const partialNos = sections.filter((s) => !s.filled && s.partial).map((s) => String(s.no));
      applyProgressToGrid(filledNos, partialNos);

      // 他モジュール向けイベント発火
      window.SK_CORE.emit('progress-updated', sections);
    } catch (e) {
      window.SK_CORE.showToast('進捗取得に失敗しました: ' + e.message, true);
    } finally {
      reloadBtn.disabled = false;
      reloadBtn.textContent = '再読込';
    }
  }

  // スロットに UI を構築して初回ロードを実行
  function buildUI(slot) {
    const { el } = window.SK_CORE;

    // ヘッダ — eyebrow + editorial-title 形式に統一
    const eyebrowRow = el('div', { class: 'card-eyebrow-row' },
      el('span', { class: 'card-eyebrow', text: 'progress' }),
      el('span', { class: 'card-eyebrow-rule' })
    );
    slot.appendChild(eyebrowRow);
    slot.appendChild(el('h2', { class: 'editorial-title', text: '進捗' }));

    // サマリー
    const summaryEl = el('p', { class: 'sk-progress-summary', text: '読込中…' });
    slot.appendChild(summaryEl);

    // 進捗バー
    const barOuter = el('div', { class: 'sk-progress-bar' });
    const barInner = el('div', { class: 'sk-progress-bar-fill' });
    barOuter.appendChild(barInner);
    barOuter.style.marginBottom = '12px';
    slot.appendChild(barOuter);

    // 章リスト
    const listEl = el('div', { class: 'sk-progress-list' });
    listEl.style.marginBottom = '12px';
    slot.appendChild(listEl);

    // 再読込ボタン
    const reloadBtn = el('button', { class: 'btn btn-quiet btn-sm', text: '再読込' });
    reloadBtn.addEventListener('click', function () {
      loadProgress(barInner, listEl, summaryEl, reloadBtn);
    });
    slot.appendChild(reloadBtn);

    // master-doc-changed から再読込を呼べるよう、現在のスロットの再読込処理を保持
    reloadActiveProgress = function () {
      loadProgress(barInner, listEl, summaryEl, reloadBtn);
    };

    // 初回自動ロード
    loadProgress(barInner, listEl, summaryEl, reloadBtn);
  }

  // core-ready 後に初期化
  window.SK_CORE.on('core-ready', async function () {
    const slot = document.getElementById('mod-progress-tracker-slot');
    if (!slot) return;

    const ready = await isOAuthReady();
    if (!ready) return;

    slot.classList.remove('hidden');
    buildUI(slot);
  });

  // マスタードキュメントが新規作成・変更されたら進捗を再取得する。
  // （sidepanel.js が storage の sk_master_doc_v012 変化を master-doc-changed として中継）
  // 症状: 新規案件でマスタードキュメントを作っても最上部の進捗チップ/ドット/「次は §N」が
  //       前案件の値のまま固まる → ここで読み直して解消する。
  window.SK_CORE.on('master-doc-changed', async function () {
    const slot = document.getElementById('mod-progress-tracker-slot');
    if (!slot) return;
    const ready = await isOAuthReady();
    if (!ready) return;
    if (slot.classList.contains('hidden')) {
      // 連携直後などでまだ UI 未構築なら、初回構築＝初回ロードで反映
      slot.classList.remove('hidden');
      buildUI(slot);
    } else if (reloadActiveProgress) {
      // 構築済みなら既存の再読込と同じ処理で最上部進捗を更新
      reloadActiveProgress();
    }
  });
})();
