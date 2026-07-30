// STRATEGY-KIT Phase v0.6 — 自動化モジュール（半自動チェーン）
// 役割:
//   半自動チェーン: 各フェーズで AI 挿入→出力貼付→次へ のチェーン進行
//   全自動・半自動はマスター本体、旧 DRAFT は取り込み・後処理の補助導線
//   研究ログは research-NN-auto.md として Drive に蓄積

(function () {
  const DRAFT_DECISION_CANCELLED = 'DRAFT_DECISION_CANCELLED';
  const TASK_MONITOR_STORAGE_KEY = 'sk_task_monitor_v1';
  const TASK_MONITOR_ALLOWED_ORIGINS = new Set([
    'https://claude.ai',
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://gemini.google.com',
    'https://manus.im',
    'https://www.manus.im',
    'https://genspark.ai',
    'https://www.genspark.ai',
    'https://www.perplexity.ai',
    'https://perplexity.ai',
    'https://notebooklm.google.com',
    'https://grok.com',
    'https://www.grok.com',
    'https://docs.google.com',
  ]);
  let taskMonitorWrite_ = Promise.resolve();
  let taskMonitorTarget_ = null;

  async function captureTaskMonitorTarget_() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs && tabs[0];
      const origin = tab?.url ? new URL(tab.url).origin : null;
      taskMonitorTarget_ = tab?.id && TASK_MONITOR_ALLOWED_ORIGINS.has(origin)
        ? { targetTabId: tab.id, targetOrigin: origin }
        : null;
    } catch (_) {
      taskMonitorTarget_ = null;
    }
    return taskMonitorTarget_;
  }

  // 課金APIキーが必要なモデル。無料枠のキーでは 429 で拒否される。
  // ここを変えたら lib/model-policy.js も同じ内容に揃えること（テストが一致を検査する）。
  const SK_PAID_ONLY_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-image', 'gemini-3-pro-image'];
  const SK_FREE_TIER_FALLBACK_MODEL = 'gemini-3.6-flash';
  const SK_MODEL_POLICY_VERSION = 1;

  // v0.12.28 では §7 の既定が gemini-3.1-pro-preview だった。その値は
  // sk-state.projects.<id>.automation.uiDraft に残り、更新しても消えない。
  // 保存値をそのまま復元すると、既存受講者だけ §7 で止まり続ける。
  // ただし読み替えるのは版数の無い（＝旧バージョンが自動保存した）ドラフトだけ。
  // 課金APIキーを貼って自分で Pro を選んだ人の設定は維持する。
  function skNeedsLegacyModelRemap_(savedDraft) {
    return (Number(savedDraft && savedDraft.modelPolicyVersion) || 0) < SK_MODEL_POLICY_VERSION;
  }

  function restoreSelectableModel_(savedModel, selectEl, remapLegacy) {
    const selectable = Array.from(selectEl.options).some(function (option) {
      return option.value === savedModel;
    });
    if (!selectable) return SK_FREE_TIER_FALLBACK_MODEL;
    if (remapLegacy && SK_PAID_ONLY_MODELS.indexOf(savedModel) !== -1) {
      return SK_FREE_TIER_FALLBACK_MODEL;
    }
    return savedModel;
  }

  function publishTaskMonitor_(snapshot) {
    const input = snapshot || {};
    const executionMode = document.getElementById('sk-mode-semi')?.checked ? 'semi' : 'full';
    const allowedStatuses = new Set(['idle', 'running', 'retrying', 'paused', 'blocked', 'completed']);
    const payload = {
      visible: true,
      provider: input.provider || (executionMode === 'semi' ? '複数AI' : 'Gemini'),
      projectId: window.SK_STATE?._activeProjectId || '',
      mode: executionMode,
      relativeTime: 'いま',
      updatedAt: Date.now(),
      status: allowedStatuses.has(input.status) ? input.status : 'running',
      taskLabel: String(input.taskLabel || '処理内容を確認しています'),
      taskCount: input.taskCount ? String(input.taskCount) : '',
      eta: input.eta ? String(input.eta) : '',
      lastEvent: String(input.lastEvent || '状態を更新しました'),
    };
    if (input.visible === false || payload.status === 'idle') payload.visible = false;
    if (taskMonitorTarget_) Object.assign(payload, taskMonitorTarget_);
    taskMonitorWrite_ = taskMonitorWrite_
      .catch(function () {})
      .then(function () {
        return chrome.storage.local.set({ [TASK_MONITOR_STORAGE_KEY]: payload });
      })
      .catch(function (error) {
        console.warn('[STRATEGY-KIT] task monitor update failed:', error);
      });
    if (payload.status === 'idle') taskMonitorTarget_ = null;
    return taskMonitorWrite_;
  }

  // 生成物タイトル等のブランド表記を product.json の branding.footerLabel に間接化する。
  // SK_CORE.getFooterLabel 経由（未読・未定義時は STRATEGY-KIT へフォールバック）。
  function brandFooterLabel_() {
    try {
      const fn = window.SK_CORE && window.SK_CORE.getFooterLabel;
      const label = typeof fn === 'function' ? fn() : null;
      return label || 'STRATEGY-KIT';
    } catch (_) {
      return 'STRATEGY-KIT';
    }
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

  async function loadDraftManagerDeps() {
    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const driveUrl = chrome.runtime.getURL('phase0/drive-client.js');
    const draftManagerUrl = chrome.runtime.getURL('phase0/draft-manager.js');
    const [docsClient, driveClient, draftManager] = await Promise.all([
      import(docsUrl),
      import(driveUrl),
      import(draftManagerUrl),
    ]);
    return { docsClient, driveClient, draftManager };
  }

  async function loadMasterWriterDeps() {
    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const driveUrl = chrome.runtime.getURL('phase0/drive-client.js');
    const masterDocManagerUrl = chrome.runtime.getURL('phase0/master-doc-manager.js');
    const masterSectionWriterUrl = chrome.runtime.getURL('phase0/master-section-writer.js');
    const masterStateUrl = chrome.runtime.getURL('phase0/automation-master-state.js');
    const [docsClient, driveClient, masterDocManager, masterSectionWriter, masterState] = await Promise.all([
      import(docsUrl),
      import(driveUrl),
      import(masterDocManagerUrl),
      import(masterSectionWriterUrl),
      import(masterStateUrl),
    ]);
    return { docsClient, driveClient, masterDocManager, masterSectionWriter, masterState };
  }

  async function loadMasterMigrationDeps() {
    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const driveUrl = chrome.runtime.getURL('phase0/drive-client.js');
    const draftManagerUrl = chrome.runtime.getURL('phase0/draft-manager.js');
    const masterDocManagerUrl = chrome.runtime.getURL('phase0/master-doc-manager.js');
    const masterSectionWriterUrl = chrome.runtime.getURL('phase0/master-section-writer.js');
    const masterMigrationUrl = chrome.runtime.getURL('phase0/master-migration.js');
    const [docsClient, driveClient, draftManager, masterDocManager, masterSectionWriter, masterMigration] = await Promise.all([
      import(docsUrl),
      import(driveUrl),
      import(draftManagerUrl),
      import(masterDocManagerUrl),
      import(masterSectionWriterUrl),
      import(masterMigrationUrl),
    ]);
    return { docsClient, driveClient, draftManager, masterDocManager, masterSectionWriter, masterMigration };
  }

  function normalizeDraftBusinessValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^[（(]?\s*(未設定|未指定|なし|無し)\s*[）)]?$/.test(text)) return '';
    return text;
  }

  async function applyDraftBusinessInfoToSettings(businessInfo) {
    const industryLabel = normalizeDraftBusinessValue(businessInfo?.industryLabel);
    const storeName = normalizeDraftBusinessValue(businessInfo?.storeName);
    if (!industryLabel && !storeName) return null;

    const settings = window.SK_CORE?.getState?.()?.settings || {};
    const patch = {};
    if (industryLabel && industryLabel !== settings.industryLabel) {
      patch.industryLabel = industryLabel;
    }
    if (storeName && storeName !== settings.storeName) {
      patch.storeName = storeName;
    }
    if (!Object.keys(patch).length) return null;

    Object.assign(settings, patch);
    await chrome.storage.sync.set(patch);
    try {
      if (window.SK_STATE) {
        if (patch.industryLabel) window.SK_STATE.save('placeholders.industryLabel', patch.industryLabel);
        if (patch.storeName) window.SK_STATE.save('placeholders.storeName', patch.storeName);
      }
      if (window.SK_CORE?.emit) window.SK_CORE.emit('business-updated', patch);
    } catch (_) {
      // local UI persistence is best-effort; sync storage above is the source for this handoff.
    }
    return patch;
  }

  async function loadResearchStore() {
    const researchStoreUrl = chrome.runtime.getURL('phase0/research-store.js');
    return await import(researchStoreUrl);
  }

  async function loadGeminiClient() {
    const geminiUrl = chrome.runtime.getURL('phase0/gemini-client.js');
    return await import(geminiUrl);
  }

  async function loadFinanceGateDeps() {
    const financeGateUrl = chrome.runtime.getURL('phase0/finance-gate.js');
    return await import(financeGateUrl);
  }

  async function loadDraftPreviewDeps() {
    const previewUrl = chrome.runtime.getURL('phase0/draft-preview.js');
    return await import(previewUrl);
  }

  async function loadAutomationResumeDeps() {
    const resumeUrl = chrome.runtime.getURL('phase0/automation-resume.js');
    return await import(resumeUrl);
  }

  async function loadDecisionLogDeps() {
    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const decisionLogUrl = chrome.runtime.getURL('phase0/decision-log.js');
    const [docsClient, decisionLog] = await Promise.all([
      import(docsUrl),
      import(decisionLogUrl),
    ]);
    return { docsClient, decisionLog };
  }

  function showDraftDecisionModal({ existingTitle, onChoice }) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;
    let root = document.getElementById('draft-decision-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'draft-decision-modal-root';
      root.className = 'draft-decision-modal-root hidden';
      document.body.appendChild(root);
    }

    return new Promise(function (resolve) {
      const previouslyFocused = document.activeElement;
      let settled = false;

      function cleanup() {
        document.removeEventListener('keydown', onKeyDown, true);
        root.classList.add('hidden');
        root.removeAttribute('role');
        root.removeAttribute('aria-modal');
        root.removeAttribute('aria-labelledby');
        clear(root);
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus({ preventScroll: true }); } catch (_) {}
        }
      }

      function resolveChoice(choice) {
        if (settled) return;
        settled = true;
        cleanup();
        if (typeof onChoice === 'function') onChoice(choice);
        resolve(choice);
      }

      function onKeyDown(event) {
        if (event['key'] === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          resolveChoice('cancel');
        }
      }

      const titleText = existingTitle || '(無題)';
      const actions = el('div', { class: 'draft-decision-actions' },
        el('button', {
          class: 'draft-decision-choice is-recommended',
          type: 'button',
          attrs: { 'data-choice': 'reuse' },
          on: { click: function () { resolveChoice('reuse'); } },
        },
          el('span', { class: 'draft-decision-choice-title', text: '既存 DRAFT に追記する (推奨)' }),
          el('span', { class: 'draft-decision-choice-desc', text: '既存 docId に章を追記します。Drive にファイルが増えません。' })
        ),
        el('button', {
          class: 'draft-decision-choice',
          type: 'button',
          attrs: { 'data-choice': 'create' },
          on: { click: function () { resolveChoice('create'); } },
        },
          el('span', { class: 'draft-decision-choice-title', text: '新規 DRAFT を作成する' }),
          el('span', { class: 'draft-decision-choice-desc', text: '既存は残し、別 docId を新規作成します。Drive にもう 1 ファイルできます。' })
        ),
        el('button', {
          class: 'draft-decision-choice',
          type: 'button',
          attrs: { 'data-choice': 'cancel' },
          on: { click: function () { resolveChoice('cancel'); } },
        },
          el('span', { class: 'draft-decision-choice-title', text: 'やめる' }),
          el('span', { class: 'draft-decision-choice-desc', text: '実行をキャンセルします。DRAFT は変更しません。' })
        )
      );

      const sheet = el('div', {
        class: 'draft-decision-sheet',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'draft-decision-title',
        },
        on: {
          click: function (event) {
            event.stopPropagation();
          },
        },
      },
        el('h2', { id: 'draft-decision-title', class: 'draft-decision-title', text: '既存の DRAFT が見つかりました' }),
        el('p', { class: 'draft-decision-lede', text: 'どの DRAFT に書くかを選んでから実行します。' }),
        el('div', { class: 'draft-decision-file', text: titleText }),
        actions
      );

      clear(root);
      root.appendChild(sheet);
      root.classList.remove('hidden');
      document.addEventListener('keydown', onKeyDown, true);
      const first = root.querySelector('[data-choice="reuse"]');
      if (first && first.focus) first.focus({ preventScroll: true });
    });
  }

  window.SK_SHOW_DRAFT_DECISION_MODAL = showDraftDecisionModal;

  // 業種別 unitEconomicsBenchmark を sidepanel.js の state.industries から取得
  function findIndustry(industryIdOrLabel) {
    try {
      const st =
        window.SK_CORE && window.SK_CORE.getState
          ? window.SK_CORE.getState()
          : null;
      const items = st && st.industries && st.industries.items;
      if (!items) return null;
      return (
        items.find(function (i) {
          return i.id === industryIdOrLabel || i.label === industryIdOrLabel;
        }) || null
      );
    } catch (e) {
      return null;
    }
  }

  // SNS 版プラットフォーム別 snsBenchmark を sidepanel.js の state.platforms から取得
  // findIndustry（state.industries）と対称。state.platforms は benchmarkSource==="platform"
  // のときだけロードされる（Webマーケ版は null）→ その場合は常に null を返し無害。
  function findPlatform(platformIdOrLabel) {
    try {
      const st =
        window.SK_CORE && window.SK_CORE.getState
          ? window.SK_CORE.getState()
          : null;
      const items = st && st.platforms && st.platforms.items;
      if (!items) return null;
      return (
        items.find(function (p) {
          return p.id === platformIdOrLabel || p.label === platformIdOrLabel;
        }) || null
      );
    } catch (e) {
      return null;
    }
  }

  // snsBenchmark を Markdown ブロック化して body 先頭に差し込む（injectBenchmark と同型）。
  // X 単一前提のため業種未登録向けの代替注入分岐は持たない（default 解決で足りる）。
  // metrics は platforms.json 側でキーが増減しうるため Object.entries で動的に行生成する。
  function injectPlatformBenchmark(body, platform) {
    if (!platform || !platform.snsBenchmark) return body;
    const b = platform.snsBenchmark;
    const m = b.metrics || {};
    function fmtRange(x) {
      if (!x) return '— / — / —';
      const u = x.unit ? ' ' + x.unit : '';
      return x.low + ' / ' + x.mid + ' / ' + x.high + u;
    }
    function tag(x) {
      return x && x.tag ? x.tag : '';
    }
    const sourcesText = (b.sources || [])
      .map(function (s, i) {
        return i + 1 + '. ' + s.label + ' — ' + s.url;
      })
      .join('\n');

    const header =
      '【プラットフォーム別ベンチマーク（自動注入: ' +
      platform.label +
      ' / 更新 ' +
      b.updated +
      '）】';
    const lines = ['', header];
    if (b.notes) lines.push('> ' + b.notes);
    lines.push('', '| 指標 | low / mid / high | タグ |', '|---|---|---|');
    // metrics は JSON のキー順を維持して動的に行生成（キー名をそのまま指標名に使う）
    const memos = [];
    Object.keys(m).forEach(function (key) {
      const x = m[key];
      lines.push('| ' + key + ' | ' + fmtRange(x) + ' | ' + tag(x) + ' |');
      if (x && x.memo) memos.push('- ' + key + ': ' + x.memo);
    });
    lines.push('');
    if (memos.length) {
      lines.push('【指標メモ】');
      memos.forEach(function (line) {
        lines.push(line);
      });
      lines.push('');
    }
    if (platform.algorithmNotes) {
      lines.push('【アルゴリズム特性メモ】', platform.algorithmNotes, '');
    }
    lines.push('【主要出典】', sourcesText, '');
    return lines.join('\n') + '\n\n' + body;
  }

  // unitEconomicsBenchmark を Markdown ブロック化して body 先頭に差し込む
  // 第3引数 actualIndustryLabel を渡すと「汎用基準で代替注入」モードになる
  function injectBenchmark(body, industry, actualIndustryLabel) {
    if (!industry || !industry.unitEconomicsBenchmark) return body;
    const b = industry.unitEconomicsBenchmark;
    const m = b.metrics || {};
    function fmtRange(x) {
      if (!x) return '— / — / —';
      const u = x.unit ? ' ' + x.unit : '';
      return x.low + ' / ' + x.mid + ' / ' + x.high + u;
    }
    function tag(x) {
      return x && x.tag ? x.tag : '';
    }
    const sourcesText = (b.sources || [])
      .map(function (s, i) {
        return i + 1 + '. ' + s.label + ' — ' + s.url;
      })
      .join('\n');

    const fallback = !!actualIndustryLabel;
    const header = fallback
      ? '【業種別ベンチマーク（汎用基準で代替注入：実業種=' + actualIndustryLabel + '）】'
      : '【業種別ベンチマーク（自動注入：' + industry.label + ' / 更新 ' + b.updated + '）】';
    const lines = ['', header];
    if (fallback) {
      lines.push(
        '※ 下記は汎用（業種非依存）の基準値です。実際の業種は『' +
          actualIndustryLabel +
          '』。**下記の汎用値をそのまま転載することは禁止**。まず ' +
          actualIndustryLabel +
          ' の特性（客単価・来店頻度・粗利率・商習慣など）を踏まえて各指標を調整した「' +
          actualIndustryLabel +
          '向け調整ベンチマーク（low/mid/high）」を最初に1つ作り、調整後の数値レンジと各指標の調整理由を1行ずつ示してから、その調整値を使って本文を記入してください。◯や空欄のまま出力することは禁止です。'
      );
    }
    if (b.notes) lines.push('> ' + b.notes);
    lines.push(
      '',
      '| 指標 | low / mid / high | タグ |',
      '|---|---|---|',
      '| 顧客単価 | ' + fmtRange(m.customerUnitPrice) + ' | ' + tag(m.customerUnitPrice) + ' |',
      '| 粗利率 | ' + fmtRange(m.grossMarginRate) + ' | ' + tag(m.grossMarginRate) + ' |',
      '| 月次継続率 | ' + fmtRange(m.monthlyRetention) + ' | ' + tag(m.monthlyRetention) + ' |',
      '| 月間頻度 | ' + fmtRange(m.visitFrequencyPerMonth) + ' | ' + tag(m.visitFrequencyPerMonth) + ' |',
      '| CAC | ' + fmtRange(m.cac) + ' | ' + tag(m.cac) + ' |',
      '| LTV | ' + fmtRange(m.ltv) + ' | ' + tag(m.ltv) + ' |',
      '| Payback | ' + fmtRange(m.paybackMonths) + ' | ' + tag(m.paybackMonths) + ' |',
      '',
      '【主要出典】',
      sourcesText,
      ''
    );
    return lines.join('\n') + '\n\n' + body;
  }

  // 蓄積コンテキストをプロンプト本文に埋め込む（サブプロンプト単位）
  function buildSubPrompt(prompt, accumulated, formInputs) {
    if (!prompt) return '';
    let body = window.SK_CORE.applyTemplate(prompt.body || '');

    // v0.12: phase-7-unit-economics に業種別 unitEconomicsBenchmark を自動注入
    if (
      prompt.id === 'phase-7-unit-economics' &&
      formInputs &&
      formInputs.industry
    ) {
      const ind = findIndustry(formInputs.industry);
      if (ind && ind.unitEconomicsBenchmark) {
        // プリセット業種にヒット → 従来どおり注入（後方互換）
        body = injectBenchmark(body, ind);
      } else {
        // 未登録業種 → 汎用ベンチマークで代替注入（実業種名を明示）
        const generic = findIndustry('generic');
        if (generic && generic.unitEconomicsBenchmark) {
          console.warn(
            '業種『' +
              formInputs.industry +
              '』未登録→汎用ベンチマークで代替注入'
          );
          body = injectBenchmark(body, generic, formInputs.industry);
        }
        // generic も取れない最悪ケースは従来どおり素通り（body そのまま）
      }
    }

    // SNS版: §0/§7 にプラットフォーム別 snsBenchmark を自動注入（state.platforms.default で解決）。
    // state.platforms は benchmarkSource==="platform" のときだけロードされる → Webマーケ版は素通り。
    if (
      prompt.id === 'phase-sns-0-platform-research' ||
      prompt.id === 'phase-sns-7-operations-economics'
    ) {
      const st =
        window.SK_CORE && window.SK_CORE.getState
          ? window.SK_CORE.getState()
          : null;
      const platformKey =
        (formInputs && formInputs.platform) ||
        (st && st.platforms && st.platforms.default) ||
        null;
      const plat = platformKey ? findPlatform(platformKey) : null;
      if (plat && plat.snsBenchmark) {
        body = injectPlatformBenchmark(body, plat);
      }
    }

    // 蓄積コンテキスト
    const ctxEntries = Object.keys(accumulated).map(function (k) {
      return '### ' + k + '\n' + accumulated[k];
    });
    const ctx = ctxEntries.length ? ctxEntries.join('\n\n') : '（蓄積コンテキストなし）';

    // 残った ★...★ プレースホルダを「蓄積コンテキスト参照」に置換
    // （業種・店舗・テーマは applyTemplate で置換済み。残りは蓄積データ系）
    body = body.replace(/★[^★\n]+★/g, '（後段の【蓄積コンテキスト】参照）');

    // 末尾に蓄積コンテキストを必ず追加
    body += '\n\n---\n\n【蓄積コンテキスト】\n\n' + ctx;

    // 初期入力も追加
    if (formInputs) {
      body +=
        '\n\n---\n\n【ユーザー初期入力】\n' +
        '業種: ' + (formInputs.industry || '未指定') + '\n' +
        '店舗: ' + (formInputs.storeName || '未指定') + '\n' +
        '現状メモ:\n' + (formInputs.memo || '（なし）') + '\n' +
        (formInputs.context ? '\n追加コンテキスト:\n' + formInputs.context + '\n' : '');
    }
    return body;
  }

  // フェーズの全サブプロンプトを横並びにフラット化
  function flattenPhases(phases) {
    const steps = [];
    for (const phase of phases) {
      if (!phase.prompts || !phase.prompts.length) {
        // サブプロンプトなしのフェーズは見出しだけ生成
        steps.push({
          phase: phase,
          prompt: null,
          subNo: 1,
          totalSubs: 1,
          isPlaceholder: true,
        });
        continue;
      }
      phase.prompts.forEach(function (p, idx) {
        steps.push({
          phase: phase,
          prompt: p,
          subNo: idx + 1,
          totalSubs: phase.prompts.length,
        });
      });
    }
    return steps;
  }

  // UI構築
  function buildUI(slot) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;

    clear(slot);
    const eyebrowRow = el('div', { class: 'card-eyebrow-row' },
      el('span', { class: 'card-eyebrow card-eyebrow-auto', text: 'automation' }),
      el('span', { class: 'card-eyebrow-rule' })
    );
    slot.appendChild(eyebrowRow);
    slot.appendChild(el('h2', { class: 'editorial-title editorial-title-auto', text: '自動化モード' }));

    // ===== モード切替ラジオボタン =====
    const modeCard = el('div', {
      class: 'sk-automation-mode-inputs',
      style: 'display:none',
      attrs: { 'aria-hidden': 'true' },
    });

    const radioSemi = el('input', { type: 'radio', name: 'sk-automode', value: 'semi', id: 'sk-mode-semi' });
    radioSemi.checked = true;
    const labelSemi = el('label', {
      attrs: { for: 'sk-mode-semi' },
      style: 'font-size:12px;font-weight:600;cursor:pointer;margin-left:4px',
      text: '半自動チェーン（マスター本体へ保存・8AI使い分け）',
    });

    const radioFull = el('input', { type: 'radio', name: 'sk-automode', value: 'full', id: 'sk-mode-full' });
    radioFull.style.marginTop = '6px';
    const labelFull = el('label', {
      attrs: { for: 'sk-mode-full' },
      style: 'font-size:12px;font-weight:600;cursor:pointer;margin-left:4px',
      text: '全自動（Gemini API一本で短時間完走・初心者向け）',
    });

    const semiRow = el('div', { style: 'display:flex;align-items:center;margin-bottom:4px' }, radioSemi, labelSemi);
    const fullRow = el('div', { style: 'display:flex;align-items:center' }, radioFull, labelFull);

    // Geminiモデル選択（全自動時のみ表示）
    const modelSelect = el('select', {
      id: 'sk-auto-model',
      style: 'font-size:12px;padding:3px 6px;border:1px solid #e2e8f0;border-radius:4px',
    });
    [
      { value: 'gemini-3.6-flash', label: '通常: gemini-3.6-flash（推奨・無料枠OK）' },
      { value: 'gemini-3.5-flash', label: '通常: gemini-3.5-flash（無料枠OK）' },
      { value: 'gemini-3.5-flash-lite', label: '通常: gemini-3.5-flash-lite（無料枠OK・低コスト）' },
      { value: 'gemini-3.1-pro-preview', label: '通常: gemini-3.1-pro-preview（高精度・課金APIキーが必要）' },
    ].forEach(function (m) {
      modelSelect.appendChild(el('option', { value: m.value, text: m.label }));
    });
    const financeModelSelect = el('select', {
      id: 'sk-auto-finance-model',
      style: 'font-size:12px;padding:3px 6px;border:1px solid #e2e8f0;border-radius:4px',
    });
    [
      { value: 'gemini-3.6-flash', label: 'ユニットエコノミクス: gemini-3.6-flash（推奨・無料枠OK）' },
      { value: 'gemini-3.5-flash', label: 'ユニットエコノミクス: gemini-3.5-flash（無料枠OK・節約）' },
      { value: 'gemini-3.1-pro-preview', label: 'ユニットエコノミクス: gemini-3.1-pro-preview（高精度・課金APIキーが必要）' },
    ].forEach(function (m) {
      financeModelSelect.appendChild(el('option', { value: m.value, text: m.label }));
    });
    const modelRow = el('div', {
      style: 'display:none;margin-left:24px;margin-top:6px;gap:6px;flex-wrap:wrap;align-items:center',
    }, modelSelect, financeModelSelect);

    modeCard.appendChild(semiRow);
    modeCard.appendChild(fullRow);
    slot.appendChild(modeCard);

    const modeSummary = el('div', {
      id: 'sk-automation-mode-summary',
      class: 'sk-automation-mode-summary',
    });
    slot.appendChild(modeSummary);

    const fullModelSettings = el('div', {
      id: 'sk-full-auto-model-settings',
      class: 'sk-full-auto-model-settings',
      style: 'display:none',
    },
      el('div', { class: 'sk-full-auto-model-title', text: '全自動で使用するモデル' }),
      modelRow
    );
    slot.appendChild(fullModelSettings);

    // モード切替でモデル選択の表示/非表示
    function updateModeUI() {
      fullModelSettings.style.display = radioFull.checked ? '' : 'none';
      modelRow.style.display = radioFull.checked ? 'flex' : 'none';
      modeSummary.dataset.mode = radioFull.checked ? 'full' : 'semi';
      modeSummary.textContent = radioFull.checked
        ? '全自動モード：Geminiが§0〜§9を順番に生成・保存します。'
        : '半自動モード：AIの回答を確認・貼り付けしながら1ステップずつ進めます。';
      descP.textContent = radioFull.checked
        ? '§0〜§9 を Gemini API で順番に自動生成し、マスター本体に直接保存します。ユニットエコノミクスはFinance Gateで数値の算術整合（獲得人数=予算÷CAC・粗利LTV/CAC・Payback整合）まで検査し、合わなければ自動で数字を再計算（最大2回）。それでも残る不足は⚠要確認として明示しつつ完走します。'
        : '入力情報をベースに、各フェーズを順番に進めます。AIに送信→出力を貼付→次へ、を繰り返すことで、人間が選別しながらマスター本体へ保存します。';
      refreshCurrentActionCache().then(refreshAutomationPrimaryAction).catch(function () {
        refreshAutomationPrimaryAction();
      });
    }
    radioSemi.addEventListener('change', updateModeUI);
    radioFull.addEventListener('change', updateModeUI);

    const descP = el('p', {
      class: 'muted-note',
      text: '入力情報をベースに、各フェーズを順番に進めます。AIに送信→出力を貼付→次へ、を繰り返すことで、人間が選別しながらマスター本体へ保存します。',
    });
    slot.appendChild(descP);
    updateModeUI();

    const masterPrimaryCard = el('div', {
      style: 'background:#ecfdf5;border:1px solid #86efac;border-radius:6px;padding:8px 10px;margin:0 0 10px',
    },
      el('div', {
        style: 'font-size:12px;font-weight:700;color:#166534;margin-bottom:4px',
        text: '主動線: マスター本体',
      }),
      el('div', {
        style: 'font-size:11px;color:#166534;line-height:1.5',
        text: '全自動・半自動の保存先はマスター本体です。旧 DRAFT は取り込み・後処理が必要な場合だけ使います。',
      })
    );
    slot.appendChild(masterPrimaryCard);

    // 入力フォーム
    //   v0.9.14: 業種・店舗はトップ「事業設定」セクションを単一ソースとし、ここでは入力欄を持たない。
    //   - 読み取り専用表示 + 「変更」ボタンでトップ事業設定セクションへスクロール
    //   - 値は state.settings.industryLabel / storeName から都度参照
    const memoArea = el('textarea', {
      id: 'sk-auto-memo',
      placeholder: '現状の口頭メモを5〜10行で入力（事業概要・課題感・予算など）',
      style: 'width:100%;min-height:80px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:inherit;font-size:12px;resize:vertical',
    });
    const contextArea = el('textarea', {
      id: 'sk-auto-context',
      placeholder: '追加コンテキスト（任意・10行以内）',
      style: 'width:100%;min-height:60px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:inherit;font-size:12px;resize:vertical',
    });

    function snapshotAutomationDraft() {
      return {
        memo: memoArea.value || '',
        context: contextArea.value || '',
        mode: radioFull.checked ? 'full' : 'semi',
        model: modelSelect.value || 'gemini-3.6-flash',
        financeModel: financeModelSelect.value || 'gemini-3.6-flash',
        // この版数があるドラフトは「受講者が選んだ値」として扱い、以後読み替えない。
        modelPolicyVersion: SK_MODEL_POLICY_VERSION,
        draftUrl: typeof draftUrlInput !== 'undefined' && draftUrlInput ? draftUrlInput.value || '' : '',
        updatedAt: Date.now(),
      };
    }

    function persistAutomationDraft() {
      if (!window.SK_STATE) return;
      window.SK_STATE.save('automation.uiDraft', snapshotAutomationDraft());
    }

    function persistAutomationExecutionMode() {
      if (!window.SK_STATE) return;
      window.SK_STATE.save('automation.executionMode', radioFull.checked ? 'full' : 'semi');
    }

    function setExecutionMode(mode, options) {
      const normalized = mode === 'full' ? 'full' : 'semi';
      const opts = options || {};
      radioSemi.checked = normalized === 'semi';
      radioFull.checked = normalized === 'full';
      updateModeUI();
      if (opts.persistMode !== false) persistAutomationExecutionMode();
      if (opts.persistDraft !== false) persistAutomationDraft();
      if (automationPrimaryAction) applyAutomationPrimaryAction(automationPrimaryAction);
      return normalized;
    }

    slot._skSetExecutionMode = setExecutionMode;
    slot._skGetExecutionMode = function () {
      return radioFull.checked ? 'full' : 'semi';
    };
    slot._skIsRunning = function () {
      return isAutomationRunning;
    };

    function row(labelText, inputNode) {
      return el(
        'label',
        { class: 'form-row' },
        el('span', { class: 'form-label', text: labelText }),
        inputNode
      );
    }

    // 事業設定の読み取り専用表示
    function getCurrentBusinessLabels() {
      const s = window.SK_CORE.getState().settings || {};
      return {
        industry: (s.industryLabel || '').trim(),
        storeName: (s.storeName || '').trim(),
      };
    }
    const businessReadout = el('div', {
      class: 'sk-auto-business-readout',
      style: 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:5px;font-size:12px;color:#0f172a;flex-wrap:wrap',
    });
    const businessReadoutLabel = el('span', {
      style: 'font-weight:700;color:#475569',
      text: '事業設定:',
    });
    const businessReadoutValue = el('span', {
      class: 'sk-auto-business-value',
      style: 'font-weight:600;color:#0f172a;flex:1 1 auto;min-width:120px',
      text: '—',
    });
    const businessEditBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '変更',
      style: 'font-size:11px;padding:3px 10px',
    });
    businessEditBtn.addEventListener('click', function () {
      // トップ事業設定セクションを展開しスクロール
      const setupSection = document.getElementById('setup');
      const setupBody = document.getElementById('setup-body');
      const setupCollapseBtn = document.getElementById('setup-collapse');
      if (setupBody && setupBody.classList.contains('hidden')) {
        setupBody.classList.remove('hidden');
      }
      if (setupCollapseBtn) {
        setupCollapseBtn.setAttribute('aria-expanded', 'true');
      }
      // state.settings.setupCollapsed を解除
      const st = window.SK_CORE.getState();
      if (st && st.settings) {
        st.settings.setupCollapsed = false;
        try { window.SK_CORE.persistSettings(); } catch (e) {}
      }
      if (setupSection && setupSection.scrollIntoView) {
        // v0.9.14: バグC対策 — block:'nearest' で必要最小限スクロール
        setupSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      // 業種未設定なら入力欄にフォーカス
      const cur = getCurrentBusinessLabels();
      if (!cur.industry) {
        const indInput = document.getElementById('industry-input');
        if (indInput) {
          // v0.9.14: バグC対策 — preventScroll で自動スクロール抑制
          setTimeout(function () { indInput.focus({ preventScroll: true }); }, 350);
        }
      }
    });
    businessReadout.appendChild(businessReadoutLabel);
    businessReadout.appendChild(businessReadoutValue);
    businessReadout.appendChild(businessEditBtn);
    slot.appendChild(businessReadout);

    function refreshBusinessReadout() {
      const cur = getCurrentBusinessLabels();
      if (!cur.industry && !cur.storeName) {
        businessReadoutValue.textContent = '⚠ 上の「事業設定」で業種と店舗を入力してください';
        businessReadoutValue.style.color = '#b45309';
      } else if (!cur.industry) {
        businessReadoutValue.textContent = '⚠ 業種が未設定（店舗: ' + cur.storeName + '）';
        businessReadoutValue.style.color = '#b45309';
      } else {
        businessReadoutValue.textContent = cur.industry + ' / ' + (cur.storeName || '（店舗未設定）');
        businessReadoutValue.style.color = '#0f172a';
      }
    }
    refreshBusinessReadout();
    // フォーカス時に再取得（トップ事業設定で編集してから自動化タブへ戻ってきたケース）
    slot.addEventListener('focusin', refreshBusinessReadout);
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'sync') return;
        if (changes.industryLabel || changes.storeName) {
          refreshBusinessReadout();
        }
      });
    } catch (e) {}
    // タブ切替フックがないため、自動化タブが is-active になるたび再描画する MutationObserver を仕掛ける
    try {
      const tabAuto = document.getElementById('tab-automation');
      if (tabAuto && typeof MutationObserver === 'function') {
        const mo = new MutationObserver(function () {
          if (tabAuto.classList.contains('is-active')) refreshBusinessReadout();
        });
        mo.observe(tabAuto, { attributes: true, attributeFilter: ['class'] });
      }
    } catch (e) { /* noop */ }

    slot.appendChild(row('現状メモ', memoArea));
    slot.appendChild(row('追加コンテキスト（任意）', contextArea));

    const legacyDraftDetails = el('details', {
      style: 'margin-top:16px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;padding:8px 10px',
    });
    legacyDraftDetails.appendChild(
      el('summary', {
        style: 'font-size:12px;font-weight:700;color:#475569;cursor:pointer',
        text: '旧 DRAFT 取り込み・後処理（必要な場合だけ）',
      })
    );
    legacyDraftDetails.appendChild(
      el('p', {
        style: 'font-size:11px;color:#64748b;margin:6px 0 10px;line-height:1.5',
        text: '通常の実行はマスター本体へ保存します。過去のDRAFTを取り込む、または旧DRAFTを整形する場合だけ開いて使います。',
      })
    );

    // ===== 旧 DRAFT 補助セクション =====
    const resumeDraftCard = el('div', {
      style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;margin-bottom:10px',
    });
    resumeDraftCard.appendChild(
      el('div', { style: 'font-size:12px;font-weight:700;color:#0f766e;margin-bottom:6px', text: '📂 旧 DRAFT を扱う' })
    );
    resumeDraftCard.appendChild(
      el('div', {
        style: 'font-size:11px;color:#64748b;margin-bottom:6px',
        text: '既存DRAFTの進捗確認・マスター取り込み・後処理だけをここで行います。通常の実行はマスター本体へ保存します。',
      })
    );
    const draftUrlInput = el('input', {
      type: 'text',
      placeholder: 'DRAFT Doc URL（https://docs.google.com/document/d/...）任意',
      style: 'width:100%;box-sizing:border-box;padding:6px 8px;font-size:11px;border:1px solid #cbd5e1;border-radius:4px;margin-bottom:6px',
    });
    resumeDraftCard.appendChild(draftUrlInput);
    // 入力値の永続化
    if (window.SK_STATE) {
      window.SK_STATE.load('automation.draftUrl', '').then(function (v) {
        if (v) draftUrlInput.value = v;
      });
      draftUrlInput.addEventListener('input', function () {
        window.SK_STATE.debounceSave('automation.draftUrl', draftUrlInput.value, 500);
        persistAutomationDraft();
      });
    }
    const checkProgressBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '旧DRAFTの進捗を確認',
      style: 'font-size:12px',
    });
    const importDraftBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '旧 DRAFT からマスターへ取り込む',
      style: 'font-size:12px',
    });
    const draftProgressStatus = el('div', {
      style: 'font-size:11px;color:#475569;margin-top:6px',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });

    // 進捗確認ボタンのクリックハンドラ
    //   v0.9.13: §N-M サブインデックス再開対応。
    //   - draftResumeStartIndex は文字列形式（'3-3' or '4'）で保持し、startBtn 経路で正規化
    //   - v0.12: Docs API で DRAFT を確認し、旧DRAFT見出しと marker 方式の両方を読む
    let draftResumeStartIndex = '0';
    let cachedDraftProgress = null;
    let cachedFailedSections = [];
    let cachedMasterProgress = null;
    let cachedMasterFailedSections = [];
    let cachedMasterResumeContext = null;
    let automationPrimaryAction = null;
    let automationActionRefreshSeq = 0;

    async function createFreshDraftFromUi(triggerButton) {
      const originalText = triggerButton ? triggerButton.textContent : '';
      if (triggerButton) {
        triggerButton.disabled = true;
        triggerButton.textContent = '作成中…';
      }
      draftProgressStatus.textContent = '新規DRAFTを作成中…';
      draftProgressStatus.style.color = '#475569';
      try {
        const { docsClient, driveClient, draftManager } = await loadDraftManagerDeps();
        const settings = window.SK_CORE.getState()?.settings || {};
        const draftRes = await draftManager.createDraftDoc({
          docsClient,
          driveClient,
          storageArea: chrome.storage.sync,
          titleBase: settings.storeName || settings.industryLabel || (brandFooterLabel_() + ' DRAFT'),
        });
        draftUrlInput.value = draftRes.draftDocUrl;
        if (window.SK_STATE) {
          window.SK_STATE.save('automation.draftUrl', draftUrlInput.value);
        }
        persistAutomationDraft();
        clearResumeContext();
        draftResumeStartIndex = '0';
        cachedDraftProgress = null;
        cachedFailedSections = [];
        showDraftInfo(draftInfoArea, draftRes);
        draftProgressStatus.textContent = '新規DRAFTを作成しました。「実行」で§0から開始します。';
        draftProgressStatus.style.color = '#0f766e';
        refreshAutomationPrimaryAction();
        return draftRes;
      } catch (e) {
        const help = describeAutomationError(e);
        draftProgressStatus.textContent = 'DRAFT作成エラー: ' + help.short;
        draftProgressStatus.style.color = '#b91c1c';
        window.SK_CORE.showToast('DRAFT作成に失敗しました。' + help.short, true, 6000);
        return null;
      } finally {
        if (triggerButton) {
          triggerButton.disabled = false;
          triggerButton.textContent = originalText;
        }
        if (!isAutomationRunning) setAutomationRunIdle();
      }
    }

    checkProgressBtn.addEventListener('click', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      checkProgressBtn.disabled = true;
      draftProgressStatus.textContent = '確認中…';
      draftProgressStatus.style.color = '#475569';
      try {
        const { docsClient, draftManager } = await loadDraftManagerDeps();
        // URLが入力されていれば先に DRAFT を切り替える
        const urlVal = draftUrlInput.value.trim();
        if (urlVal) {
          const setRes = await draftManager.setDraftDocFromUrl(urlVal, {
            docsClient,
            storageArea: chrome.storage.sync,
          });
          draftProgressStatus.textContent = 'DRAFT切替: 「' + (setRes.draftDocTitle || '(無題)') + '」を使います。進捗を確認中…';
          draftProgressStatus.style.color = '#475569';
        }
        const res = await draftManager.getDraftProgress({
          docsClient,
          storageArea: chrome.storage.sync,
          phases: window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [],
        });
        const businessPatch = await applyDraftBusinessInfoToSettings(res.businessInfo);
        const businessSuffix = businessPatch ? ' DRAFTから事業情報も引き継ぎました。' : '';
        const phases = window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [];
        const resumeDeps = await loadAutomationResumeDeps();
        cachedDraftProgress = res;
        try {
          const draftText = await draftManager.getDraftText({
            docsClient,
            storageArea: chrome.storage.sync,
          });
          cachedFailedSections = resumeDeps.findFailedSectionsFromDraftText(draftText.text || '');
        } catch (_) {
          cachedFailedSections = [];
        }

        const next = resumeDeps.computeNextDraftResumeIndex({ progress: res, phases });
        if (next.complete) {
          draftProgressStatus.textContent = cachedFailedSections.length
            ? '旧DRAFT内に生成エラーがあります。取り込み後、マスター側の failed 章として確認できます。' + businessSuffix
            : '旧DRAFT検出: 全章完了済みです。必要ならマスターへ取り込んでください。' + businessSuffix;
          draftProgressStatus.style.color = cachedFailedSections.length ? '#b91c1c' : '#0f766e';
        } else if (res.maxFilledSection < 0 && (!res.subFilledSections || Object.keys(res.subFilledSections).length === 0) && cachedFailedSections.length === 0) {
          draftProgressStatus.textContent = '旧DRAFTに記入済みの章がありません。' + businessSuffix;
          draftProgressStatus.style.color = '#475569';
        } else {
          draftResumeStartIndex = next.rawIndex;
          const subFilled = res.subFilledSections || {};
          const filledLabels = [];
          (res.filledSections || []).forEach(function (n) {
            const subs = subFilled[String(n)];
            if (subs && subs.length > 0) {
              subs.forEach(function (s) {
                filledLabels.push('§' + n + '-' + s);
              });
            } else {
              filledLabels.push('§' + n);
            }
          });
          const filled = filledLabels.length ? filledLabels.join('・') : '未記入';
          draftProgressStatus.textContent = '旧DRAFT検出: ' + filled + ' が記入済み。必要ならマスターへ取り込んでください。' + businessSuffix;
          draftProgressStatus.style.color = '#0f766e';
        }
        refreshAutomationPrimaryAction();
      } catch (e) {
        const help = describeAutomationError(e);
        draftProgressStatus.textContent = 'DRAFT未作成またはGoogle連携エラー: ' + help.short;
        draftProgressStatus.style.color = '#b91c1c';
        cachedDraftProgress = null;
        cachedFailedSections = [];
      } finally {
        checkProgressBtn.disabled = false;
        if (!isAutomationRunning) setAutomationRunIdle();
      }
    });

    importDraftBtn.addEventListener('click', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (isAutomationRunning) return;
      const ok = window.confirm('バックアップ作成後にマスターへ取り込みます。既存 DRAFT は削除しません。続行しますか？');
      if (!ok) return;

      const originalText = importDraftBtn.textContent;
      importDraftBtn.disabled = true;
      checkProgressBtn.disabled = true;
      importDraftBtn.textContent = '取り込み中…';
      draftProgressStatus.textContent = 'DRAFTを確認し、マスターのバックアップを作成中…';
      draftProgressStatus.style.color = '#475569';

      try {
        const deps = await loadMasterMigrationDeps();
        const urlVal = draftUrlInput.value.trim();
        if (urlVal) {
          const setRes = await deps.draftManager.setDraftDocFromUrl(urlVal, {
            docsClient: deps.docsClient,
            storageArea: chrome.storage.sync,
          });
          draftProgressStatus.textContent = 'DRAFT切替: 「' + (setRes.draftDocTitle || '(無題)') + '」を取り込みます。';
        }

        const res = await deps.masterMigration.importDraftToMaster({
          docsClient: deps.docsClient,
          driveClient: deps.driveClient,
          draftManager: deps.draftManager,
          masterDocManager: deps.masterDocManager,
          masterSectionWriter: deps.masterSectionWriter,
          storageArea: chrome.storage.sync,
          phases: window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [],
        });

        showMasterInfo(draftInfoArea, {
          masterDocUrl: res.masterDocUrl,
          title: res.title,
          backup: res.backup,
        });
        const legacySuffix = res.masterFormat === 'legacy'
          ? ' 旧形式マスターのため、既存本文を残して marker 付きで追記しました。'
          : '';
        const failedSuffix = res.failedCount
          ? ' 生成エラー章 ' + res.failedCount + ' 件は failed として残しました。'
          : '';
        if (res.action === 'noop') {
          draftProgressStatus.textContent = '取り込めるDRAFT本文がありません。DRAFT本文または対象URLを確認してください。';
          draftProgressStatus.style.color = '#b45309';
        } else {
          draftProgressStatus.textContent = 'DRAFT取り込み完了: ' + res.importedCount + ' 件をマスターへ反映しました。DRAFTは削除していません。' + failedSuffix + legacySuffix;
          draftProgressStatus.style.color = res.failedCount ? '#b45309' : '#0f766e';
          window.SK_CORE.showToast('旧 DRAFT をマスターへ取り込みました。', false, 5000);
        }
        await refreshMasterActionCache();
        await refreshDraftActionCache();
        refreshAutomationPrimaryAction();
      } catch (e) {
        const help = describeAutomationError(e);
        draftProgressStatus.textContent = 'DRAFT取り込みエラー: ' + help.short;
        draftProgressStatus.style.color = '#b91c1c';
        window.SK_CORE.showToast('DRAFT取り込みに失敗しました。' + help.short, true, 6000);
      } finally {
        importDraftBtn.disabled = false;
        checkProgressBtn.disabled = false;
        importDraftBtn.textContent = originalText;
      }
    });

    resumeDraftCard.appendChild(
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, checkProgressBtn, importDraftBtn)
    );
    resumeDraftCard.appendChild(draftProgressStatus);
    legacyDraftDetails.appendChild(resumeDraftCard);

    const automationCtaStatus = el('div', {
      style: 'display:none;font-size:12px;color:#0f766e;background:#ccfbf1;border:1px solid #5eead4;border-radius:5px;padding:6px 10px;margin-top:6px',
    });
    slot.appendChild(automationCtaStatus);

    // コンテキストのヘルパ（dataset への直接アクセスを集約）
    // codex R2 提案: set/clear だけでなく get も用意して startBtn ハンドラの dataset 直読みを排除
    //
    // v0.9.13: §N-M サブインデックス対応。
    //   - startIndex は文字列 '3-3' or 整数 4 のどちらでも受け取り、'-' を含めば split
    //   - parseSubIndexStr() で { phaseNo, subNo|null } に正規化
    //   - parseInt('3-3', 10) は silently 3 になるため、必ず文字列を経由する
    function parseSubIndexStr(idxLike) {
      if (idxLike === null || idxLike === undefined) return { phaseNo: 0, subNo: null };
      const s = String(idxLike).trim();
      if (s === '') return { phaseNo: 0, subNo: null };
      if (s.indexOf('-') >= 0) {
        const m = s.match(/^(\d+)-(\d+)$/);
        if (m) return { phaseNo: parseInt(m[1], 10), subNo: parseInt(m[2], 10) };
      }
      const n = parseInt(s, 10);
      return { phaseNo: isNaN(n) ? 0 : n, subNo: null };
    }
    function formatStartLabel(idxLike) {
      const p = parseSubIndexStr(idxLike);
      return p.subNo ? ('§' + p.phaseNo + '-' + p.subNo) : ('§' + p.phaseNo);
    }
    function setResumeContext(source, startIndex, opts) {
      // source: 'draft' | 'paused'
      // startIndex: §番号（整数 or '3-3' のような文字列）
      // opts: { mode?: 'semi'|'full', accumulatedJson?: string }
      const idxStr = String(startIndex);
      const label = formatStartLabel(idxStr);
      if (source === 'draft') {
        slot.dataset.draftResumeIndex = idxStr;
        // DRAFT 経路では中断データを使わない
        delete slot.dataset.resumeIndex;
        delete slot.dataset.resumeMode;
        delete slot.dataset.resumeAccumulated;
        automationCtaStatus.textContent = '次の実行: ' + label + ' から続きを書き込みます（下書きの続き）';
      } else if (source === 'paused') {
        slot.dataset.resumeIndex = idxStr;
        if (opts && opts.mode) slot.dataset.resumeMode = opts.mode;
        if (opts && opts.accumulatedJson !== undefined) slot.dataset.resumeAccumulated = opts.accumulatedJson;
        delete slot.dataset.draftResumeIndex;
        automationCtaStatus.textContent = '次の実行: ' + label + ' から続きを書き込みます（前回の続き）';
      }
      automationCtaStatus.style.display = '';
      refreshAutomationPrimaryAction();
    }
    function clearResumeContext(silent) {
      delete slot.dataset.draftResumeIndex;
      delete slot.dataset.resumeIndex;
      delete slot.dataset.resumeMode;
      delete slot.dataset.resumeAccumulated;
      automationCtaStatus.style.display = 'none';
      automationCtaStatus.textContent = '';
      if (!silent) refreshAutomationPrimaryAction();
    }
    function getResumeContext() {
      // 単一コンテキストとして取得。draftResumeIndex を優先（バグX 対策）
      // 戻り値の startIndex は parsed.phaseNo（整数）、startSubNo は parsed.subNo（1-based or null）
      const draftIdx = slot.dataset.draftResumeIndex;
      const pausedIdx = slot.dataset.resumeIndex;
      if (draftIdx !== undefined && draftIdx !== '') {
        const p = parseSubIndexStr(draftIdx);
        return {
          source: 'draft',
          startIndex: p.phaseNo,
          startSubNo: p.subNo,
          rawIndex: String(draftIdx),
          accumulated: null,
        };
      }
      if (pausedIdx !== undefined && pausedIdx !== '') {
        let acc = null;
        if (slot.dataset.resumeAccumulated) {
          try { acc = JSON.parse(slot.dataset.resumeAccumulated); } catch (e) { acc = null; }
        }
        const p = parseSubIndexStr(pausedIdx);
        return {
          source: 'paused',
          startIndex: p.phaseNo,
          startSubNo: p.subNo,
          rawIndex: String(pausedIdx),
          mode: slot.dataset.resumeMode || null,
          accumulated: acc,
        };
      }
      return { source: 'none', startIndex: 0, startSubNo: null, rawIndex: '0', accumulated: null };
    }
    // 外部（core-ready 後の再開モーダル等）から参照できるよう slot に紐付け
    slot._skResume = { set: setResumeContext, clear: clearResumeContext, get: getResumeContext };

    const startBtn = el('button', {
      id: 'sk-auto-start',
      class: 'btn',
      type: 'button',
      text: '§0 から実行',
    });
    const secondaryActionBtn = el('button', {
      id: 'sk-auto-secondary',
      class: 'btn btn-ghost',
      type: 'button',
      text: '',
      style: 'display:none',
    });
    const cancelBtn = el('button', {
      id: 'sk-auto-cancel',
      class: 'btn btn-ghost',
      type: 'button',
      text: 'キャンセル',
      style: 'display:none',
    });
    const btnRow = el(
      'div',
      { style: 'display:flex;gap:8px;margin-top:6px' },
      startBtn,
      secondaryActionBtn,
      cancelBtn
    );
    slot.appendChild(btnRow);

    // 進行状況エリア
    const progressArea = el('div', { id: 'sk-auto-progress', class: 'hidden' });
    const progressBarOuter = el('div', {
      style: 'background:#e2e8f0;border-radius:6px;height:8px;overflow:hidden;margin:8px 0',
    });
    const progressBarInner = el('div', {
      style: 'background:#0f766e;height:100%;width:0%;transition:width .3s',
    });
    progressBarOuter.appendChild(progressBarInner);
    progressArea.appendChild(progressBarOuter);

    const progressLabel = el('div', {
      style: 'font-size:11px;color:#475569;margin-bottom:6px',
      text: '',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    progressArea.appendChild(progressLabel);

    const logArea = el('div', {
      style: 'max-height:240px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:5px;padding:6px',
    });
    progressArea.appendChild(logArea);
    slot.appendChild(progressArea);

    memoArea.addEventListener('input', function () {
      if (window.SK_STATE) window.SK_STATE.debounceSave('automation.memo', memoArea.value, 350);
      persistAutomationDraft();
    });
    contextArea.addEventListener('input', function () {
      if (window.SK_STATE) window.SK_STATE.debounceSave('automation.context', contextArea.value, 350);
      persistAutomationDraft();
    });
    radioSemi.addEventListener('change', function () {
      persistAutomationExecutionMode();
      persistAutomationDraft();
      if (automationPrimaryAction) applyAutomationPrimaryAction(automationPrimaryAction);
    });
    radioFull.addEventListener('change', function () {
      persistAutomationExecutionMode();
      persistAutomationDraft();
      if (automationPrimaryAction) applyAutomationPrimaryAction(automationPrimaryAction);
    });
    modelSelect.addEventListener('change', persistAutomationDraft);
    financeModelSelect.addEventListener('change', persistAutomationDraft);
    if (window.SK_STATE) {
      Promise.all([
        window.SK_STATE.load('automation.uiDraft', null),
        window.SK_STATE.load('automation.executionMode', null),
      ]).then(function (savedValues) {
        const savedDraft = savedValues[0] && typeof savedValues[0] === 'object'
          ? savedValues[0]
          : {};
        const savedMode = savedValues[1];
        if (!memoArea.value && savedDraft.memo) memoArea.value = savedDraft.memo;
        if (!contextArea.value && savedDraft.context) contextArea.value = savedDraft.context;
        if (savedDraft.draftUrl && !draftUrlInput.value) draftUrlInput.value = savedDraft.draftUrl;
        const remapLegacyModels = skNeedsLegacyModelRemap_(savedDraft);
        if (savedDraft.model) {
          modelSelect.value = restoreSelectableModel_(savedDraft.model, modelSelect, remapLegacyModels);
        }
        if (savedDraft.financeModel) {
          financeModelSelect.value = restoreSelectableModel_(savedDraft.financeModel, financeModelSelect, remapLegacyModels);
        }
        // 読み替えたら版数を刻んで保存する。次回以降は受講者の選択をそのまま尊重する。
        if (remapLegacyModels) persistAutomationDraft();
        const restoredMode = savedMode || savedDraft.mode;
        if (restoredMode === 'full') {
          radioFull.checked = true;
        } else {
          radioSemi.checked = true;
        }
        updateModeUI();
      });
    }

    // DRAFT情報エリア
    const draftInfoArea = el('div', { class: 'hidden', style: 'margin-top:8px' });
    slot.appendChild(draftInfoArea);

    // 半自動チェーン進行エリア
    const chainArea = el('div', { class: 'hidden', style: 'margin-top:8px' });
    slot.appendChild(chainArea);

    // 状態
    const ctrl = {
      cancelled: false,
    };
    let isAutomationRunning = false;

    function applyAutomationPrimaryAction(action) {
      automationPrimaryAction = action;
      const modeLabel = radioFull.checked ? '全自動' : '半自動';
      startBtn.textContent = action.primaryDisabled
        ? action.primaryLabel
        : modeLabel + '｜' + action.primaryLabel;
      startBtn.disabled = !!action.primaryDisabled || isAutomationRunning;
      if (action.secondaryLabel && !isAutomationRunning) {
        secondaryActionBtn.textContent = action.secondaryLabel;
        secondaryActionBtn.dataset.secondaryKind = action.secondaryKind || '';
        secondaryActionBtn.style.display = '';
      } else {
        secondaryActionBtn.textContent = '';
        secondaryActionBtn.dataset.secondaryKind = '';
        secondaryActionBtn.style.display = 'none';
      }
    }

    async function refreshDraftActionCache() {
      try {
        const { docsClient, draftManager } = await loadDraftManagerDeps();
        const phases = window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [];
        cachedDraftProgress = await draftManager.getDraftProgress({
          docsClient,
          storageArea: chrome.storage.sync,
          phases,
        });
        await applyDraftBusinessInfoToSettings(cachedDraftProgress.businessInfo);
        const draftText = await draftManager.getDraftText({
          docsClient,
          storageArea: chrome.storage.sync,
        });
        const resumeDeps = await loadAutomationResumeDeps();
        cachedFailedSections = resumeDeps.findFailedSectionsFromDraftText(draftText.text || '');
      } catch (_) {
        cachedDraftProgress = null;
        cachedFailedSections = [];
      }
    }

    async function refreshMasterActionCache() {
      try {
        const { docsClient, masterDocManager, masterState } = await loadMasterWriterDeps();
        const phases = window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [];
        const masterInfo = await masterDocManager.getStoredMasterDocInfo({
          docsClient,
          storageArea: chrome.storage.sync,
        });
        if (!masterInfo.exists) {
          cachedMasterProgress = null;
          cachedMasterFailedSections = [];
          cachedMasterResumeContext = null;
          return;
        }
        const doc = await docsClient.getDocument(masterInfo.documentId);
        const state = masterState.buildMasterAutomationState(doc, phases);
        cachedMasterProgress = state.progress;
        cachedMasterFailedSections = state.failedSections;
        cachedMasterResumeContext = state.resumeContext;
      } catch (_) {
        cachedMasterProgress = null;
        cachedMasterFailedSections = [];
        cachedMasterResumeContext = null;
      }
    }

    async function refreshCurrentActionCache() {
      await refreshMasterActionCache();
    }

    async function buildCurrentAutomationAction(options) {
      const opts = options || {};
      if (opts.refreshDraft) {
        await refreshCurrentActionCache();
      }
      const resumeDeps = await loadAutomationResumeDeps();
      const action = resumeDeps.buildAutomationPrimaryAction({
        phases: window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [],
        resumeContext: opts.forceResumeContext
          ? opts.forceResumeContext
          : opts.forceStartAtZero
          ? { source: 'none', startIndex: 0, startSubNo: null, rawIndex: '0', accumulated: null }
          : (cachedMasterResumeContext || { source: 'none', startIndex: 0, startSubNo: null, rawIndex: '0', accumulated: null }),
        failedSections: opts.ignoreFailedSections
          ? []
          : cachedMasterFailedSections,
        progress: cachedMasterProgress,
      });
      if (action.kind === 'complete') {
        return Object.assign({}, action, { secondaryLabel: '', secondaryKind: '' });
      }
      return action;
    }

    async function refreshAutomationPrimaryAction() {
      const seq = ++automationActionRefreshSeq;
      const action = await buildCurrentAutomationAction({ refreshDraft: false });
      if (seq !== automationActionRefreshSeq) return;
      applyAutomationPrimaryAction(action);
    }

    function updateFailedSectionsCache(failedSections) {
      cachedMasterFailedSections = Array.isArray(failedSections) ? failedSections.slice() : [];
      refreshAutomationPrimaryAction();
    }

    function setAutomationRunIdle() {
      cancelBtn.style.display = 'none';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'キャンセル';
      secondaryActionBtn.disabled = false;
      if (automationPrimaryAction) {
        applyAutomationPrimaryAction(automationPrimaryAction);
      } else {
        startBtn.disabled = false;
      }
      refreshCurrentActionCache().then(refreshAutomationPrimaryAction).catch(function () {
        refreshAutomationPrimaryAction();
      });
    }

    function setAutomationRunBusy() {
      isAutomationRunning = true;
      startBtn.disabled = true;
      secondaryActionBtn.style.display = 'none';
      cancelBtn.style.display = '';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'キャンセル';
      ctrl.cancelled = false;
    }

    // ============================================================
    // ヒアリング停止ゲート（設計 §4: 全自動の前にヒアリング完了を促す）
    // showDraftDecisionModal と同パターンの Promise モーダル。
    // #draft-decision-modal-root にマウント / Escape / 既存モーダルと排他。
    // ============================================================
    async function loadHearingReadinessModule() {
      const url = chrome.runtime.getURL('phase0/hearing-readiness.js');
      return await import(url);
    }

    // 壁打ちプロンプトを全画面コマンドセンターの壁打ち欄へ引き継ぐ。
    // 成功したら true（モーダルは閉じ、以降のやりとりは全画面の中で完結する）。
    // 失敗したら false を返し、呼び出し側は従来どおりコピー導線へ落とす
    // （全画面ウィンドウを作れない環境で受講者を詰まらせない）。
    async function handOffSparringToFullscreen_(basePrompt, items) {
      try {
        const url = chrome.runtime.getURL('lib/sparring-session.js');
        const mod = await import(url);
        const projectId = (window.SK_STATE && window.SK_STATE._activeProjectId) || '';
        const key = mod.sparringStorageKey(projectId);
        // 既存のレコードは読むだけで、まだ書かない。全画面を開けないまま書き換えると、
        // コピー導線へ落ちたときには会話が壊れた後、という状態になる。
        let existing = null;
        try {
          const stored = await chrome.storage.local.get([key]);
          existing = stored && stored[key] ? mod.normalizeSparringSession(stored[key]) : null;
        } catch (_) {}
        // 引き継いでもコピーはしておく。AI 連携が未設定の人・外部AIで進めたい人が、
        // 従来どおり貼り付けて始められる状態を失わない。
        // 必ず全画面を開く前に行う: 別タブを開くとサイドパネルはフォーカスを失い、
        // navigator.clipboard.writeText が必ず失敗する（copyPrompt を全画面側で
        // 実行しているのと同じ理由）。引き継ぎに失敗しても、下のコピー導線が
        // もう一度コピーするだけなので害はない。
        let copied = true;
        try {
          await navigator.clipboard.writeText(basePrompt);
        } catch (_) {
          copied = false;
        }
        // openMissionFullscreen は開いたタブを返し、開けなかったときだけ null を返す。
        const opened = await window.SK_CORE.openMissionFullscreen();
        if (!opened) return false;

        // 進行中の会話は消さない（判定は mergeHandoffSession が単一ソース）。
        const hadTurns = !!(existing && existing.turns && existing.turns.length);
        const session = mod.mergeHandoffSession(existing, { basePrompt: basePrompt, items: items });
        await chrome.storage.local.set({ [key]: session });
        window.SK_CORE.showToast(
          hadTurns
            ? '全画面の「ヒアリング壁打ち」に引き継ぎました。進行中の会話はそのまま続けられます'
            : copied
              ? '全画面の「ヒアリング壁打ち」でAIとやりとりできます（プロンプトのコピーも済んでいます）'
              : '全画面の「ヒアリング壁打ち」でAIとやりとりできます',
          false,
          6000,
        );
        return true;
      } catch (e) {
        console.warn('[SK hearing] sparring handoff failed:', e);
        return false;
      }
    }

    function showHearingGateModal(plan, handlers) {
      const el = window.SK_CORE.el;
      const clear = window.SK_CORE.clearChildren;
      let root = document.getElementById('draft-decision-modal-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'draft-decision-modal-root';
        root.className = 'draft-decision-modal-root hidden';
        document.body.appendChild(root);
      }

      return new Promise(function (resolve) {
        const previouslyFocused = document.activeElement;
        let settled = false;
        let resultPane = null;

        function getFocusable() {
          return Array.prototype.slice.call(
            root.querySelectorAll('button, [href], textarea, [tabindex]:not([tabindex="-1"])')
          ).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
        }

        function cleanup() {
          document.removeEventListener('keydown', onKeyDown, true);
          root.classList.add('hidden');
          root.removeAttribute('role');
          root.removeAttribute('aria-modal');
          root.removeAttribute('aria-labelledby');
          clear(root);
          if (previouslyFocused && previouslyFocused.focus) {
            try { previouslyFocused.focus({ preventScroll: true }); } catch (_) {}
          }
        }

        function close(outcome) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(outcome || { action: 'cancel' });
        }

        // Escape は「何もしない」= ゲートを閉じるだけ（全自動は開始しない・busy にしない）。
        function onKeyDown(event) {
          if (event['key'] === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close({ action: 'cancel' });
            return;
          }
          // フォーカストラップ
          if (event['key'] === 'Tab') {
            const focusable = getFocusable();
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }

        async function onChoice(choice) {
          // 結果表示型（モードA質問生成）は閉じずにモーダル内で結果を見せる
          if (choice.id === 'generate-questions' && handlers.onGenerateQuestions) {
            const btn = root.querySelector('[data-choice="generate-questions"]');
            if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
            try {
              const text = await handlers.onGenerateQuestions();
              showResult('ヒアリング質問', text);
            } catch (e) {
              if (btn) { btn.disabled = false; btn.textContent = choice.label; }
              showResult('生成に失敗しました', String((e && e.message) || e || ''), true);
            }
            return;
          }
          // 壁打ち（3段フロー）: ①項目策定中表示 ②項目確認 ③確定でコピー。
          // フォールバック（事前調査不可・パース失敗）は handlers.onWallbounce 側で
          // 汎用テンプレを即コピーして閉じる（ユーザーが詰まらない）。
          if (choice.id === 'wallbounce' && handlers.onWallbounce) {
            const btn = root.querySelector('[data-choice="wallbounce"]');
            if (btn) { btn.disabled = true; btn.textContent = '項目を作成中…（Webで事前調査しています）'; }
            try {
              const res = await handlers.onWallbounce();
              if (res && res.kind === 'items' && Array.isArray(res.items) && res.items.length) {
                // ② 項目リストを表示し「この項目で壁打ちプロンプトを確定」ボタンを出す。
                //    項目表示中は wallbounce ボタンを disabled のまま固定し再策定の暴発を防ぐ。
                showInterviewItems(res.items, res.heading, {
                  searchQueries: res.searchQueries,
                  urlStatuses: res.urlStatuses,
                }, async function () {
                  const outcome = await res.onConfirm();
                  // fix1: コピー成功時のみ閉じる。失敗時は閉じず、生成済みプロンプト全文を
                  //       textarea で表示して手動コピー / 再コピーできる状態を残す。
                  if (outcome && outcome.copied === false) {
                    showResult('コピーに失敗しました（下の本文を手動でコピーしてください）', outcome.prompt || '', true);
                    return;
                  }
                  close(outcome || { action: 'wallbounce' });
                });
                if (btn) { btn.textContent = '項目を作成しました'; }
              } else {
                // フォールバック（汎用テンプレを即コピー済み）。
                // fix1: 汎用コピーも失敗時は閉じず本文を残す。
                if (res && res.outcome && res.outcome.copied === false) {
                  if (btn) { btn.disabled = false; btn.textContent = choice.label; }
                  showResult('コピーに失敗しました（下の本文を手動でコピーしてください）', res.outcome.prompt || '', true);
                } else {
                  close((res && res.outcome) || { action: 'wallbounce' });
                }
              }
            } catch (e) {
              if (btn) { btn.disabled = false; btn.textContent = choice.label; }
              showResult('項目の作成に失敗しました', String((e && e.message) || e || ''), true);
            }
            return;
          }
          // 貼り付け / 要約 / 引き継ぎ / 同意 はハンドラへ委譲して閉じる
          const outcome = await handlers.onChoice(choice);
          close(outcome || { action: 'cancel' });
        }

        // 壁打ち②: 策定された項目リストと「確定」ボタンをモーダル内に表示する。
        // heading は grounded 有無で正直に出し分けた見出し文言（fix2）。
        // meta = { searchQueries, urlStatuses } で検索・URL読み込みを透明化する（v3.3）。
        function showInterviewItems(items, heading, meta, onConfirm) {
          if (!resultPane) return;
          clear(resultPane);
          resultPane.style.display = '';
          resultPane.appendChild(el('div', {
            style: 'font-size:12px;font-weight:700;margin-bottom:6px;color:#166534',
            text: heading || 'この案件のヒアリング項目',
          }));
          const listEl = el('ol', {
            style: 'margin:0 0 8px 0;padding-left:20px;font-size:12px;line-height:1.6;max-height:220px;overflow:auto',
          });
          items.forEach(function (it) {
            listEl.appendChild(el('li', { text: String(it) }));
          });
          resultPane.appendChild(listEl);

          // 検索・URL 読み込みの透明化（v3.3）: 何を調べたかをユーザーに見せる。
          const info = meta || {};
          const queries = Array.isArray(info.searchQueries) ? info.searchQueries : [];
          const urlStatuses = Array.isArray(info.urlStatuses) ? info.urlStatuses : [];
          if (queries.length) {
            resultPane.appendChild(el('div', {
              style: 'font-size:11px;color:#475569;margin:0 0 4px 0',
              text: '🔎 検索したキーワード: ' + queries.join(' / '),
            }));
          }
          if (urlStatuses.length) {
            const sites = urlStatuses.map(function (s) {
              const host = hostFromUrl(s.url);
              return host + (s.ok ? ' ✓' : ' ✗（読み込み失敗）');
            }).join(' / ');
            resultPane.appendChild(el('div', {
              style: 'font-size:11px;color:#475569;margin:0 0 6px 0',
              text: '📄 読み込んだサイト: ' + sites,
            }));
          }

          const confirmBtn = el('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: 'この項目で壁打ちプロンプトを確定',
            style: 'margin-top:4px',
            on: { click: function () { onConfirm(); } },
          });
          resultPane.appendChild(confirmBtn);
          if (confirmBtn.focus) confirmBtn.focus({ preventScroll: true });
        }

        // URL からホスト名だけを取り出して短く表示する（失敗時は元文字列）。
        function hostFromUrl(url) {
          try {
            return new URL(String(url)).host;
          } catch (_) {
            return String(url || '');
          }
        }

        function showResult(title, text, isError) {
          if (!resultPane) return;
          clear(resultPane);
          resultPane.style.display = '';
          resultPane.appendChild(el('div', {
            style: 'font-size:12px;font-weight:700;margin-bottom:6px;color:' + (isError ? '#b91c1c' : '#166534'),
            text: title,
          }));
          const ta = el('textarea', {
            value: text,
            attrs: { readonly: 'readonly' },
            style: 'width:100%;min-height:160px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:12px;line-height:1.5;resize:vertical',
          });
          resultPane.appendChild(ta);
          const copyBtn = el('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: 'コピー',
            style: 'margin-top:6px',
            on: { click: async function () {
              try {
                await navigator.clipboard.writeText(text);
                window.SK_CORE.showToast('コピーしました');
              } catch (_) {
                window.SK_CORE.showToast('コピーに失敗しました', true);
              }
            } },
          });
          resultPane.appendChild(copyBtn);
        }

        const actions = el('div', { class: 'draft-decision-actions' });
        (plan.choices || []).forEach(function (choice) {
          const btn = el('button', {
            class: 'draft-decision-choice' + (choice.recommended ? ' is-recommended' : ''),
            type: 'button',
            attrs: { 'data-choice': choice.id },
            on: { click: function () { onChoice(choice); } },
          },
            el('span', { class: 'draft-decision-choice-title', text: choice.label }),
            el('span', { class: 'draft-decision-choice-desc', text: choice.desc || '' })
          );
          actions.appendChild(btn);
        });
        // 「やめる」= 何もせず閉じる
        actions.appendChild(el('button', {
          class: 'draft-decision-choice',
          type: 'button',
          attrs: { 'data-choice': 'cancel' },
          on: { click: function () { close({ action: 'cancel' }); } },
        },
          el('span', { class: 'draft-decision-choice-title', text: 'やめる' }),
          el('span', { class: 'draft-decision-choice-desc', text: '実行をキャンセルします。何も変更しません。' })
        ));

        resultPane = el('div', { style: 'display:none;margin-top:12px' });

        const sheet = el('div', {
          class: 'draft-decision-sheet',
          attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'draft-decision-title',
          },
          on: { click: function (event) { event.stopPropagation(); } },
        },
          el('h2', { id: 'draft-decision-title', class: 'draft-decision-title', text: plan.title || 'ヒアリングを完了させましょう' }),
          el('p', { class: 'draft-decision-lede', text: plan.lede || '' }),
          actions,
          resultPane
        );

        clear(root);
        root.appendChild(sheet);
        root.classList.remove('hidden');
        document.addEventListener('keydown', onKeyDown, true);
        const first = root.querySelector('.draft-decision-choice');
        if (first && first.focus) first.focus({ preventScroll: true });
      });
    }

    // 全自動開始前に呼ぶ。ゲートが必要なら表示し、選択結果に応じて
    // { proceed: bool } を返す。proceed=false なら呼び出し側は busy 化せず return する。
    async function maybeRunHearingGate(formInputs) {
      const core = window.SK_CORE;
      let readiness;
      try {
        readiness = core.getHearingReadinessState();
      } catch (_) {
        readiness = { gateRequired: false };
      }
      if (!readiness || !readiness.gateRequired) {
        return { proceed: true };
      }

      let mod;
      try {
        mod = await loadHearingReadinessModule();
      } catch (_) {
        // 純ロジックが読めない場合は既存動線を壊さず素通り（全自動を止めない）
        return { proceed: true };
      }
      const plan = mod.getHearingGatePlan({
        mode: readiness.mode,
        status: readiness.status,
        staleStoreName: readiness.staleStoreName,
      });

      // supplementary id "mode-c-wallbounce" の製品別文言（questionAreas / summaryHeading）。
      // 無ければ buildWallbounceHearingPrompt / buildGuidedInterviewPrompt 側の現行版にフォールバック。
      function resolveWallbounceSupplementary() {
        try {
          var sups = (core.getState().prompts || {}).supplementary;
          if (Array.isArray(sups)) {
            return sups.find(function (s) { return s && s.id === 'mode-c-wallbounce'; }) || null;
          }
        } catch (_) {}
        return null;
      }

      // クリップボードへコピーを試み、成否を返す（fix1: 失敗時に本文を救済できるよう prompt も返す）。
      async function tryCopyPrompt(prompt, successNotice) {
        try {
          await navigator.clipboard.writeText(prompt);
          core.showToast(successNotice || '壁打ちプロンプトをコピーしました。AI で要約ができたら、入口モードの貼り付け欄で確定 → もう一度「実行」を押してください', false, 8000);
          return { action: 'wallbounce', copied: true, prompt: prompt };
        } catch (_) {
          core.showToast('コピーに失敗しました。下に表示した本文を手動でコピーしてください', true);
          return { action: 'wallbounce', copied: false, prompt: prompt };
        }
      }

      // 汎用テンプレ（事前調査なし）を即コピーする最終フォールバック。
      async function copyGenericWallbouncePrompt(wbSup, notice) {
        const prompt = mod.buildWallbounceHearingPrompt({
          industry: formInputs.industry,
          storeName: formInputs.storeName,
          memo: formInputs.memo,
          context: formInputs.context,
          questionAreas: wbSup && wbSup.questionAreas,
          summaryHeading: wbSup && wbSup.summaryHeading,
        });
        return await tryCopyPrompt(prompt, notice);
      }

      // 未設定かどうかは事前判定せず、実行時のエラーで判定する（判定と実行の経路を一元化。
      // 事前判定の二重実装は「実生成は通るのに判定だけ落ちる」乖離バグを生んだため廃止）。
      function isGeminiUnconfiguredError(e) {
        return /未設定/.test(String((e && e.message) || ''));
      }

      const outcome = await showHearingGateModal(plan, {
        // 壁打ち3段フロー: ①項目策定(google_search) ②項目確認 ③確定でコピー。
        // 戻り値: { kind:'items', items, onConfirm } で②へ進む / それ以外は即コピー済み（フォールバック）。
        onWallbounce: async function () {
          const wbSup = resolveWallbounceSupplementary();
          // ① 項目策定（google_search 付き → 失敗なら tools 無しで再試行）
          // プロンプトは useTools に合わせて生成する: ツール無しの再試行で検索指示を残すと
          // モデルがツール呼び出しを試みて本文なし応答（text 空）になることがあるため。
          function buildItemsPrompt(searchEnabled) {
            return mod.buildInterviewItemsPrompt({
              industry: formInputs.industry,
              storeName: formInputs.storeName,
              memo: formInputs.memo,
              context: formInputs.context,
              searchEnabled: searchEnabled,
              // TODO(将来拡張): §0 プレリサーチ本文（マスタードキュメントの §0 相当）を
              // 安価に取得できるヘルパが整い次第 preResearch に渡す。現状は重い doc 読み取りが
              // 必要なためスコープ外（implementation-report v3 §将来拡張 参照）。
            });
          }
          const geminiClient = await loadGeminiClient();
          const model = modelSelect.value || 'gemini-3.6-flash';
          const runOpts = { storage: chrome.storage.local, syncStorage: chrome.storage.sync };

          // context / メモに URL があれば url_context ツールも付けてページ内容を読ませる（v3.3）。
          // google_search は検索でURL閲覧ではないため、URL の中身は url_context が必要。
          const hasUrl = mod.extractUrls(
            String(formInputs.context || '') + '\n' + String(formInputs.memo || '')
          ).length > 0;

          // text だけでなく result（mode / groundingMetadata / url_context_metadata）も返し
          // grounding 判定（fix2）と検索クエリ・URL 取得状況の透明化（v3.3）に使う。
          async function generateItems(useTools) {
            const params = { prompt: buildItemsPrompt(useTools), model: model, temperature: 0.3 };
            if (useTools) {
              const tools = [{ google_search: {} }];
              if (hasUrl) tools.push({ url_context: {} });
              params.tools = tools;
            }
            const result = await geminiClient.generateContent(params, runOpts);
            const text = String((result && result.text) || '').trim();
            if (!text) {
              // 空応答（HTTP 200 だが本文 part が無い: thinking 消費・safety 等）は
              // 生成失敗として扱い、throw で次の段（tools 無し再試行→汎用）へ落とす。
              const cand = result && result.raw && result.raw.candidates && result.raw.candidates[0];
              console.warn('[SK hearing] empty response text: tools=' + useTools
                + ' mode=' + String(result && result.mode)
                + ' finishReason=' + String(cand && cand.finishReason)
                + ' rawHead=' + JSON.stringify(result && result.raw ? JSON.stringify(result.raw).slice(0, 300) : ''));
              throw new Error('empty response text');
            }
            const items = mod.parseInterviewItems(text);
            if (!items) {
              // 診断用: パース失敗の生テキスト先頭を残す（原因特定後に縮小可）
              console.warn('[SK hearing] interview items parse failed: tools=' + useTools
                + ' mode=' + String(result && result.mode)
                + ' textHead=' + JSON.stringify(text.slice(0, 300)));
            }
            return {
              items: items,
              grounded: mod.wasPreResearchGrounded(result),
              searchQueries: mod.extractSearchQueries(result),
              urlStatuses: mod.extractUrlContextStatuses(result),
            };
          }

          let items = null;
          let grounded = false;
          let searchQueries = [];
          let urlStatuses = [];
          let unconfigured = false;
          // 1段目: google_search（+ URL があれば url_context）付き
          try {
            const r1 = await generateItems(true);
            items = r1.items;
            grounded = r1.grounded;
            searchQueries = r1.searchQueries;
            urlStatuses = r1.urlStatuses;
          } catch (e) {
            console.warn('[SK hearing] items generation failed (tools=true):', e);
            unconfigured = isGeminiUnconfiguredError(e);
            items = null;
          }
          // 2段目: tools 無しで再試行（tools 無し＝grounding は必ず無効。未設定確定なら再試行しない）
          if (!items && !unconfigured) {
            try {
              const r2 = await generateItems(false);
              items = r2.items;
              grounded = false;
              searchQueries = [];
              urlStatuses = [];
            } catch (e) {
              console.warn('[SK hearing] items generation failed (tools=false):', e);
              unconfigured = isGeminiUnconfiguredError(e);
              items = null;
            }
          }
          // 3段目: それも失敗 or 件数不足 → 汎用テンプレを即コピー（事前調査スキップ告知）
          if (!items || !items.length) {
            return { outcome: await copyGenericWallbouncePrompt(wbSup, unconfigured
              ? '事前調査をスキップして汎用の質問でコピーしました（AI 連携が未設定です）'
              : '事前調査をスキップして汎用の質問でコピーしました（項目の自動作成に失敗。混雑時は時間をおくと成功します）') };
          }
          // ② 成功 → 項目リストを表示し、③ 確定で guided プロンプトをコピー。
          //    見出しは grounded 有無で正直に出し分ける（proxy / 非 grounding は誤認させない）。
          return {
            kind: 'items',
            items: items,
            heading: mod.interviewItemsHeading(grounded),
            searchQueries: searchQueries,
            urlStatuses: urlStatuses,
            onConfirm: async function () {
              const guided = mod.buildGuidedInterviewPrompt({
                industry: formInputs.industry,
                storeName: formInputs.storeName,
                memo: formInputs.memo,
                context: formInputs.context,
                summaryHeading: wbSup && wbSup.summaryHeading,
              }, items);
              // 全画面の壁打ち欄へ引き継ぎ、往復をその画面の中で完結させる。
              // 引き継げなかったときだけ従来のコピー導線へ落とす。
              if (await handOffSparringToFullscreen_(guided, items)) {
                return { action: 'wallbounce', copied: true, prompt: guided, handoff: true };
              }
              // fix1: コピー成否を返し、失敗時は呼び出し側がモーダルを閉じず本文を残す。
              return await tryCopyPrompt(guided);
            },
          };
        },
        onChoice: async function (choice) {
          if (choice.id === 'paste' || choice.id === 'summarize') {
            // 入口モードの貼り付け欄（B も C も対応）へ誘導。全自動は開始しない。
            core.showToast('入口モードの貼り付け欄でヒアリング要約を確定してから、もう一度「実行」を押してください', false, 6000);
            try {
              const st = core.getState();
              if (st && st.settings) st.settings.lastPhase = 'phase-0';
            } catch (_) {}
            return { action: 'paste' };
          }
          if (choice.id === 'keep-stale') {
            // 残っている要約を現在の案件のものとして整合化（後方互換 / 引き継ぎ）
            try { await core.adoptHearingSummaryForCurrentCase(); } catch (_) {}
            core.showToast('この要約をこの案件のものとして引き継ぎました', false, 4000);
            return { action: 'keep-stale', proceed: true };
          }
          if (choice.id === 'proceed' && choice.ackOnProceed) {
            // 同意を案件スコープで記録 → 続行（同一案件では再表示しない）
            try { await core.persistHearingSkipAck(); } catch (_) {}
            return { action: 'proceed', proceed: true };
          }
          return { action: 'cancel' };
        },
        onGenerateQuestions: async function () {
          // モードA: runFullAuto を使わず、質問設計プロンプトを単発 generateContent で実行
          const designBody = getModeADesignPromptBody();
          const promptText = window.SK_CORE.applyTemplate(designBody);
          const geminiClient = await loadGeminiClient();
          const result = await geminiClient.generateContent({
            prompt: promptText,
            model: modelSelect.value || 'gemini-3.6-flash',
            temperature: 0.4,
          }, {
            storage: chrome.storage.local,
            syncStorage: chrome.storage.sync,
          });
          return String((result && result.text) || '').trim();
        },
      });

      // keep-stale / proceed は続行、それ以外（壁打ち/貼り付け/cancel）は中断
      if (outcome && outcome.proceed) {
        return { proceed: true };
      }
      return { proceed: false };
    }

    // v3.6: 全自動 fresh run の §0 シード判定＋実行。戻り値は「生成ループの開始 index」上書き値（null=従来どおり）。
    //   ready（整合確定要約あり）のときだけ:
    //     - §0 未充足 → 確定要約を §0 章として直書きシード（成功なら §1 から / 失敗なら §0 から生成へフォールバック）
    //     - §0 既に done → 書き込みスキップ・§1 から
    //   ready でない（このまま進む 等）→ null（従来どおり §0 から生成）。
    async function maybeSeedPhase0ForFreshRun_() {
      let readiness;
      try {
        readiness = window.SK_CORE.getHearingReadinessState();
      } catch (_) {
        return null;
      }
      let plan;
      try {
        const mod = await loadHearingReadinessModule();
        // §0 が既に done かどうかは master 進捗の filledSections（0 を含むか）で判定。
        const phase0Filled = !!(cachedMasterProgress
          && Array.isArray(cachedMasterProgress.filledSections)
          && cachedMasterProgress.filledSections.indexOf(0) !== -1);
        plan = mod.planFullAutoFreshRunStart({ status: readiness && readiness.status, phase0Filled, mode: readiness && readiness.mode });
      } catch (_) {
        return null;
      }
      if (!plan || plan.startIndex !== 1) {
        // ready でない（plan.startIndex===0）→ 従来どおり §0 から生成。
        return null;
      }
      if (plan.seedPhase0) {
        const ok = await seedPhase0FromHearingSummary_();
        if (!ok) {
          // 書き込み失敗は安全側: 従来どおり §0 から生成にフォールバック（全自動を止めない）。
          return null;
        }
      }
      // §0 はシード済み or 既に done。生成ループは §1 から。
      return 1;
    }

    // v3.6: 確定済みヒアリング要約を §0 章としてマスターへ直書きする（AI 生成なし）。
    //   appendMasterSectionDirect_ 流用（SK-SECTION マーカー・status done・章配置は既存規約準拠）。
    //   見出しタイトルは §0 既存章タイトル規約（phases[0].title）に合わせる。
    //   成功で true、失敗で false（呼び出し側が §0 からの従来生成にフォールバック）。
    async function seedPhase0FromHearingSummary_() {
      try {
        const settings = (window.SK_CORE.getState && window.SK_CORE.getState().settings) || {};
        const summary = String(settings['sk_hearing_summary_v012'] || '').trim();
        if (!summary) {
          console.warn('[SK hearing] §0 seed skipped: confirmed summary is empty');
          return false;
        }
        // §0 章タイトルは既存規約（phases[0].title）に準拠。取れなければ汎用フォールバック。
        let title = '事前調査・ヒアリング要約';
        try {
          const phases = window.SK_CORE.getPhases();
          const p0 = (phases || []).find(function (p) { return String(p.no) === '0'; });
          if (p0 && p0.title) title = String(p0.title);
        } catch (_) {}
        await appendMasterSectionDirect_({
          sectionNo: '0',
          title: title,
          body: summary,
          status: 'done',
          aiUsed: 'hearing-summary',
        });
        return true;
      } catch (e) {
        console.warn('[SK hearing] §0 seed write failed; falling back to generating §0:', e);
        return false;
      }
    }

    // モードA 質問設計プロンプトの body（sidepanel.js buildModeAHearingDesignPhase と同一・設計 §4-3）。
    // 全自動ループを使わず単発実行するため、ここで合成プロンプトを取得する。
    function getModeADesignPromptBody() {
      try {
        const phases = window.SK_CORE.getPhases();
        const p0 = (phases || []).find(function (p) { return String(p.no) === '0'; });
        if (p0 && p0.prompts && p0.prompts[0] && p0.prompts[0].body) {
          return p0.prompts[0].body;
        }
      } catch (_) {}
      // フォールバック（getPhases がモードA合成フェーズを返さない場合）
      return '{{businessContext}}\n\n業種「★業種★」／店舗「★店舗名★」について、クライアントワーク開始前のヒアリング設計を作成してください。6カテゴリ x 5問 = 30問に整理し、各質問に「質問の意図」を1行で付けてください。';
    }

    async function executeAutomation(actionOptions = {}) {
      // 再入ガード（TOCTOU 対策）: 最初の await より前に同期でフラグを立て、二重起動で同一
      // マスター Doc への並行 batchUpdate が起きないようにする。連打・並行呼び出しでも 2 本目は
      // ここで即 return する。以降の early-return・例外・完走のいずれでも下の finally で必ず解除する。
      // ボタンの視覚的無効化はフラグ set 直後の applyAutomationPrimaryAction / setAutomationRunBusy に
      // 委ね、startBtn.disabled=true は setAutomationRunBusy 一箇所に保つ（fix-2 の単一ロック不変条件）。
      if (isAutomationRunning) return;
      isAutomationRunning = true;
      let busyStarted = false;
      try {
        const primaryAction = await buildCurrentAutomationAction({
          refreshDraft: true,
          forceStartAtZero: !!actionOptions.forceStartAtZero,
          ignoreFailedSections: !!actionOptions.ignoreFailedSections,
          forceResumeContext: actionOptions.forceResumeContext,
        });
        applyAutomationPrimaryAction(primaryAction);
        if (primaryAction.primaryDisabled) return;

        // v0.9.14: 業種・店舗はトップ「事業設定」を単一ソースとして参照
        const settings = window.SK_CORE.getState().settings || {};
        const industryVal = (settings.industryLabel || '').trim();
        const storeVal = (settings.storeName || '').trim();

        const formInputs = {
          industry: industryVal,
          storeName: storeVal,
          memo: memoArea.value.trim(),
          context: contextArea.value.trim(),
        };
        if (!formInputs.industry) {
          window.alert('⚠ 上の「事業設定」セクションで業種を選んでください。\n\nページ上部の「事業設定」カードで業種（プリセット選択 or 自由入力）と店舗・屋号を入力してから、もう一度「実行」を押してください。');
          // トップ事業設定セクションへ誘導
          if (typeof businessEditBtn !== 'undefined' && businessEditBtn.click) {
            businessEditBtn.click();
          }
          refreshBusinessReadout();
          return;
        }
        // 読み取り専用表示を最新化
        refreshBusinessReadout();

        // ヒアリング停止ゲート（設計 §4-1: setAutomationRunBusy・ログ初期化より前に判定）。
        // 全自動分岐のみ。整合要約あり / 同案件 ack 済みならゲートは出ない（既存動線不変）。
        // 中断・再開（resume / retry）時は再度のヒアリング確認を挟まず素通りさせる。
        const isFreshFullAutoRun =
          radioFull.checked &&
          !actionOptions.forceResumeContext &&
          primaryAction.kind !== 'retry';
        // v3.6: ready（整合確定要約あり）の fresh run は §0 を直書きシードして §1 から開始する
        //   ための上書き開始 index（ヒアリング/項目策定で §0 相当は済んでいる二度手間の解消）。
        let freshRunStartOverride = null;
        if (isFreshFullAutoRun) {
          const gateOutcome = await maybeRunHearingGate(formInputs);
          if (gateOutcome && gateOutcome.proceed === false) {
            // 壁打ち/貼り付け選択 or キャンセル: 全自動は開始しない（busy 化しない）
            return;
          }
          freshRunStartOverride = await maybeSeedPhase0ForFreshRun_();
        }

        setAutomationRunBusy();
        busyStarted = true;

        progressArea.classList.remove('hidden');
        window.SK_CORE.clearChildren(logArea);
        progressBarInner.style.width = '0%';
        persistAutomationDraft();

        const isFullAuto = radioFull.checked;
        await captureTaskMonitorTarget_();
        publishTaskMonitor_({
          status: 'running',
          taskLabel: isFullAuto ? '全自動を開始しています' : '半自動を開始しています',
          lastEvent: isFullAuto
            ? 'Geminiで順番に生成します'
            : 'サイドパネルでAIの回答を確認しながら進めます',
        });
        if (isFullAuto) {
          // 実行本体はこのサイドパネルで継続し、操作UIを専用の最大化
          // ウィンドウへ切り替える。ここを await するとウィンドウ生成の失敗で
          // 全自動まで止めてしまうため、UI handoff は best-effort にする。
          Promise.resolve(window.SK_CORE?.openMissionFullscreen?.()).catch(function (error) {
            console.warn('[STRATEGY-KIT] command center handoff failed:', error);
          });
        }

        const startIndex = (freshRunStartOverride != null)
          ? freshRunStartOverride
          : (primaryAction.startIndex || 0);
        const startSubNo = primaryAction.startSubNo || null;
        const resumedAccumulated = primaryAction.accumulated || null;
        const retrySections = primaryAction.retrySections || [];
        clearResumeContext(true);

        try {
          if (isFullAuto) {
            await runFullAuto(formInputs, ctrl, modelSelect.value, {
              progressBarInner,
              progressLabel,
              logArea,
              draftInfoArea,
              chainArea,
              onFailedSectionsChange: updateFailedSectionsCache,
            }, {
              startIndex: startIndex,
              startSubNo: startSubNo,
              accumulated: resumedAccumulated,
              retrySections: retrySections,
              retryOnly: primaryAction.kind === 'retry',
              financeModel: financeModelSelect.value,
            });
          } else {
            await runSemiAuto(formInputs, ctrl, {
              progressBarInner,
              progressLabel,
              logArea,
              draftInfoArea,
              chainArea,
              onFailedSectionsChange: updateFailedSectionsCache,
            }, { startIndex: startIndex, startSubNo: startSubNo, accumulated: resumedAccumulated, retrySections: retrySections });
          }
        } catch (e) {
          const mode = isFullAuto ? '全自動' : '半自動チェーン';
          console.error('[STRATEGY-KIT] ' + mode + 'エラー:', e);
          stopSavingOverlay();
          setCurrentLocationText(mode + 'でエラーが発生しました', 'Google連携とマスターの状態を確認してください');
          const help = describeAutomationError(e);
          progressLabel.textContent = '⚠ ' + mode + 'で停止しました: ' + help.short;
          publishTaskMonitor_({
            status: 'blocked',
            taskLabel: mode + 'が停止しました',
            lastEvent: mode + 'の実行エラー',
          });
          appendAutomationErrorLog(logArea, mode + 'の実行エラー', e);
          window.SK_CORE.showToast(mode + 'を実行中にエラーが発生しました。' + help.short, true, 6000);
        } finally {
          stopSavingOverlay();
        }
      } finally {
        // TOCTOU 解除側: fresh/resume/retry・早期リターン・例外のどの経路でも実行中フラグを
        // 必ず戻す。busy 化まで到達した実行のみ setAutomationRunIdle で完全復帰（再取得あり）、
        // busy 前の早期リターンはボタン状態のみ戻す（余計なマスター再取得を発生させない）。
        isAutomationRunning = false;
        if (busyStarted) {
          setAutomationRunIdle();
        } else if (automationPrimaryAction) {
          applyAutomationPrimaryAction(automationPrimaryAction);
        } else {
          startBtn.disabled = false;
        }
      }
    }

    // 全画面ダッシュボードから任意の §N を指定して再実行する公開フック。
    // 既存 executeAutomation の forceResumeContext を再利用し、§N より前は保持、
    // §N 以降だけを同じマスター本体へ上書きする。
    slot._skRunFromPhase = function (phaseNo, options) {
      const parsed = parseSubIndexStr(phaseNo);
      const phases = window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [];
      const exists = phases.some(function (phase) {
        return Number.parseInt(String(phase.no), 10) === parsed.phaseNo;
      });
      if (!exists) return Promise.reject(new Error('指定したフェーズが見つかりません'));

      const mode = options && options.mode === 'semi' ? 'semi' : 'full';
      setExecutionMode(mode, { persistMode: true, persistDraft: true });
      clearResumeContext(true);
      return executeAutomation({
        ignoreFailedSections: true,
        forceResumeContext: {
          source: 'manual-restart',
          rawIndex: String(parsed.phaseNo),
          startIndex: parsed.phaseNo,
          startSubNo: null,
          accumulated: null,
        },
      });
    };

    // 実行ハンドラ
    startBtn.addEventListener('click', async function (event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      executeAutomation();
    });

    secondaryActionBtn.addEventListener('click', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      const kind = secondaryActionBtn.dataset.secondaryKind || '';
      if (kind === 'restart') {
        const ok = window.confirm('現在の中断点・失敗章の判定を使わず、§0 からマスター本体へ実行します。');
        if (!ok) return;
        clearResumeContext(true);
        executeAutomation({ forceStartAtZero: true, ignoreFailedSections: true });
        return;
      }
      if (kind === 'resume-ignore-failed' || kind === 'resume-forward') {
        executeAutomation({
          ignoreFailedSections: true,
          forceResumeContext: automationPrimaryAction.secondaryResumeContext,
        });
        return;
      }
      if (kind === 'new-draft-start') {
        const ok = window.confirm('新しい DRAFT を作成して、§0 から実行します。既存 DRAFT は残します。');
        if (!ok) return;
        const draft = await createFreshDraftFromUi(secondaryActionBtn);
        if (draft) executeAutomation({ forceStartAtZero: true, ignoreFailedSections: true });
      }
    });

    cancelBtn.addEventListener('click', function () {
      ctrl.cancelled = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'キャンセル中…';
    });

    // ===========================================================
    // 旧 DRAFT 後処理セクション（整形＋Executive Summary）
    // ===========================================================
    const postCard = el('div', {
      style: 'margin-top:16px;padding:10px 12px;background:#f0fdfa;border:1px solid #14b8a6;border-radius:6px',
    });
    postCard.appendChild(
      el('div', {
        style: 'font-size:12px;font-weight:700;color:#0f766e;margin-bottom:4px',
        text: '✨ 旧 DRAFT 後処理（任意）',
      })
    );
    postCard.appendChild(
      el('p', {
        style: 'font-size:11px;color:#475569;margin:0 0 8px;line-height:1.5',
        text: '旧DRAFTを Gemini で整形して読みやすくしたり、A4 1枚相当の Executive Summary を別ファイルとして生成できます。',
      })
    );

    const postStatus = el('div', {
      style: 'font-size:11px;margin-top:6px;color:#0f172a',
    });

    function renderPostActionResult(res, labels) {
      postStatus.textContent = '';
      const buttons = [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: labels.docButton,
          style: 'font-size:11px',
          on: { click: function () { chrome.tabs.create({ url: res.docUrl }); } },
        }),
      ];
      if (res.previewUrl) {
        buttons.push(
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: labels.previewButton,
            style: 'font-size:11px',
            on: { click: function () { chrome.tabs.create({ url: res.previewUrl }); } },
          })
        );
      }
      const buttonRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      buttons.forEach(function (button) {
        buttonRow.appendChild(button);
      });
      postStatus.appendChild(
        el(
          'div',
          {
            style: 'background:#ccfbf1;border:1px solid #14b8a6;border-radius:5px;padding:6px 8px',
          },
          el('div', {
            style: 'font-size:11px;font-weight:600;margin-bottom:4px',
            text: labels.doneText + '（' + (res.charCount || 0) + '字）',
          }),
          el('div', { style: 'font-size:10px;margin-bottom:4px', text: res.title || '' }),
          buttonRow
        )
      );
    }

    const cleanupBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '🧹 旧DRAFTを整形（Docs + HTML）',
      on: {
        click: async function () {
          cleanupBtn.disabled = true;
          const orig = cleanupBtn.textContent;
          cleanupBtn.textContent = '整形中…（章数×30秒程度）';
          postStatus.textContent = '';
          try {
            const res = await runDraftPostAction_('cleanup');
            renderPostActionResult(res, {
              doneText: '✅ 整形完了',
              docButton: '[CLEAN]版を開く',
              previewButton: 'HTMLプレビューを開く',
            });
          } catch (e) {
            console.error('[STRATEGY-KIT] DRAFT整形エラー:', e);
            postStatus.textContent = 'DRAFT整形に失敗しました。Google連携とGemini API keyを確認してください。';
            postStatus.style.color = '#b91c1c';
          } finally {
            cleanupBtn.disabled = false;
            cleanupBtn.textContent = orig;
          }
        },
      },
    });

    const summaryBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '📄 Executive Summary生成',
      on: {
        click: async function () {
          summaryBtn.disabled = true;
          const orig = summaryBtn.textContent;
          summaryBtn.textContent = '生成中…';
          postStatus.textContent = '';
          try {
            const res = await runDraftPostAction_('summary');
            renderPostActionResult(res, {
              doneText: '✅ Executive Summary 生成完了',
              docButton: 'Summaryを開く',
              previewButton: 'Summary HTMLを開く',
            });
          } catch (e) {
            console.error('[STRATEGY-KIT] Executive Summary生成エラー:', e);
            postStatus.textContent = 'Executive Summaryの生成に失敗しました。Google連携とGemini API keyを確認してください。';
            postStatus.style.color = '#b91c1c';
          } finally {
            summaryBtn.disabled = false;
            summaryBtn.textContent = orig;
          }
        },
      },
    });

    postCard.appendChild(
      el(
        'div',
        { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        cleanupBtn,
        summaryBtn
      )
    );
    postCard.appendChild(postStatus);
    legacyDraftDetails.appendChild(postCard);
    slot.appendChild(legacyDraftDetails);
    refreshCurrentActionCache().then(refreshAutomationPrimaryAction).catch(function () {
      refreshAutomationPrimaryAction();
    });
  }

  // ===========================================================
  // §0 から実行する際の DRAFT 確保ヘルパ
  // 既存 DRAFT があれば再利用してドライブが DRAFT で埋まるのを防ぐ。
  // 中身が無ければ無確認で再利用、章が記入済みなら inline modal で意思確認。
  // 戻り値: 'reused' | 'created' | 'cancelled'
  // ===========================================================
  async function ensureDraftDoc_(ui) {
    try {
      const { docsClient, driveClient, draftManager } = await loadDraftManagerDeps();
      const settings = window.SK_CORE.getState()?.settings || {};
      const result = await draftManager.ensureDraftDoc({
        docsClient,
        driveClient,
        storageArea: chrome.storage.sync,
        phases: window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [],
        titleBase: settings.storeName || settings.industryLabel || (brandFooterLabel_() + ' DRAFT'),
        confirmUseExisting: async function (existing) {
          const title = existing.title || '(無題)';
          const choice = await showDraftDecisionModal({
            existingTitle: title,
            onChoice: function (nextChoice) {
              if (nextChoice === 'create') {
                ui.progressLabel.textContent = '新規 DRAFT を作成中…';
              } else if (nextChoice === 'reuse') {
                ui.progressLabel.textContent = '既存 DRAFT に追記します。§0 から実行開始';
              } else if (nextChoice === 'cancel') {
                ui.progressLabel.textContent = '実行をやめました。DRAFT は変更していません。';
              }
            },
          });
          if (choice === 'cancel') {
            throw new Error(DRAFT_DECISION_CANCELLED);
          }
          if (choice === 'create') {
            ui.progressLabel.textContent = '新規 DRAFT を作成中…';
            return false;
          }
          return true;
        },
      });
      showDraftInfo(ui.draftInfoArea, result);
      ui.progressLabel.textContent = result.action === 'reused'
        ? '既存 DRAFT に追記します。§0 から実行開始'
        : '新規 DRAFT を作成しました。§0 から実行開始';
      return result.action || 'created';
    } catch (e) {
      if (e && e.message === DRAFT_DECISION_CANCELLED) {
        ui.progressLabel.textContent = '実行をやめました。DRAFT は変更していません。';
        return 'cancelled';
      }
      ui.progressLabel.textContent = 'DRAFT 作成失敗: ' + e.message;
      return 'cancelled';
    }
  }

  async function showCurrentDraftInfo_(container) {
    try {
      const { docsClient, draftManager } = await loadDraftManagerDeps();
      const draftInfo = await draftManager.getStoredDraftInfo({
        docsClient,
        storageArea: chrome.storage.sync,
      });
      if (container && draftInfo.exists) {
        showDraftInfo(container, {
          draftDocUrl: draftInfo.draftDocUrl,
          title: draftInfo.title,
        });
      }
      return draftInfo;
    } catch (e) {
      return null;
    }
  }

  async function appendDraftSectionDirect_(input) {
    const { docsClient, draftManager } = await loadDraftManagerDeps();
    return await draftManager.appendDraftSection({
      docsClient,
      storageArea: chrome.storage.sync,
      ...input,
    });
  }

  // 修正B: 全自動の「頭から実行する初回」以外（再試行・途中再開・失敗章スキップ等の継続実行）
  //   ではバックアップ Doc を量産しないよう、バックアップ作成をスキップすべきか判定する純関数。
  function shouldSkipFullAutoBackup_(opts) {
    const o = opts || {};
    const retrySections = Array.isArray(o.retrySections) ? o.retrySections : [];
    const isContinuation =
      retrySections.length > 0 ||
      !!o.retryOnly ||
      (Number(o.startIndex) > 0) ||
      (Number(o.startSubNo) > 0);
    return isContinuation;
  }

  async function ensureFullAutoMasterTarget_(ui, skipBackup) {
    try {
      const { docsClient, driveClient, masterDocManager } = await loadMasterWriterDeps();
      const settings = window.SK_CORE.getState()?.settings || {};
      let info = await masterDocManager.getStoredMasterDocInfo({
        docsClient,
        storageArea: chrome.storage.sync,
      });
      let backup = null;
      let created = false;

      if (!info.exists) {
        ui.progressLabel.textContent = 'マスターを作成中…';
        const createdInfo = await masterDocManager.createMasterDocument({
          docsClient,
          storageArea: chrome.storage.sync,
          phases: window.SK_CORE.getPhases ? window.SK_CORE.getPhases() : [],
          industryLabel: settings.industryLabel || '',
          storeName: settings.storeName || '',
          title: settings.storeName || settings.industryLabel || (brandFooterLabel_() + ' Master'),
        });
        info = {
          exists: true,
          documentId: createdInfo.masterDocId,
          docUrl: createdInfo.masterDocUrl,
          title: createdInfo.title,
          masterInfo: createdInfo.masterInfo,
        };
        created = true;
      } else if (!skipBackup) {
        // 既存マスター + 頭からの初回実行のときだけバックアップを取る（破壊防止の安全網）
        ui.progressLabel.textContent = 'マスターのバックアップを作成中…';
        backup = await createMasterBackupCopy_({
          driveClient,
          masterInfo: info.masterInfo || info,
        });
      }

      showMasterInfo(ui.draftInfoArea, {
        masterDocUrl: info.docUrl,
        title: info.title,
        backup,
      });
      ui.progressLabel.textContent = backup
        ? 'バックアップ作成済み。マスター本体へ書き込みます。'
        : created
        ? '新規マスターを作成しました。マスター本体へ書き込みます。'
        : '既存マスターへ続きを書き込みます。';
      return 'ready';
    } catch (e) {
      ui.progressLabel.textContent = 'マスター準備失敗: ' + (e.message || String(e));
      window.SK_CORE.showToast('マスター準備に失敗しました。バックアップ作成またはGoogle連携を確認してください。', true, 6000);
      return 'cancelled';
    }
  }

  async function createMasterBackupCopy_({ driveClient, masterInfo }) {
    if (!driveClient || typeof driveClient.copyFile !== 'function') {
      throw new Error('driveClient.copyFile is required');
    }
    const documentId = masterInfo?.documentId;
    if (!documentId) throw new Error('マスター Doc が未設定です');
    const baseTitle = masterInfo.title || (brandFooterLabel_() + ' Master');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const copied = await driveClient.copyFile(documentId, {
      name: '[BACKUP before full auto] ' + baseTitle + ' ' + timestamp,
    });
    const backup = {
      documentId: copied.id,
      docUrl: copied.webViewLink || ('https://docs.google.com/document/d/' + encodeURIComponent(copied.id) + '/edit'),
      title: copied.name || '',
      sourceMasterDocumentId: documentId,
      createdAt: new Date().toISOString(),
    };
    await chrome.storage.sync.set({ sk_master_backup_v012: backup });
    return backup;
  }

  async function showCurrentMasterInfo_(container) {
    try {
      const { docsClient, masterDocManager } = await loadMasterWriterDeps();
      const info = await masterDocManager.getStoredMasterDocInfo({
        docsClient,
        storageArea: chrome.storage.sync,
      });
      if (container && info.exists) {
        showMasterInfo(container, {
          masterDocUrl: info.docUrl,
          title: info.title,
        });
      }
      return info;
    } catch (e) {
      return null;
    }
  }

  async function appendMasterSectionDirect_(input) {
    const { docsClient, masterSectionWriter } = await loadMasterWriterDeps();
    return await masterSectionWriter.writeMasterSection({
      docsClient,
      storageArea: chrome.storage.sync,
      ...input,
    });
  }

  async function saveDraftHtmlPreview_({ title, text, kind, sourceDocUrl }) {
    const preview = await loadDraftPreviewDeps();
    const previewId = preview.buildDraftPreviewId();
    const record = preview.buildDraftPreviewRecord({
      title,
      text,
      kind,
      sourceDocUrl,
    });
    await chrome.storage.local.set({
      [preview.PREVIEW_STORAGE_KEY_PREFIX + previewId]: record,
    });
    return {
      previewId,
      previewUrl: chrome.runtime.getURL('preview/draft-clean.html?id=' + encodeURIComponent(previewId)),
    };
  }

  async function runDraftPostAction_(type) {
    const { docsClient, draftManager } = await loadDraftManagerDeps();
    const geminiClient = await loadGeminiClient();
    const draft = await draftManager.getDraftText({
      docsClient,
      storageArea: chrome.storage.sync,
    });
    const isSummary = type === 'summary';
    const draftLabel = brandFooterLabel_() + ' DRAFT';
    const prompt = isSummary
      ? [
          '以下の' + draftLabel + 'を読み、A4 1枚相当のExecutive Summaryを作成してください。',
          '条件:',
          '- Markdown形式で出力する',
          '- HTMLは出さない',
          '- # の大見出しを1つ、## の中見出しを3〜5個使う',
          '- 事業の現状、勝ち筋、重点施策、KPIを短く整理',
          '- 箇条書きは各見出し3〜5項目まで',
          '- 推測で補わず、DRAFT内の内容を根拠にする',
          '',
          draft.text,
        ].join('\n')
      : [
          '以下の' + draftLabel + 'を整形してください。',
          '条件:',
          '- Markdown形式で出力する',
          '- HTMLは出さない',
          '- # の大見出しを1つ、## の中見出しを各章に使う',
          '- 冒頭に「全体要約」を3〜5行で置く',
          '- 内容の意味は変えない',
          '- 重複や読みにくい箇所を整理',
          '- 見出し、箇条書き、短い段落で読みやすくする',
          '- 3C / クロス3C / 5Forces / SWOT / クロスSWOT / ユニットエコノミクスは、元のフレーム名を見出しに残し、表形式を維持する',
          '- ユニットエコノミクスの CAC / LTV / Payback などの数値レンジは削らない。空欄や「PDCAで更新」に置き換えない',
          '- 根拠がない断定は追加しない',
          '',
          draft.text,
        ].join('\n');
    const generated = await geminiClient.generateContent({
      prompt,
      model: 'gemini-3.6-flash',
      temperature: isSummary ? 0.2 : 0.25,
    });
    const titlePrefix = isSummary ? '[SUMMARY]' : '[CLEAN]';
    const generatedText = generated.text || '（応答なし）';
    const title = `${titlePrefix} ${draft.title || draftLabel}`;
    const derived = await draftManager.createDerivedDraftDocument({
      docsClient,
      title,
      text: generatedText,
    });
    const preview = await saveDraftHtmlPreview_({
      title,
      text: generatedText,
      kind: isSummary ? 'summary' : 'cleanup',
      sourceDocUrl: derived.docUrl,
    });
    return { ...derived, ...preview };
  }

  // ===========================================================
  // 全自動モード: §0〜§9 を Gemini API で順番に生成しマスター本体に保存
  // ===========================================================
  function shouldSplitPhaseForFinanceGate(phase) {
    return !!(phase.prompts || []).some(function (prompt) {
      return prompt && prompt.id === 'phase-7-unit-economics';
    });
  }

  function buildFullAutoUnits(phase, accumulated, formInputs) {
    const phaseLabel = '§' + phase.no + ' ' + phase.title;
    if (phase.prompts && phase.prompts.length > 0) {
      if (shouldSplitPhaseForFinanceGate(phase)) {
        return phase.prompts.map(function (prompt, index) {
          // sectionNo は配列 index 由来の内部キー（resume/retry/accKey/master 見出しの契約・不変）。
          // displayNo/displayLabel は UI・進捗・失敗・サマリ表示専用（prompt の実番号・名）。
          return {
            phase: phase,
            prompt: prompt,
            promptText: buildSubPrompt(prompt, accumulated, formInputs),
            sectionNo: phase.no + '-' + (index + 1),
            displayNo: prompt.no || (phase.no + '-' + (index + 1)),
            displayLabel: prompt.label,
            title: prompt.label,
            logTitle: '§' + phase.no + '-' + (index + 1) + ' ' + prompt.label,
            accKey: '§' + phase.no + '-' + (index + 1) + '（' + prompt.label + '）',
            split: true,
          };
        });
      }
      return [{
        phase: phase,
        prompt: { id: 'phase-' + phase.no + '-combined' },
        promptText: phase.prompts.map(function (p) {
          return buildSubPrompt(p, accumulated, formInputs);
        }).join('\n\n---\n\n'),
        sectionNo: String(phase.no),
        displayNo: String(phase.no),
        displayLabel: phase.title,
        title: phase.title,
        logTitle: phaseLabel,
        accKey: '§' + phase.no,
        split: false,
      }];
    }

    return [{
      phase: phase,
      prompt: { id: 'phase-' + phase.no + '-placeholder' },
      promptText: buildSubPrompt({ body: '以下のフェーズについてマーケ戦略の観点から分析・提案してください:\n' + phaseLabel }, accumulated, formInputs),
      sectionNo: String(phase.no),
      displayNo: String(phase.no),
      displayLabel: phase.title,
      title: phase.title,
      logTitle: phaseLabel,
      accKey: '§' + phase.no,
      split: false,
    }];
  }

  async function generateWithFinanceGate({
    geminiClient,
    financeGate,
    prompt,
    promptText,
    selectedModel,
    financeModel,
    sectionLabel,
  }) {
    const isFinance = financeGate.isFinanceGatePrompt(prompt);
    const effectiveModel = isFinance
      ? (financeModel || financeGate.FINANCE_GATE_RECOMMENDED_MODEL)
      : selectedModel;
    const temperature = isFinance ? 0.2 : 0.4;
    // 空応答（2xx だが本文 part が無い: safety block / MAX_TOKENS / finishReason=SAFETY 等）は
    // 「（応答なし）」を status:done で保存せず throw し、呼び出し側の failed マーカー + retry UI へ
    // 落とす。モードA 質問設計の空応答 throw（'empty response text'）と挙動を揃える。
    function requireGeneratedBody_(res) {
      const text = (res && res.text) ? String(res.text) : '';
      if (!text.trim()) {
        throw new Error('AI が空の応答を返しました（応答なし）。時間をおいて再試行してください');
      }
      return text;
    }
    let res = await geminiClient.generateContent({
      prompt: promptText,
      model: effectiveModel,
      temperature: temperature,
    });
    let bodyText = requireGeneratedBody_(res);

    if (!isFinance) {
      return { bodyText: bodyText, model: effectiveModel, financeGate: null, financeGateWarning: false };
    }

    // 記入漏れ（presence・repair/要確認注記用）＋算術整合（arithmetic・合否の主軸）を束ねて検査する。
    // 不合格なら最大 MAX_FINANCE_REPAIRS 回まで repair を回し、ok になった時点で即 return する
    // （初回含め最大 3 回 Gemini 呼び出し）。空応答は各回とも requireGeneratedBody_ で throw する。
    const MAX_FINANCE_REPAIRS = 2;
    let validation = financeGate.validateUnitEconomics(bodyText);
    let financeRepairs = 0;
    while (!validation.ok && financeRepairs < MAX_FINANCE_REPAIRS) {
      const repairPrompt = financeGate.buildUnitEconomicsRepairPrompt({
        originalPrompt: promptText,
        outputText: bodyText,
        validation: validation,
        sectionLabel: sectionLabel || 'ユニットエコノミクス',
      });
      res = await geminiClient.generateContent({
        prompt: repairPrompt,
        model: effectiveModel,
        temperature: 0.1,
      });
      bodyText = requireGeneratedBody_(res);
      validation = financeGate.validateUnitEconomics(bodyText);
      financeRepairs += 1;
    }

    if (validation.ok) {
      return { bodyText: bodyText, model: effectiveModel, financeGate: validation, financeGateWarning: false };
    }

    // MAX_FINANCE_REPAIRS 回 repair してもなお不合格 → 最良出力に ⚠要確認 注記（記入漏れ＋数値矛盾）を
    // 付けて完走する（停止しない・安全網）。曖昧な数字を黙って流さず、確認すべき点を本文に明示する。
    bodyText = financeGate.appendUnitEconomicsWarning({ bodyText: bodyText, validation: validation });
    return { bodyText: bodyText, model: effectiveModel, financeGate: validation, financeGateWarning: true };
  }

  async function runFullAuto(formInputs, ctrl, model, ui, opts) {
    const startIndex = (opts && opts.startIndex > 0) ? opts.startIndex : 0;
    const startSubNo = (opts && opts.startSubNo > 0) ? opts.startSubNo : null;
    const retrySections = Array.isArray(opts && opts.retrySections) ? opts.retrySections : [];

    const phases = window.SK_CORE.getPhases();
    const total = phases.length;

    // B8: 全章完了済みなら再実行しない
    if (startIndex >= phases.length) {
      ui.progressLabel.textContent = 'すでに全章完了しています。マスターを確認してください。';
      publishTaskMonitor_({
        status: 'completed',
        taskLabel: '戦略書への保存が完了しています',
        lastEvent: 'マスタードキュメントを確認できます',
      });
      return;
    }

    // 修正B: 再試行・途中再開・失敗章スキップ等の継続実行ではバックアップを作らない
    const skipBackup = shouldSkipFullAutoBackup_({
      startIndex: startIndex,
      startSubNo: startSubNo,
      retrySections: retrySections,
      retryOnly: opts && opts.retryOnly,
    });
    const masterReady = await ensureFullAutoMasterTarget_(ui, skipBackup);
    if (masterReady === 'cancelled') {
      ui.progressLabel.textContent = 'キャンセルされました。';
      publishTaskMonitor_({ status: 'idle', visible: false });
      return;
    }

    if (startIndex > 0) {
      const resumeLabel = startSubNo ? ('§' + startIndex + '-' + startSubNo) : ('§' + startIndex);
      ui.progressLabel.textContent = 'マスター再開: ' + resumeLabel + ' から実行中…';
      await showCurrentMasterInfo_(ui.draftInfoArea);
    }

    // 蓄積コンテキスト（中断再開時は前回分を復元、なければ初期入力から開始）
    const accumulated = (opts && opts.accumulated && typeof opts.accumulated === 'object')
      ? Object.assign({}, opts.accumulated)
      : {};
    if (!accumulated['初期入力']) {
      accumulated['初期入力'] =
        '業種: ' + formInputs.industry +
        '\n店舗: ' + (formInputs.storeName || '未指定') +
        '\n現状メモ:\n' + formInputs.memo +
        (formInputs.context ? '\n追加コンテキスト:\n' + formInputs.context : '');
    }

    // R4: 失敗章のトラッキング（最後にまとめて再試行できるようにする）
    const failedSections = []; // [{ no, displayNo, title, displayLabel, reason }]
    // 安全網で ⚠要確認 のまま完走した小節（停止ではなく完走サマリで「要確認」表示する）
    const financeWarningSections = []; // [{ no, displayNo, title, displayLabel, missing, violations }]

    // R4: ユーザー向けエラーメッセージへの整形
    function humanizeGeminiError(e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (msg.indexOf('Finance Gate 不合格') !== -1) {
        return msg.slice(0, 180);
      }
      // 「無料枠では使えないモデル」と「一時的なレート上限」は、どちらも 429 で
      // 同じ本文（You exceeded your current quota... / RESOURCE_EXHAUSTED）が返る。
      // 区別できるのは quotaMetric だけ:
      //   ..._input_token_count → モデルを変えるしかない
      //   ..._requests          → 待てば直る
      // 取り違えると、既定モデルで毎分上限に触れた受講者へ「モデルを変えてください
      // （無料枠なら gemini-3.6-flash）」と、すでに使っているモデルを案内してしまう。
      // モデル不在・権限拒否（404 / 403）は quotaMetric が無くても確実にモデル側の問題。
      if (/input_token_count|PERMISSION_DENIED|NOT_FOUND|model not found|is not found for API version|HTTP 40[34]\b/i.test(msg)) {
        return '選択中のAIモデルは、このAPIキーでは使えません。「実行モードを管理」でモデルを変更してください（無料枠なら gemini-3.6-flash / gemini-3.5-flash）';
      }
      if (msg.indexOf('503') !== -1 || /unavailable/i.test(msg)) {
        return 'AI が一時的に混雑しています（503）。あとで再試行してください';
      }
      if (msg.indexOf('429') !== -1 || /rate/i.test(msg)) {
        return 'AI のレートリミットに達しました（429）。1分ほど待ってから再試行してください';
      }
      if (/network|fetch|timeout/i.test(msg)) {
        return 'ネットワーク接続が不安定です。Wi-Fiを確認してください';
      }
      return msg.slice(0, 120);
    }

    function consumeForcedFullAutoFailure(sectionNo) {
      const forced = String(window.SK_FORCE_FULL_AUTO_FAIL_SECTION || '').trim();
      if (!forced || forced !== String(sectionNo || '').trim()) return;
      window.SK_FORCE_FULL_AUTO_FAIL_SECTION = '';
      throw new Error('Intentional full-auto failure for live smoke: §' + forced);
    }

    async function stopFullAutoAtFailure(sectionNo, title, reason, resumeIndex, failedSections, displayNo, displayLabel) {
      const noLabel = String(sectionNo || ''); // master 見出し・resume/retry の内部キー（不変）
      const dispNo = String(displayNo || sectionNo || ''); // ユーザー可視の小節番号（§7-4 等）
      const dispLabel = String(displayLabel || title || '');
      stopSavingOverlay();
      try {
        await appendMasterSectionDirect_({
          sectionNo: noLabel,
          displayNo: dispNo, // 見出し表示は実番号（§7-4）。マーカー/突合キーは sectionNo(noLabel)。
          title: title || '生成エラー',
          status: 'failed',
          errorCode: 'FULL_AUTO_FAIL',
          errorMessage: String(reason || '不明なエラー'),
          body: 'この章は primary CTA から埋め直せます。',
          aiUsed: 'gemini-error',
        });
      } catch (markerError) {
        console.warn('[STRATEGY-KIT] failed to write master failure marker:', markerError);
      }
      ui.progressLabel.textContent = '⚠️ §' + dispNo + ' ' + dispLabel + ' で失敗しました。手動で続行してください。';
      publishTaskMonitor_({
        status: 'blocked',
        taskLabel: '§' + dispNo + ' ' + dispLabel + ' で停止',
        lastEvent: '保存地点から再開できます',
      });
      setCurrentLocationText('§' + dispNo + ' ' + dispLabel + ' で失敗しました', '手動で修正または再実行してから続行してください');
      saveAutomationState(resumeIndex, accumulated, 'full');
      if (typeof ui.onFailedSectionsChange === 'function') {
        ui.onFailedSectionsChange(failedSections);
      }
      showRetryUI(ui.chainArea, failedSections, function () {
        retryFailedSections(formInputs, ctrl, model, ui, accumulated, failedSections, financeModel);
      });
      window.SK_CORE.showToast('§' + dispNo + ' ' + dispLabel + ' で失敗しました。手動で続行してください。', true, 7000);
      appendAutomationErrorLog(ui.logArea, '§' + dispNo + ' ' + dispLabel + ' の実行エラー', new Error(reason));
    }

    const financeModel = (opts && opts.financeModel) || 'gemini-3.6-flash';
    const financeGate = await loadFinanceGateDeps();
    const geminiClient = await loadGeminiClient();
    let effectiveStartIndex = startIndex;

    if (retrySections.length > 0) {
      ui.progressLabel.textContent = '失敗した小節を埋め直しています…';
      publishTaskMonitor_({
        status: 'retrying',
        taskLabel: '失敗した小節を再試行中',
        taskCount: retrySections.length + '件を確認',
        lastEvent: '保存済みの章はそのまま維持します',
      });
      await retryFailedSections(formInputs, ctrl, model, ui, accumulated, retrySections, financeModel);
      if (opts && opts.retryOnly) {
        return;
      }
      const maxRetriedParent = retrySections.reduce(function (max, section) {
        const parent = parseInt(String(section.no || '').split('-')[0], 10);
        return Number.isFinite(parent) ? Math.max(max, parent) : max;
      }, -1);
      if (startIndex <= maxRetriedParent) {
        effectiveStartIndex = Math.min(phases.length, maxRetriedParent + 1);
      }
    }

    for (let i = effectiveStartIndex; i < phases.length; i++) {
      if (ctrl.cancelled) {
        ui.progressLabel.textContent = 'キャンセルされました（' + i + '/' + total + ' 完了）';
        publishTaskMonitor_({
          status: 'paused',
          taskLabel: '全自動処理を中断しました',
          lastEvent: '§' + phases[i].no + ' から再開できます',
        });
        saveAutomationState(i, accumulated, 'full');
        setCurrentLocationText('全自動を中断しました', '§' + phases[i].no + ' から再開できます');
        return;
      }

      const phase = phases[i];
      const phaseLabel = '§' + phase.no + ' ' + phase.title;

      // 進捗を保存
      saveAutomationState(i, accumulated, 'full');

      // R4: より詳細な進捗表示（章番号 + 進捗率）
      const pct = Math.round((i / total) * 100);
      ui.progressLabel.textContent = '§' + phase.no + ' ' + phase.title + ' を生成中…（' + (i + 1) + '/' + total + '・' + pct + '%）';
      publishTaskMonitor_({
        status: 'running',
        taskLabel: '§' + phase.no + ' ' + phase.title + ' を準備中',
        eta: 'Geminiで生成します',
        lastEvent: '前の章までマスターへ保存済み',
      });
      setCurrentLocationText('いま §' + phase.no + ' を全自動生成中', 'ステップ ' + (i + 1) + '/' + total);
      window.SK_CORE.showToast('§' + phase.no + ' 実行中…', false, 1500);

      let units;
      try {
        units = buildFullAutoUnits(phase, accumulated, formInputs);
        if (startSubNo && parseInt(phase.no, 10) === startIndex) {
          units = units.filter(function (unit) {
            const parts = String(unit.sectionNo || '').split('-');
            const unitSubNo = parts[1] ? parseInt(parts[1], 10) : 1;
            return unitSubNo >= startSubNo;
          });
          if (!units.length) continue;
        }
      } catch (e) {
        const human = humanizeGeminiError(e);
        const failed = [{ no: phase.no, displayNo: String(phase.no), title: phase.title, displayLabel: phase.title, reason: human }];
        await stopFullAutoAtFailure(phase.no, phase.title, human, i, failed, String(phase.no), phase.title);
        return;
      }
      const phaseOutputs = [];
      let phaseFailed = false;

      for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
        if (ctrl.cancelled) break;
        const unit = units[unitIndex];
        const unitLabel = unit.logTitle || phaseLabel; // 内部ログ用（sectionNo=§7-2 由来）
        // ユーザー可視の表示名は displayNo/displayLabel（実番号 §7-4）から作る。
        const unitDisplayTitle = '§' + (unit.displayNo || unit.sectionNo) + ' ' + (unit.displayLabel || unit.title);
        const gateLabel = financeGate.isFinanceGatePrompt(unit.prompt)
          ? 'Finance Gate'
          : 'Gemini';
        if (units.length > 1) {
          ui.progressLabel.textContent =
            '§' + phase.no + ' 分割実行中: ' + unitDisplayTitle + '（' + (unitIndex + 1) + '/' + units.length + '・' + gateLabel + '）';
          setCurrentLocationText('いま ' + unitDisplayTitle + ' を全自動生成中', gateLabel);
        }
        publishTaskMonitor_({
          status: 'running',
          taskLabel: unitDisplayTitle + ' を生成中',
          taskCount: (unitIndex + 1) + ' / ' + units.length + '項目',
          eta: gateLabel + 'で処理中',
          lastEvent: phaseLabel + ' の現在タスク',
        });

        let bodyText = '';
        let usedModel = model;
        try {
          consumeForcedFullAutoFailure(unit.sectionNo);
          const generated = await generateWithFinanceGate({
            geminiClient: geminiClient,
            financeGate: financeGate,
            prompt: unit.prompt,
            promptText: unit.promptText,
            selectedModel: model,
            financeModel: financeModel,
            sectionLabel: '§' + unit.sectionNo + ' ' + unit.title,
          });
          bodyText = generated.bodyText;
          usedModel = generated.model;
          accumulated[unit.accKey] = bodyText.slice(0, 2000);
          phaseOutputs.push(bodyText);
          if (generated.financeGateWarning) {
            // 2回 repair してなお不合格 → ⚠要確認 注記付きで完走（停止しない）。
            financeWarningSections.push({
              no: unit.sectionNo,
              displayNo: unit.displayNo,
              title: unit.title,
              displayLabel: unit.displayLabel,
              missing: (generated.financeGate && generated.financeGate.missing) || [],
              violations: (generated.financeGate && generated.financeGate.violations) || [],
            });
            window.SK_CORE.showToast('§' + (unit.displayNo || unit.sectionNo) + ' ' + (unit.displayLabel || unit.title) + ' に要確認項目があります。完走を優先します。', 'warn', 5000);
          } else if (generated.financeGate) {
            window.SK_CORE.showToast('ユニットエコノミクス Finance Gate 通過', false, 2500);
          }
        } catch (e) {
          console.error('[STRATEGY-KIT] ' + unitLabel + ' 生成エラー:', e);
          const human = humanizeGeminiError(e);
          phaseFailed = true;
          failedSections.push({ no: unit.sectionNo, displayNo: unit.displayNo, title: unit.title, displayLabel: unit.displayLabel, reason: human });
          await stopFullAutoAtFailure(unit.sectionNo, unit.title, human, i, failedSections, unit.displayNo, unit.displayLabel);
          return;
        }

        // マスター本体に保存
        try {
          await appendMasterSectionDirect_({
            sectionNo: unit.sectionNo,
            displayNo: unit.displayNo, // 見出し表示は実番号（§7-4）。マーカー/突合キーは sectionNo。
            title: unit.title,
            body: bodyText,
            status: 'done',
            aiUsed: 'gemini-' + usedModel,
          });
        } catch (e) {
          console.error('[STRATEGY-KIT] ' + unitLabel + ' マスター書き込みエラー:', e);
          const human = humanizeGeminiError(e);
          if (!phaseFailed) {
            failedSections.push({ no: unit.sectionNo, displayNo: unit.displayNo, title: unit.title, displayLabel: unit.displayLabel, reason: 'マスター書き込み失敗: ' + human });
          }
          await stopFullAutoAtFailure(unit.sectionNo, unit.title, 'マスター書き込み失敗: ' + human, i, failedSections, unit.displayNo, unit.displayLabel);
          return;
        }

        // 完了ログ（文書には残らない診断表示）はユーザー可視の実番号・ラベルで出す。
        appendPhaseLog(ui.logArea, { no: unit.displayNo || unit.sectionNo, title: unit.displayLabel || unit.title }, bodyText, 'gemini-' + usedModel);
        publishTaskMonitor_({
          status: 'running',
          taskLabel: unitDisplayTitle + ' を保存しました',
          taskCount: (unitIndex + 1) + ' / ' + units.length + '項目',
          eta: unitIndex < units.length - 1 ? '次の項目へ進みます' : '次の章へ進みます',
          lastEvent: 'Google Docsへ保存済み',
        });
        if (unitIndex < units.length - 1 && !ctrl.cancelled) {
          await new Promise(function (resolve) { setTimeout(resolve, 1000); });
        }
      }

      if (phaseOutputs.length) {
        accumulated['§' + phase.no] = phaseOutputs.join('\n\n---\n\n').slice(0, 2000);
      }

      if (ctrl.cancelled) {
        ui.progressLabel.textContent = 'キャンセルされました';
        publishTaskMonitor_({
          status: 'paused',
          taskLabel: '全自動処理を中断しました',
          lastEvent: '現在の保存地点から再開できます',
        });
        saveAutomationState(i, accumulated, 'full');
        return;
      }

      ui.progressBarInner.style.width = (((i + 1) / total) * 100) + '%';
      if (window.SK_CORE?.emit) window.SK_CORE.emit('master-doc-changed');

      // レートリミット回避のためフェーズ間に1秒待機（最後のフェーズ以外）
      if (i < phases.length - 1 && !ctrl.cancelled) {
        await new Promise(function (resolve) { setTimeout(resolve, 1000); });
      }
    }

    if (!ctrl.cancelled) {
      // R4: 失敗小節があった場合の再試行 UI（失敗は途中で return するため通常ここには到達しない）
      if (failedSections.length > 0) {
        ui.progressLabel.textContent = '⚠️ 完了（' + total + '/' + total + ' 中、' + failedSections.length + '件の小節で失敗）';
        showRetryUI(ui.chainArea, failedSections, function () {
          // 再試行: 失敗した小節だけを再実行する
          retryFailedSections(formInputs, ctrl, model, ui, accumulated, failedSections, financeModel);
        });
      } else {
        ui.progressLabel.textContent = '✅ 全章完了（' + total + '/' + total + '）';
        publishTaskMonitor_({
          status: 'completed',
          taskLabel: '戦略書への保存が完了',
          lastEvent: '全章をGoogle Docsへ保存しました',
        });
        clearRetryCards(ui.chainArea);
      }
      clearAutomationState();
      hideCurrentLocation();
      // 安全網で ⚠要確認 のまま完走した小節がある場合は、停止（赤カード）ではなく
      // 非停止の「要確認」情報表示＋warn toast にする（DoD1 止まらない／曖昧なまま黙って流さない）。
      if (financeWarningSections.length > 0) {
        const labels = financeWarningSections.map(function (section) {
          return '§' + (section.displayNo || section.no);
        }).join('・');
        ui.progressLabel.textContent = '✅ 全章完了（要確認: ' + labels + '）';
        window.SK_CORE.showToast('全章完了。要確認の小節があります: ' + labels, 'warn', 7000);
      } else {
        window.SK_CORE.showToast('全章完了。マスター本体に保存しました', false, 5000);
      }
    }
  }

  // ログに1章分追加
  function appendPhaseLog(logArea, phase, text, aiUsed) {
    const el = window.SK_CORE.el;
    const card = el(
      'div',
      {
        style: 'border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;margin-bottom:6px;background:#f8fafc',
      },
      el('div', {
        style: 'font-size:11px;font-weight:600;color:#0f766e;margin-bottom:4px',
        text: '§' + phase.no + ' ' + phase.title + '（' + (aiUsed || 'AI') + '）',
      })
    );
    const pre = el('div', {
      style: 'font-size:10px;color:#0f172a;white-space:pre-wrap;line-height:1.4;max-height:120px;overflow:auto',
      text: text,
    });
    card.appendChild(pre);
    logArea.appendChild(card);
    logArea.scrollTop = logArea.scrollHeight;
  }

  // R4: 失敗章の再試行 UI を chainArea に表示
  function showRetryUI(container, failedSections, onRetry) {
    const el = window.SK_CORE.el;
    container.classList.remove('hidden');
    clearRetryCards(container);

    const wrap = el('div', {
      class: 'sk-retry-card',
      style: 'background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:10px 12px',
    });
    wrap.appendChild(el('div', {
      style: 'font-size:12px;font-weight:700;color:#b91c1c;margin-bottom:6px',
      text: '⚠️ ' + failedSections.length + '件の小節で失敗しました（マスターには failed マーカーを書き込みました）',
    }));
    const list = el('ul', {
      style: 'font-size:11px;color:#7f1d1d;margin:4px 0 8px;padding-left:18px;line-height:1.5',
    });
    failedSections.forEach(function (f) {
      list.appendChild(el('li', { text: '§' + (f.displayNo || f.no) + ' ' + (f.displayLabel || f.title) + ' — ' + f.reason }));
    });
    wrap.appendChild(list);

    const dismissBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '今回はここで止める',
      style: 'font-size:12px',
      on: { click: function () { wrap.remove(); } },
    });
    const openMasterBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '📄 マスターを開いて失敗した小節を確認',
      style: 'font-size:12px',
      on: { click: async function () {
        try {
          const info = await showCurrentMasterInfo_(null);
          if (info && info.docUrl) {
            chrome.tabs.create({ url: info.docUrl });
          } else {
            window.SK_CORE.showToast('マスター URL が取得できませんでした', true);
          }
        } catch (e) {
          window.SK_CORE.showToast('マスター URL 取得エラー: ' + (e.message || ''), true);
        }
      } },
    });
    wrap.appendChild(el('p', {
      style: 'font-size:11px;color:#7f1d1d;margin:0 0 8px;line-height:1.5',
      text: '実行ボタンが失敗した小節を埋める表示に変わります。',
    }));
    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, openMasterBtn, dismissBtn));
    container.appendChild(wrap);
  }

  // R4: 失敗章だけを再生成してマスターを書き直す
  function resolveFailedUnit(failed, phases, accumulated, formInputs) {
    const rawNo = String(failed.no || '');
    const parts = rawNo.split('-');
    const phaseNo = parseInt(parts[0], 10);
    const subNo = parts[1] ? parseInt(parts[1], 10) : null;
    const phase = phases.find(function (p) { return parseInt(p.no, 10) === phaseNo; });
    if (!phase) return null;
    if (subNo && phase.prompts && phase.prompts[subNo - 1]) {
      const prompt = phase.prompts[subNo - 1];
      return {
        phase: phase,
        prompt: prompt,
        promptText: buildSubPrompt(prompt, accumulated, formInputs),
        sectionNo: phase.no + '-' + subNo,
        displayNo: prompt.no || (phase.no + '-' + subNo),
        displayLabel: prompt.label,
        title: prompt.label,
        logTitle: '§' + phase.no + '-' + subNo + ' ' + prompt.label,
        accKey: '§' + phase.no + '-' + subNo + '（' + prompt.label + '）',
      };
    }
    return buildFullAutoUnits(phase, accumulated, formInputs)[0];
  }

  async function retryFailedSections(formInputs, ctrl, model, ui, accumulated, failedSections, financeModel) {
    const phases = window.SK_CORE.getPhases();
    const financeGate = await loadFinanceGateDeps();
    const geminiClient = await loadGeminiClient();

    let successCount = 0;
    const stillFailed = [];
    publishTaskMonitor_({
      status: 'retrying',
      taskLabel: '失敗した小節を再試行中',
      taskCount: failedSections.length + '件を確認',
      lastEvent: '保存済みの章はそのまま維持します',
    });

    for (let i = 0; i < failedSections.length; i++) {
      if (ctrl.cancelled) break;
      const f = failedSections[i];
      const unit = resolveFailedUnit(f, phases, accumulated, formInputs);
      if (!unit) continue;
      const phaseLabel = unit.logTitle || ('§' + unit.phase.no + ' ' + unit.phase.title); // 内部ログ用
      // ユーザー可視の表示名は displayNo/displayLabel（実番号 §7-4）から作る。
      const displayTitle = '§' + (unit.displayNo || f.displayNo || unit.sectionNo) + ' ' + (unit.displayLabel || f.displayLabel || unit.title);

      ui.progressLabel.textContent = '再試行中: ' + displayTitle + '（' + (i + 1) + '/' + failedSections.length + '）';
      publishTaskMonitor_({
        status: 'retrying',
        taskLabel: displayTitle + ' を再試行中',
        taskCount: (i + 1) + ' / ' + failedSections.length + '件',
        eta: 'Geminiで再生成中',
        lastEvent: '失敗した小節だけを再実行します',
      });

      let bodyText = '';
      let usedModel = model;
      try {
        const generated = await generateWithFinanceGate({
          geminiClient: geminiClient,
          financeGate: financeGate,
          prompt: unit.prompt,
          promptText: unit.promptText,
          selectedModel: model,
          financeModel: financeModel || 'gemini-3.6-flash',
          sectionLabel: '§' + unit.sectionNo + ' ' + unit.title,
        });
        bodyText = generated.bodyText;
        usedModel = generated.model;
        accumulated[unit.accKey] = bodyText.slice(0, 2000);
        if (generated.financeGateWarning) {
          // 2回 repair してなお不合格でも throw せず ⚠要確認 注記付きで done 保存する。
          window.SK_CORE.showToast('§' + (unit.displayNo || unit.sectionNo) + ' に要確認項目があります。done として保存します。', 'warn', 5000);
        }
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        stillFailed.push({ no: f.no, displayNo: f.displayNo, title: f.title, displayLabel: f.displayLabel, reason: msg.slice(0, 120) });
        continue;
      }

      try {
        await appendMasterSectionDirect_({
          sectionNo: unit.sectionNo,
          displayNo: unit.displayNo || f.displayNo, // 見出し表示は実番号（§7-4）。突合キーは sectionNo。
          title: unit.title,
          body: bodyText,
          status: 'done',
          aiUsed: 'gemini-' + usedModel + '（再試行）',
        });
        successCount++;
        appendPhaseLog(ui.logArea, { no: unit.displayNo || f.displayNo || unit.sectionNo, title: (unit.displayLabel || unit.title) + '（再試行）' }, bodyText, 'gemini-' + usedModel);
      } catch (e) {
        stillFailed.push({ no: f.no, displayNo: f.displayNo, title: f.title, displayLabel: f.displayLabel, reason: 'マスター再書き込み失敗: ' + (e.message || '').slice(0, 80) });
      }

      if (i < failedSections.length - 1) {
        await new Promise(function (resolve) { setTimeout(resolve, 1500); });
      }
    }

    if (stillFailed.length === 0) {
      ui.progressLabel.textContent = '✅ 再試行完了（' + successCount + '/' + failedSections.length + '）';
      publishTaskMonitor_({
        status: 'completed',
        taskLabel: '再試行した小節を保存しました',
        lastEvent: successCount + '件をGoogle Docsへ保存済み',
      });
      window.SK_CORE.showToast('失敗した小節を全て再生成しました', false, 4000);
      if (typeof ui.onFailedSectionsChange === 'function') {
        ui.onFailedSectionsChange([]);
      }
      clearRetryCards(ui.chainArea);
      if (window.SK_CORE?.emit) window.SK_CORE.emit('master-doc-changed');
    } else {
      ui.progressLabel.textContent = '⚠️ 再試行: ' + successCount + '/' + failedSections.length + ' 成功';
      publishTaskMonitor_({
        status: 'blocked',
        taskLabel: '再試行できなかった小節があります',
        taskCount: stillFailed.length + '件が未完了',
        lastEvent: successCount + '件は保存済み',
      });
      if (typeof ui.onFailedSectionsChange === 'function') {
        ui.onFailedSectionsChange(stillFailed);
      }
      showRetryUI(ui.chainArea, stillFailed, function () {
        retryFailedSections(formInputs, ctrl, model, ui, accumulated, stillFailed, financeModel);
      });
    }
  }


  // 半自動チェーン実行（サブプロンプト対応）
  //   v0.9.13: opts.startSubNo（1-based）が指定されたら、
  //     その親フェーズの該当サブステップから走破を開始する。
  async function runSemiAuto(formInputs, ctrl, ui, opts) {
    const startIndex = (opts && opts.startIndex > 0) ? opts.startIndex : 0;
    const startSubNo = (opts && opts.startSubNo > 0) ? opts.startSubNo : null;

    const phases = window.SK_CORE.getPhases();
    const allSteps = flattenPhases(phases);
    const total = allSteps.length;

    // B8: 全章完了済みなら再実行しない
    if (startIndex >= phases.length) {
      ui.progressLabel.textContent = 'すでに全章完了しています。マスターを確認してください。';
      publishTaskMonitor_({
        status: 'completed',
        taskLabel: '半自動の全ステップが完了しています',
        lastEvent: 'マスタードキュメントを確認できます',
      });
      return;
    }

    // マスター再開フェーズから始まるステップインデックスを計算
    //   - startSubNo が指定されていれば、phase.no === startIndex のうち subNo >= startSubNo の最初を採用
    //   - startSubNo 無指定なら、phase.no >= startIndex の最初（従来動作）
    let stepStartIndex = 0;
    if (startIndex > 0 || startSubNo) {
      stepStartIndex = -1;
      for (let si = 0; si < allSteps.length; si++) {
        const stepPhaseNo = parseInt(allSteps[si].phase.no, 10);
        if (startSubNo && stepPhaseNo === startIndex) {
          if ((allSteps[si].subNo || 1) >= startSubNo) {
            stepStartIndex = si;
            break;
          }
          continue;
        }
        if (stepPhaseNo >= startIndex && (!startSubNo || stepPhaseNo > startIndex)) {
          stepStartIndex = si;
          break;
        }
      }
      if (stepStartIndex < 0) {
        // startSubNo が totalSubs を超えている場合は親 N+1 の最初へフォールバック
        for (let si = 0; si < allSteps.length; si++) {
          if (parseInt(allSteps[si].phase.no, 10) > startIndex) {
            stepStartIndex = si;
            break;
          }
        }
        if (stepStartIndex < 0) stepStartIndex = allSteps.length;
      }
    }

    // B8: 全ステップ完了済みなら再実行しない
    if (stepStartIndex >= allSteps.length) {
      ui.progressLabel.textContent = 'すでに全章完了しています。マスターを確認してください。';
      publishTaskMonitor_({
        status: 'completed',
        taskLabel: '半自動の全ステップが完了しています',
        lastEvent: 'マスタードキュメントを確認できます',
      });
      return;
    }

    // 修正B: 再試行・途中再開等の継続実行ではバックアップを作らない
    const skipBackup = shouldSkipFullAutoBackup_({
      startIndex: startIndex,
      startSubNo: startSubNo,
      retrySections: (opts && opts.retrySections) || [],
    });
    const masterReady = await ensureFullAutoMasterTarget_(ui, skipBackup);
    if (masterReady === 'cancelled') {
      ui.progressLabel.textContent = 'キャンセルされました。';
      publishTaskMonitor_({ status: 'idle', visible: false });
      return;
    }

    if (startIndex > 0 || startSubNo) {
      const resumeLabel = startSubNo ? ('§' + startIndex + '-' + startSubNo) : ('§' + startIndex);
      ui.progressLabel.textContent = 'マスター再開: ' + resumeLabel + ' から実行中…';
      await showCurrentMasterInfo_(ui.draftInfoArea);
    }

    const accumulated = (opts && opts.accumulated && typeof opts.accumulated === 'object')
      ? Object.assign({}, opts.accumulated)
      : {};
    if (!accumulated['初期入力']) {
      accumulated['初期入力'] =
        '業種: ' + formInputs.industry +
        '\n店舗: ' + (formInputs.storeName || '未指定') +
        '\n現状メモ:\n' + formInputs.memo +
        (formInputs.context ? '\n追加コンテキスト:\n' + formInputs.context : '');
    }

    for (let i = stepStartIndex; i < allSteps.length; i++) {
      if (ctrl.cancelled) {
        ui.progressLabel.textContent = 'キャンセルされました（' + i + '/' + total + ' 完了）';
        // v0.9.13: semi-auto はサブ番号も保存して中断再開でも §N-M 復元できるようにする
        const cancelStep = allSteps[i];
        const cancelKey = (cancelStep.totalSubs > 1)
          ? (cancelStep.phase.no + '-' + cancelStep.subNo)
          : parseInt(cancelStep.phase.no, 10);
        saveAutomationState(cancelKey, accumulated, 'semi');
        publishTaskMonitor_({
          status: 'paused',
          taskLabel: '半自動を中断しました',
          lastEvent: '§' + cancelKey + ' から再開できます',
        });
        setCurrentLocationText('自動化を中断しました', '§' + cancelKey + ' から再開できます');
        return;
      }
      const step = allSteps[i];
      const phase = step.phase;

      // 進捗を保存
      //   v0.9.13: サブステップ有り phase は '3-2' のような文字列で保存。
      //   従来の整数 phaseIndex も互換維持（中断再開モーダルで __number__ チェック有り）
      const saveKey = (step.totalSubs > 1)
        ? (phase.no + '-' + step.subNo)
        : parseInt(phase.no, 10);
      saveAutomationState(saveKey, accumulated, 'semi');
      const subLabel =
        step.totalSubs > 1
          ? '§' + phase.no + '-' + step.subNo + ' ' + (step.prompt ? step.prompt.label : phase.title)
          : '§' + phase.no + ' ' + phase.title;

      ui.progressLabel.textContent =
        '進行中: ' + subLabel + '（' + (i + 1) + '/' + total + '）';
      publishTaskMonitor_({
        status: 'running',
        provider: '複数AI',
        taskLabel: subLabel + ' の回答待ち',
        taskCount: (i + 1) + ' / ' + total,
        lastEvent: 'サイドパネルでAIの回答を確認・貼り付けしてください',
      });

      if (step.isPlaceholder) {
        ui.progressBarInner.style.width = ((i + 1) / total * 100) + '%';
        continue;
      }

      const prompt = buildSubPrompt(step.prompt, accumulated, formInputs);
      // R1: リサーチサイクルへ accumulated と formInputs を引き渡すためのランタイム文脈
      const runtimeCtx = { accumulated: accumulated, formInputs: formInputs };
      const userOutput = await waitForUserInput(ui.chainArea, phase, prompt, step, ctrl, runtimeCtx);

      if (ctrl.cancelled || userOutput === null) {
        ui.progressLabel.textContent = 'キャンセルされました';
        publishTaskMonitor_({
          status: 'paused',
          taskLabel: '半自動を中断しました',
          lastEvent: subLabel + ' の手前から再開できます',
        });
        setCurrentLocationText('自動化を中断しました', subLabel + ' の手前で停止しました');
        return;
      }

      startSavingOverlay(
        '保存中…',
        subLabel + ' を Drive とマスターに書き込んでいます'
      );
      setCurrentLocationText('いま保存中です', subLabel + ' を保存しています');

      const accKey =
        step.totalSubs > 1
          ? '§' + phase.no + '-' + step.subNo + '（' + step.prompt.label + '）'
          : '§' + phase.no;
      accumulated[accKey] = userOutput.text;

      // フェーズ最終ステップで §N にも統合
      if (step.subNo === step.totalSubs && step.totalSubs > 1) {
        const phaseSummary = Object.keys(accumulated)
          .filter(function (k) {
            return k.indexOf('§' + phase.no + '-') === 0;
          })
          .map(function (k) {
            return accumulated[k];
          })
          .join('\n\n---\n\n');
        accumulated['§' + phase.no] = phaseSummary;
      }

      try {
        const noStr =
          step.totalSubs > 1
            ? String(phase.no).padStart(2, '0') + '-' + step.subNo
            : String(phase.no).padStart(2, '0');
        const researchStore = await loadResearchStore();
        await researchStore.saveResearchMarkdown({
          no: noStr,
          type: 'manual',
          content: userOutput.text,
          title: subLabel + '（半自動・' + userOutput.aiUsed + '）',
        });
      } catch (e) {
        // B4: 保存失敗はトースト（赤）表示して中断
        console.error('[STRATEGY-KIT] saveResearch失敗:', e);
        stopSavingOverlay();
        window.SK_CORE.showToast('保存失敗: ' + (e.message || String(e)), true, 5000);
        throw e;
      }

      try {
        const sectionNoStr =
          step.totalSubs > 1 ? phase.no + '-' + step.subNo : String(phase.no);
        await appendMasterSectionDirect_({
          sectionNo: sectionNoStr,
          title: step.totalSubs > 1 ? step.prompt.label : phase.title,
          body: userOutput.text,
          status: 'done',
          aiUsed: userOutput.aiUsed,
        });
      } catch (e) {
        // B4: マスター書き込み失敗はトースト（赤）表示して中断
        console.error('[STRATEGY-KIT] appendMasterSectionDirect_失敗:', e);
        stopSavingOverlay();
        window.SK_CORE.showToast('マスター書き込み失敗: ' + (e.message || String(e)), true, 5000);
        throw e;
      }

      stopSavingOverlay();
      if (userOutput.stepUi && userOutput.stepUi.card) {
        setChainStepState(userOutput.stepUi, 'completed', '保存完了');
        userOutput.stepUi.card.open = false;
      }
      ui.chainArea._skCurrentStep = null;
      appendPhaseLog(ui.logArea, { no: phase.no, title: subLabel }, userOutput.text, userOutput.aiUsed);
      ui.progressBarInner.style.width = ((i + 1) / total * 100) + '%';
      if (window.SK_CORE?.emit) window.SK_CORE.emit('master-doc-changed');
      setCurrentLocationText(
        '保存完了',
        subLabel + ' を保存しました / 次のステップへ進みます'
      );
      window.SK_CORE.showToast(subLabel + ' を保存しました', 'success', 2500);
    }

    if (!ctrl.cancelled) {
      ui.progressLabel.textContent = '✅ 全ステップ完了（' + total + '/' + total + '）';
      clearAutomationState();
      publishTaskMonitor_({
        status: 'completed',
        provider: '複数AI',
        taskLabel: '半自動の全ステップが完了しました',
        lastEvent: 'マスタードキュメントへ保存済み',
      });
      hideCurrentLocation();
      window.SK_CORE.showToast('半自動完了。マスターを確認してください', false, 4000);
    }
  }

  // ===========================================================
  // 共通: AI挿入用のセレクタ＋ボタン群
  // ===========================================================
  function buildAiActionRow(getPromptText, recommended) {
    const el = window.SK_CORE.el;
    const allAis = ['claude', 'chatgpt', 'gemini', 'manus', 'genspark', 'perplexity', 'grok', 'notebooklm'];
    const aiLabels = {
      claude: 'Claude',
      chatgpt: 'ChatGPT',
      gemini: 'Gemini',
      manus: 'Manus',
      genspark: 'Genspark',
      perplexity: 'Perplexity',
      grok: 'Grok',
      notebooklm: 'NotebookLM',
    };
    const aiSelect = el('select', { class: 'ai-selector' });
    allAis.forEach(function (id) {
      const opt = el('option', {
        value: id,
        text: (aiLabels[id] || id) + (id === recommended ? '（推奨）' : ''),
      });
      if (id === recommended) opt.selected = true;
      aiSelect.appendChild(opt);
    });

    const insertBtn = el('button', {
      class: 'btn btn-ghost',
      text: '挿入',
      on: {
        click: async function () {
          const text = getPromptText();
          insertBtn.disabled = true;
          insertBtn.textContent = '開いて挿入中…';
          try {
            await navigator.clipboard.writeText(text).catch(function () {});
            const resp = await chrome.runtime.sendMessage({
              type: 'INSERT_PROMPT',
              text: text,
              site: aiSelect.value,
              openIfMissing: true,
              focus: true,
            });
            if (!resp || !resp.ok) {
              throw new Error(resp?.error || 'insert-failed');
            }
            window.SK_CORE.showToast('AIタブを開いて挿入しました（送信は手動で）');
          } catch (error) {
            console.error('[STRATEGY-KIT] 挿入エラー:', error?.message || error);
            window.SK_CORE.showToast(
              '自動挿入できませんでした。プロンプトはコピー済みです。AIの入力欄へ貼り付けてください。',
              'warn',
              5000
            );
          } finally {
            insertBtn.disabled = false;
            insertBtn.textContent = '挿入';
          }
        },
      },
    });

    const openBtn = el('button', {
      class: 'btn btn-ghost',
      text: 'タブを開く',
      on: {
        click: async function () {
          openBtn.disabled = true;
          openBtn.textContent = '開いています…';
          try {
            const result = await window.SK_CORE.openOrFocusAiTab(aiSelect.value);
            if (!result?.ok) throw new Error(result?.error || 'open-failed');
            window.SK_CORE.showToast(
              (aiLabels[aiSelect.value] || aiSelect.value) + ' のタブを開きました'
            );
          } catch (error) {
            console.error('[STRATEGY-KIT] AIタブを開けません:', error?.message || error);
            window.SK_CORE.showToast(
              'AIタブを開けませんでした。拡張機能を再読み込みして、もう一度お試しください。',
              'warn',
              5000
            );
          } finally {
            openBtn.disabled = false;
            openBtn.textContent = 'タブを開く';
          }
        },
      },
    });

    const copyBtn = el('button', {
      class: 'btn btn-ghost',
      text: 'コピー',
      on: {
        click: function () {
          navigator.clipboard.writeText(getPromptText());
          window.SK_CORE.showToast('コピーしました');
        },
      },
    });

    const row = el(
      'div',
      { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap' },
      el('span', { style: 'font-size:11px;color:#475569', text: '送信先:' }),
      aiSelect,
      insertBtn,
      openBtn,
      copyBtn
    );

    return { row, aiSelect };
  }

  // ===========================================================
  // 半自動: ユーザーがAIに送信→出力貼付→次へ を待つ
  //   通常モード or リサーチサイクル展開モード
  //   R1: runtimeCtx = { accumulated, formInputs } を受け取り
  //       cycleBtn 経由で runResearchCycleForPhase に渡せるようにする
  // ===========================================================
  // v0.9.14: ステップ進行時にスクロール位置がジャンプするバグC対策。
  //   chainArea の中身を入れ替えると、前ステップで触っていた要素が消える瞬間にブラウザが
  //   scroll anchoring を失い、ページ最上部や最下部へ飛ぶケースが多い。
  //   - 入れ替え前に scrollY を保存
  //   - 入れ替え後に rAF で復元
  //   - 表示されている container そのものは min-height を持たないので、空 → 詰め直しの
  //     瞬間に高さが 0 に縮み、その下の要素が上に詰まり、結果として scrollY が範囲外になる。
  //     復元時は document.body.scrollHeight を超えないようにクランプする。
  function preserveScrollDuring(mutatorFn) {
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    try {
      mutatorFn();
    } finally {
      // 2 段階で復元: 即時 + 次フレーム（DOM 構築完了後）
      window.scrollTo(sx, sy);
      requestAnimationFrame(function () {
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(sx, Math.min(sy, maxY));
      });
    }
  }

  function ensureChainTimeline(container) {
    container.classList.remove('hidden');
    if (!container._skTimelineRoot) {
      container._skTimelineRoot = window.SK_CORE.el('div', {
        class: 'sk-chain-timeline',
        style: 'display:flex;flex-direction:column;gap:10px',
      });
      container.appendChild(container._skTimelineRoot);
    }
    return container._skTimelineRoot;
  }

  function clearRetryCards(container) {
    if (!container) return;
    Array.from(container.querySelectorAll('.sk-retry-card')).forEach(function (node) {
      node.remove();
    });
  }

  function setCurrentLocationText(eyebrow, text) {
    if (window.SK_CORE.setCurrentLocation) {
      window.SK_CORE.setCurrentLocation({ eyebrow: eyebrow, text: text });
    }
  }

  function hideCurrentLocation() {
    if (window.SK_CORE.clearCurrentLocation) {
      window.SK_CORE.clearCurrentLocation();
    }
  }

  function startSavingOverlay(title, detail) {
    if (window.SK_CORE.showSavingOverlay) {
      window.SK_CORE.showSavingOverlay(title, detail);
    }
  }

  function stopSavingOverlay() {
    if (window.SK_CORE.hideSavingOverlay) {
      window.SK_CORE.hideSavingOverlay();
    }
  }

  function ensureStepCardVisible(stepUi) {
    if (!stepUi || !stepUi.card || typeof stepUi.card.getBoundingClientRect !== 'function') return;
    const rect = stepUi.card.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 32;
    const fullyAbove = rect.bottom < margin;
    const fullyBelow = rect.top > (viewportHeight - margin);
    if (!fullyAbove && !fullyBelow) return;
    try {
      stepUi.card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    } catch (e) {
      stepUi.card.scrollIntoView();
    }
  }

  function describeAutomationError(error) {
    const raw = (error && error.message) ? error.message : String(error || '');
    if (!raw) {
      return {
        short: '原因不明のエラーが発生しました',
        detail: 'Google連携、DRAFT URL、通信状態を順に確認してください。',
      };
    }
    if (/site-tab-not-found|no-active-tab/i.test(raw)) {
      return {
        short: 'AIタブが見つかりません',
        detail: '対象AIのタブを一度開いてから、もう一度「実行」を押してください。',
      };
    }
    if (/draft/i.test(raw) && /not found|not configured|missing/i.test(raw)) {
      return {
        short: 'DRAFT ドキュメントを確認できません',
        detail: '「このDRAFTの進捗を確認」で対象DRAFTを選び直すか、新規作成モードで再開してください。',
      };
    }
    if (/403|401|permission|forbidden/i.test(raw)) {
      return {
        short: '権限エラーが発生しました',
        detail: 'Google連携、またはマスタードキュメントの共有設定を確認してください。',
      };
    }
    if (/429|rate/i.test(raw)) {
      return {
        short: 'API呼び出し回数の上限に達しました',
        detail: '1分ほど待ってから再試行してください。',
      };
    }
    if (/503|unavailable|network|fetch|timeout/i.test(raw)) {
      return {
        short: '通信またはAPIが一時的に不安定です',
        detail: '少し待ってから再試行し、改善しなければ Google連携をやり直してください。',
      };
    }
    return {
      short: raw.slice(0, 120),
      detail: 'Google連携、AIタブ、DRAFT の状態を確認してから再試行してください。',
    };
  }

  function appendAutomationErrorLog(logArea, title, error) {
    if (!logArea || !window.SK_CORE || typeof window.SK_CORE.el !== 'function') return;
    const el = window.SK_CORE.el;
    const message = describeAutomationError(error);
    logArea.appendChild(
      el(
        'div',
        {
          style: 'border:1px solid #fca5a5;border-radius:6px;padding:8px 10px;margin-bottom:6px;background:#fef2f2',
        },
        el('div', {
          style: 'font-size:11px;font-weight:700;color:#b91c1c;margin-bottom:4px',
          text: title,
        }),
        el('div', {
          style: 'font-size:11px;color:#7f1d1d;line-height:1.6',
          text: message.short,
        }),
        el('div', {
          style: 'font-size:10px;color:#991b1b;line-height:1.6;margin-top:4px',
          text: '次の確認: ' + message.detail,
        })
      )
    );
    logArea.scrollTop = logArea.scrollHeight;
  }

  function setChainStepState(stepUi, state, statusText) {
    if (!stepUi || !stepUi.card) return;
    const normalized = state === 'awaiting-input' || state === 'pending' || state === 'completed'
      ? state
      : 'pending';
    stepUi.card.dataset.stepState = normalized;
    stepUi.card.classList.toggle('is-current-step', normalized === 'awaiting-input');
    if (stepUi.badgeEl) {
      stepUi.badgeEl.hidden = normalized !== 'awaiting-input';
    }
    if (statusText && stepUi.statusEl) {
      stepUi.statusEl.textContent = statusText;
    }
    if (normalized === 'awaiting-input' && stepUi.summaryEl && typeof stepUi.summaryEl.focus === 'function') {
      try {
        stepUi.summaryEl.focus({ preventScroll: true });
      } catch (e) {
        stepUi.summaryEl.focus();
      }
      ensureStepCardVisible(stepUi);
    }
  }

  function archiveCurrentChainStep(container, statusText) {
    const current = container && container._skCurrentStep;
    if (!current) return;
    setChainStepState(current, 'completed', statusText || '完了');
    current.card.open = false;
    container._skCurrentStep = null;
  }

  function waitForUserInput(container, phase, prompt, step, ctrl, runtimeCtx) {
    const el = window.SK_CORE.el;

    return new Promise(function (resolve) {
      const timeline = ensureChainTimeline(container);
      archiveCurrentChainStep(container, '完了');
      clearRetryCards(container);

      // B2: ctrlが渡されている場合、キャンセルフラグを定期監視してPromiseを解決
      var cancelCheckInterval = null;
      if (ctrl) {
        cancelCheckInterval = setInterval(function () {
          if (ctrl.cancelled) {
            clearInterval(cancelCheckInterval);
            resolve(null);
          }
        }, 200);
      }
      // resolve をラップして インターバルを確実にクリア
      var origResolve = resolve;
      resolve = function (val) {
        if (cancelCheckInterval) {
          clearInterval(cancelCheckInterval);
          cancelCheckInterval = null;
        }
        origResolve(val);
      };

      // ヘッダ：フェーズ＋サブステップ表示
      const headerText =
        step && step.totalSubs > 1
          ? 'フェーズ' + phase.no + '-' + step.subNo + ': ' + (step.prompt ? step.prompt.label : phase.title) +
            '（' + step.subNo + '/' + step.totalSubs + ')'
          : 'フェーズ' + phase.no + ': ' + phase.title;
      const stepCard = el('details', {
        class: 'automation-step-details',
        attrs: { open: 'open', tabindex: '-1' },
      });
      stepCard.dataset.stepState = 'awaiting-input';
      const turnBadge = el('div', {
        class: 'automation-step-turn-badge',
        text: '✋ あなたの番です',
      });
      const statusEl = el('span', {
        style: 'flex-shrink:0;font-size:11px;font-weight:700;color:#7c5a0d',
        text: '入力待ち',
      });
      const summaryEl = el(
        'summary',
        {
          style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;background:#fffdf6',
        },
        el('div', {},
          el('div', {
            style: 'font-size:12px;font-weight:800;color:#7c5a0d;margin-bottom:2px',
            text: '作業中',
          }),
          el('div', {
            style: 'font-size:13px;font-weight:700;color:#0f172a;line-height:1.5',
            text: headerText,
          })
        ),
        statusEl
      );
      const stepBody = el('div', { style: 'padding:12px' });
      stepCard.appendChild(turnBadge);
      stepCard.appendChild(summaryEl);
      stepCard.appendChild(stepBody);
      timeline.appendChild(stepCard);
      container._skCurrentStep = {
        card: stepCard,
        summaryEl: summaryEl,
        statusEl: statusEl,
        badgeEl: turnBadge,
      };
      setChainStepState(container._skCurrentStep, 'awaiting-input', '入力待ち');

      // R3: 操作手順サマリ（受講生向け・3ステップを明示・DOM APIで構築）
      const stepGuide = el('div', {
        style: 'background:#fef3c7;border:1px solid #fcd34d;border-radius:5px;padding:6px 10px;margin-bottom:6px;font-size:11px;color:#78350f;line-height:1.6',
      });
      stepGuide.appendChild(el('div', {
        style: 'font-weight:700;margin-bottom:2px',
        text: 'このフェーズの進め方（目安: 3〜5分）',
      }));
      stepGuide.appendChild(el('div', { text: '① 「挿入」で推奨AIのタブを開き、プロンプトを自動挿入（「タブを開く」は開くだけ）' }));
      stepGuide.appendChild(el('div', { text: '② AIの返答をコピーして下の貼付欄に入れる' }));
      stepGuide.appendChild(el('div', { text: '③ 「次のフェーズへ →」を押して保存' }));
      stepBody.appendChild(stepGuide);

      // プロンプト本文表示
      const promptBox = el('div', {
        style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;font-size:10px;white-space:pre-wrap;max-height:160px;overflow:auto;margin-bottom:6px;font-family:monospace',
        text: prompt,
      });
      stepBody.appendChild(promptBox);

      // AI挿入行（サブプロンプトの推奨AI優先 → フェーズ推奨 → claude）
      const recommended =
        (step && step.prompt && step.prompt.for) || phase.defaultFor || 'claude';
      const aiActions = buildAiActionRow(function () {
        return promptBox.textContent;
      }, recommended);
      stepBody.appendChild(aiActions.row);

      // 出力貼付エリア
      stepBody.appendChild(
        el('p', {
          style: 'font-size:11px;color:#475569;margin:6px 0 4px',
          text: 'AIの応答をここに貼り付けてください（コピペ）',
        })
      );
      const outputArea = el('textarea', {
        placeholder: 'AIの応答をここに貼り付け',
        style: 'width:100%;min-height:140px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:inherit;font-size:11px;resize:vertical',
	      });
	      stepBody.appendChild(outputArea);

	      const q2ValidationBox = el('div', {
	        style: 'margin-top:6px;background:#fff7ed;border:1px solid #fed7aa;border-radius:5px;padding:8px',
	      });
	      q2ValidationBox.hidden = true;
	      stepBody.appendChild(q2ValidationBox);

	      function runQ2FilteringValidation() {
	        const q2Filtering = window.SK_CORE && window.SK_CORE.q2Filtering;
	        if (!q2Filtering || !q2Filtering.validateQ2FilteringOutput) {
	          q2ValidationBox.hidden = true;
	          return { applies: false, ok: true, text: outputArea.value.trim() };
	        }
	        const result = q2Filtering.validateQ2FilteringOutput(outputArea.value, phase);
	        if (q2Filtering.renderQ2FilteringPreview) {
	          q2Filtering.renderQ2FilteringPreview(q2ValidationBox, result);
	        }
	        return result;
	      }

	      outputArea.addEventListener('input', function () {
	        runQ2FilteringValidation();
	      });
	      outputArea.addEventListener('blur', function () {
	        runQ2FilteringValidation();
	      });

	      // ボタン群
      const cycleBtn = el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '🔄 リサーチサイクルで深掘り',
        title: '1次→2次→[ファクトチェック]→統合 の4ステップでこのフェーズを掘る',
        on: {
          click: async function () {
            cycleBtn.disabled = true;
            cycleBtn.textContent = 'サイクル進行中…';
            try {
              const integrated = await runResearchCycleForPhase(
                stepBody,
                phase,
                prompt,
                runtimeCtx
              );
              if (integrated) {
                // R8: 既存の手入力がある場合は上書きせず追記、partial時は文言を変える
                if (outputArea.value && outputArea.value.trim()) {
                  const sep = integrated.partial
                    ? '\n\n---\n\n# リサーチサイクル部分結果（中断）\n'
                    : '\n\n---\n\n# リサーチサイクル統合結果\n';
                  outputArea.value = outputArea.value.trimEnd() + sep + integrated.text;
                } else {
                  outputArea.value = integrated.text;
                }
                if (integrated.partial) {
                  window.SK_CORE.showToast(
                    '中断時点の部分結果を反映しました。確認のうえ追記して進めてください',
                    false,
                    4000
                  );
                } else {
                  window.SK_CORE.showToast(
                    'リサーチサイクル完了。内容を確認して「次のフェーズへ」を押してください'
                  );
                }
              }
            } catch (e) {
              console.error('[STRATEGY-KIT] リサーチサイクルエラー:', e);
              window.SK_CORE.showToast('リサーチサイクル中にエラー。Google連携または Gemini API key を確認してください', true, 5000);
            } finally {
              cycleBtn.disabled = false;
              cycleBtn.textContent = '🔄 リサーチサイクルで深掘り';
            }
          },
        },
      });

      setCurrentLocationText(
        'いま §' + phase.no + ' を実行中',
        step && step.totalSubs > 1
          ? 'ステップ ' + step.subNo + '/' + step.totalSubs + ' の入力を待っています'
          : 'AIの出力貼り付けを待っています'
      );

      const nextBtn = el('button', {
        class: 'btn',
        type: 'button',
        text: '次のフェーズへ →',
        on: {
	          click: function () {
	            const text = outputArea.value.trim();
	            if (!text) {
	              window.SK_CORE.showToast('AIの出力を貼り付けてください', true);
	              return;
	            }
	            const q2Result = runQ2FilteringValidation();
	            if (q2Result.applies && !q2Result.ok) {
	              window.SK_CORE.showToast('5枠検証で不足があります。カテゴリとRICEを確認してください', true, 5000);
	              return;
	            }
	            const textWithQ2Appendix =
	              q2Result.applies &&
	              q2Result.appendix &&
	              text.indexOf('自動確認: 5枠選定') === -1
	                ? text + q2Result.appendix
	                : text;
	            nextBtn.disabled = true;
	            cycleBtn.disabled = true;
	            skipBtn.disabled = true;
	            cancelInChainBtn.disabled = true;
	            setChainStepState(container._skCurrentStep, 'pending', '保存中');
	            resolve({
	              text: textWithQ2Appendix,
	              aiUsed: aiActions.aiSelect.value,
	              stepUi: { card: stepCard, summaryEl: summaryEl, statusEl: statusEl, badgeEl: turnBadge },
	            });
          },
        },
      });

      const skipBtn = el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: 'スキップ',
        on: {
          click: function () {
            setChainStepState(container._skCurrentStep, 'pending', 'スキップ保存中');
            resolve({
              text: '（スキップ）',
              aiUsed: aiActions.aiSelect.value,
              stepUi: { card: stepCard, summaryEl: summaryEl, statusEl: statusEl, badgeEl: turnBadge },
            });
          },
        },
      });

      // R3: container 内のキャンセルボタン（画面が長くなって startBtn 隣のキャンセルが見えない場合の代替）
      const cancelInChainBtn = el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '✕ ここで中断（後で再開可）',
        style: 'font-size:11px;color:#b91c1c',
        on: {
          click: function () {
            if (ctrl) {
              ctrl.cancelled = true;
            }
            // resolve(null) は cancelCheckInterval が拾うので待つだけでよい
            cancelInChainBtn.disabled = true;
            cancelInChainBtn.textContent = '中断中…';
          },
        },
      });

      stepBody.appendChild(
        el(
          'div',
          { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
          nextBtn,
          cycleBtn,
          skipBtn,
          cancelInChainBtn
        )
      );
      stepBody.appendChild(
        el('div', {
          style: 'font-size:10px;color:#64748b;margin-top:8px',
          text: '完了済みステップは折りたたまれて残ります。画面上部の現在地バーで、今どこを実行中か確認できます。',
        })
      );
      stepCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setChainStepState(container._skCurrentStep, 'awaiting-input', '入力待ち');
    });
  }

  // ===========================================================
  // リサーチサイクル展開（フェーズ内サブシーケンス）
  //   1次 → 2次 → ファクトチェック（任意） → 統合
  //   各ステップで AI挿入＋出力貼付＋次へ
  //   完了時に統合結果を返す
  // ===========================================================
  async function runResearchCycleForPhase(container, phase, originalPrompt, runtimeCtx) {
    const rc = window.SK_CORE.getResearchCycle();
    if (!rc || !rc.steps || rc.steps.length < 2) {
      window.SK_CORE.showToast('リサーチサイクル定義がありません', true);
      return null;
    }

    // モーダル風のオーバーレイをcontainer内に挿入
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;

    const overlay = el('div', {
      style: 'border:2px solid #0f766e;border-radius:6px;padding:8px;margin-top:10px;background:#f0fdfa',
    });
    overlay.appendChild(
      el('div', {
        style: 'font-size:12px;font-weight:700;color:#0f766e;margin-bottom:6px',
        text: '🔄 リサーチサイクル展開（フェーズ' + phase.no + '）',
      })
    );
    container.appendChild(overlay);

    // R1/R4: 経過コンテキスト構築（蓄積済み章 + 初期入力 + 元のフェーズプロンプト）
    //   runtimeCtx は runSemiAuto から渡される { accumulated, formInputs }。
    //   未指定時は空オブジェクトで動作（フェーズタブから直接呼ばれた場合などの後方互換）
    const accumulated =
      (runtimeCtx && runtimeCtx.accumulated && typeof runtimeCtx.accumulated === 'object')
        ? runtimeCtx.accumulated
        : {};
    const formInputs =
      (runtimeCtx && runtimeCtx.formInputs && typeof runtimeCtx.formInputs === 'object')
        ? runtimeCtx.formInputs
        : null;

    // R4: テーマ構築時の業種/店舗ソースを applyTemplate と一貫させる（formInputs 優先 → settings）
    //     サイクル中の settings 変更による theme と applyTemplate の不整合を防ぐ
    const themeIndustry =
      (formInputs && formInputs.industry) ||
      window.SK_CORE.getState().settings.industryLabel ||
      '';
    const themeStore =
      (formInputs && formInputs.storeName) ||
      window.SK_CORE.getState().settings.storeName ||
      '';
    const theme =
      phase.title +
      '（業種: ' + themeIndustry +
      '／店舗: ' + themeStore + '）';

    // R3: §99 決定ログ取得（accumulated 優先 → Docs API 取得をフォールバック）
    //   - 半自動チェーンの accumulated['§99'] が存在すれば、そのサイクル中の最新人手調整を含む可能性が高いので最優先
    //   - 無ければ DRAFT / 章別記録 Docs から §99 を取得
    //   - 失敗してもリサーチ継続を止めない（ベストエフォート）。ただし observability のため warn は出す。
    let decisionLog = null;
    if (accumulated && accumulated['§99']) {
      decisionLog = String(accumulated['§99']).trim();
    } else {
      try {
        const { docsClient, decisionLog: decisionLogMod } = await loadDecisionLogDeps();
        const sec = await decisionLogMod.getDecisionLogText({
          storage: chrome.storage.sync,
          docs: { getDocument: docsClient.getDocument },
        });
        if (sec && sec.ok && sec.text && sec.text.trim()) {
          decisionLog = sec.text.trim();
        }
      } catch (e) {
        console.warn('[STRATEGY-KIT] §99 決定ログ取得失敗（リサーチサイクルは続行）:', e && e.message ? e.message : e);
      }
    }

    const cycleAccumulated = buildCycleAccumulated(accumulated, formInputs, originalPrompt, phase, decisionLog);

    // 各ステップを順次実行
    const stepOutputs = {};
    for (let i = 0; i < rc.steps.length; i++) {
      const step = rc.steps[i];

      // ファクトチェックは任意 → スキップ確認
      if (step.optional) {
        const doFactcheck = await confirmInOverlay(
          overlay,
          'ファクトチェック（任意）を実施しますか？',
          'はい（' + (step.estimatedMinutes || 10) + '分）',
          'スキップ',
          'サイクル中断'
        );
        if (doFactcheck === 'cancel') {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          window.SK_CORE.showToast('リサーチサイクルを中断しました', false, 2500);
          return null;
        }
        if (!doFactcheck) {
          stepOutputs[step.id] = '（実施せず）';
          continue;
        }
      }

      // ステップ実行（R1: cycleAccumulated を渡して経過注入する）
      const stepPrompt = buildCycleStepPrompt(step, theme, stepOutputs, originalPrompt, cycleAccumulated);
      const stepResult = await waitForCycleStep(overlay, step, stepPrompt, i + 1, rc.steps.length);
      if (stepResult === null) {
        // R8: キャンセル時、確定済み stepOutputs があれば部分結果として返す（受講生の作業損失防止）
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        const completedKeys = Object.keys(stepOutputs).filter(function (k) {
          return stepOutputs[k] && stepOutputs[k] !== '（実施せず）';
        });
        if (completedKeys.length > 0) {
          window.SK_CORE.showToast('リサーチサイクルを中断（' + completedKeys.length + '件の部分結果を反映）', false, 3500);
          const partialText = completedKeys
            .map(function (k) { return '## ' + k + '（部分結果）\n' + stepOutputs[k]; })
            .join('\n\n---\n\n');
          return { text: partialText, stepOutputs: stepOutputs, partial: true };
        }
        window.SK_CORE.showToast('リサーチサイクルを中断しました', false, 2500);
        return null;
      }
      stepOutputs[step.id] = stepResult.text;
    }

    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

    // 統合結果を返す
    const integratedText =
      stepOutputs['integrate'] ||
      Object.values(stepOutputs).join('\n\n---\n\n');
    return { text: integratedText, stepOutputs: stepOutputs };
  }

  // R1: リサーチサイクル用の蓄積コンテキストを組み立てる
  //   accumulated = { '§0': '…', '§1-1': '…', '§1': '…', '初期入力': '…' }
  //   formInputs = { industry, storeName, memo, context } | null
  //   originalPrompt = 元のフェーズプロンプト
  //   phase = 現フェーズ（自分自身は除外して『これまでの章』だけを残す）
  //   decisionLog = §99 決定ログのテキスト | null（R3）
  function buildCycleAccumulated(accumulated, formInputs, originalPrompt, phase, decisionLog) {
    const out = {};
    const settings = window.SK_CORE.getState().settings;

    // 1) 業種・店舗の事業設定（applyTemplate と同じソース）
    const industry =
      (formInputs && formInputs.industry) ||
      settings.industryLabel ||
      '';
    const storeName =
      (formInputs && formInputs.storeName) ||
      settings.storeName ||
      '';
    if (industry || storeName) {
      out['事業設定'] =
        '業種: ' + (industry || '未指定') +
        '\n店舗・屋号: ' + (storeName || '未指定');
    }

    // 2) ユーザー初期入力（現状メモ・追加コンテキスト）
    if (formInputs) {
      const lines = [];
      if (formInputs.memo) lines.push('現状メモ:\n' + formInputs.memo);
      if (formInputs.context) lines.push('追加コンテキスト:\n' + formInputs.context);
      if (lines.length) out['ユーザー初期入力'] = lines.join('\n\n');
    } else if (accumulated && accumulated['初期入力']) {
      out['ユーザー初期入力'] = accumulated['初期入力'];
    }

    // 3) これまでの章で確定した内容（自フェーズ自体は除外）
    //    - 半自動の accumulated は { '§0': '…', '§1': '…', '§1-1': '…', '初期入力': '…' }
    //    - 現在フェーズと同じ §N / §N-x は除外（自分自身を入れない）
    const currentNo = phase ? String(phase.no) : null;
    const sectionEntries = [];
    if (accumulated) {
      const keys = Object.keys(accumulated);
      // §0, §1, §2 ... の順に並べる（数値 → サブ）
      keys.sort(function (a, b) {
        const ma = a.match(/^§(\d+)(?:-(\d+))?/);
        const mb = b.match(/^§(\d+)(?:-(\d+))?/);
        if (!ma) return mb ? 1 : 0;
        if (!mb) return -1;
        const an = parseInt(ma[1], 10);
        const bn = parseInt(mb[1], 10);
        if (an !== bn) return an - bn;
        const asub = ma[2] ? parseInt(ma[2], 10) : 0;
        const bsub = mb[2] ? parseInt(mb[2], 10) : 0;
        return asub - bsub;
      });
      for (const k of keys) {
        if (!k.startsWith('§')) continue;
        // 自フェーズは除外
        if (currentNo) {
          const m = k.match(/^§(\d+)/);
          if (m && m[1] === currentNo) continue;
        }
        const text = accumulated[k];
        if (!text) continue;
        // 各章は要点圧縮（先頭1500字に丸めて文脈窓を圧迫しない）
        const trimmed = text.length > 1500 ? text.slice(0, 1500) + '…（以下省略）' : text;
        sectionEntries.push(k + '\n' + trimmed);
      }
    }
    if (sectionEntries.length) {
      out['これまでの章で確定した内容'] = sectionEntries.join('\n\n---\n\n');
    }

    // 4) §99 決定ログ（R3: これまでの決定事項）
  //   呼び出し側で accumulated['§99'] 優先 → Docs API フォールバックの順で
    //   decisionLog を解決済み。ここでは長さ調整だけ行う。
    if (decisionLog && typeof decisionLog === 'string' && decisionLog.trim()) {
      const decisionText = decisionLog.trim();
      // 長すぎる決定ログは末尾2000字に圧縮（直近の決定を優先したいので末尾基準）
      const trimmed = decisionText.length > 2000
        ? '…（前略）\n' + decisionText.slice(-2000)
        : decisionText;
      out['§99 これまでの決定事項'] = trimmed;
    }

    // 5) 元のフェーズプロンプト（このリサーチで何を解こうとしているか）
    if (originalPrompt) {
      out['元のフェーズの問い'] = originalPrompt;
    }

    return out;
  }

  // サイクル各ステップのプロンプト構築
  // R1: cycleAccumulated を末尾に展開して『これまでの経過』を必ずプロンプトに含める
  function buildCycleStepPrompt(step, theme, prevOutputs, originalPrompt, cycleAccumulated) {
    let body = step.body || '';
    body = body.replaceAll('★テーマ★', theme);
    body = body.replaceAll('★1次と同じテーマ★', theme);
    body = body.replaceAll(
      '★research-NN-primary.md を貼付★',
      prevOutputs.primary || '（未取得）'
    );
    body = body.replaceAll(
      '★research-NN-primary.md の内容を貼付★',
      prevOutputs.primary || '（未取得）'
    );
    body = body.replaceAll(
      '★research-NN-secondary.md を貼付★',
      prevOutputs.secondary || '（未取得）'
    );
    body = body.replaceAll(
      '★research-NN-secondary.md の内容を貼付★',
      prevOutputs.secondary || '（未取得）'
    );
    body = body.replaceAll(
      '★research-NN-factcheck.md を貼付（無ければ「実施せず」）★',
      prevOutputs.factcheck || '（実施せず）'
    );
    body = body.replaceAll(
      '★research-NN-factcheck.md を貼付★',
      prevOutputs.factcheck || '（実施せず）'
    );
    // ★業種★ ★店舗名★ ★テーマ★（一般版）など共通プレースホルダを置換
    if (window.SK_CORE && typeof window.SK_CORE.applyTemplate === 'function') {
      body = window.SK_CORE.applyTemplate(body);
    }

    // R2: 残存★トークンの最終ガード（検知してから置換）
    //   想定外の★...★（プロンプト定義変更時の取りこぼし／未知のプレースホルダ）が
    //   受講生のコピペにそのまま★付きで届かないよう「後段の経過参照」に置換する。
    //   不具合を隠さないように、置換前に残存トークンを console.warn で出す。
    //   buildSubPrompt と同じガード方針 + ログ。
    const leftoverStars = body.match(/★[^★\n]+★/g);
    if (leftoverStars && leftoverStars.length) {
      console.warn(
        '[STRATEGY-KIT] リサーチサイクル: 未置換★トークンを検出（最終ガードで置換します）:',
        step.id,
        leftoverStars
      );
      body = body.replace(
        /★[^★\n]+★/g,
        '（後段の【これまでの経過・コンテキスト】を参照）'
      );
    }

    // R1: 蓄積コンテキスト（事業設定 / 初期入力 / これまでの章 / 元のフェーズの問い）を末尾に展開
    //   1次→2次→ファクトチェック→統合 のどのステップでも文脈を持たせる
    //   originalPrompt は cycleAccumulated['元のフェーズの問い'] にも入っているので二重表示を避ける
    if (cycleAccumulated && Object.keys(cycleAccumulated).length) {
      const ctxBlock = Object.keys(cycleAccumulated)
        .map(function (k) {
          return '## ' + k + '\n' + cycleAccumulated[k];
        })
        .join('\n\n');
      body +=
        '\n\n---\n\n' +
        '【これまでの経過・コンテキスト】\n' +
        '※このリサーチは下記フェーズを掘り下げるための作業です。出力はこの問いに答える素材として使えるよう構成してください。\n\n' +
        ctxBlock;
    } else if (originalPrompt) {
      // フォールバック: cycleAccumulated 未供給時は元のフェーズプロンプトだけでも入れる
      body +=
        '\n\n---\n\n【元のフェーズの問い】\n' +
        '※このリサーチは下記フェーズを掘り下げるためのものです。出力はこの問いに答える素材として使えるよう構成してください。\n\n' +
        originalPrompt;
    }
    return body;
  }

  // サイクル1ステップ用のUIを overlay 内に出して、ユーザー入力を待つ
  function waitForCycleStep(overlay, step, prompt, stepNo, totalSteps) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;

    return new Promise(function (resolve) {
      // 既存のサブUIをクリア（タイトルだけ残す）
      while (overlay.children.length > 1) {
        overlay.removeChild(overlay.lastChild);
      }

      overlay.appendChild(
        el('div', {
          style: 'font-size:11px;font-weight:600;margin-bottom:4px',
          text: 'ステップ ' + stepNo + '/' + totalSteps + ': ' + step.label,
        })
      );

      const meta = el('div', {
        style: 'font-size:10px;color:#475569;margin-bottom:4px',
      });
      const altText =
        step.alternativeFor && step.alternativeFor.length
          ? '（推奨: ' + step.for + ' / 代替: ' + step.alternativeFor.join('・') + '）'
          : '（推奨: ' + step.for + '）';
      meta.textContent =
        '出力ファイル: ' + (step.outputFile || '?') + '　／　目安: ' + (step.estimatedMinutes || '?') + '分　' + altText;
      overlay.appendChild(meta);

      // R7: 受講生向けステップガイド（このステップで何をやるか・何を貼るか）
      const stepGuide = el('div', {
        style: 'background:#fef3c7;border:1px solid #fcd34d;border-radius:5px;padding:6px 10px;margin-bottom:6px;font-size:11px;color:#78350f;line-height:1.6',
      });
      stepGuide.appendChild(el('div', {
        style: 'font-weight:700;margin-bottom:2px',
        text: 'このステップの進め方',
      }));
      // ステップごとに「これまでの経過」が既にプロンプトに展開済みであることを明示
      const guidePrev = (step.id === 'primary')
        ? '前章までの経過は既にプロンプト末尾に展開済み（コピペするだけでOK）'
        : (step.id === 'secondary')
          ? '前章＋1次リサーチ出力が既に展開済み（追加貼付不要）'
          : (step.id === 'factcheck')
            ? '前章＋1次・2次の出力が既に展開済み（追加貼付不要）'
            : '前章＋1次・2次・ファクトチェック出力が既に展開済み（追加貼付不要）';
      stepGuide.appendChild(el('div', {
        style: 'color:#0f766e;font-weight:600',
        text: '✓ ' + guidePrev,
      }));
      stepGuide.appendChild(el('div', { text: '① 「挿入」で推奨AI（' + (step.for || 'claude') + '）のタブを開いて自動挿入（または「コピー」）' }));
      stepGuide.appendChild(el('div', { text: '② AI の応答をコピーして下の貼付欄へ' }));
      stepGuide.appendChild(el('div', { text: '③ 「このステップ完了 →」を押して次へ' }));
      overlay.appendChild(stepGuide);

      const promptBox = el('div', {
        style: 'background:#fff;border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;font-size:10px;white-space:pre-wrap;max-height:140px;overflow:auto;margin-bottom:6px;font-family:monospace',
        text: prompt,
      });
      overlay.appendChild(promptBox);

      const aiActions = buildAiActionRow(function () {
        return promptBox.textContent;
      }, step.for);
      overlay.appendChild(aiActions.row);

      overlay.appendChild(
        el('p', {
          style: 'font-size:11px;color:#475569;margin:6px 0 4px',
          text: 'AIの応答をここに貼り付け',
        })
      );
      const outputArea = el('textarea', {
        placeholder: 'AIの応答をここに貼り付け',
        style: 'width:100%;min-height:120px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:inherit;font-size:11px;resize:vertical',
      });
      overlay.appendChild(outputArea);
      overlay.appendChild(
        el('p', {
          style: 'font-size:10px;color:#64748b;margin:6px 0 0;line-height:1.6',
          text: '貼り付け前に軽く整えても構いません。途中中断しても、ここまで確定したステップは部分結果として引き継げます。',
        })
      );

      const nextBtn = el('button', {
        class: 'btn',
        text: 'このステップ完了 →',
        on: {
          click: function () {
            const text = outputArea.value.trim();
            if (!text) {
              window.SK_CORE.showToast('AIの出力を貼り付けてください', true);
              return;
            }
            resolve({ text: text, aiUsed: aiActions.aiSelect.value });
          },
        },
      });

      const cancelBtn = el('button', {
        class: 'btn btn-ghost',
        text: 'サイクル中断',
        on: {
          click: function () {
            resolve(null);
          },
        },
      });

      overlay.appendChild(
        el(
          'div',
          { style: 'display:flex;gap:6px;margin-top:6px' },
          nextBtn,
          cancelBtn
        )
      );
    });
  }

  // overlay内に確認ダイアログを表示
  function confirmInOverlay(overlay, message, yesText, noText, cancelText) {
    const el = window.SK_CORE.el;
    return new Promise(function (resolve) {
      while (overlay.children.length > 1) {
        overlay.removeChild(overlay.lastChild);
      }

      overlay.appendChild(
        el('p', {
          style: 'font-size:12px;margin:6px 0',
          text: message,
        })
      );

      const yesBtn = el('button', {
        class: 'btn',
        text: yesText,
        on: { click: function () { resolve(true); } },
      });
      const noBtn = el('button', {
        class: 'btn btn-ghost',
        text: noText,
        on: { click: function () { resolve(false); } },
      });
      const buttons = [yesBtn, noBtn];
      if (cancelText) {
        const cancelBtn = el('button', {
          class: 'btn btn-ghost',
          text: cancelText,
          on: { click: function () { resolve('cancel'); } },
        });
        buttons.push(cancelBtn);
      }
      overlay.appendChild(
        el(
          'div',
          { style: 'display:flex;gap:6px;margin-top:4px;flex-wrap:wrap' },
          ...buttons
        )
      );
    });
  }

  // DRAFTドキュメント情報表示
  function showDraftInfo(container, draftRes) {
    const el = window.SK_CORE.el;
    container.classList.remove('hidden');
    window.SK_CORE.clearChildren(container);
    container.appendChild(
      el('div', {
        style: 'background:#ccfbf1;border:1px solid #14b8a6;border-radius:5px;padding:8px',
      },
        el('div', { style: 'font-size:11px;font-weight:600;margin-bottom:4px', text: '📄 DRAFT版マスタードキュメントを作成しました' }),
        el('div', { style: 'font-size:10px;color:#0f172a;margin-bottom:4px', text: draftRes.title || '' }),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'DRAFTを開く',
          style: 'font-size:11px',
          on: {
            click: function () {
              chrome.tabs.create({ url: draftRes.draftDocUrl });
            },
          },
        })
      )
    );
  }

  function showMasterInfo(container, masterRes) {
    const el = window.SK_CORE.el;
    container.classList.remove('hidden');
    window.SK_CORE.clearChildren(container);
    const children = [
      el('div', { style: 'font-size:11px;font-weight:600;margin-bottom:4px', text: '📄 マスター本体へ保存します' }),
      el('div', { style: 'font-size:10px;color:#0f172a;margin-bottom:4px', text: masterRes.title || '' }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: 'マスターを開く',
        style: 'font-size:11px',
        on: {
          click: function () {
            chrome.tabs.create({ url: masterRes.masterDocUrl });
          },
        },
      }),
    ];
    if (masterRes.backup && masterRes.backup.docUrl) {
      children.push(el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: 'バックアップを開く',
        style: 'font-size:11px;margin-left:6px',
        on: {
          click: function () {
            chrome.tabs.create({ url: masterRes.backup.docUrl });
          },
        },
      }));
    }
    container.appendChild(
      el('div', {
        style: 'background:#eff6ff;border:1px solid #60a5fa;border-radius:5px;padding:8px',
      }, ...children)
    );
  }

  // 自動化状態を保存
  function saveAutomationState(phaseIndex, accumulated, mode) {
    if (!window.SK_STATE) return;
    const ctx = JSON.stringify(accumulated);
    // 100KB 超の場合は truncate
    const truncated = ctx.length > 100000 ? ctx.slice(0, 100000) : ctx;
    window.SK_STATE.save('automation.state', {
      phaseIndex: phaseIndex,
      mode: mode || 'semi',
      accumulatedJson: truncated,
      savedAt: Date.now(),
    });
  }

  // 自動化状態をクリア
  function clearAutomationState() {
    if (!window.SK_STATE) return;
    window.SK_STATE.save('automation.state', null);
  }

  // 前回の自動化進捗（中断再開）を復元する。
  //   修正A: 二重構築・二重復元を防ぐため slot.dataset.skResumeRestored で1回だけ実行。
  async function restoreSavedAutomationState_(slot) {
    if (slot.dataset.skResumeRestored === '1') return;
    slot.dataset.skResumeRestored = '1';

    // 前回の自動化進捗を確認
    //   v0.9.13: phaseIndex は数値 or 文字列（'3-2'）。文字列ケースは < 0 で弾けないので type で判定
    if (!window.SK_STATE) return;
    const savedState = await window.SK_STATE.load('automation.state', null);
    if (!savedState || savedState.phaseIndex === undefined || savedState.phaseIndex === null) return;
    if (typeof savedState.phaseIndex === 'number' && savedState.phaseIndex < 0) return;
    if (typeof savedState.phaseIndex === 'string' && savedState.phaseIndex === '') return;

    // 24時間以内の保存のみ再開対象
    const age = Date.now() - (savedState.savedAt || 0);
    if (age > 24 * 60 * 60 * 1000) {
      clearAutomationState();
      return;
    }

    if (slot._skResume) {
      slot._skResume.set('paused', savedState.phaseIndex, {
        mode: savedState.mode || 'semi',
        accumulatedJson: savedState.accumulatedJson || '{}',
      });
    }

    var radioFull = slot.querySelector('input[value="full"]');
    var radioSemi = slot.querySelector('input[value="semi"]');
    if (savedState.mode === 'full') {
      if (radioFull) radioFull.checked = true;
    } else {
      if (radioSemi) radioSemi.checked = true;
    }
    if (savedState.mode === 'full' && radioFull) {
      radioFull.dispatchEvent(new Event('change'));
    } else if (radioSemi) {
      radioSemi.dispatchEvent(new Event('change'));
    }

    const toastIdx = String(savedState.phaseIndex);
    window.SK_CORE.showToast('中断点を検出しました。実行ボタンは §' + toastIdx + ' から続行します', false, 4000);
  }

  // 修正A: OAuth 連携済みなら自動化スロットを構築・復元する（冪等）。
  //   連携が取れていなければ hidden のまま何もしない。
  //   連携後に自動化タブをアクティブにした／options 側で連携した（storage 変化）タイミングから
  //   再評価され、拡張のリロード無しで有効になる。
  let automationInitInFlight = null;
  async function initAutomationSlot() {
    const slot = document.getElementById('mod-automation-slot');
    if (!slot) return false;
    // 二重構築防止: 既に構築済みなら再評価しない
    if (slot.dataset.skBuilt === '1') return true;
    // 並行呼び出しのデデュープ（タブ切替 + storage 変化が同時に来ても1回だけ）
    if (automationInitInFlight) return automationInitInFlight;

    automationInitInFlight = (async function () {
      const ready = await isOAuthReady();
      if (!ready) return false;
      // await 中に別経路が構築を終えている可能性に備えて再チェック
      if (slot.dataset.skBuilt === '1') return true;
      slot.dataset.skBuilt = '1';
      slot.classList.remove('hidden');
      buildUI(slot);
      await restoreSavedAutomationState_(slot);
      return true;
    })();

    try {
      return await automationInitInFlight;
    } finally {
      automationInitInFlight = null;
    }
  }

  // sidepanel から連携検知時に呼べる公開 API
  window.SK_AUTOMATION = window.SK_AUTOMATION || {};
  window.SK_AUTOMATION.ensureReady = initAutomationSlot;
  window.SK_AUTOMATION.setMode = function (mode, options) {
    const slot = document.getElementById('mod-automation-slot');
    if (!slot || typeof slot._skSetExecutionMode !== 'function') return false;
    slot._skSetExecutionMode(mode, options || {});
    return true;
  };
  window.SK_AUTOMATION.getMode = function () {
    const slot = document.getElementById('mod-automation-slot');
    if (!slot || typeof slot._skGetExecutionMode !== 'function') return null;
    return slot._skGetExecutionMode();
  };
  // 実行中かどうかの唯一の真実。タスク監視スナップショットは 10 分で失効するため、
  // 半自動で受講者が長く考えていると「停止した」と誤判定される。
  window.SK_AUTOMATION.isRunning = function () {
    const slot = document.getElementById('mod-automation-slot');
    if (!slot || typeof slot._skIsRunning !== 'function') return false;
    return slot._skIsRunning();
  };
  window.SK_AUTOMATION.runFromPhase = async function (phaseNo, options) {
    const ready = await initAutomationSlot();
    const slot = document.getElementById('mod-automation-slot');
    if (!ready || !slot || typeof slot._skRunFromPhase !== 'function') {
      throw new Error('自動化を利用できません');
    }
    return slot._skRunFromPhase(phaseNo, options || {});
  };

  // core-ready 後に初期化（連携済みのときだけ構築）
  window.SK_CORE.on('core-ready', function () {
    initAutomationSlot();
  });
})();
