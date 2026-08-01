// STRATEGY-KIT Phase 4 — 決定ログ追記モジュール
// 役割:
//   §99 決定ログへの追記と全章タイムスタンプ更新を提供する。
//   OAuth 未連携時はスロットを hidden のまま機能オフ。

(function () {
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

  async function loadDecisionLog() {
    const logUrl = chrome.runtime.getURL('phase0/decision-log.js');
    return await import(logUrl);
  }

  // モーダルを閉じて DOM から除去
  function closeModal(backdrop) {
    backdrop.remove();
  }

  // 決定追記モーダルを開く
  function openDecisionModal(lastEntryEl) {
    const { el } = window.SK_CORE;

    const backdrop = el('div', { class: 'modal-backdrop' });

    const modal = el('div', { class: 'modal' });

    modal.appendChild(el('h2', { class: 'card-title', text: '決定を追記' }));

    // 決定（必須）
    const decisionRow = el('label', { class: 'form-row' });
    decisionRow.appendChild(el('span', { class: 'form-label', text: '決定内容（必須）' }));
    const decisionInput = el('input', {
      attrs: { type: 'text', placeholder: '例: ターゲットを30代女性に絞る' },
    });
    decisionRow.appendChild(decisionInput);
    modal.appendChild(decisionRow);

    // 理由（textarea 2行）
    const reasonRow = el('label', { class: 'form-row' });
    reasonRow.appendChild(el('span', { class: 'form-label', text: '理由' }));
    const reasonTextarea = el('textarea', {
      attrs: { rows: '2', placeholder: '例: 来店客データで最多客層のため' },
    });
    reasonRow.appendChild(reasonTextarea);
    modal.appendChild(reasonRow);

    // 次アクション（任意）
    const actionRow = el('label', { class: 'form-row' });
    actionRow.appendChild(el('span', { class: 'form-label', text: '次アクション（任意）' }));
    const actionInput = el('input', {
      attrs: { type: 'text', placeholder: '例: §3 ペルソナ章を更新する' },
    });
    actionRow.appendChild(actionInput);
    modal.appendChild(actionRow);

    // ボタン行
    const actions = el('div', { class: 'modal-actions' });

    const appendBtn = el('button', { class: 'btn', text: '追記' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: 'キャンセル' });

    appendBtn.addEventListener('click', async function () {
      const decision = decisionInput.value.trim();
      if (!decision) {
        window.SK_CORE.showToast('決定内容を入力してください', true);
        return;
      }

      appendBtn.disabled = true;
      appendBtn.textContent = '追記中…';

      try {
        const decisionLog = await loadDecisionLog();
        const result = await decisionLog.appendDecisionLog({
          decision,
          reason: reasonTextarea.value.trim(),
          action: actionInput.value.trim(),
        });
        // 直近追記の表示を更新
        if (lastEntryEl) {
          lastEntryEl.textContent = (result.date || '—') + '　' + decision;
        }
        window.SK_CORE.showToast('§99 に追記しました');
        closeModal(backdrop);
      } catch (e) {
        console.error('[STRATEGY-KIT] 決定ログ追記エラー:', e);
        window.SK_CORE.showToast('決定ログの追記に失敗しました。Google連携とマスタードキュメントを確認してください。', true);
        appendBtn.disabled = false;
        appendBtn.textContent = '追記';
      }
    });

    cancelBtn.addEventListener('click', function () {
      closeModal(backdrop);
    });

    actions.appendChild(appendBtn);
    actions.appendChild(cancelBtn);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // 背景クリックで閉じる
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal(backdrop);
    });

    // ESC キーで閉じる
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        closeModal(backdrop);
        document.removeEventListener('keydown', onKeyDown);
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // 開いたらフォーカス
    // v0.9.14: バグC対策 — preventScroll でモーダル open 時の背景スクロールを抑制
    decisionInput.focus({ preventScroll: true });
  }

  // スロットに UI を構築
  function buildUI(slot) {
    const { el } = window.SK_CORE;

    slot.appendChild(el('h2', { class: 'card-title', text: '§99 決定ログ' }));

    // 直近追記表示
    const lastEntryEl = el('p', {
      class: 'muted-note',
      text: '（未追記）',
    });
    Object.assign(lastEntryEl.style, { fontSize: '11px', marginBottom: '8px' });
    slot.appendChild(lastEntryEl);

    // ボタン行
    const btnRow = el('div', { class: 'form-row' });
    btnRow.style.gap = '6px';

    const addBtn = el('button', { class: 'btn', text: '決定を追記' });
    addBtn.addEventListener('click', function () {
      openDecisionModal(lastEntryEl);
    });

    const tsBtn = el('button', { class: 'btn btn-ghost', text: 'タイムスタンプ記録を追記' });
    tsBtn.addEventListener('click', async function () {
      if (!confirm('§99 にタイムスタンプ更新記録を追記しますか？')) return;
      tsBtn.disabled = true;
      tsBtn.textContent = '更新中…';
      try {
        const decisionLog = await loadDecisionLog();
        await decisionLog.appendTimestampRefresh({});
        window.SK_CORE.showToast(
          '§99 にタイムスタンプ更新記録を追記しました'
        );
      } catch (e) {
        console.error('[STRATEGY-KIT] タイムスタンプ更新エラー:', e);
        window.SK_CORE.showToast('タイムスタンプ更新記録の追記に失敗しました。Google連携とマスタードキュメントを確認してください。', true);
      } finally {
        tsBtn.disabled = false;
        tsBtn.textContent = 'タイムスタンプ記録を追記';
      }
    });

    btnRow.appendChild(addBtn);
    btnRow.appendChild(tsBtn);
    slot.appendChild(btnRow);
  }

  // core-ready 後に初期化
  window.SK_CORE.on('core-ready', async function () {
    const slot = document.getElementById('mod-decision-logger-slot');
    if (!slot) return;

    const ready = await isOAuthReady();
    if (!ready) return;

    slot.classList.remove('hidden');
    buildUI(slot);
  });
})();
