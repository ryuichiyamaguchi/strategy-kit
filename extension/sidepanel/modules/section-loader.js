// STRATEGY-KIT Phase 2 — 章読込モジュール
// 役割:
//   フェーズの inputs に含まれる §N を Docs API 経由で取得し、
//   プロンプト本文のプレースホルダを置換するボタン群を提供する。

(function () {
  // §N 形式の文字列を section番号（数値）に変換
  function parseSecNo(str) {
    const m = str.match(/§(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // inputs 配列から §N を抽出して数値配列で返す
  function extractSecNos(inputs) {
    if (!Array.isArray(inputs)) return [];
    const nos = [];
    for (const inp of inputs) {
      const no = parseSecNo(inp);
      if (no !== null) nos.push(no);
    }
    return nos;
  }

  // 取得した章テキストを prompt-body の textContent 内プレースホルダに置換する
  // sections: Map<number, string>  (§番号 → テキスト)
  // secNos: number[]  (対象番号一覧)
  function replacePlaceholders(bodyEl, sections, secNos) {
    let text = bodyEl.textContent;

    // 1) 個別プレースホルダ: ★§N★, ★§Nの内容★, ★§Nを貼付★
    for (const no of secNos) {
      const secText = sections.get(no);
      if (secText == null) continue;
      const patterns = [
        new RegExp(`★§${no}を貼付★`, 'g'),
        new RegExp(`★§${no}の内容★`, 'g'),
        new RegExp(`★§${no}★`, 'g'),
      ];
      for (const re of patterns) {
        text = text.replace(re, secText);
      }
    }

    // 2) 範囲プレースホルダ: ★§A〜§B★ や ★§A〜§B★
    text = text.replace(/★§(\d+)[〜~]§(\d+)★/g, (_, a, b) => {
      const start = parseInt(a, 10);
      const end = parseInt(b, 10);
      const parts = [];
      for (let n = start; n <= end; n++) {
        const t = sections.get(n);
        if (t) parts.push(t);
      }
      return parts.length ? parts.join('\n\n') : `★§${a}〜§${b}★`;
    });

    // 3) ★ここに貼付★ → 全対象章を連結して置換
    const allText = secNos
      .map((n) => sections.get(n))
      .filter(Boolean)
      .join('\n\n');
    if (allText) {
      text = text.replace(/★ここに貼付★/g, allText);
    }

    // 4) ★参照情報★ 直後の ★...の内容★ / ★...を貼付★ 系をまとめて置換
    if (allText) {
      text = text.replace(/★[^★]*(?:の内容|を貼付|貼付)[^★]*★/g, allText);
    }

    bodyEl.textContent = text;
  }

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

  async function getSourceDocumentId() {
    const stored = await chrome.storage.sync.get([
      'sk_draft_doc_v012',
      'sk_chapter_doc_v012',
      'sk_master_doc_v012',
    ]);
    return (
      stored.sk_draft_doc_v012?.documentId ||
      stored.sk_chapter_doc_v012?.documentId ||
      stored.sk_master_doc_v012?.documentId ||
      null
    );
  }

  // 対象 §番号セットを Docs から取得し Map<no, text> を返す
  async function fetchSections(secNos) {
    const documentId = await getSourceDocumentId();
    if (!documentId) throw new Error('DRAFT または章別記録 Docs が未作成です');

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const [docsMod, sectionsMod] = await Promise.all([import(docsUrl), import(sectionsUrl)]);
    const doc = await docsMod.getDocument(documentId);
    return sectionsMod.buildSectionTextMap(doc, secNos, { allowLastSectionNo: 99 });
  }

  // 単一ボタンのクリックハンドラを生成（対象 secNos のみ取得して置換）
  function makeLoadHandler(btn, secNos) {
    return async function () {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = '読込中…';
      try {
        const sections = await fetchSections(secNos);
        const bodyEls = document.querySelectorAll(
          '#prompts-list .prompt-item .prompt-body'
        );
        for (const bodyEl of bodyEls) {
          replacePlaceholders(bodyEl, sections, secNos);
        }
        window.SK_CORE.showToast('§' + secNos.join('・§') + ' を読み込みました');
      } catch (e) {
        window.SK_CORE.showToast('読込失敗: ' + e.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    };
  }

  // .section-load-row を生成してプロンプトリストの各 .prompt-body 直前に挿入
  function renderLoadRow(secNos) {
    // 既存のロード行をすべて除去
    for (const old of document.querySelectorAll('.section-load-row')) {
      old.remove();
    }

    if (secNos.length === 0) return;

    const { el } = window.SK_CORE;

    // 各 .prompt-body の直前に独立した .section-load-row を挿入
    const bodyEls = document.querySelectorAll(
      '#prompts-list .prompt-item .prompt-body'
    );
    for (const bodyEl of bodyEls) {
      const row = el('div', { class: 'section-load-row' });

      // 個別ボタン（章ごと）
      for (const no of secNos) {
        const btn = el('button', {
          class: 'section-load-btn',
          text: `§${no} を埋める`,
        });
        btn.addEventListener('click', makeLoadHandler(btn, [no]));
        row.appendChild(btn);
      }

      // まとめてボタン（2章以上のとき）
      if (secNos.length >= 2) {
        const allBtn = el('button', {
          class: 'section-load-btn',
          text: '全部読み込む',
        });
        allBtn.addEventListener('click', makeLoadHandler(allBtn, secNos));
        row.appendChild(allBtn);
      }

      bodyEl.parentNode.insertBefore(row, bodyEl);
    }
  }

  // フェーズ切替・初期描画の共通処理
  async function onPhaseChange() {
    const ready = await isOAuthReady();
    if (!ready) return;

    const phase = window.SK_CORE.getCurrentPhase();
    const secNos = extractSecNos(phase ? phase.inputs : []);
    renderLoadRow(secNos);
  }

  // core-ready 後に初期化
  window.SK_CORE.on('core-ready', function () {
    onPhaseChange();
    window.SK_CORE.on('phase-changed', function () {
      onPhaseChange();
    });
  });

  // 任意公開（デバッグ用）
  window.SK_MOD_SECTION_LOADER = { extractSecNos, replacePlaceholders };
})();
