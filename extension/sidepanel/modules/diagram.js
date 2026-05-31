// STRATEGY-KIT v0.9 — 図解生成モジュール
// 役割:
//   DRAFT / 原本マスター / 手動入力を元に、HTMLカード中心の図解を生成する
//   生成は AI（Gemini API or 手動 AI挿入）経由
//   Mermaid は上級者向けの後方互換として残す

(function () {
  let diagramTypes = null;
  let diagramStylesInjected = false;

  const SELECT_FORCE_STYLE = 'width:100%;display:block;min-height:32px;white-space:normal;appearance:auto;-webkit-appearance:menulist;box-sizing:border-box;';
  const CARD_FORMAT_PREFIX = 'html-card-';
  const EXPERT_GROUP_LABEL = '上級者向け（Mermaid）';
  const NOTEBOOKLM_SOURCE_BASENAME = 'notebooklm-source-all';
  const NOTEBOOKLM_SOURCE_CHOICES = [
    { value: 'draft', label: 'DRAFT' },
    { value: 'master', label: 'master document' },
    { value: 'chapter', label: 'chapter record' },
  ];

  async function loadDiagramTypes() {
    if (diagramTypes) return diagramTypes;
    try {
      const res = await fetch(chrome.runtime.getURL('data/diagram-types.json'));
      diagramTypes = await res.json();
    } catch (e) {
      console.error('[STRATEGY-KIT][diagram] diagram-types.json load failed:', e);
      diagramTypes = { diagrams: [] };
    }
    return diagramTypes;
  }

  function ensureDiagramStyles() {
    if (diagramStylesInjected) return;
    const href = chrome.runtime.getURL('sidepanel/modules/diagram.css');
    if (document.querySelector('link[data-sk-diagram-style="1"]')) {
      diagramStylesInjected = true;
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.skDiagramStyle = '1';
    link.addEventListener('error', function (e) {
      console.error('[STRATEGY-KIT][diagram] diagram.css load failed:', e);
    });
    document.head.appendChild(link);
    diagramStylesInjected = true;
  }

  function isHtmlCardFormat(format) {
    return typeof format === 'string' && format.indexOf(CARD_FORMAT_PREFIX) === 0;
  }

  function normalizeSectionNo(value) {
    return String(value || '').replace(/[^0-9]/g, '');
  }

  function buildSectionIndex(sections) {
    const map = new Map();
    (sections || []).forEach(function (section) {
      const no = normalizeSectionNo(section && section.no);
      if (!no) return;
      map.set(no, section);
    });
    return map;
  }

  function buildJoinedSource(parts, sourceLabel) {
    if (!parts.length) {
      return '（' + sourceLabel + 'から該当章を取得できませんでした）';
    }
    return parts.join('\n\n---\n\n');
  }

  async function getDiagramDocumentId(source) {
    const stored = await chrome.storage.sync.get([
      'sk_draft_doc_v012',
      'sk_chapter_doc_v012',
      'sk_master_doc_v012',
    ]);
    if (source === 'draft') {
      return (
        stored.sk_draft_doc_v012?.documentId ||
        stored.sk_chapter_doc_v012?.documentId ||
        null
      );
    }
    if (source === 'chapter') {
      return stored.sk_chapter_doc_v012?.documentId || null;
    }
    return stored.sk_master_doc_v012?.documentId || null;
  }

  async function fetchSectionsFromDocs(sectionNos, source) {
    const documentId = await getDiagramDocumentId(source);
    if (!documentId) {
      return { parts: [], foundNos: [], missingNos: sectionNos.map(normalizeSectionNo).filter(Boolean) };
    }

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const [docsMod, sectionsMod] = await Promise.all([import(docsUrl), import(sectionsUrl)]);
    const doc = await docsMod.getDocument(documentId);
    const parts = [];
    const foundNos = [];
    const missingNos = [];

    for (const noWithPrefix of sectionNos) {
      const no = normalizeSectionNo(noWithPrefix);
      if (!no) continue;
      const result = sectionsMod.getSectionText(doc, Number(no), { allowLastSectionNo: 99 });
      if (result.status === 'ok' && result.text.trim()) {
        parts.push('## §' + no + '\n\n' + result.text.trim());
        foundNos.push(no);
      } else {
        missingNos.push(no);
      }
    }

    return { parts: parts, foundNos: foundNos, missingNos: missingNos };
  }

  // 該当章のテキストを Docs API から取得
  // source: 'master' (原本) | 'draft' (DRAFT版)
  async function fetchSourceText(sectionNos, source) {
    const requestedSource = source === 'draft' ? 'draft' : 'master';
    const sourceLabel = requestedSource === 'draft' ? 'DRAFT版' : '原本マスター';

    const fromRequested = await fetchSectionsFromDocs(sectionNos, requestedSource);
    if (fromRequested.parts.length) {
      return {
        text: buildJoinedSource(fromRequested.parts, sourceLabel),
        sourceUsed: requestedSource,
        requestedSource: requestedSource,
        notice: fromRequested.missingNos.length
          ? sourceLabel + 'の一部章（§' + fromRequested.missingNos.join('・§') + '）は取得できませんでした。'
          : '',
        fallbackUsed: false,
        missingSections: fromRequested.missingNos,
      };
    }

    if (requestedSource === 'draft') {
      const masterFallback = await fetchSectionsFromDocs(sectionNos, 'master');
      if (masterFallback.parts.length) {
        return {
          text: buildJoinedSource(masterFallback.parts, '原本マスター'),
          sourceUsed: 'master',
          requestedSource: requestedSource,
          notice: 'ドラフト本文を取得できなかったため、マスタードキュメントへフォールバックしました。必要なら元データを「マスタードキュメント」に切り替えてください。',
          fallbackUsed: true,
          missingSections: masterFallback.missingNos,
        };
      }
    }

    return {
      text: '（' + sourceLabel + 'から該当章を取得できませんでした）',
      sourceUsed: requestedSource,
      requestedSource: requestedSource,
      notice: requestedSource === 'draft'
        ? 'DRAFT本文を取得できませんでした。原本マスターも取得できなかったため、図解生成を継続できません。'
        : sourceLabel + 'から本文を取得できませんでした。',
      fallbackUsed: false,
      missingSections: sectionNos.map(normalizeSectionNo).filter(Boolean),
    };
  }

  function buildDiagramPrompt(diagram, sourceInfo) {
    const sourceText = typeof sourceInfo === 'string' ? sourceInfo : (sourceInfo && sourceInfo.text) || '';
    let body = window.SK_CORE.applyTemplate(diagram.body || '');
    body = body.replaceAll('★貼付★', sourceText);
    body = body.replaceAll('★sourceText★', sourceText);
    body = body.replace(/★[^★\n]+★/g, '（後段の元データ参照）');
    body += '\n\n---\n\n【元データ】\n\n' + sourceText;
    if (sourceInfo && sourceInfo.requestedSource && sourceInfo.sourceUsed && sourceInfo.requestedSource !== sourceInfo.sourceUsed) {
      body += '\n\n【補足】\nDRAFT取得に失敗したため、今回は原本マスターを参照しています。';
    }
    return body;
  }

  function getDefaultNotebookLmPhases() {
    const phases = (window.SK_CORE.getPhases && window.SK_CORE.getPhases()) || [];
    return phases.map(function (phase, index) {
      const no = normalizeSectionNo(phase.no || phase.id || String(index));
      return {
        no: no,
        title: phase.title || phase.label || 'Phase ' + no,
      };
    }).filter(function (phase) {
      const n = Number(phase.no);
      return Number.isInteger(n) && n >= 0 && n <= 9;
    }).sort(function (a, b) {
      return Number(a.no) - Number(b.no);
    });
  }

  function getProjectInfoForExport(sourceUsed) {
    const state = (window.SK_CORE.getState && window.SK_CORE.getState()) || {};
    const settings = state.settings || {};
    const industry = settings.industryLabel ||
      ((state.industries && state.industries.items || []).find(function (item) {
        return item.id === settings.industry;
      }) || {}).label ||
      '';
    return {
      industry: industry || '未設定',
      storeName: settings.storeName || settings.caseName || '未設定',
      sourceUsed: getNotebookLmSourceLabel(sourceUsed),
    };
  }

  function getNotebookLmSourceLabel(sourceUsed) {
    if (sourceUsed === 'master') return 'master document';
    if (sourceUsed === 'chapter') return 'chapter record';
    return 'DRAFT';
  }

  async function getStoredMasterDocUrlForExport() {
    const stored = await chrome.storage.sync.get(['sk_master_doc_v012']);
    const info = stored.sk_master_doc_v012 || null;
    if (!info || !info.documentId) return '';
    return info.docUrl || 'https://docs.google.com/document/d/' + encodeURIComponent(info.documentId) + '/edit';
  }

  function formatCompactTimestamp(date) {
    const pad = function (value) { return String(value).padStart(2, '0'); };
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
    ].join('');
  }

  function buildNotebookLmSourceMarkdown(bundle) {
    const exportedAt = bundle.exportedAt || new Date().toISOString();
    const project = bundle.project || {};
    const sections = bundle.sections || [];
    const lines = [
      '---',
      'strategyKitVersion: "0.12.0"',
      'exportType: "notebooklm-source"',
      'sourceUsed: "' + (bundle.sourceUsed || 'draft') + '"',
      'exportedAt: "' + exportedAt + '"',
      'phaseScope: "all"',
      '---',
      '',
      '# STRATEGY-KIT NotebookLM Source Pack',
      '',
      '## 使い方',
      '',
      'このファイルを NotebookLM の source として追加してください。',
      'Studio の Slide Deck 生成では、末尾の「Studio で使えるプロンプト集」から用途に合う prompt を選んで貼り付けます。',
      '',
      '## Project',
      '',
      '| key | value |',
      '|---|---|',
      '| 業種 | ' + project.industry + ' |',
      '| 店舗・屋号 | ' + project.storeName + ' |',
      '| source | ' + project.sourceUsed + ' |',
      '',
      '## Phase Index',
      '',
      '| phase | title | char_count | source_status |',
      '|---|---|---:|---|',
    ];

    sections.forEach(function (section) {
      lines.push('| §' + section.no + ' | ' + section.title + ' | ' + section.charCount + ' | ' + section.status + ' |');
    });

    sections.forEach(function (section) {
      lines.push(
        '',
        '---',
        '',
        '## §' + section.no + ' ' + section.title,
        '',
        section.text || '（未記入）'
      );
    });

    lines.push(
      '',
      '---',
      '',
      '## ⚙️ Studio で使えるプロンプト集',
      '',
      'NotebookLM にこの source を追加したあと、Studio の Slide Deck で以下の prompt を貼ってください。',
      '',
      '### Presenter Slides',
      '',
      '```text',
      bundle.studioPrompt || buildNotebookLmStudioPrompt(project),
      '```',
      '',
      '### Detailed Deck にしたい場合',
      '',
      'Presenter Slides ではなく単体で読ませる資料にしたい場合は、prompt 内の "Presenter Slides" を "Detailed Deck" に置き換えてください。'
    );

    return lines.join('\n');
  }

  function buildNotebookLmStudioPrompt(project) {
    const projectName = project && project.storeName && project.storeName !== '未設定'
      ? project.storeName
      : 'この事業';
    return [
      '# NotebookLM Studio Slide Deck Prompt',
      '',
      'Create a Japanese slide deck from the uploaded STRATEGY-KIT source.',
      '',
      'Audience:',
      '- 職業訓練マーケティング戦略講座の受講者',
      '- 事業者や支援者に説明できる完成資料を作る',
      '',
      'Format:',
      '- Slide Deck',
      '- Presenter Slides',
      '- Japanese',
      '- Default length',
      '- Clean business presentation style',
      '',
      'Deck structure:',
      '1. 表紙: ' + projectName + '、業種、戦略テーマ',
      '2. 現状整理: 市場・顧客・競合の要点',
      '3. 主要課題: いちばん詰まっているポイント',
      '4. 戦略方針: 誰に、何を、なぜ選ばれる形で届けるか',
      '5. ペルソナ / 価値設計: 受け手の具体像と選ばれる理由',
      '6. 施策 5 枠: Quick Win 1 / Quick Win 2 / 地道 / 中長期 / 最悪',
      '7. KPI / PDCA: 見る指標、運用頻度、改善サイクル',
      '8. 次の 14 日間: 最初にやる行動',
      '9. まとめ: この戦略の勝ち筋',
      '',
      'Rules:',
      '- Use only the uploaded source.',
      '- Do not invent financial numbers, competitor names, or customer facts.',
      '- Keep Japanese text readable in slides.',
      '- Prefer tables, diagrams, and short bullets.',
      '- If a section is missing, mark it as "未記入" instead of inventing content.',
      '',
      'Alternative:',
      '単体で読ませる資料にしたい場合は、NotebookLM 側で Detailed Deck を選び、prompt の "Presenter Slides" を "Detailed Deck" に置き換えてください。',
    ].join('\n');
  }

  async function fetchNotebookLmSectionsFromDocs(phases, source) {
    const documentId = await getDiagramDocumentId(source);
    if (!documentId) {
      return {
        foundCount: 0,
        sections: phases.map(function (phase) {
          return {
            no: phase.no,
            title: phase.title,
            text: '',
            charCount: 0,
            status: 'missing',
          };
        }),
      };
    }

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const [docsMod, sectionsMod] = await Promise.all([import(docsUrl), import(sectionsUrl)]);
    const doc = await docsMod.getDocument(documentId);
    let foundCount = 0;
    const sections = phases.map(function (phase) {
      const result = sectionsMod.getSectionText(doc, Number(phase.no), { allowLastSectionNo: 99 });
      const text = result.status === 'ok' ? String(result.text || '').trim() : '';
      if (text) foundCount += 1;
      return {
        no: phase.no,
        title: phase.title,
        text: text,
        charCount: text.length,
        status: text ? 'ok' : 'missing',
      };
    });
    return { foundCount: foundCount, sections: sections };
  }

  async function fetchNotebookLmSourceBundle(sourceChoice) {
    const phases = getDefaultNotebookLmPhases();
    if (!phases.length) throw new Error('NotebookLM export 対象のフェーズが見つかりません');

    const exportedAt = new Date();
    const sourceUsed = ['master', 'draft', 'chapter'].includes(sourceChoice) ? sourceChoice : 'draft';
    const sourceResult = await fetchNotebookLmSectionsFromDocs(phases, sourceUsed);
    if (!sourceResult.foundCount) {
      throw new Error(getNotebookLmSourceLabel(sourceUsed) + ' から章本文を取得できません。source 選択を変えるか、先に DRAFT / 章別記録を作成してください');
    }

    const project = getProjectInfoForExport(sourceUsed);
    const stamp = formatCompactTimestamp(exportedAt);
    const bundle = {
      exportedAt: exportedAt.toISOString(),
      sourceUsed: sourceUsed,
      notice: getNotebookLmSourceLabel(sourceUsed) + ' から NotebookLM source を作成しました（Studio prompt は source 末尾に含まれます）',
      project: project,
      sections: sourceResult.sections,
      masterDocUrl: await getStoredMasterDocUrlForExport(),
      sourceFileName: NOTEBOOKLM_SOURCE_BASENAME + '-' + stamp + '.md',
    };
    bundle.studioPrompt = buildNotebookLmStudioPrompt(project);
    bundle.sourceMarkdown = buildNotebookLmSourceMarkdown(bundle);
    return bundle;
  }

  async function copyTextWithManualFallback(text, fallbackArea, statusEl, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      if (statusEl) statusEl.textContent = successMessage || 'コピーしました';
      window.SK_CORE.showToast(successMessage || 'コピーしました');
    } catch (e) {
      if (fallbackArea) fallbackArea.classList.remove('hidden');
      if (statusEl) statusEl.textContent = '自動コピーできませんでした。下の内容を選択してコピーしてください';
      window.SK_CORE.showToast('自動コピーできませんでした。手動コピーしてください', true);
    }
  }

  async function copyNotebookLmPackage(bundle, mode, fallbackArea, statusEl) {
    const text = mode === 'master-url'
      ? bundle.masterDocUrl
      : bundle.sourceMarkdown;
    if (mode === 'master-url' && !text) {
      if (statusEl) statusEl.textContent = 'master document URL が未設定です';
      window.SK_CORE.showToast('master document URL が未設定です', true);
      return;
    }
    await copyTextWithManualFallback(text, fallbackArea, statusEl, 'コピーしました');
  }

  async function saveNotebookLmPackageToDrive(bundle) {
    const driveUrl = chrome.runtime.getURL('phase0/drive-client.js');
    const drive = await import(driveUrl);
    const sourceFile = await drive.createMultipartFile({
      name: bundle.sourceFileName,
      mimeType: 'text/markdown',
      content: bundle.sourceMarkdown,
      appProperties: {
        skType: 'notebooklm-export',
        skVersion: 'v012',
        exportType: 'source',
      },
    });
    return { sourceFile: sourceFile };
  }

  function renderNotebookLmExportResult(container, bundle) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;
    clear(container);

    const statusEl = el('p', {
      class: 'muted-note',
      text: bundle.notice || 'NotebookLM source を作成しました（Studio prompt は source 末尾に含まれます）',
    });
    container.appendChild(statusEl);

    const actions = el('div', {
      class: 'sk-notebooklm-export-actions',
      style: 'display:flex;gap:6px;flex-wrap:wrap;margin:8px 0',
    });
    const fallbackArea = el('textarea', {
      class: 'hidden',
      style: 'width:100%;min-height:120px;box-sizing:border-box;margin:6px 0;padding:8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;font-family:monospace',
      value: bundle.sourceMarkdown,
    });

    [
      ['NotebookLM source をコピー', 'source'],
      ['master document URL をコピー', 'master-url'],
    ].forEach(function (item) {
      actions.appendChild(el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: item[0],
        on: {
          click: function (event) {
            event.preventDefault();
            event.stopPropagation();
            copyNotebookLmPackage(bundle, item[1], fallbackArea, statusEl);
          },
        },
      }));
    });

    const driveSaveBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Drive に .md 保存',
      on: {
        click: async function (event) {
          event.preventDefault();
          event.stopPropagation();
          driveSaveBtn.disabled = true;
          statusEl.textContent = 'Drive 保存中...';
          try {
            const files = await saveNotebookLmPackageToDrive(bundle);
            statusEl.textContent = 'Drive 保存しました: ' + files.sourceFile.name;
            window.SK_CORE.showToast('Drive に source Markdown を保存しました', false, 4000);
          } catch (e) {
            statusEl.textContent = 'Drive保存に失敗しました。コピーで続行できます: ' + e.message;
            window.SK_CORE.showToast('Drive保存に失敗しました', true);
          } finally {
            driveSaveBtn.disabled = false;
          }
        },
      },
    });
    actions.appendChild(driveSaveBtn);

    container.appendChild(actions);
    container.appendChild(fallbackArea);

    const sourceArea = el('textarea', {
      style: 'width:100%;min-height:180px;box-sizing:border-box;margin:6px 0;padding:8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;font-family:monospace',
      value: bundle.sourceMarkdown,
    });
    container.appendChild(el('p', { class: 'muted-note', text: bundle.sourceFileName }));
    container.appendChild(sourceArea);
  }

  function renderNotebookLmExportBlock(slot) {
    const el = window.SK_CORE.el;
    const section = el('section', {
      class: 'sk-notebooklm-export',
      style: 'border:1px solid #dbeafe;background:#eff6ff;border-radius:8px;padding:10px 12px;margin:8px 0 14px',
    });
    section.appendChild(el('h3', {
      style: 'font-size:13px;margin:0 0 4px;color:#1d4ed8',
      text: 'NotebookLM 半自動エクスポート',
    }));
    section.appendChild(el('p', {
      class: 'muted-note',
      text: 'master document / DRAFT / chapter record から選んだ source.md を作成します。Studio prompt は source の末尾に入ります。',
    }));
    section.appendChild(el('p', {
      class: 'muted-note',
      text: 'NotebookLM では Studio パネルの「Slide Deck」を使います。最初は Presenter Slides / Japanese / Default length を選んでください。',
    }));
    section.appendChild(el('p', {
      class: 'muted-note',
      text: '単体で読ませる資料にしたい場合だけ Detailed Deck を選びます。',
    }));
    section.appendChild(el('p', {
      class: 'muted-note',
      text: 'source保存名: notebooklm-source-all-YYYYMMDD-HHmm.md',
    }));

    const sourceChoice = el('select', {
      class: 'sk-notebooklm-source-choice',
      style: SELECT_FORCE_STYLE,
    });
    NOTEBOOKLM_SOURCE_CHOICES.forEach(function (choice) {
      sourceChoice.appendChild(el('option', { value: choice.value, text: choice.label }));
    });
    sourceChoice.value = 'draft';
    section.appendChild(el('label', { class: 'form-row' },
      el('span', { class: 'form-label', text: 'NotebookLM source 選択' }),
      sourceChoice
    ));

    const result = el('div', { style: 'margin-top:8px' });
    const button = el('button', {
      class: 'btn',
      type: 'button',
      text: 'NotebookLM 用パッケージを書き出す',
      on: {
        click: async function (event) {
          event.preventDefault();
          event.stopPropagation();
          button.disabled = true;
          button.textContent = '取得中...';
          window.SK_CORE.clearChildren(result);
          result.appendChild(el('p', { class: 'muted-note', text: '取得中...' }));
          try {
            const bundle = await fetchNotebookLmSourceBundle(sourceChoice.value);
            renderNotebookLmExportResult(result, bundle);
          } catch (e) {
            window.SK_CORE.clearChildren(result);
            result.appendChild(el('p', {
              class: 'sk-diagram-inline-notice is-warn',
              text: e.message,
            }));
            window.SK_CORE.showToast('NotebookLM export 失敗: ' + e.message, true);
          } finally {
            button.disabled = false;
            button.textContent = 'NotebookLM 用パッケージを書き出す';
          }
        },
      },
    });
    section.appendChild(button);
    section.appendChild(result);
    slot.appendChild(section);
  }

  function buildImageDiagramPrompt(diagram, sourceInfo) {
    const types = diagramTypes || { imageGeneration: { stylePresets: {}, promptTemplate: '' } };
    const ig = types.imageGeneration || { stylePresets: {}, promptTemplate: '' };
    const sourceText = typeof sourceInfo === 'string' ? sourceInfo : (sourceInfo && sourceInfo.text) || '';
    const styleDesc = (ig.stylePresets && ig.stylePresets.presentation) || 'プレゼン資料向け。要点を大きく、視線誘導がはっきりした構成';
    const hint = diagram.imagePromptHint || diagram.label || '戦略図解';
    let prompt = ig.promptTemplate || [
      '以下の戦略内容を、{{HINT}} として1枚の図版に整形してください。',
      '',
      '【スタイル】',
      '{{STYLE}}',
      '',
      '【構造データ】',
      '{{CONTENT}}',
    ].join('\n');
    prompt = prompt
      .replaceAll('{{HINT}}', hint)
      .replaceAll('{{STYLE}}', styleDesc)
      .replaceAll('{{CONTENT}}', sourceText);
    return [
      prompt,
      '',
      '【追加ルール】',
      '- 1枚のPNG画像として成立する構図にしてください。',
      '- 日本語文字は大きく、誤字脱字なし。',
      '- 図版内に不要な説明文やAIの注釈を入れない。',
      '- 画像生成は1回だけ行います。複数案は出さないでください。',
    ].join('\n');
  }

  function downloadImageDataUrl(dataUrl, fileName) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName || 'strategy-kit-diagram.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function isPreviewableImageRef(value) {
    return /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value) || /^https?:\/\//i.test(value);
  }

  function renderImageResult(resultArea, diagram, image, meta) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;
    clear(resultArea);
    restoreInlineNotice(resultArea);

    const prompt = meta && meta.prompt ? meta.prompt : '';
    const modelName = meta && meta.modelName ? meta.modelName : '';
    const generatedAt = meta && meta.generatedAt ? meta.generatedAt : new Date().toISOString();
    const sourceLabel = meta && meta.sourceLabel ? meta.sourceLabel : (resultArea.dataset && resultArea.dataset.renderSourceLabel) || '';
    const dataUrl = image && image.dataUrl ? image.dataUrl : '';
    const isDataImage = dataUrl.indexOf('data:image') === 0;
    const fileName = 'strategy-kit-' + (diagram.id || 'diagram') + '-' + formatCompactTimestamp(new Date()) + '.png';

    resultArea.appendChild(el('section', { class: 'sk-diagram-image-result' },
      el('h3', { style: 'font-size:13px;margin:8px 0 6px;color:#0f766e', text: '生成された画像系図解' })
    ));
    if (sourceLabel) {
      resultArea.appendChild(el('p', {
        style: 'font-size:11px;color:#7c2d12;margin:0 0 8px;font-weight:700',
        text: sourceLabel,
      }));
    }
    resultArea.appendChild(el('img', {
      class: 'sk-diagram-generated-image',
      src: dataUrl,
      alt: diagram.label + ' image diagram',
      style: 'width:100%;max-height:520px;object-fit:contain;border:1px solid #e2e8f0;border-radius:8px;background:#fff',
    }));
    resultArea.appendChild(el('p', {
      class: 'muted-note',
      text: isDataImage
        ? '画像を生成しました。まず PNG をダウンロードしてください。'
        : '貼り戻した画像を表示しました。必要なら元サービス側で画像を保存してください。',
    }));

    const actions = el('div', {
      class: 'sk-diagram-image-actions',
      style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px',
    });
    actions.appendChild(el('button', {
      class: 'btn',
      text: 'PNGをダウンロード',
      on: { click: function () { downloadImageDataUrl(dataUrl, fileName); } },
    }));
    actions.appendChild(el('button', {
      class: 'btn btn-ghost',
      text: 'DataURLをコピー',
      on: { click: function () { copyTextWithManualFallback(dataUrl, null, null, 'DataURLをコピーしました'); } },
    }));
    actions.appendChild(el('button', {
      class: 'btn btn-ghost',
      text: '生成promptをコピー',
      on: { click: function () { copyTextWithManualFallback(prompt, null, null, '生成promptをコピーしました'); } },
    }));
    actions.appendChild(el('button', {
      class: 'btn',
      text: 'DRAFTにメタ情報を追記',
      on: {
        click: async function () {
          try {
            await appendDiagramToDraft(diagram, {
              mode: 'image',
              prompt: prompt,
              modelName: modelName,
              generatedAt: generatedAt,
              sourceLabel: sourceLabel,
            });
            window.SK_CORE.showToast('DRAFTにメタ情報を追記しました', false, 4000);
          } catch (e) {
            window.SK_CORE.showToast('追記失敗: ' + e.message, true);
          }
        },
      },
    }));
    resultArea.appendChild(actions);

    if (meta && meta.rawText) {
      const details = el('details', { style: 'margin-top:8px' });
      details.appendChild(el('summary', { style: 'font-size:11px;color:#475569;cursor:pointer', text: 'Gemini の補足を見る' }));
      details.appendChild(el('pre', {
        style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px;font-size:10px;white-space:pre-wrap;max-height:180px;overflow:auto;margin-top:4px',
        text: meta.rawText,
      }));
      resultArea.appendChild(details);
    }
  }

  // 画像生成の失敗理由を、利用者が次の一手を判断しやすい平易な日本語に分類する。
  // リトライ(503/429/5xx)を尽くしても失敗した時にだけ手動 fallback へ来るので、
  // 「混雑（時間をおけば直る）」と「設定不足（直さないと直らない）」を区別して伝える。
  function describeImageFailureReason(error) {
    const message = String((error && error.message) || '');
    const status = error && typeof error.status === 'number' ? error.status : null;
    if (/未設定|api key|proxy/i.test(message) && !/HTTP/.test(message)) {
      return 'Gemini API key または proxy が未設定です。Options で設定すると自動生成できます。今は下の prompt をコピーして外部AIで画像化してください。';
    }
    if (status === 404 || /model not found|not found.*model|404/i.test(message)) {
      return '画像生成モデルが見つかりませんでした（モデル名が変更された可能性）。下の prompt をコピーして外部AIで画像化してください。';
    }
    if (status === 429 || /HTTP 429|rate limit|quota/i.test(message)) {
      return '利用枠（レート上限）に達したため、自動生成を一時的に行えません。少し時間をおくか、下の prompt をコピーして外部AIで画像化してください。';
    }
    if (status === 503 || status === 500 || status === 502 || status === 504 ||
        /HTTP (?:500|502|503|504)|high demand|overloaded|unavailable|混雑/i.test(message)) {
      return 'Gemini 側が混雑しています。自動リトライしても生成できませんでした。少し時間をおくか、下の prompt をコピーして外部AIで画像化してください。';
    }
    if (message) return '画像を自動生成できませんでした（' + message + '）。下の prompt をコピーして外部AIで画像化してください。';
    return 'Gemini API key または proxy が未設定です。下の prompt をコピーして外部AIで画像化できます。';
  }

  function showImageFallbackManual(prompt, diagram, resultArea, error) {
    const el = window.SK_CORE.el;
    window.SK_CORE.clearChildren(resultArea);
    restoreInlineNotice(resultArea);
    resultArea.appendChild(el('div', {
      class: 'sk-diagram-fallback-box',
      style: 'border:1px solid #fed7aa;background:#fff7ed;border-radius:8px;padding:10px',
    },
      el('p', {
        style: 'font-size:12px;color:#9a3412;margin:0 0 6px;font-weight:700',
        text: '画像生成に失敗しました。生成promptをコピーして、Gemini や ChatGPT の画像生成に貼り付けてください。',
      }),
      el('p', {
        class: 'muted-note',
        text: describeImageFailureReason(error),
      })
    ));

    const promptArea = el('textarea', {
      style: 'width:100%;min-height:220px;box-sizing:border-box;margin:8px 0;padding:8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;font-family:monospace',
      value: prompt,
    });
    resultArea.appendChild(promptArea);

    const actions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px' });
    actions.appendChild(el('button', {
      class: 'btn',
      text: 'prompt をコピー',
      on: { click: function () { copyTextWithManualFallback(promptArea.value, null, null, 'prompt をコピーしました'); } },
    }));
    actions.appendChild(el('button', {
      class: 'btn btn-ghost',
      text: 'Gemini を開く',
      on: { click: function () { chrome.tabs.create({ url: 'https://gemini.google.com/app' }); } },
    }));
    actions.appendChild(el('button', {
      class: 'btn btn-ghost',
      text: 'ChatGPT を開く',
      on: { click: function () { chrome.tabs.create({ url: 'https://chatgpt.com/' }); } },
    }));
    resultArea.appendChild(actions);

    resultArea.appendChild(el('p', { class: 'muted-note', text: '画像URL / DataURL を貼り戻す' }));
    const pasteArea = el('textarea', {
      placeholder: 'data:image/png;base64,... または https://...',
      style: 'width:100%;min-height:90px;box-sizing:border-box;padding:8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;font-family:monospace',
    });
    const previewArea = el('div', { style: 'margin-top:8px' });
    const previewBtn = el('button', {
      class: 'btn',
      text: '貼り戻した画像を表示',
      on: {
        click: function () {
          const value = pasteArea.value.trim();
          if (!isPreviewableImageRef(value)) {
            window.SK_CORE.showToast('画像URLまたはDataURLを貼ってください', true);
            return;
          }
          renderImageResult(previewArea, diagram, { dataUrl: value }, {
            prompt: promptArea.value,
            modelName: 'manual-external-image',
            generatedAt: new Date().toISOString(),
            sourceLabel: resultArea.dataset && resultArea.dataset.renderSourceLabel,
            rawText: 'Manual fallback image reference pasted by user.',
          });
        },
      },
    });
    resultArea.appendChild(pasteArea);
    resultArea.appendChild(el('div', { style: 'margin-top:6px' }, previewBtn));
    resultArea.appendChild(previewArea);
  }

  function extractCode(text, format) {
    if (!text) return '';
    let re;
    if (isHtmlCardFormat(format)) {
      re = /```json\s*\n([\s\S]*?)```/i;
    } else {
      re = /```mermaid\s*\n([\s\S]*?)```/i;
    }
    const m = text.match(re);
    if (m) return m[1].trim();
    return text.trim();
  }

  function formatLabel(format) {
    if (!format) return '';
    if (format.indexOf('mermaid-mindmap') === 0) return 'マインドマップ';
    if (format.indexOf('mermaid-flowchart') === 0) return 'フローチャート';
    if (format.indexOf('mermaid-quadrant') === 0) return '4象限図';
    if (isHtmlCardFormat(format)) return 'HTMLカード';
    if (format.indexOf('mermaid') === 0) return 'Mermaid';
    return format;
  }

  function ensureArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  }

  function ensureMatrixRow(row, size) {
    const cells = Array.isArray(row) ? row.slice(0, size) : [];
    while (cells.length < size) cells.push('');
    return cells;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createHtmlFragment(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content;
  }

  function parseJsonPayload(raw) {
    const payload = String(raw || '').trim();
    if (!payload) throw new Error('生成結果が空です');

    const candidates = [payload];
    const fenceMatch = payload.match(/```json\s*\n([\s\S]*?)```/i);
    if (fenceMatch) candidates.unshift(fenceMatch[1].trim());
    const objectMatch = payload.match(/\{[\s\S]*\}/);
    if (objectMatch) candidates.push(objectMatch[0]);

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        return JSON.parse(candidate);
      } catch (_) {}
    }
    throw new Error('HTMLカード用のJSONを解析できませんでした。AI応答が ```json ... ``` 形式か確認してください。');
  }

  function renderBadge(text, modifier) {
    return '<span class="sk-diagram-badge' + (modifier ? ' ' + modifier : '') + '">' + escapeHtml(text) + '</span>';
  }

  function renderList(items) {
    const list = ensureArray(items);
    if (!list.length) return '<li>記載なし</li>';
    return list.map(function (item) {
      return '<li>' + escapeHtml(item) + '</li>';
    }).join('');
  }

  function renderSwotCard(data) {
    const sections = [
      { key: 'strengths', title: 'Strengths', badge: 'S', modifier: 'is-strength' },
      { key: 'weaknesses', title: 'Weaknesses', badge: 'W', modifier: 'is-weakness' },
      { key: 'opportunities', title: 'Opportunities', badge: 'O', modifier: 'is-opportunity' },
      { key: 'threats', title: 'Threats', badge: 'T', modifier: 'is-threat' },
    ];
    const quadrants = sections.map(function (section) {
      return ''
        + '<section class="sk-diagram-quadrant">'
        + '<div class="sk-diagram-quadrant-head">'
        + renderBadge(section.badge, section.modifier)
        + '<h4>' + escapeHtml(section.title) + '</h4>'
        + '</div>'
        + '<ul>' + renderList(data[section.key]) + '</ul>'
        + '</section>';
    }).join('');

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--swot">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">SWOT ANALYSIS</p><h3>' + escapeHtml(data.title || 'SWOT分析') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '内部要因と外部要因を4象限で整理した戦略図解') + '</p>'
      + '</div>'
      + '<div class="sk-diagram-grid sk-diagram-grid--2x2">' + quadrants + '</div>'
      + '</div>';
  }

  function renderFourPCard(data) {
    const headers = ['視点', '企業側（4P）', '顧客側（4C）'];
    const rows = ensureArray(data.rows);
    const bodyRows = rows.length ? rows.map(function (row) {
      const cells = ensureMatrixRow(row, 3);
      return '<tr><th>' + escapeHtml(cells[0]) + '</th><td>' + escapeHtml(cells[1]) + '</td><td>' + escapeHtml(cells[2]) + '</td></tr>';
    }).join('') : '<tr><th>Product / Value</th><td>記載なし</td><td>記載なし</td></tr>';

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--table">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">4P / 4C</p><h3>' + escapeHtml(data.title || '4P / 4C 対応表') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '企業視点と顧客視点を1枚で比較') + '</p>'
      + '</div>'
      + '<table class="sk-diagram-table"><thead><tr>'
      + headers.map(function (header) { return '<th>' + escapeHtml(header) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
      + '</div>';
  }

  function renderPersonaCard(data) {
    return ''
      + '<div class="sk-diagram-card sk-diagram-card--persona">'
      + '<div class="sk-diagram-persona">'
      + '<div class="sk-diagram-persona__portrait">'
      + '<div class="sk-diagram-avatar">' + escapeHtml((data.name || 'P').slice(0, 1)) + '</div>'
      + '<p>' + escapeHtml(data.photoHint || '顔写真風プレースホルダー') + '</p>'
      + '</div>'
      + '<div class="sk-diagram-persona__body">'
      + '<p class="sk-diagram-card__eyebrow">PERSONA</p>'
      + '<h3>' + escapeHtml(data.name || '想定ペルソナ') + '</h3>'
      + '<p class="sk-diagram-persona__meta">' + escapeHtml(data.profile || '年齢・職業・居住地') + '</p>'
      + '<div class="sk-diagram-info-grid">'
      + '<section><h4>属性</h4><ul>' + renderList(data.attributes) + '</ul></section>'
      + '<section><h4>ペイン</h4><ul>' + renderList(data.pains) + '</ul></section>'
      + '<section><h4>ゴール</h4><ul>' + renderList(data.goals) + '</ul></section>'
      + '<section><h4>情報源</h4><ul>' + renderList(data.channels) + '</ul></section>'
      + '</div>'
      + '<section class="sk-diagram-highlight"><h4>選ばれる理由</h4><p>' + escapeHtml(data.reason || '記載なし') + '</p></section>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function renderJourneyCard(data) {
    const stages = ensureArray(data.stages);
    const body = stages.length ? stages.map(function (stage) {
      const title = stage && stage.stage ? stage.stage : '段階';
      return ''
        + '<article class="sk-diagram-journey-step">'
        + '<div class="sk-diagram-journey-step__head">' + escapeHtml(title) + '</div>'
        + '<p><strong>行動:</strong> ' + escapeHtml(stage && stage.action ? stage.action : '記載なし') + '</p>'
        + '<p><strong>感情:</strong> ' + escapeHtml(stage && stage.emotion ? stage.emotion : '記載なし') + '</p>'
        + '<p><strong>接点:</strong> ' + escapeHtml(stage && stage.touchpoint ? stage.touchpoint : '記載なし') + '</p>'
        + '<p><strong>打ち手:</strong> ' + escapeHtml(stage && stage.opportunity ? stage.opportunity : '記載なし') + '</p>'
        + '</article>';
    }).join('') : '<article class="sk-diagram-journey-step"><div class="sk-diagram-journey-step__head">段階</div><p>記載なし</p></article>';

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--journey">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">CUSTOMER JOURNEY</p><h3>' + escapeHtml(data.title || 'カスタマージャーニー') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '認知から再来までの接点整理') + '</p>'
      + '</div>'
      + '<div class="sk-diagram-journey-track">' + body + '</div>'
      + '</div>';
  }

  function renderKpiTreeCard(data) {
    const branches = ensureArray(data.branches);
    const body = branches.length ? branches.map(function (branch) {
      const actions = ensureArray(branch && branch.actions);
      return ''
        + '<article class="sk-diagram-kpi-branch">'
        + '<div class="sk-diagram-kpi-node sk-diagram-kpi-node--mid">'
        + '<h4>' + escapeHtml(branch && branch.kpi ? branch.kpi : 'KPI') + '</h4>'
        + '<p>' + escapeHtml(branch && branch.target ? branch.target : '目標未設定') + '</p>'
        + '</div>'
        + '<div class="sk-diagram-kpi-actions">'
        + (actions.length ? actions.map(function (action) {
          return '<div class="sk-diagram-kpi-node sk-diagram-kpi-node--leaf">' + escapeHtml(action) + '</div>';
        }).join('') : '<div class="sk-diagram-kpi-node sk-diagram-kpi-node--leaf">施策なし</div>')
        + '</div>'
        + '</article>';
    }).join('') : '<article class="sk-diagram-kpi-branch"><div class="sk-diagram-kpi-node sk-diagram-kpi-node--mid"><h4>KPI</h4><p>目標未設定</p></div></article>';

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--kpi">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">KPI TREE</p><h3>' + escapeHtml(data.title || 'KPIツリー') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || 'KGIから日次アクションまでを立体的に整理') + '</p>'
      + '</div>'
      + '<div class="sk-diagram-kpi-root">'
      + '<div class="sk-diagram-kpi-node sk-diagram-kpi-node--root">'
      + '<h4>' + escapeHtml(data.kgi || 'KGI') + '</h4>'
      + '<p>' + escapeHtml(data.kgiTarget || '最終目標') + '</p>'
      + '</div>'
      + '</div>'
      + '<div class="sk-diagram-kpi-tree">' + body + '</div>'
      + '</div>';
  }

  function renderCompetitorCard(data) {
    const headers = ensureArray(data.headers).slice(0, 5);
    while (headers.length < 5) headers.push(headers.length === 0 ? '項目' : '列' + headers.length);
    const rows = ensureArray(data.rows);
    const bodyRows = rows.length ? rows.map(function (row) {
      const cells = ensureMatrixRow(row, 5);
      return '<tr>' + cells.map(function (cell, index) {
        return index === 0 ? '<th>' + escapeHtml(cell) + '</th>' : '<td>' + escapeHtml(cell) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><th>自社</th><td>記載なし</td><td>記載なし</td><td>記載なし</td><td>記載なし</td></tr>';

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--table">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">COMPETITOR SNAPSHOT</p><h3>' + escapeHtml(data.title || '競合比較表') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '競合との差分を一覧で可視化') + '</p>'
      + '</div>'
      + '<table class="sk-diagram-table"><thead><tr>'
      + headers.map(function (header) { return '<th>' + escapeHtml(header) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + bodyRows + '</tbody></table>'
      + '</div>';
  }

  function renderChecklistCard(data) {
    const checks = ensureArray(data.items);
    const body = checks.length ? checks.map(function (item) {
      return '<li><span class="sk-diagram-check"></span><div><strong>' + escapeHtml(item.title || 'チェック項目') + '</strong><p>' + escapeHtml(item.detail || '') + '</p></div></li>';
    }).join('') : '<li><span class="sk-diagram-check"></span><div><strong>チェック項目</strong><p>記載なし</p></div></li>';

    return ''
      + '<div class="sk-diagram-card sk-diagram-card--checklist">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">FIELD CHECKLIST</p><h3>' + escapeHtml(data.title || '業種別チェックリスト') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '現場確認と改善優先度の整理') + '</p>'
      + '</div>'
      + '<ol class="sk-diagram-checklist">' + body + '</ol>'
      + '</div>';
  }

  function renderCross3cCard(data) {
    const focusSummary = ensureArray(data.all_three).slice(0, 2).join(' / ') || '三者が重なる領域を主戦場候補として確認';
    return ''
      + '<div class="sk-diagram-card sk-cross-3c">'
      + '<div class="sk-diagram-card__header">'
      + '<div><p class="sk-diagram-card__eyebrow">CROSS 3C ANALYSIS</p><h3>' + escapeHtml(data.title || 'クロス3C分析') + '</h3></div>'
      + '<p class="sk-diagram-card__summary">' + escapeHtml(data.summary || '顧客・自社・競合の重なりから、どこで戦うかを可視化') + '</p>'
      + '</div>'
      + '<div class="sk-cross-3c-visual">'
      + '<div class="sk-3c-spotlight">'
      + '<span class="sk-3c-spotlight-label">注目領域</span>'
      + '<strong>' + escapeHtml(focusSummary) + '</strong>'
      + '</div>'
      + '<svg viewBox="0 0 400 350" class="sk-3c-svg" aria-label="クロス3C分析ベン図">'
      + '<circle cx="145" cy="145" r="104" fill="#ec635c30" stroke="#ec635c" stroke-width="2.5"></circle>'
      + '<circle cx="255" cy="145" r="104" fill="#27725230" stroke="#277252" stroke-width="2.5"></circle>'
      + '<circle cx="200" cy="240" r="104" fill="#dba2352e" stroke="#dba235" stroke-width="2.5"></circle>'
      + '<circle cx="200" cy="190" r="34" fill="#0f172a" fill-opacity="0.08" stroke="#0f172a" stroke-dasharray="4 4"></circle>'
      + '<text x="68" y="92">顧客</text>'
      + '<text x="292" y="92">競合</text>'
      + '<text x="182" y="337">自社</text>'
      + '<text x="122" y="192" class="sk-3c-svg__hint">刺さる</text>'
      + '<text x="238" y="192" class="sk-3c-svg__hint">奪回</text>'
      + '<text x="186" y="250" class="sk-3c-svg__hint">主戦場</text>'
      + '</svg>'
      + '<div class="sk-3c-legend" aria-hidden="true">'
      + '<span class="is-customer">顧客</span>'
      + '<span class="is-company">自社</span>'
      + '<span class="is-competitor">競合</span>'
      + '<span class="is-focus">中央 = 三者が重なる注目領域</span>'
      + '</div>'
      + '</div>'
      + '<div class="sk-3c-grid">'
      + '<section class="sk-3c-zone"><h4>顧客のみ</h4><ul>' + renderList(data.customer) + '</ul></section>'
      + '<section class="sk-3c-zone"><h4>競合のみ</h4><ul>' + renderList(data.competitor) + '</ul></section>'
      + '<section class="sk-3c-zone"><h4>自社のみ</h4><ul>' + renderList(data.company) + '</ul></section>'
      + '<section class="sk-3c-zone"><h4>顧客∩自社（刺さる）</h4><ul>' + renderList(data.customer_company) + '</ul></section>'
      + '<section class="sk-3c-zone"><h4>顧客∩競合（取られている）</h4><ul>' + renderList(data.customer_competitor) + '</ul></section>'
      + '<section class="sk-3c-zone"><h4>自社∩競合（レッドオーシャン）</h4><ul>' + renderList(data.company_competitor) + '</ul></section>'
      + '<section class="sk-3c-zone sk-3c-zone--all"><h4>3つ全て（三つ巴）</h4><ul>' + renderList(data.all_three) + '</ul></section>'
      + '</div>'
      + '<p class="sk-3c-insight"><strong>戦略的示唆:</strong> ' + escapeHtml(data.insight || '記載なし') + '</p>'
      + '</div>';
  }

  function renderHtmlCardMarkup(format, data) {
    switch (format) {
      case 'html-card-swot':
        return renderSwotCard(data);
      case 'html-card-4p4c':
        return renderFourPCard(data);
      case 'html-card-persona':
        return renderPersonaCard(data);
      case 'html-card-journey':
        return renderJourneyCard(data);
      case 'html-card-kpi-tree':
        return renderKpiTreeCard(data);
      case 'html-card-competitor':
        return renderCompetitorCard(data);
      case 'html-card-checklist':
        return renderChecklistCard(data);
      case 'html-card-cross-3c':
        return renderCross3cCard(data);
      default:
        return '<div class="sk-diagram-card"><div class="sk-diagram-card__header"><div><p class="sk-diagram-card__eyebrow">DIAGRAM</p><h3>' + escapeHtml(data.title || '図解') + '</h3></div></div><p>' + escapeHtml(data.summary || 'レンダラー未対応') + '</p></div>';
    }
  }

  function renderHtmlCardResult(resultArea, diagram, rawPayload) {
    const data = parseJsonPayload(rawPayload);
    const markup = renderHtmlCardMarkup(diagram.format, data);
    const previewWrap = document.createElement('div');
    previewWrap.className = 'sk-diagram-render';
    previewWrap.appendChild(createHtmlFragment(markup));
    resultArea.appendChild(previewWrap);

    return {
      exportText: markup,
      displayText: JSON.stringify(data, null, 2),
      codeLabel: '構造データ',
      isMermaid: false,
      imagePromptSource: markup,
    };
  }

  function appendGroupedOptions(selectEl, diagrams) {
    const el = window.SK_CORE.el;
    const groups = [];
    const index = new Map();

    diagrams.forEach(function (diagram) {
      const groupLabel = diagram.group || '図解';
      if (!index.has(groupLabel)) {
        const bucket = { label: groupLabel, items: [] };
        index.set(groupLabel, bucket);
        groups.push(bucket);
      }
      index.get(groupLabel).items.push(diagram);
    });

    groups.forEach(function (group) {
      if (group.label === '図解') {
        group.items.forEach(function (diagram) {
          selectEl.appendChild(el('option', { value: diagram.id, text: diagram.label }));
        });
        return;
      }
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.items.forEach(function (diagram) {
        optgroup.appendChild(el('option', { value: diagram.id, text: diagram.label }));
      });
      selectEl.appendChild(optgroup);
    });
  }

  function showInlineNotice(resultArea, message, tone) {
    if (!message) return;
    const el = window.SK_CORE.el;
    resultArea.appendChild(
      el('p', {
        class: 'sk-diagram-inline-notice' + (tone === 'warn' ? ' is-warn' : ''),
        text: message,
      })
    );
  }

  function restoreInlineNotice(resultArea) {
    const message = resultArea && resultArea.dataset ? resultArea.dataset.sourceNotice : '';
    const tone = resultArea && resultArea.dataset ? resultArea.dataset.sourceNoticeTone : '';
    if (message) showInlineNotice(resultArea, message, tone);
  }

  function describeSourceSelection(diagram, sourceValue) {
    const sections = ensureArray(diagram && diagram.sourceSection).map(function (n) {
      return '§ ' + normalizeSectionNo(n);
    }).filter(Boolean);
    const joined = sections.join(' と ');
    if (sourceValue === 'draft') {
      return joined
        ? joined + ' の DRAFT 章本文を抽出して図解化します'
        : 'DRAFT 章本文を抽出して図解化します';
    }
    if (sourceValue === 'master') {
      return joined
        ? joined + ' の原本マスター章本文を抽出します'
        : '原本マスター章本文を抽出します';
    }
    return '下のテキストエリアに任意のテキストを貼り付けてください';
  }

  function buildResultSourceLabel(sourceInfo, diagram) {
    if (!sourceInfo) return '';
    if (sourceInfo.requestedSource === 'manual' || sourceInfo.sourceUsed === 'manual') {
      return '📄 元データ: 手動貼り付け';
    }
    const sections = ensureArray(diagram && diagram.sourceSection).map(function (n) {
      return '§ ' + normalizeSectionNo(n);
    }).filter(Boolean);
    const sectionText = sections.length ? ' ' + sections.join('・') : '';
    const sourceLabel = sourceInfo.sourceUsed === 'draft' ? 'DRAFT' : '原本マスター';
    return '📄 元データ: ' + sourceLabel + sectionText;
  }

  function buildUI(slot) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;

    try {
      clear(slot);
      const eyebrowRow = el('div', { class: 'card-eyebrow-row' },
        el('span', { class: 'card-eyebrow card-eyebrow-diagram', text: 'diagram' }),
        el('span', { class: 'card-eyebrow-rule' })
      );
      slot.appendChild(eyebrowRow);
      slot.appendChild(el('h2', { class: 'editorial-title editorial-title-diagram', text: '図解生成' }));
      slot.appendChild(
        el('p', {
          class: 'muted-note',
          text: 'DRAFTの本文から、そのまま配布できるHTMLカード図解を生成します。Mermaidは上級者向けに最後尾へ残しています。',
        })
      );

      renderNotebookLmExportBlock(slot);

      const guideCard = el('div', {
        class: 'sk-diagram-guide-card',
      });
      guideCard.appendChild(el('div', {
        class: 'sk-diagram-guide-card__title',
        text: '基本操作: 元データ「ドラフト」 + 生成方法「自動で図にする」',
      }));
      guideCard.appendChild(el('div', {
        text: 'DRAFTが取れない時は自動で原本マスターにフォールバックし、画面に理由を明示します。',
      }));
      slot.appendChild(guideCard);

      const typeSelect = el('select', { id: 'sk-diagram-type', style: SELECT_FORCE_STYLE });
      slot.appendChild(
        el(
          'label',
          { class: 'form-row' },
          el('span', { class: 'form-label', text: '図解タイプ' }),
          typeSelect
        )
      );

      const descEl = el('p', {
        class: 'muted-note',
        style: 'font-size:11px;margin-top:4px',
      });
      slot.appendChild(descEl);

      const methodSelect = el('select', { id: 'sk-diagram-method', style: SELECT_FORCE_STYLE });
      [
        { value: 'gemini', label: '自動で図にする（おすすめ・数秒）' },
        { value: 'manual', label: '自分でAIに貼って図を作る' },
      ].forEach(function (m) {
        console.log('[STRATEGY-KIT][diagram] appending option', m);
        methodSelect.appendChild(el('option', { value: m.value, text: m.label }));
      });
      slot.appendChild(
        el(
          'label',
          { class: 'form-row' },
          el('span', { class: 'form-label', text: '生成方法' }),
          methodSelect
        )
      );

      const generationModeSelect = el('select', { id: 'sk-diagram-generation-mode', style: SELECT_FORCE_STYLE });
      [
        { value: 'text', label: 'テキスト系図解（高速・編集可）' },
        { value: 'image', label: '画像系図解（Nano Banana・きれい・編集不可）' },
      ].forEach(function (m) {
        generationModeSelect.appendChild(el('option', { value: m.value, text: m.label }));
      });
      slot.appendChild(
        el(
          'label',
          { class: 'form-row' },
          el('span', { class: 'form-label', text: '出力モード' }),
          generationModeSelect
        )
      );

      const generationModeHelp = el('p', {
        class: 'muted-note',
        style: 'font-size:11px;margin-top:4px',
      });
      slot.appendChild(generationModeHelp);

      const sourceSelect = el('select', { id: 'sk-diagram-source', style: SELECT_FORCE_STYLE });
      [
        { value: 'draft', label: 'ドラフト' },
        { value: 'master', label: 'マスタードキュメント' },
        { value: 'manual', label: '自分で入力' },
      ].forEach(function (s) {
        console.log('[STRATEGY-KIT][diagram] appending source option', s);
        sourceSelect.appendChild(el('option', { value: s.value, text: s.label }));
      });
      sourceSelect.value = 'draft';
      slot.appendChild(
        el(
          'label',
          { class: 'form-row' },
          el('span', { class: 'form-label', text: '元データ' }),
          sourceSelect
        )
      );

      const manualSourceArea = el('textarea', {
        placeholder: '元テキスト（章の内容など）を貼り付け',
        style: 'width:100%;min-height:80px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:inherit;font-size:11px;display:none',
      });
      slot.appendChild(manualSourceArea);

      const sourceHelp = el('p', {
        class: 'muted-note',
        style: 'font-size:11px;margin-top:4px',
      });
      slot.appendChild(sourceHelp);

      function updateSourceUi() {
        manualSourceArea.style.display = sourceSelect.value === 'manual' ? '' : 'none';
        const selectedOption = typeSelect.value;
        const currentDiagram = (diagramTypes && diagramTypes.diagrams || []).find(function (item) {
          return item.id === selectedOption;
        });
        sourceHelp.textContent = currentDiagram
          ? describeSourceSelection(currentDiagram, sourceSelect.value)
          : '';
      }

      function updateGenerationModeUi() {
        generationModeHelp.textContent = generationModeSelect.value === 'image'
          ? '画像生成は通常のテキスト生成より時間と利用枠を使います。連打せず、1枚ずつ確認してください。'
          : 'HTMLカード / Mermaid として編集できるテキスト図解を生成します。';
      }

      sourceSelect.addEventListener('change', updateSourceUi);
      generationModeSelect.addEventListener('change', updateGenerationModeUi);
      updateGenerationModeUi();

      const generateBtn = el('button', { class: 'btn', text: '生成' });
      slot.appendChild(
        el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, generateBtn)
      );

      const resultArea = el('div', { class: 'hidden', style: 'margin-top:10px' });
      slot.appendChild(resultArea);

      loadDiagramTypes().then(function (data) {
        const types = ((data && data.diagrams) || []).slice();
        window.SK_CORE.clearChildren(typeSelect);
        appendGroupedOptions(typeSelect, types);

        function updateDesc() {
          const id = typeSelect.value;
          const diagram = types.find(function (item) { return item.id === id; });
          if (!diagram) {
            descEl.textContent = '';
            sourceHelp.textContent = '';
            return;
          }
          const secs = (diagram.sourceSection || []).map(function (n) { return '§' + normalizeSectionNo(n); }).join('・');
          descEl.textContent = formatLabel(diagram.format)
            + (secs ? '／参照する章: ' + secs : '')
            + (diagram.group === EXPERT_GROUP_LABEL ? '／Mermaid上級者向け' : '');
          sourceHelp.textContent = describeSourceSelection(diagram, sourceSelect.value);
        }

        typeSelect.addEventListener('change', updateDesc);

        if (window.SK_STATE) {
          window.SK_STATE.load('diagram.typeId', null).then(function (savedTypeId) {
            if (savedTypeId) typeSelect.value = savedTypeId;
            if (!typeSelect.value && types[0]) typeSelect.value = types[0].id;
            updateDesc();
          });
        } else {
          if (!typeSelect.value && types[0]) typeSelect.value = types[0].id;
          updateDesc();
        }
      }).catch(function (e) {
        console.error('[STRATEGY-KIT][diagram] type initialization failed:', e);
        descEl.textContent = '図解タイプの読み込みに失敗しました。コンソールを確認してください。';
      });

      generateBtn.addEventListener('click', async function () {
        const data = await loadDiagramTypes();
        const types = (data && data.diagrams) || [];
        const diagram = types.find(function (x) { return x.id === typeSelect.value; });
        if (!diagram) {
          window.SK_CORE.showToast('図解タイプが選択されていません', true);
          return;
        }

        generateBtn.disabled = true;
        generateBtn.textContent = '実行中…';
        resultArea.classList.remove('hidden');
        window.SK_CORE.clearChildren(resultArea);
        resultArea.appendChild(el('p', { style: 'font-size:11px', text: '元データを取得中…' }));

        try {
          let sourceInfo;
          if (sourceSelect.value === 'manual') {
            sourceInfo = {
              text: manualSourceArea.value.trim() || '（手動貼付なし）',
              sourceUsed: 'manual',
              requestedSource: 'manual',
              notice: '',
              fallbackUsed: false,
              missingSections: [],
            };
          } else {
            sourceInfo = await fetchSourceText(diagram.sourceSection || [], sourceSelect.value);
          }

          if (
            sourceSelect.value !== 'manual' &&
            sourceInfo &&
            typeof sourceInfo.text === 'string' &&
            sourceInfo.text.indexOf('取得できませんでした') !== -1 &&
            !sourceInfo.fallbackUsed
          ) {
            throw new Error(sourceInfo.notice || '元データの取得に失敗しました');
          }

          const prompt = buildDiagramPrompt(diagram, sourceInfo);
          window.SK_CORE.clearChildren(resultArea);
          resultArea.dataset.sourceNotice = sourceInfo.notice || '';
          resultArea.dataset.sourceNoticeTone = sourceInfo.fallbackUsed ? 'warn' : '';
          resultArea.dataset.renderSourceLabel = buildResultSourceLabel(sourceInfo, diagram);
          restoreInlineNotice(resultArea);

          if (sourceInfo.requestedSource === 'draft' && sourceInfo.sourceUsed === 'master') {
            window.SK_CORE.showToast('DRAFT取得に失敗したため原本マスターへ切り替えました', false, 4500);
          }

          const generationMode = generationModeSelect.value === 'image' ? 'image' : 'text';
          if (methodSelect.value === 'gemini') {
            await runGenerationViaGemini(prompt, diagram, resultArea, {
              generationMode: generationMode,
              sourceInfo: sourceInfo,
            });
          } else {
            await runGenerationManual(prompt, diagram, resultArea, {
              generationMode: generationMode,
              sourceInfo: sourceInfo,
            });
          }
        } catch (e) {
          console.error('[STRATEGY-KIT][diagram] generation failed:', e);
          window.SK_CORE.showToast('生成エラー: ' + e.message, true);
          showInlineNotice(resultArea, '生成中にエラーが発生しました: ' + e.message, 'warn');
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = '生成';
        }
      });
    } catch (e) {
      console.error('[STRATEGY-KIT][diagram] buildUI failed:', e);
      clear(slot);
      slot.appendChild(el('p', {
        style: 'color:#b91c1c;font-size:12px;white-space:pre-wrap',
        text: '図解タブの初期化に失敗しました。コンソールを確認してください。\n' + (e && e.message ? e.message : e),
      }));
    }
  }

  async function runGenerationViaGemini(prompt, diagram, resultArea, options = {}) {
    const el = window.SK_CORE.el;
    const generationMode = options.generationMode === 'image' ? 'image' : 'text';

    window.SK_CORE.clearChildren(resultArea);
    restoreInlineNotice(resultArea);
    resultArea.appendChild(el('p', {
      style: 'font-size:11px',
      text: generationMode === 'image'
        ? 'Nano Banana で画像を生成中... 1分ほどかかる場合があります。'
        : '⏳ Geminiで図解生成中…',
    }));

    const geminiUrl = chrome.runtime.getURL('phase0/gemini-client.js');
    const gemini = await import(geminiUrl);
    if (generationMode === 'image') {
      const provider = await gemini.getSelectedProvider({
        storage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      if (provider !== 'gemini') {
        throw new Error('画像生成は Gemini プロバイダでのみ利用できます。テキスト図解（HTML/Mermaid）をご利用ください');
      }
      const imagePrompt = buildImageDiagramPrompt(diagram, options.sourceInfo || prompt);
      try {
        const res = await gemini.generateImage({
          prompt: imagePrompt,
          model: gemini.DEFAULT_GEMINI_IMAGE_MODEL,
          temperature: 0.2,
          responseModalities: ['TEXT', 'IMAGE'],
        });
        const image = res && res.images && res.images[0];
        if (!image || !image.dataUrl) throw new Error('Gemini の画像応答が空です');
        renderImageResult(resultArea, diagram, image, {
          prompt: imagePrompt,
          modelName: gemini.DEFAULT_GEMINI_IMAGE_MODEL,
          generatedAt: new Date().toISOString(),
          rawText: res.text || '',
        });
      } catch (e) {
        showImageFallbackManual(imagePrompt, diagram, resultArea, e);
      }
      return;
    }

    const res = await gemini.generateContent({
      prompt: prompt,
      model: gemini.DEFAULT_GEMINI_MODEL,
      temperature: 0.3,
    });

    const rawText = (res && res.text) || '';
    if (!rawText.trim()) throw new Error('Gemini の応答が空です');
    const code = extractCode(rawText, diagram.format);

    renderResult(resultArea, diagram, code, rawText);
  }

  async function appendDiagramToDraft(diagram, renderMeta) {
    const stored = await chrome.storage.sync.get(['sk_draft_doc_v012', 'sk_chapter_doc_v012']);
    const documentId = stored.sk_draft_doc_v012?.documentId || stored.sk_chapter_doc_v012?.documentId;
    if (!documentId) throw new Error('DRAFT または章別記録 Docs が未作成です');

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const [docsMod, sectionsMod] = await Promise.all([import(docsUrl), import(sectionsUrl)]);
    const doc = await docsMod.getDocument(documentId);
    let block;
    if (renderMeta && renderMeta.mode === 'image') {
      block = [
        '',
        `[[SK-SECTION:§90]]`,
        `## 図解画像: ${diagram.label}`,
        '',
        '- mode: Nano Banana image',
        '- model: ' + (renderMeta.modelName || 'unknown'),
        '- generatedAt: ' + (renderMeta.generatedAt || new Date().toISOString()),
        '- source: ' + (renderMeta.sourceLabel || 'DRAFT / manual source'),
        '- savedFile: browser download',
        '',
        '### prompt',
        '',
        '```text',
        renderMeta.prompt || '',
        '```',
        '',
      ].join('\n');
    } else {
      const fenceLang = renderMeta.isMermaid ? 'mermaid' : 'html';
      block = [
        '',
        `[[SK-SECTION:§90]]`,
        `## 図解: ${diagram.label}`,
        '',
        '```' + fenceLang,
        renderMeta.exportText,
        '```',
        '',
      ].join('\n');
    }
    await docsMod.batchUpdate(documentId, sectionsMod.buildAppendToDocumentEndRequests(doc, block));
    return { ok: true, documentId };
  }

  async function runGenerationManual(prompt, diagram, resultArea, options = {}) {
    const el = window.SK_CORE.el;

    window.SK_CORE.clearChildren(resultArea);
    restoreInlineNotice(resultArea);

    if (options.generationMode === 'image') {
      showImageFallbackManual(buildImageDiagramPrompt(diagram, options.sourceInfo || prompt), diagram, resultArea, null);
      return;
    }

    const promptBox = el('div', {
      style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;font-size:10px;white-space:pre-wrap;max-height:200px;overflow:auto;margin-bottom:6px;font-family:monospace',
      text: prompt,
    });
    resultArea.appendChild(promptBox);

    const recommended = diagram.promptFor || 'claude';
    const aiSelect = el('select', { class: 'ai-selector', style: SELECT_FORCE_STYLE });
    ['claude', 'chatgpt', 'gemini', 'manus', 'genspark', 'perplexity', 'grok'].forEach(function (id) {
      const opt = el('option', { value: id, text: id + (id === recommended ? '（推奨）' : '') });
      if (id === recommended) opt.selected = true;
      aiSelect.appendChild(opt);
    });

    const insertBtn = el('button', {
      class: 'btn btn-ghost',
      text: '挿入',
      on: {
        click: function () {
          chrome.runtime.sendMessage(
            { type: 'INSERT_PROMPT', text: promptBox.textContent, site: aiSelect.value },
            function (resp) {
              if (chrome.runtime.lastError || !resp || !resp.ok) {
                navigator.clipboard.writeText(promptBox.textContent);
                const aiUrls = {
                  claude: 'https://claude.ai/',
                  chatgpt: 'https://chatgpt.com/',
                  gemini: 'https://gemini.google.com/app',
                  manus: 'https://manus.im/',
                  genspark: 'https://genspark.ai/',
                  perplexity: 'https://www.perplexity.ai/',
                  grok: 'https://grok.com/',
                };
                chrome.tabs.create({ url: aiUrls[aiSelect.value] || 'https://claude.ai/' });
                window.SK_CORE.showToast('挿入失敗。コピー＋AIタブを開きました', false, 4000);
              } else {
                window.SK_CORE.showToast('挿入しました');
              }
            }
          );
        },
      },
    });
    const copyBtn = el('button', {
      class: 'btn btn-ghost',
      text: 'コピー',
      on: {
        click: function () {
          navigator.clipboard.writeText(promptBox.textContent);
          window.SK_CORE.showToast('コピーしました');
        },
      },
    });
    resultArea.appendChild(
      el(
        'div',
        { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' },
        el('span', { style: 'font-size:11px;color:#475569', text: '送信先:' }),
        aiSelect,
        insertBtn,
        copyBtn
      )
    );

    resultArea.appendChild(
      el('p', { style: 'font-size:11px;color:#475569;margin:6px 0 4px', text: 'AIの応答をここに貼り付け' })
    );
    const outputArea = el('textarea', {
      placeholder: isHtmlCardFormat(diagram.format)
        ? 'AIのJSON応答を貼り付け'
        : 'AIのMermaid応答を貼り付け',
      style: 'width:100%;min-height:160px;box-sizing:border-box;padding:6px;border:1px solid #e2e8f0;border-radius:5px;font-family:monospace;font-size:11px;resize:vertical',
    });
    resultArea.appendChild(outputArea);

    const renderBtn = el('button', {
      class: 'btn',
      text: isHtmlCardFormat(diagram.format) ? '✅ 結果を表示（HTMLカード化）' : '✅ 結果を表示',
      on: {
        click: function () {
          const raw = outputArea.value.trim();
          if (!raw) {
            window.SK_CORE.showToast('AIの応答を貼り付けてください', true);
            return;
          }
          const code = extractCode(raw, diagram.format);
          renderResult(resultArea, diagram, code, raw);
        },
      },
    });
    resultArea.appendChild(el('div', { style: 'display:flex;gap:6px;margin-top:6px' }, renderBtn));
  }

  function renderResult(resultArea, diagram, code, rawText) {
    const el = window.SK_CORE.el;
    const clear = window.SK_CORE.clearChildren;
    clear(resultArea);
    restoreInlineNotice(resultArea);

    resultArea.appendChild(
      el('h3', {
        style: 'font-size:13px;margin:8px 0 6px;color:#0f766e',
        text: '生成された ' + diagram.label,
      })
    );
    if (resultArea.dataset && resultArea.dataset.renderSourceLabel) {
      resultArea.appendChild(
        el('p', {
          style: 'font-size:11px;color:#7c2d12;margin:0 0 8px;font-weight:700',
          text: resultArea.dataset.renderSourceLabel,
        })
      );
    }

    let renderMeta;
    try {
      if (isHtmlCardFormat(diagram.format)) {
        renderMeta = renderHtmlCardResult(resultArea, diagram, code);
      } else {
        renderMeta = {
          exportText: code,
          displayText: code,
          codeLabel: 'Mermaidコード',
          isMermaid: true,
          imagePromptSource: code,
        };
      }
    } catch (e) {
      console.error('[STRATEGY-KIT][diagram] renderResult failed:', e);
      showInlineNotice(resultArea, e.message, 'warn');
      return;
    }

    resultArea.appendChild(
      el('p', {
        style: 'font-size:11px;color:#475569;margin:8px 0 4px',
        text: renderMeta.codeLabel,
      })
    );
    resultArea.appendChild(
      el('pre', {
        style: 'background:#0f172a;color:#a7f3d0;border-radius:5px;padding:8px;font-size:10px;font-family:monospace;white-space:pre-wrap;max-height:240px;overflow:auto',
        text: renderMeta.displayText,
      })
    );

    const actions = el('div', {
      style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px',
    });

    actions.appendChild(
      el('button', {
        class: 'btn',
        text: '📷 画像生成プロンプト',
        style: 'background:#b45309;color:#fff;font-weight:600',
        on: {
          click: function () {
            showImageGenModal(diagram, renderMeta.imagePromptSource, renderMeta.isMermaid ? 'mermaid' : 'html-card');
          },
        },
      })
    );

    actions.appendChild(
      el('button', {
        class: 'btn btn-ghost',
        text: renderMeta.isMermaid ? 'コードをコピー' : 'HTMLをコピー',
        on: {
          click: function () {
            navigator.clipboard.writeText(renderMeta.exportText);
            window.SK_CORE.showToast('コピーしました');
          },
        },
      })
    );

    if (renderMeta.isMermaid) {
      actions.appendChild(
        el('button', {
          class: 'btn btn-ghost',
          text: 'Mermaid Liveで開く',
          on: {
            click: function () {
              navigator.clipboard.writeText(renderMeta.exportText);
              chrome.tabs.create({ url: 'https://mermaid.live/edit' });
              window.SK_CORE.showToast('コードをコピーしました。エディタに貼り付けてください', false, 4000);
            },
          },
        })
      );

      actions.appendChild(
        el('button', {
          class: 'btn btn-ghost',
          text: 'Mermaid Inkで画像化',
          on: {
            click: async function () {
              try {
                const utf8 = new TextEncoder().encode(renderMeta.exportText);
                let bin = '';
                for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
                const b64 = btoa(bin);
                const inkUrl = 'https://mermaid.ink/img/' + b64 + '?type=png';
                let okUrl = inkUrl;
                try {
                  const r = await fetch(inkUrl, { method: 'HEAD' });
                  if (!r.ok) okUrl = null;
                } catch (_) {
                  okUrl = null;
                }

                if (okUrl) {
                  chrome.tabs.create({ url: okUrl });
                } else {
                  await navigator.clipboard.writeText(renderMeta.exportText);
                  chrome.tabs.create({ url: 'https://mermaid.live/edit' });
                  window.SK_CORE.showToast('Mermaid Inkに失敗したため Mermaid Live を開きました', false, 5000);
                }
              } catch (e) {
                window.SK_CORE.showToast('画像化エラー: ' + e.message, true);
              }
            },
          },
        })
      );
    }

    actions.appendChild(
      el('button', {
        class: 'btn',
        text: 'DRAFTに追記',
        on: {
          click: async function () {
            try {
              await appendDiagramToDraft(diagram, renderMeta);
              window.SK_CORE.showToast('DRAFTに追記しました', false, 4000);
            } catch (e) {
              window.SK_CORE.showToast('追記失敗: ' + e.message, true);
            }
          },
        },
      })
    );

    resultArea.appendChild(actions);

    if (rawText && rawText !== code) {
      const details = el('details', { style: 'margin-top:8px' });
      details.appendChild(el('summary', { style: 'font-size:11px;color:#475569;cursor:pointer', text: 'AI応答全文を見る' }));
      details.appendChild(
        el('pre', {
          style: 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px;font-size:10px;white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:4px',
          text: rawText,
        })
      );
      resultArea.appendChild(details);
    }
  }

  function showImageGenModal(diagram, renderSource, sourceType) {
    const el = window.SK_CORE.el;
    const types = diagramTypes || { imageGeneration: { stylePresets: {}, promptTemplate: '' } };
    const ig = types.imageGeneration || { stylePresets: {}, promptTemplate: '' };

    const overlay = el('div', {
      style: 'position:fixed;inset:0;background:rgba(15,23,42,.6);display:grid;place-items:center;z-index:10000;padding:14px',
    });

    const modal = el('div', {
      style: 'background:#fff;border-radius:10px;padding:14px 16px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 30px rgba(0,0,0,.3)',
    });

    modal.appendChild(el('h3', {
      style: 'font-size:14px;margin:0 0 8px;color:#0f766e',
      text: '📷 画像生成プロンプト — ' + diagram.label,
    }));

    modal.appendChild(el('p', {
      style: 'font-size:11px;color:#475569;margin:0 0 8px',
      text: 'ChatGPT・Gemini などの画像生成AIに貼り付けて使えます。',
    }));

    const styleSelect = el('select', { id: 'sk-img-style', style: SELECT_FORCE_STYLE });
    Object.entries(ig.stylePresets || {}).forEach(function (entry) {
      const key = entry[0];
      const desc = entry[1];
      styleSelect.appendChild(el('option', { value: key, text: key + ' — ' + desc.slice(0, 40) + '…' }));
    });
    modal.appendChild(el('label', { class: 'form-row' },
      el('span', { class: 'form-label', text: 'スタイル' }),
      styleSelect
    ));

    const promptPreview = el('textarea', {
      style: 'width:100%;min-height:240px;box-sizing:border-box;padding:8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;font-family:monospace;resize:vertical;margin-top:6px',
    });
    modal.appendChild(promptPreview);

    function buildPrompt() {
      const style = styleSelect.value;
      const styleDesc = (ig.stylePresets && ig.stylePresets[style]) || '';
      const hint = diagram.imagePromptHint || diagram.label;
      const sourceLabel = sourceType === 'mermaid' ? '【Mermaid記法】' : '【HTMLカード構造】';
      let prompt = ig.promptTemplate || '';
      prompt = prompt
        .replaceAll('{{HINT}}', hint)
        .replaceAll('{{STYLE}}', styleDesc)
        .replaceAll('{{CONTENT}}', sourceLabel + '\n```\n' + renderSource + '\n```');
      return prompt;
    }

    promptPreview.value = buildPrompt();
    styleSelect.addEventListener('change', function () {
      promptPreview.value = buildPrompt();
    });

    const copyBtn = el('button', {
      class: 'btn',
      text: 'コピー',
      on: {
        click: async function () {
          await navigator.clipboard.writeText(promptPreview.value);
          window.SK_CORE.showToast('コピーしました');
        },
      },
    });

    const chatgptBtn = el('button', {
      class: 'btn btn-ghost',
      text: 'ChatGPTに送る',
      on: {
        click: function () {
          chrome.runtime.sendMessage(
            { type: 'INSERT_PROMPT', text: promptPreview.value, site: 'chatgpt' },
            function (resp) {
              if (chrome.runtime.lastError || !resp || !resp.ok) {
                navigator.clipboard.writeText(promptPreview.value);
                chrome.tabs.create({ url: 'https://chatgpt.com/' });
                window.SK_CORE.showToast('コピー＋ChatGPTタブを開きました', false, 4000);
              }
            }
          );
        },
      },
    });

    const geminiBtn = el('button', {
      class: 'btn btn-ghost',
      text: 'Geminiに送る',
      on: {
        click: function () {
          chrome.runtime.sendMessage(
            { type: 'INSERT_PROMPT', text: promptPreview.value, site: 'gemini' },
            function (resp) {
              if (chrome.runtime.lastError || !resp || !resp.ok) {
                navigator.clipboard.writeText(promptPreview.value);
                chrome.tabs.create({ url: 'https://gemini.google.com/app' });
                window.SK_CORE.showToast('コピー＋Geminiタブを開きました', false, 4000);
              }
            }
          );
        },
      },
    });

    const closeBtn = el('button', {
      class: 'btn btn-ghost',
      text: '閉じる',
      on: {
        click: function () {
          overlay.remove();
        },
      },
    });

    modal.appendChild(
      el('div',
        { style: 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap' },
        copyBtn, chatgptBtn, geminiBtn, closeBtn
      )
    );

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  window.SK_CORE.on('core-ready', async function () {
    const slot = document.getElementById('mod-diagram-slot');
    if (!slot) return;
    ensureDiagramStyles();
    slot.classList.remove('hidden');
    buildUI(slot);

    if (!window.SK_STATE) return;
    window.SK_STATE.loadAll(function (saved) {
      const methodSelect = document.getElementById('sk-diagram-method');
      const sourceSelect = document.getElementById('sk-diagram-source');
      const generationModeSelect = document.getElementById('sk-diagram-generation-mode');

      if (methodSelect && saved['diagram.method']) {
        methodSelect.value = saved['diagram.method'];
      }
      if (sourceSelect && saved['diagram.source']) {
        sourceSelect.value = saved['diagram.source'];
        sourceSelect.dispatchEvent(new Event('change'));
      }
      if (generationModeSelect && saved['diagram.generationMode']) {
        generationModeSelect.value = saved['diagram.generationMode'];
        generationModeSelect.dispatchEvent(new Event('change'));
      }

      const manualArea = slot.querySelector('textarea[placeholder="元テキスト（章の内容など）を貼り付け"]');
      if (manualArea && saved['diagram.manualSource']) {
        manualArea.value = saved['diagram.manualSource'];
      }
    });

    const typeSelect = document.getElementById('sk-diagram-type');
    const methodSelect = document.getElementById('sk-diagram-method');
    const sourceSelect = document.getElementById('sk-diagram-source');
    const generationModeSelect = document.getElementById('sk-diagram-generation-mode');
    const manualArea = slot.querySelector('textarea[placeholder="元テキスト（章の内容など）を貼り付け"]');

    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        window.SK_STATE.save('diagram.typeId', typeSelect.value);
      });
    }
    if (methodSelect) {
      methodSelect.addEventListener('change', function () {
        window.SK_STATE.save('diagram.method', methodSelect.value);
      });
    }
    if (sourceSelect) {
      sourceSelect.addEventListener('change', function () {
        window.SK_STATE.save('diagram.source', sourceSelect.value);
      });
    }
    if (generationModeSelect) {
      generationModeSelect.addEventListener('change', function () {
        window.SK_STATE.save('diagram.generationMode', generationModeSelect.value);
      });
    }
    if (manualArea) {
      manualArea.addEventListener('input', function () {
        window.SK_STATE.debounceSave('diagram.manualSource', manualArea.value);
      });
    }
  });
})();
