/**
 * STRATEGY-KIT — Apps Script for マスタードキュメント (v0.10.0)
 *
 * バインド先: Googleドキュメント（コンテナバインド型）
 *
 * v0.10 の最大の変更:
 *   v2.x: insertTemplate_() で body.appendParagraph() を多用してゼロから章生成
 *   v0.10: Driveに「マスター原本Doc（template_v3.0）」を1つ置き、
 *          makeCopy() で複製 → replaceText() で {{変数}} 差し替え
 *
 * 役割:
 *   1) STRATEGY-KIT メニューを Doc 上部に追加
 *   2) テンプレート原本のセットアップ（初回のみ）
 *   3) 業種プリセットからの新規マスタードキュメント生成（コピー方式）
 *   4) §99 決定ログへの追記補助
 *   5) 章末タイムスタンプの更新
 *   6) §N 要点版（500字以内）の生成・追記
 *   7) 拡張機能との Web App 連携API
 *
 * 後方互換:
 *   - v0.9.15 の Web App エンドポイント action 名は維持
 *   - 拡張機能から呼ばれる handle_createDraftDoc_ / handle_appendDraftSection_ /
 *     handle_appendMeta_ / handle_getDraftProgress_ / handle_getSection_ /
 *     _cleanupAiText_ は継承
 *
 * 廃止:
 *   - 旧 insertTemplate_() のゼロ生成ロジック
 *   - 旧 SK_SECTIONS 定数（章構造の正本は template_v3.0.md に移管）
 */

const SK_VERSION = '0.11.0';
const SK_PRODUCT_LINE = 'strategy-kit-v0.11';
const SK_SCHEMA_VERSION = 3;
const SK_TEMPLATE_DOC_ID_KEY = 'SK_TEMPLATE_DOC_ID';

// 拡張機能が v0.9.x 系 GAS と v0.10 系 GAS を識別するための共通ペイロード
function _versionPayload_() {
  return {
    productLine: SK_PRODUCT_LINE,
    productVersion: SK_VERSION,
    schemaVersion: SK_SCHEMA_VERSION,
    version: SK_VERSION,
  };
}

// 業種プリセット（v0.9.15 を継承し businessType フィールド追加）
const SK_PRESETS = {
  generic: {
    label: '汎用（業種非依存）',
    businessLine: '★業種定義（1行）★',
    valueLine: '★誰に・何を・どう提供するか★',
    businessType: '',
  },
  'climbing-gym': {
    label: 'クライミングジム',
    businessLine: 'ボルダリング/リードを提供する会員制＋単発来場のジム',
    valueLine: '運動習慣を再起動したい大人に、安全で楽しい上達体験を提供する',
    businessType: 'B2C地域型',
  },
  restaurant: {
    label: '飲食店（地域単店舗）',
    businessLine: '★料理ジャンル★を提供する地域型単店舗',
    valueLine: '★ターゲット★に、★場面★で食事を楽しむ体験を提供する',
    businessType: 'B2C地域型',
  },
  'beauty-salon': {
    label: '美容室・整体院',
    businessLine: '★施術ジャンル★を提供する個人事業主',
    valueLine: '★悩み★を持つ人に、再来したくなる施術体験を提供する',
    businessType: 'B2C地域型',
  },
  'btob-creative': {
    label: 'BtoB制作・受託',
    businessLine: '★制作ジャンル★を中小企業に提供する受託制作会社',
    valueLine: '★顧客課題★を抱える企業に、ビジネス成果につながる制作物を提供する',
    businessType: 'B2B中小受託',
  },
  retail: {
    label: '小売・物販（実店舗中心）',
    businessLine: '★商品カテゴリ★を扱う実店舗',
    valueLine: '★こだわり客層★に、店主のセレクトした商品体験を提供する',
    businessType: 'B2C地域型',
  },
};

// =====================================================
// メニュー
// =====================================================

function onOpen() {
  // onOpen はコンテナバインドDocを開いたときの自動トリガでのみ動く前提。
  // Apps Script エディタの「実行」ボタンや Web App コンテキストから呼ばれると
  // DocumentApp.getUi() が "Cannot call DocumentApp.getUi() from this context." で落ちる。
  // 全体を try/catch で囲み、無効なコンテキストでは静かに何もしない。
  try {
    const active = DocumentApp.getActiveDocument();
    if (!active) return; // Web App / 非バインド実行
    PropertiesService.getScriptProperties().setProperty('SK_DOC_ID', active.getId());

    const ui = DocumentApp.getUi();
    ui.createMenu('STRATEGY-KIT')
      .addItem('テンプレート原本セットアップ（初回のみ）', 'setupTemplate_')
      .addSeparator()
      .addSubMenu(
        ui.createMenu('新規マスタードキュメント作成')
          .addItem('クライミングジム', 'createMasterClimbingGym')
          .addItem('飲食店', 'createMasterRestaurant')
          .addItem('美容室・整体院', 'createMasterBeautySalon')
          .addItem('BtoB制作・受託', 'createMasterBtobCreative')
          .addItem('小売・物販', 'createMasterRetail')
          .addSeparator()
          .addItem('汎用（業種非依存）', 'createMasterGeneric')
      )
      .addSeparator()
      .addItem('§99 決定ログに追記', 'showDecisionDialog')
      .addItem('章末タイムスタンプを更新', 'showTimestampDialog')
      .addItem('§N 要点版を生成・追記（手動）', 'showSectionSummaryDialog')
      .addSeparator()
      .addItem('使い方（v0.10）', 'showHelpDialog')
      .addToUi();
  } catch (e) {
    // Apps Script エディタから手動実行された場合などは UI が無いので静かに終了
    Logger.log('onOpen skipped: ' + e.message);
  }
}

// =====================================================
// テンプレート原本セットアップ（v0.10 新規）
// =====================================================

function setupTemplate_() {
  const ui = DocumentApp.getUi();
  const r = ui.prompt(
    'STRATEGY-KIT v0.10 セットアップ',
    'テンプレート原本 Doc の ID を入力してください\n' +
      '（template_v3.0.md を Google Docs にインポートしたファイルのID）\n\n' +
      'Doc URL の /document/d/<ID>/ の <ID> 部分を貼り付けてもOK',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  let docId = r.getResponseText().trim();
  if (!docId) return;

  // URL 形式が貼られた場合 ID を抽出
  const m = docId.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) docId = m[1];

  try {
    const file = DriveApp.getFileById(docId);
    const name = file.getName();
    PropertiesService.getScriptProperties().setProperty(SK_TEMPLATE_DOC_ID_KEY, docId);
    ui.alert(
      'セットアップ完了',
      'テンプレート原本を登録しました\n\nファイル名: ' + name + '\nDoc ID: ' + docId,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('エラー', 'その ID のファイルが見つかりません: ' + e.message, ui.ButtonSet.OK);
  }
}

// =====================================================
// 新規マスタードキュメント作成（v0.10 新規・コピー方式）
// =====================================================

function createMasterGeneric() {
  createMasterFromTemplateUI_('generic');
}
function createMasterClimbingGym() {
  createMasterFromTemplateUI_('climbing-gym');
}
function createMasterRestaurant() {
  createMasterFromTemplateUI_('restaurant');
}
function createMasterBeautySalon() {
  createMasterFromTemplateUI_('beauty-salon');
}
function createMasterBtobCreative() {
  createMasterFromTemplateUI_('btob-creative');
}
function createMasterRetail() {
  createMasterFromTemplateUI_('retail');
}

/**
 * UIから受講者に最低限の入力を求めて createMasterFromTemplate_ を呼ぶラッパ。
 */
function createMasterFromTemplateUI_(presetId) {
  const ui = DocumentApp.getUi();
  const preset = SK_PRESETS[presetId] || SK_PRESETS.generic;

  const templateId = PropertiesService.getScriptProperties().getProperty(SK_TEMPLATE_DOC_ID_KEY);
  if (!templateId) {
    ui.alert(
      'テンプレート未登録',
      '先に「テンプレート原本セットアップ（初回のみ）」を実行してください',
      ui.ButtonSet.OK
    );
    return;
  }

  const r1 = ui.prompt(
    'STRATEGY-KIT — 新規マスター作成',
    '店舗・屋号を入力してください（例: エナジー柏店 / 空欄可）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const storeName = r1.getResponseText().trim();

  const r2 = ui.prompt(
    'STRATEGY-KIT — 新規マスター作成',
    '案件ID（任意・空欄可。例: case-2026-001）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const caseId = r2.getResponseText().trim();

  const r3 = ui.prompt(
    'STRATEGY-KIT — 新規マスター作成',
    '所在地（市区町村・任意）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  const location = r3.getResponseText().trim();

  const r4 = ui.prompt(
    'STRATEGY-KIT — 新規マスター作成',
    '担当者名（任意）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r4.getSelectedButton() !== ui.Button.OK) return;
  const ownerName = r4.getResponseText().trim();

  let result;
  try {
    result = createMasterFromTemplate_(presetId, {
      storeName: storeName,
      caseId: caseId,
      location: location,
      ownerName: ownerName,
      stakeholders: '',
      monthlyBudget: '',
      businessType: preset.businessType,
    });
  } catch (e) {
    ui.alert('エラー', '新規マスタードキュメント作成に失敗しました: ' + e.message, ui.ButtonSet.OK);
    return;
  }

  // 新Docを今後の操作対象として SK_DOC_ID にセット
  PropertiesService.getScriptProperties().setProperty('SK_DOC_ID', result.docId);

  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,sans-serif;font-size:13px;line-height:1.6;padding:8px;">' +
      '<p>新規マスタードキュメントを作成しました。</p>' +
      '<p><strong>ファイル名:</strong> ' + _escapeHtml_(result.name) + '</p>' +
      '<p><a href="' + result.docUrl + '" target="_blank">' + result.docUrl + '</a></p>' +
      '<p style="color:#475569;font-size:12px;">※残った {{...}} プレースホルダは案件進行に応じて手動またはAI連携で埋めてください。</p>' +
      '</div>'
  )
    .setWidth(480)
    .setHeight(220);
  ui.showModalDialog(html, 'STRATEGY-KIT — 新規マスター作成完了');
}

/**
 * テンプレート原本をコピーして {{...}} を差し替えた新規マスタードキュメントを生成する。
 *
 * @param {string} presetId  SK_PRESETS のキー
 * @param {object} formInputs { storeName, caseId, location, ownerName, stakeholders, monthlyBudget, businessType, ... }
 * @return {{ docId:string, docUrl:string, name:string }}
 */
function createMasterFromTemplate_(presetId, formInputs) {
  const templateId = PropertiesService.getScriptProperties().getProperty(SK_TEMPLATE_DOC_ID_KEY);
  if (!templateId) {
    throw new Error('テンプレート原本未登録。先に setupTemplate_ を実行してください');
  }

  const preset = SK_PRESETS[presetId] || SK_PRESETS.generic;
  const today = _today_();
  const inputs = formInputs || {};
  const storeName = String(inputs.storeName || '').trim() || '★店舗名★';
  const newName = '戦略マスタードキュメント — ' + preset.label + ' ／ ' + storeName;

  // テンプレートをコピー
  const templateFile = DriveApp.getFileById(templateId);
  const newFile = templateFile.makeCopy(newName);
  const newDocId = newFile.getId();

  // 同フォルダへ移動（テンプレートの親フォルダがあればそこに置く）
  try {
    const parents = templateFile.getParents();
    if (parents.hasNext()) {
      newFile.moveTo(parents.next());
    }
  } catch (e) {
    Logger.log('moveTo skipped: ' + e.message);
  }

  // 変数差し替え
  const newDoc = DocumentApp.openById(newDocId);
  const body = newDoc.getBody();

  const replacements = {
    '{{業種}}': preset.label,
    '{{店舗名}}': storeName,
    '{{案件ID}}': inputs.caseId || '',
    '{{所在地}}': inputs.location || '',
    '{{担当者名}}': inputs.ownerName || '',
    '{{関係者リスト}}': inputs.stakeholders || '',
    '{{月次予算}}': inputs.monthlyBudget || '',
    '{{YYYY-MM-DD}}': today,
    '{{業種タイプ}}': inputs.businessType || preset.businessType || '',
    '{{B2C地域型 / B2B中小受託 / その他}}': inputs.businessType || preset.businessType || '',
    '{{タイプ補足}}': '',
  };

  _applyReplacements_(body, replacements);

  newDoc.saveAndClose();

  return {
    docId: newDocId,
    docUrl: newDoc.getUrl(),
    name: newName,
  };
}

/**
 * 値が空文字でもプレースホルダは消す（中途半端な {{...}} を残さない）方針で
 * body.replaceText を呼ぶ。
 */
function _applyReplacements_(body, replacements) {
  const keys = Object.keys(replacements);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = replacements[k];
    body.replaceText(escapeRegex_(k), v == null ? '' : String(v));
  }
}

function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
}

function _escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================
// 決定ログ追記
// =====================================================

function showDecisionDialog() {
  const ui = DocumentApp.getUi();
  const r1 = ui.prompt('決定ログ追記', '決めたことを1行で', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const decision = r1.getResponseText();

  const r2 = ui.prompt('決定ログ追記', '理由（1〜2行）', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const reason = r2.getResponseText();

  const r3 = ui.prompt('決定ログ追記', '次アクション（任意）', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  const action = r3.getResponseText();

  appendDecisionEntry_(decision, reason, action);
  ui.alert('STRATEGY-KIT', '§99 決定ログに追記しました', ui.ButtonSet.OK);
}

function appendDecisionEntry_(decision, reason, action) {
  const doc = _getDoc_();
  const body = doc.getBody();
  const today = _today_();
  const line = today + '　／　' + decision + '　／　理由: ' + (reason || '—') + '　／　次: ' + (action || '—');

  // §99 ヘッダがなければ末尾に追加
  if (!_hasSection_(body, '99')) {
    body.appendParagraph('§99. 決定ログ').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  }
  // ドキュメント末尾に1行追加（§99 が最後の章なら自然に §99 の中に入る）
  const para = body.appendParagraph(line);
  para.setHeading(DocumentApp.ParagraphHeading.NORMAL);

  // 編集の確実な反映のため
  doc.saveAndClose();
}

function _hasSection_(body, sectionNo) {
  const num = body.getNumChildren();
  const prefix = '§' + sectionNo;
  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    if (
      para.getHeading() === DocumentApp.ParagraphHeading.HEADING1 &&
      para.getText().indexOf(prefix) === 0
    ) {
      return true;
    }
  }
  return false;
}

// =====================================================
// 章末タイムスタンプ更新
// =====================================================

function showTimestampDialog() {
  const ui = DocumentApp.getUi();
  const r = ui.prompt(
    '章末タイムスタンプ',
    '更新する章番号を入力（例: 3）。空欄ですべての章を更新',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const target = r.getResponseText().trim();
  const updated = updateTimestamp_(target);
  ui.alert('STRATEGY-KIT', updated + '件のタイムスタンプを更新しました', ui.ButtonSet.OK);
}

function updateTimestamp_(targetSection) {
  const doc = _getDoc_();
  const body = doc.getBody();
  const today = _today_();
  const num = body.getNumChildren();
  let updated = 0;
  let inTargetSection = !targetSection;
  let currentSection = '';

  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();

    if (para.getHeading() === DocumentApp.ParagraphHeading.HEADING1) {
      const m = para.getText().match(/^§(\d+)\./);
      currentSection = m ? m[1] : '';
      inTargetSection = !targetSection || currentSection === String(targetSection);
    }

    if (inTargetSection && /^\[最終更新: .*?\/\s*担当: /.test(para.getText())) {
      para.setText('[最終更新: ' + today + '／担当: 自分]');
      updated++;
    }
  }
  return updated;
}

// =====================================================
// §N 要点版（500字以内）— v0.10 新規
// =====================================================

function showSectionSummaryDialog() {
  const ui = DocumentApp.getUi();
  const r1 = ui.prompt(
    '§N 要点版',
    '対象の章番号（例: 3）',
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const sectionNo = r1.getResponseText().replace(/[^0-9]/g, '');
  if (!sectionNo) {
    ui.alert('エラー', '章番号が空です', ui.ButtonSet.OK);
    return;
  }

  const r2 = ui.prompt(
    '§N 要点版',
    '要点版テキスト（500字以内・後続フェーズ参照用）を貼り付けてください',
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const summaryText = r2.getResponseText();
  if (!summaryText.trim()) {
    ui.alert('エラー', '要点版テキストが空です', ui.ButtonSet.OK);
    return;
  }

  try {
    const result = appendSectionSummary_(sectionNo, summaryText);
    ui.alert(
      'STRATEGY-KIT',
      '§' + sectionNo + ' 要点版を追記しました（' + result.action + '）',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('エラー', e.message, ui.ButtonSet.OK);
  }
}

/**
 * §N 章内の「### §N 要点版」サブヘッダ直後に要点版テキストを挿入。
 * 既存の要点版があれば置換。サブヘッダが無い章に対しては章末に「### §N 要点版」付きで追加。
 *
 * @return {{ action: 'replaced' | 'appended-with-header' | 'inserted' }}
 */
function appendSectionSummary_(sectionNo, summaryText, opt_docId) {
  const doc = opt_docId
    ? DocumentApp.openById(opt_docId)
    : _getDoc_();
  const body = doc.getBody();
  const num = body.getNumChildren();
  const targetNo = String(sectionNo).replace(/[^0-9]/g, '');
  if (!targetNo) throw new Error('sectionNo is required');

  // §N HEADING1 の開始位置と次の HEADING1 の位置を探す
  let secStart = -1;
  let secEnd = num; // exclusive
  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING1) continue;
    const txt = para.getText();
    const m = txt.match(/^§(\d+)\.\s*/);
    if (!m) continue;
    if (secStart < 0) {
      if (m[1] === targetNo) secStart = i;
    } else {
      // すでに開始しているなら「次の HEADING1」が章境界
      secEnd = i;
      break;
    }
  }
  if (secStart < 0) {
    throw new Error('§' + targetNo + ' が見つかりません');
  }

  // 「### §N 要点版」サブヘッダ（HEADING3）を章内で探す
  const summaryHeaderRe = new RegExp('^§' + targetNo + '\\s*要点版');
  let headerIdx = -1;
  for (let i = secStart + 1; i < secEnd; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    const heading = para.getHeading();
    if (
      heading === DocumentApp.ParagraphHeading.HEADING3 ||
      heading === DocumentApp.ParagraphHeading.HEADING2 ||
      heading === DocumentApp.ParagraphHeading.HEADING4
    ) {
      if (summaryHeaderRe.test(para.getText())) {
        headerIdx = i;
        break;
      }
    }
  }

  let action;
  if (headerIdx >= 0) {
    // 要点版ヘッダ直後 → 次の同階層以上のヘッダ手前まで を削除して差し替え
    const headerHeading = body.getChild(headerIdx).asParagraph().getHeading();
    let stopAt = secEnd;
    for (let i = headerIdx + 1; i < secEnd; i++) {
      const c = body.getChild(i);
      if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      const p = c.asParagraph();
      const h = p.getHeading();
      if (
        h === DocumentApp.ParagraphHeading.HEADING1 ||
        h === DocumentApp.ParagraphHeading.HEADING2 ||
        (h === DocumentApp.ParagraphHeading.HEADING3 && headerHeading === DocumentApp.ParagraphHeading.HEADING3)
      ) {
        stopAt = i;
        break;
      }
    }
    // 既存ボディ削除
    for (let i = stopAt - 1; i > headerIdx; i--) {
      body.removeChild(body.getChild(i));
    }
    // 新ボディ挿入
    let pos = headerIdx + 1;
    const lines = String(summaryText).split('\n');
    for (let j = 0; j < lines.length; j++) {
      body.insertParagraph(pos, lines[j]).setHeading(DocumentApp.ParagraphHeading.NORMAL);
      pos++;
    }
    action = 'replaced';
  } else {
    // ヘッダ無し → 章末（次章直前）に「### §N 要点版」付きで追加
    let pos = secEnd;
    body
      .insertParagraph(pos, '§' + targetNo + ' 要点版（500字以内・後続フェーズ参照用）')
      .setHeading(DocumentApp.ParagraphHeading.HEADING3);
    pos++;
    const lines = String(summaryText).split('\n');
    for (let j = 0; j < lines.length; j++) {
      body.insertParagraph(pos, lines[j]).setHeading(DocumentApp.ParagraphHeading.NORMAL);
      pos++;
    }
    action = 'appended-with-header';
  }

  doc.saveAndClose();
  return { action: action };
}

/**
 * §N 要点版テキストを取得（後続フェーズプロンプト貼付用）。
 * 該当章のサマリーヘッダ直後 → 次の同階層以上ヘッダ直前 までのテキストを連結して返す。
 */
function getSectionSummary_(sectionNo, opt_docId) {
  const doc = opt_docId
    ? DocumentApp.openById(opt_docId)
    : _getDoc_();
  const body = doc.getBody();
  const num = body.getNumChildren();
  const targetNo = String(sectionNo).replace(/[^0-9]/g, '');
  if (!targetNo) throw new Error('sectionNo is required');

  // §N の範囲
  let secStart = -1;
  let secEnd = num;
  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING1) continue;
    const m = para.getText().match(/^§(\d+)\.\s*/);
    if (!m) continue;
    if (secStart < 0) {
      if (m[1] === targetNo) secStart = i;
    } else {
      secEnd = i;
      break;
    }
  }
  if (secStart < 0) return { ok: false, error: '§' + targetNo + ' が見つかりません' };

  // 要点版ヘッダ
  const summaryHeaderRe = new RegExp('^§' + targetNo + '\\s*要点版');
  let headerIdx = -1;
  let headerHeading = null;
  for (let i = secStart + 1; i < secEnd; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    const heading = para.getHeading();
    if (heading === DocumentApp.ParagraphHeading.HEADING3 ||
        heading === DocumentApp.ParagraphHeading.HEADING2 ||
        heading === DocumentApp.ParagraphHeading.HEADING4) {
      if (summaryHeaderRe.test(para.getText())) {
        headerIdx = i;
        headerHeading = heading;
        break;
      }
    }
  }
  if (headerIdx < 0) {
    return { ok: false, error: '§' + targetNo + ' 要点版が未生成です' };
  }

  // 本文収集
  let stopAt = secEnd;
  for (let i = headerIdx + 1; i < secEnd; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const p = c.asParagraph();
    const h = p.getHeading();
    if (
      h === DocumentApp.ParagraphHeading.HEADING1 ||
      h === DocumentApp.ParagraphHeading.HEADING2 ||
      (h === DocumentApp.ParagraphHeading.HEADING3 && headerHeading === DocumentApp.ParagraphHeading.HEADING3)
    ) {
      stopAt = i;
      break;
    }
  }
  const lines = [];
  for (let i = headerIdx + 1; i < stopAt; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const txt = c.asParagraph().getText();
    if (txt) lines.push(txt);
  }

  return {
    ok: true,
    sectionNo: targetNo,
    summary: lines.join('\n').trim(),
    charCount: lines.join('').replace(/\s/g, '').length,
  };
}

// =====================================================
// ヘルプ
// =====================================================

function showHelpDialog() {
  const ui = DocumentApp.getUi();
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,sans-serif;font-size:13px;line-height:1.6;padding:8px;">' +
      '<h2 style="font-size:15px;margin:0 0 8px;">STRATEGY-KIT メニュー（v' + SK_VERSION + '）</h2>' +
      '<ul>' +
        '<li><strong>テンプレート原本セットアップ</strong> — 初回のみ。template_v3.0.md を Google Docs にインポートし、その Doc ID を登録</li>' +
        '<li><strong>新規マスタードキュメント作成</strong> — 業種プリセットを選んでテンプレートをコピー → 変数差し替え</li>' +
        '<li><strong>§99 決定ログに追記</strong> — 「日付／決めたこと／理由／次アクション」を1行追加</li>' +
        '<li><strong>章末タイムスタンプを更新</strong> — 各章末の <code>[最終更新: ...]</code> を今日の日付に</li>' +
        '<li><strong>§N 要点版を生成・追記</strong> — 後続フェーズ参照用の500字以内サマリーを章末に追記</li>' +
      '</ul>' +
      '<h2 style="font-size:15px;margin:12px 0 8px;">v0.10 の主要変更</h2>' +
      '<ul>' +
        '<li>マスタードキュメント生成を「コードからゼロ生成」→「<strong>テンプレートDocコピー方式</strong>」に切替</li>' +
        '<li>章構造の正本は Apps Script ではなく <code>template_v3.0.md</code> に移管</li>' +
        '<li>§-1 案件メタ情報はテンプレート側にすでに表が存在するため、<code>replaceText</code> で値だけ差し替え</li>' +
      '</ul>' +
      '<h2 style="font-size:15px;margin:12px 0 8px;">運用原則</h2>' +
      '<ol>' +
        '<li>AIの出力をマスター直書きしない。別ファイル（DRAFT）に保存し、人間が選別して転記</li>' +
        '<li>★や {{...}} が残っているプロンプトは送らない</li>' +
        '<li>出典URLのない主張は採用しない</li>' +
        '<li>1日で全部やろうとしない（1フェーズ30〜60分）</li>' +
      '</ol>' +
      '<p style="color:#475569;font-size:12px;">v' + SK_VERSION + '</p>' +
    '</div>'
  )
    .setWidth(460)
    .setHeight(520);
  ui.showModalDialog(html, 'STRATEGY-KIT 使い方');
}

// =====================================================
// Web App ルーター（拡張機能 ↔ GAS 連携用）
// 「ウェブアプリとしてデプロイ」した場合のエンドポイント
//
// 受け取り: POST body の JSON { action, ...payload } または { __action, payload }
// CORS回避: 拡張側は text/plain で送るので preflight が走らない
// 返却: { ok: true, ...data } または { ok: false, error }
// =====================================================

function doPost(e) {
  return _routeWebRequest(e);
}

function doGet(e) {
  // 簡易ヘルスチェック
  return _jsonResponse(Object.assign({ ok: true, action: 'health' }, _versionPayload_()));
}

function _routeWebRequest(e) {
  let raw = {};
  try {
    raw = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  } catch (err) {
    return _jsonResponse({ ok: false, error: 'invalid JSON: ' + err.message });
  }
  // 新形式: { __action, payload } / 後方互換: { action, ...fields }
  const action = raw.__action || raw.action || (e && e.parameter && e.parameter.action) || 'ping';
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;

  try {
    switch (action) {
      // 後方互換（v0.9.x 由来）
      case 'ping':
        return _jsonResponse(handle_ping_(payload));
      case 'diagnoseSetup':
        return _jsonResponse(handle_diagnoseSetup_(payload));
      case 'getSection':
        return _jsonResponse(handle_getSection_(payload));
      case 'getAllSections':
        return _jsonResponse(handle_getAllSections_(payload));
      case 'getProgress':
        return _jsonResponse(handle_getProgress_(payload));
      case 'saveResearch':
        return _jsonResponse(handle_saveResearch_(payload));
      case 'appendDecision':
        return _jsonResponse(handle_appendDecision_(payload));
      case 'appendMeta':
        return _jsonResponse(handle_appendMeta_(payload));
      case 'updateTimestamp':
        return _jsonResponse(handle_updateTimestamp_(payload));
      case 'geminiProxy':
        return _jsonResponse(handle_geminiProxy_(payload));
      case 'listResearchFiles':
        return _jsonResponse(handle_listResearchFiles_(payload));
      case 'createDraftDoc':
        return _jsonResponse(handle_createDraftDoc_(payload));
      case 'appendDraftSection':
        return _jsonResponse(handle_appendDraftSection_(payload));
      case 'getDraftInfo':
        return _jsonResponse(handle_getDraftInfo_(payload));
      case 'cleanupDraft':
        return _jsonResponse(handle_cleanupDraft_(payload));
      case 'generateExecutiveSummary':
        return _jsonResponse(handle_generateExecutiveSummary_(payload));
      case 'setMasterDoc':
        return _jsonResponse(handle_setMasterDoc_(payload));
      case 'getMasterDocInfo':
        return _jsonResponse(handle_getMasterDocInfo_(payload));
      case 'getDraftProgress':
        return _jsonResponse(handle_getDraftProgress_(payload));
      case 'setDraftDoc':
        return _jsonResponse(handle_setDraftDoc_(payload));

      // v0.10 新規
      case 'setupTemplate':
        return _jsonResponse(handle_setupTemplate_(payload));
      case 'getTemplateInfo':
        return _jsonResponse(handle_getTemplateInfo_(payload));
      case 'createMasterFromTemplate':
        return _jsonResponse(handle_createMasterFromTemplate_(payload));
      case 'appendSectionSummary':
        return _jsonResponse(handle_appendSectionSummary_(payload));
      case 'getSectionSummary':
        return _jsonResponse(handle_getSectionSummary_(payload));

      default:
        return _jsonResponse({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return _jsonResponse({ ok: false, error: err.message, stack: String(err.stack || '').slice(0, 400) });
  }
}

// =====================================================
// Doc ID 解決（Web App から呼ばれた場合は getActiveDocument が動かない）
// =====================================================

function _getDoc_() {
  const props = PropertiesService.getScriptProperties();
  let docId = props.getProperty('SK_DOC_ID');

  // 未保存ならアクティブDocから自動取得して保存（Apps Scriptエディタから直接実行された場合）
  if (!docId) {
    try {
      const active = DocumentApp.getActiveDocument();
      if (active) {
        docId = active.getId();
        props.setProperty('SK_DOC_ID', docId);
      }
    } catch (e) {
      // Web App コンテキスト等で getActiveDocument が動かないケース
    }
  }

  if (!docId) {
    throw new Error('SK_DOC_ID 未設定。マスタードキュメントを開いて onOpen を実行（メニュー再生成）するか、Apps Scriptのスクリプトプロパティに SK_DOC_ID を手動設定してください');
  }
  return DocumentApp.openById(docId);
}

function _getDraftDoc_() {
  const draftId = PropertiesService.getScriptProperties().getProperty('SK_DRAFT_DOC_ID');
  if (!draftId) {
    throw new Error('DRAFT Doc 未作成。先に自動化モードを実行して DRAFT Doc を生成してください');
  }
  return DocumentApp.openById(draftId);
}

function _jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// -----------------------------------------------------
// ping: 疎通テスト
// -----------------------------------------------------
function handle_ping_(body) {
  const doc = _getDoc_();
  const templateId = PropertiesService.getScriptProperties().getProperty(SK_TEMPLATE_DOC_ID_KEY);
  return Object.assign(
    { ok: true },
    _versionPayload_(),
    {
      docId: doc.getId(),
      docTitle: doc.getName(),
      docUrl: doc.getUrl(),
      templateRegistered: !!templateId,
      templateDocId: templateId || '',
      ts: new Date().toISOString(),
    }
  );
}

function handle_diagnoseSetup_(body) {
  const runGeminiProbe = !!(body && body.runGeminiProbe);
  const props = PropertiesService.getScriptProperties();
  const docId = props.getProperty('SK_DOC_ID');
  const templateId = props.getProperty(SK_TEMPLATE_DOC_ID_KEY);
  const geminiApiKey = props.getProperty('GEMINI_API_KEY');
  const checks = [];
  let doc = null;
  let docTitle = '';
  let docUrl = '';

  checks.push({
    id: 'gas-connection',
    title: 'GAS 接続',
    status: 'ok',
    label: '接続OK',
    detail: 'Web App へ到達できました。以降はマスタードキュメント・権限・DRAFT・Gemini を個別に確認します。',
  });

  // テンプレート原本（v0.10 新規）
  let tplStatus = 'warn';
  let tplLabel = '未登録';
  let tplDetail = 'テンプレート原本 Doc が未登録です。setupTemplate_ を実行してください。';
  let tplRecovery = 'マスタードキュメントを開く → STRATEGY-KIT メニュー → テンプレート原本セットアップ';
  if (templateId) {
    try {
      const tplFile = DriveApp.getFileById(templateId);
      tplStatus = 'ok';
      tplLabel = '登録済み';
      tplDetail = 'テンプレート原本: ' + tplFile.getName();
      tplRecovery = '';
    } catch (e) {
      tplStatus = 'error';
      tplLabel = '紐付け切れ';
      tplDetail = 'テンプレートID はあるが Doc が見つかりません: ' + e.message;
      tplRecovery = 'setupTemplate_ を再実行して正しい Doc ID を登録してください';
    }
  }
  checks.push({
    id: 'template-doc',
    title: 'テンプレート原本',
    status: tplStatus,
    label: tplLabel,
    detail: tplDetail,
    recovery: tplRecovery,
    action: tplStatus === 'ok' ? '' : 'open-options',
    actionLabel: 'セットアップ手順を見る',
  });

  checks.push({
    id: 'master-doc',
    title: 'マスタードキュメント',
    status: 'warn',
    label: '未紐付け',
    detail: 'SK_DOC_ID が未設定です。マスタードキュメントを開いて Apps Script 側で `onOpen` を1回実行してください。',
    recovery: 'マスタードキュメントを開く → 拡張機能 → Apps Script → `onOpen` 実行 → 権限承認 → 接続テストを再実行',
    action: 'open-options',
    actionLabel: 'onOpen手順を見る',
  });
  if (docId) {
    try {
      doc = DocumentApp.openById(docId);
      docTitle = doc.getName();
      docUrl = doc.getUrl();
      checks[2] = {
        id: 'master-doc',
        title: 'マスタードキュメント',
        status: 'ok',
        label: '紐付け済み',
        detail: 'SK_DOC_ID が設定済みです。章読込・進捗・決定ログ追記を使えます。',
        action: 'open-master-doc',
        actionLabel: 'ドキュメントを開く',
      };
    } catch (e) {
      checks[2] = {
        id: 'master-doc',
        title: 'マスタードキュメント',
        status: 'error',
        label: '紐付け切れ',
        detail: 'SK_DOC_ID はありますが、ドキュメントを開けません: ' + e.message,
        recovery: '対象ドキュメントを開ける Google アカウントか確認し、必要なら正しいマスタードキュメントで `onOpen` を再実行',
        action: 'open-options',
        actionLabel: '紐付けをやり直す',
      };
    }
  }

  let authStatus = 'warn';
  let authLabel = '要承認';
  let authDetail = 'Apps Script の権限状態を確認できませんでした。';
  let authRecovery = 'Apps Script エディタで `onOpen` を実行し、Google の承認画面を最後まで完了してください。';
  try {
    const authInfo = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    const status = authInfo.getAuthorizationStatus();
    if (status === ScriptApp.AuthorizationStatus.NOT_REQUIRED) {
      authStatus = 'ok';
      authLabel = '承認済み';
      authDetail = 'Drive / Docs / 外部通信に必要な Apps Script 権限は承認済みです。';
      authRecovery = '';
    } else {
      authStatus = 'error';
      authLabel = '要承認';
      authDetail = 'Apps Script の追加権限承認が必要です。Apps Script エディタで `onOpen` を実行し、承認を完了してください。';
    }
  } catch (e) {
    authStatus = 'error';
    authLabel = '確認失敗';
    authDetail = '権限状態の取得に失敗しました: ' + e.message;
  }
  checks.push({
    id: 'script-auth',
    title: 'Apps Script 権限',
    status: authStatus,
    label: authLabel,
    detail: authDetail,
    recovery: authRecovery,
    action: authStatus === 'ok' ? '' : 'open-options',
    actionLabel: '承認手順を見る',
  });

  let draftStatus = 'warn';
  let draftLabel = '要確認';
  let draftDetail = 'DRAFT 作成の準備状態を確認できませんでした。';
  let draftRecovery = '';
  if (!doc) {
    draftStatus = docId ? 'error' : 'warn';
    draftLabel = docId ? '確認失敗' : '未設定';
    draftDetail = docId
      ? 'マスタードキュメントにアクセスできないため、DRAFT 作成準備を判定できません。'
      : 'マスタードキュメントを紐付けたあとに DRAFT 作成準備を判定できます。';
    draftRecovery = docId
      ? '先に「マスタードキュメント」のエラーを解消し、その後で接続テストを再実行してください。'
      : 'まずマスタードキュメントを紐付けてから、接続テストを再実行してください。';
  } else {
    try {
      const docFile = DriveApp.getFileById(doc.getId());
      const parents = docFile.getParents();
      const parent = parents.hasNext() ? parents.next() : null;
      if (parent) {
        draftStatus = 'ok';
        draftLabel = '準備OK';
        draftDetail = 'マスタードキュメントの保存先フォルダにアクセスできます。DRAFT 作成先として利用できます。';
      } else {
        draftStatus = 'warn';
        draftLabel = 'DRAFT先未確定';
        draftDetail = 'マスタードキュメントの親フォルダを特定できません。DRAFT は Drive 直下に作られる可能性があります。';
        draftRecovery = 'マスタードキュメントを My Drive 配下の通常フォルダへ移動し、接続テストを再実行してください。';
      }
    } catch (e) {
      draftStatus = 'error';
      draftLabel = 'DRAFT不可';
      draftDetail = 'DRAFT 作成先の Drive フォルダへアクセスできません: ' + e.message;
      draftRecovery = 'マスタードキュメントを保存している Drive フォルダへのアクセス権を確認し、接続テストを再実行してください。';
    }
  }
  checks.push({
    id: 'draft-write',
    title: 'DRAFT 作成準備',
    status: draftStatus,
    label: draftLabel,
    detail: draftDetail,
    recovery: draftRecovery,
    action: draftStatus === 'ok' ? '' : 'open-options',
    actionLabel: draftStatus === 'error' ? 'Drive権限を見直す' : '保存先を見直す',
  });

  checks.push({
    id: 'gemini-key',
    title: 'GEMINI_API_KEY',
    status: geminiApiKey ? 'ok' : 'warn',
    label: geminiApiKey ? '設定済み' : '未設定',
    detail: geminiApiKey
      ? 'Gemini API キーはスクリプトプロパティに保存されています。'
      : 'Gemini プロキシと全自動モードには `GEMINI_API_KEY` が必要です。Apps Script のスクリプトプロパティに追加してください。',
    action: geminiApiKey ? '' : 'open-options',
    actionLabel: '設定手順を見る',
  });

  let geminiStatus = 'warn';
  let geminiLabel = geminiApiKey ? '未実行' : '未設定';
  let geminiDetail = geminiApiKey
    ? 'Gemini 実行確認はまだ行っていません。必要なときだけ明示的に実行してください。'
    : 'API キー未設定のため Gemini 実行テストをスキップしました。';
  let geminiAction = geminiApiKey ? 'run-gemini-probe' : 'open-options';
  let geminiActionLabel = geminiApiKey ? 'Gemini 実行確認' : '設定手順を見る';
  if (geminiApiKey && runGeminiProbe) {
    const probe = GEMINI('OK', SK_GEMINI_DEFAULT_MODEL, 0);
    if (typeof probe === 'string' && probe.indexOf('[ERROR]') === 0) {
      geminiStatus = 'error';
      geminiLabel = '実行失敗';
      geminiDetail = 'Gemini プロキシの試験実行に失敗しました: ' + probe.replace(/^\[ERROR\]\s*/, '');
    } else {
      geminiStatus = 'ok';
      geminiLabel = '実行OK';
      geminiDetail = 'Gemini プロキシで短い試験実行に成功しました。全自動モード開始前の前提は揃っています。';
    }
    geminiAction = 'open-options';
    geminiActionLabel = '設定手順を見る';
  }
  checks.push({
    id: 'gemini-proxy',
    title: 'Gemini 実行可否',
    status: geminiStatus,
    label: geminiLabel,
    detail: geminiDetail,
    action: geminiStatus === 'ok' ? '' : geminiAction,
    actionLabel: geminiActionLabel,
  });

  return Object.assign(
    { ok: true },
    _versionPayload_(),
    {
      docId: docId || '',
      docTitle: docTitle,
      docUrl: docUrl,
      templateDocId: templateId || '',
      checks: checks,
      ts: new Date().toISOString(),
    }
  );
}

// -----------------------------------------------------
// 章本文の取得
// -----------------------------------------------------
function _getSections_(doc) {
  if (!doc) doc = _getDoc_();
  const body = doc.getBody();
  const num = body.getNumChildren();
  const sections = [];
  let current = null;

  // filled判定で除外する見出し階層
  const SUB_HEADINGS = {};
  SUB_HEADINGS[DocumentApp.ParagraphHeading.HEADING2] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.HEADING3] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.HEADING4] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.HEADING5] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.HEADING6] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.TITLE] = true;
  SUB_HEADINGS[DocumentApp.ParagraphHeading.SUBTITLE] = true;

  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) {
      if (current) current.allLines.push(_safeText_(c));
      continue;
    }
    const para = c.asParagraph();
    const heading = para.getHeading();
    const text = para.getText();

    if (heading === DocumentApp.ParagraphHeading.HEADING1) {
      // §-1 のような負番号も許容
      const m = text.match(/^§(-?\d+)\.\s*(.*)$/);
      if (m) {
        if (current) sections.push(current);
        current = {
          no: m[1],
          title: m[2].trim(),
          startIndex: i,
          allLines: [],
          contentLines: [],
          lastUpdated: '',
        };
        continue;
      }
    }
    if (!current) continue;
    current.allLines.push(text);

    const tm = text.match(/最終更新:\s*([0-9\-未]+)/);
    if (tm) current.lastUpdated = tm[1].trim();

    // filled判定の対象は「ユーザーが書いた本文」のみ
    if (SUB_HEADINGS[heading]) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.indexOf('★') >= 0) continue;
    if (trimmed.indexOf('{{') >= 0) continue; // v0.10: 未差し替えプレースホルダも除外
    if (/^\[最終更新/.test(trimmed)) continue;
    if (/^[\-｜・|>＞]/.test(trimmed)) {
      // テンプレの空フィールド「- ／・／>」のみで内容空のもの
      if (trimmed.replace(/[\-｜・|>＞\s:：]/g, '').length === 0) continue;
    }
    current.contentLines.push(trimmed);
  }
  if (current) sections.push(current);

  return sections.map(function (s) {
    const fullText = s.allLines.join('\n').trim();
    const contentText = s.contentLines.join('\n');
    const charCount = contentText.replace(/\s/g, '').length;
    const progressState = _classifySectionProgress_(s.contentLines, charCount);
    return {
      no: s.no,
      title: s.title,
      text: fullText,
      charCount: charCount,
      lastUpdated: s.lastUpdated || '',
      filled: progressState === 'filled',
      partial: progressState === 'partial',
    };
  });
}

function _safeText_(child) {
  try {
    return child.asText ? child.asText().getText() : '';
  } catch (e) {
    return '';
  }
}

function _normalizeProgressLine_(line) {
  return String(line || '')
    .replace(/[|｜]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' URL ')
    .replace(/[\s\-—–・:：、。.,/()[\]{}「」『』"'`]/g, '');
}

function _isNoiseOnlyProgressLine_(normalized) {
  if (!normalized) return true;
  if (/^(仮|仮案|未|未定|未入力|なし|保留|同上|todo|test|tbd|sample)$/i.test(normalized)) return true;
  if (/^([A-Za-z0-9])\1{2,}$/i.test(normalized)) return true;
  if (/^([ぁ-んァ-ヶー一-龠])\1{2,}$/.test(normalized)) return true;
  return false;
}

function _classifySectionProgress_(contentLines, charCount) {
  if (charCount >= 40) return 'filled';

  let normalizedTotal = 0;
  let meaningfulLines = 0;
  let hasPartial = false;

  for (let i = 0; i < contentLines.length; i++) {
    const normalized = _normalizeProgressLine_(contentLines[i]);
    if (!normalized || _isNoiseOnlyProgressLine_(normalized)) continue;

    hasPartial = true;
    normalizedTotal += normalized.length;
    if (normalized.length >= 6) meaningfulLines += 1;

    if (normalized.length >= 18) return 'filled';
    if (meaningfulLines >= 2 && normalizedTotal >= 18) return 'filled';
    if (meaningfulLines >= 3 && normalizedTotal >= 24) return 'filled';
  }

  return hasPartial ? 'partial' : 'empty';
}

function _isSectionFilled_(contentLines, charCount) {
  return _classifySectionProgress_(contentLines, charCount) === 'filled';
}

function handle_getSection_(body) {
  const target = String(body.sectionNo || '').replace(/[^0-9\-]/g, '');
  if (!target) return { ok: false, error: 'sectionNo is required' };
  const source = body.source === 'draft' ? 'draft' : 'master';
  let doc;
  try {
    doc = source === 'draft' ? _getDraftDoc_() : _getDoc_();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const sections = _getSections_(doc);
  const found = sections.find(function (s) { return s.no === target; });
  if (!found) return { ok: false, error: 'section not found in ' + source + ': §' + target };
  return Object.assign({ ok: true, source: source }, found);
}

function handle_getAllSections_(body) {
  const source = body && body.source === 'draft' ? 'draft' : 'master';
  let doc;
  try {
    doc = source === 'draft' ? _getDraftDoc_() : _getDoc_();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, source: source, sections: _getSections_(doc) };
}

// -----------------------------------------------------
// 進捗計算
// -----------------------------------------------------
function handle_getProgress_(body) {
  const sections = _getSections_();
  const summary = sections.map(function (s) {
    return {
      no: s.no,
      title: s.title,
      charCount: s.charCount,
      lastUpdated: s.lastUpdated,
      filled: s.filled,
      partial: !!s.partial,
    };
  });
  const filledCount = summary.filter(function (s) { return s.filled && s.no !== '99'; }).length;
  const partialCount = summary.filter(function (s) { return s.partial && s.no !== '99'; }).length;
  const totalChapters = summary.filter(function (s) { return s.no !== '99'; }).length;
  return {
    ok: true,
    sections: summary,
    filledCount: filledCount,
    partialCount: partialCount,
    totalChapters: totalChapters,
    progressRate: totalChapters > 0 ? Math.round(((filledCount + (partialCount * 0.5)) / totalChapters) * 100) : 0,
    completionRate: totalChapters > 0 ? Math.round((filledCount / totalChapters) * 100) : 0,
  };
}

// -----------------------------------------------------
// リサーチ保存
// -----------------------------------------------------
function handle_saveResearch_(body) {
  const no = String(body.no || '').replace(/[^0-9]/g, '') || '00';
  const type = String(body.type || 'note').replace(/[^a-z\-]/g, '');
  const content = String(body.content || '');
  const title = String(body.title || '').trim();
  if (!content) return { ok: false, error: 'content is required' };

  const doc = _getDoc_();
  const docFile = DriveApp.getFileById(doc.getId());
  const parents = docFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  // research/ フォルダを作る or 取得
  let researchFolder;
  const it = parent.getFoldersByName('research');
  if (it.hasNext()) researchFolder = it.next();
  else researchFolder = parent.createFolder('research');

  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd_HHmm');
  const filename = 'research-' + no + '-' + type + '-' + ts + '.md';
  const header = title
    ? '# ' + title + '\n\n（番号: ' + no + ' / 種類: ' + type + ' / 保存: ' + ts + '）\n\n---\n\n'
    : '# research-' + no + '-' + type + '\n\n（保存: ' + ts + '）\n\n---\n\n';
  const file = researchFolder.createFile(filename, header + content, MimeType.PLAIN_TEXT);

  return {
    ok: true,
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    fileName: filename,
    folderUrl: researchFolder.getUrl(),
  };
}

function handle_listResearchFiles_(body) {
  const doc = _getDoc_();
  const docFile = DriveApp.getFileById(doc.getId());
  const parents = docFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName('research');
  if (!it.hasNext()) return { ok: true, files: [] };
  const folder = it.next();
  const files = [];
  const fit = folder.getFiles();
  while (fit.hasNext()) {
    const f = fit.next();
    files.push({
      id: f.getId(),
      name: f.getName(),
      url: f.getUrl(),
      updated: f.getLastUpdated().toISOString(),
    });
  }
  files.sort(function (a, b) { return a.updated < b.updated ? 1 : -1; });
  return { ok: true, files: files, folderUrl: folder.getUrl() };
}

// -----------------------------------------------------
// 決定ログ追記（既存の appendDecisionEntry_ を流用）
// -----------------------------------------------------
function handle_appendDecision_(body) {
  const decision = String(body.decision || '').trim();
  if (!decision) return { ok: false, error: 'decision is required' };
  const reason = String(body.reason || '');
  const action = String(body.action || '');
  appendDecisionEntry_(decision, reason, action);
  return { ok: true, date: _today_() };
}

// -----------------------------------------------------
// §-1 案件メタ情報の差し替え
//
// v0.9.x: 段落形式で §-1 セクションを丸ごと挿入
// v0.10: テンプレート由来で §-1 セクションには既にテーブルが存在するため、
//        {{...}} プレースホルダを replaceText で値に差し替えるだけ
//
// 引数で docId を明示できる場合はそれを優先（マスター直編集も可能）。
// 省略時は DRAFT があれば DRAFT、なければマスター。
// -----------------------------------------------------
function handle_appendMeta_(body) {
  const explicitDocId = body && body.docId ? String(body.docId).trim() : '';
  const target = body && body.target ? String(body.target).trim() : ''; // 'master' | 'draft' | ''

  let doc;
  try {
    if (explicitDocId) {
      doc = DocumentApp.openById(explicitDocId);
    } else if (target === 'master') {
      doc = _getDoc_();
    } else if (target === 'draft') {
      doc = _getDraftDoc_();
    } else {
      // 自動: DRAFT 優先（後方互換）→ なければマスター
      try {
        doc = _getDraftDoc_();
      } catch (e) {
        doc = _getDoc_();
      }
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const industry = String(body.industry || '').trim();
  const storeName = String(body.storeName || '').trim();
  const caseId = String(body.caseId || '').trim() || ('case-' + Date.now());
  const owner = String(body.owner || body.ownerName || '').trim();
  const location = String(body.location || '').trim();
  const stakeholders = String(body.stakeholders || '').trim();
  const periodStart = String(body.periodStart || '').trim();
  const periodEnd = String(body.periodEnd || '').trim();
  const monthlyBudget = String(body.monthlyBudget || body.budgetScale || '').trim();
  const businessType = String(body.businessType || '').trim();
  const updatedAt = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || 'Asia/Tokyo',
    'yyyy-MM-dd HH:mm'
  );

  const docBody = doc.getBody();
  const docText = docBody.getText();

  // テンプレート由来の {{...}} が残っていれば差し替え方式
  if (docText.indexOf('{{') >= 0) {
    const replacements = {};
    if (industry) replacements['{{業種}}'] = industry;
    if (storeName) replacements['{{店舗名}}'] = storeName;
    if (caseId) replacements['{{案件ID}}'] = caseId;
    if (location) replacements['{{所在地}}'] = location;
    if (owner) replacements['{{担当者名}}'] = owner;
    if (stakeholders) replacements['{{関係者リスト}}'] = stakeholders;
    if (monthlyBudget) replacements['{{月次予算}}'] = monthlyBudget;
    if (businessType) {
      replacements['{{業種タイプ}}'] = businessType;
      replacements['{{B2C地域型 / B2B中小受託 / その他}}'] = businessType;
    }
    if (periodStart || periodEnd) {
      // テンプレートでは「{{YYYY-MM-DD}} 〜 {{YYYY-MM-DD}}」となっているため、
      // 行全体を確実に差し替えるために段落単位で対応する。
      _replaceContractPeriod_(docBody, periodStart, periodEnd);
    }
    _applyReplacements_(docBody, replacements);

    // 「最終更新日: {{YYYY-MM-DD}}」の行を更新（残っていれば）
    docBody.replaceText(escapeRegex_('{{YYYY-MM-DD}}'), _today_());

    const docId = doc.getId();
    const docUrl = doc.getUrl();
    doc.saveAndClose();
    return {
      ok: true,
      mode: 'replace',
      docId: docId,
      docUrl: docUrl,
      section: '§-1',
      updatedAt: updatedAt,
      caseId: caseId,
    };
  }

  // フォールバック: テンプレート方式でない（プレースホルダなし）→ 旧 v0.9.x 互換で §-1 段落挿入
  const num = docBody.getNumChildren();
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < num; i++) {
    const child = docBody.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING1) continue;
    const text = para.getText();
    if (/^§-1\.?\s*案件メタ情報/.test(text)) {
      startIdx = i;
    } else if (startIdx >= 0 && /^§(?:\d+|-?\d+)/.test(text)) {
      endIdx = i;
      break;
    }
  }

  if (startIdx >= 0) {
    const removeUntil = endIdx > 0 ? endIdx : num;
    for (let i = removeUntil - 1; i >= startIdx; i--) {
      docBody.removeChild(docBody.getChild(i));
    }
  }

  let insertAt = startIdx >= 0 ? startIdx : 0;
  if (insertAt === 0 && num > 0) {
    const first = docBody.getChild(0);
    if (first.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const firstPara = first.asParagraph();
      if (firstPara.getHeading() === DocumentApp.ParagraphHeading.TITLE) {
        insertAt = Math.min(num, 4);
      }
    }
  }

  const lines = [
    { label: '業種', value: industry || '〔未入力〕' },
    { label: '店舗名', value: storeName || '〔未入力〕' },
    { label: '案件ID', value: caseId },
    { label: '担当者', value: owner || '〔未入力〕' },
    { label: '所在地', value: location || '〔未入力〕' },
    { label: '業種タイプ', value: businessType || '〔未入力〕' },
    {
      label: '契約期間',
      value: periodStart || periodEnd
        ? (periodStart || '〔未入力〕') + ' 〜 ' + (periodEnd || '〔未入力〕')
        : '〔未入力〕',
    },
    { label: '予算規模（月次）', value: monthlyBudget || '〔未入力〕' },
    { label: 'テンプレバージョン', value: 'v3.0' },
    { label: '最終更新日', value: updatedAt },
  ];

  let pos = insertAt;
  docBody.insertParagraph(pos, '§-1. 案件メタ情報').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  pos++;

  for (let i = 0; i < lines.length; i++) {
    docBody.insertParagraph(pos, lines[i].label + ': ' + lines[i].value)
      .setHeading(DocumentApp.ParagraphHeading.NORMAL);
    pos++;
  }

  docBody.insertParagraph(pos, '').setHeading(DocumentApp.ParagraphHeading.NORMAL);
  const docId = doc.getId();
  const docUrl = doc.getUrl();
  doc.saveAndClose();

  return {
    ok: true,
    mode: 'append',
    docId: docId,
    docUrl: docUrl,
    section: '§-1',
    updatedAt: updatedAt,
    caseId: caseId,
  };
}

/**
 * 「契約期間 | {{YYYY-MM-DD}} 〜 {{YYYY-MM-DD}} |」のような
 * 同一プレースホルダ複数出現を、段落単位で1回ずつ確実に差し替える。
 */
function _replaceContractPeriod_(body, periodStart, periodEnd) {
  const start = periodStart || '〔未入力〕';
  const end = periodEnd || '〔未入力〕';
  const num = body.getNumChildren();
  for (let i = 0; i < num; i++) {
    const c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    const txt = para.getText();
    if (!/契約期間/.test(txt)) continue;
    if (txt.indexOf('{{YYYY-MM-DD}}') < 0) continue;
    const newTxt = txt
      .replace('{{YYYY-MM-DD}}', start)
      .replace('{{YYYY-MM-DD}}', end);
    para.setText(newTxt);
    return true;
  }
  return false;
}

// -----------------------------------------------------
// タイムスタンプ更新（既存の updateTimestamp_ を流用）
// -----------------------------------------------------
function handle_updateTimestamp_(body) {
  const target = body.sectionNo ? String(body.sectionNo).replace(/[^0-9]/g, '') : '';
  const updated = updateTimestamp_(target);
  return { ok: true, updated: updated };
}

// -----------------------------------------------------
// Gemini プロキシ（Gemini.gs の GEMINI 関数を再利用）
// -----------------------------------------------------
function handle_geminiProxy_(body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required' };
  const requestedModel = body.model || SK_GEMINI_DEFAULT_MODEL;
  const temperature =
    typeof body.temperature === 'number' ? body.temperature : undefined;

  // モデル試行順: 指定モデル → flash → flash-lite
  // 503/429/UNAVAILABLE/RESOURCE_EXHAUSTED は一時障害扱いで指数バックオフリトライ
  const modelChain = [requestedModel];
  if (requestedModel !== 'gemini-2.5-flash') modelChain.push('gemini-2.5-flash');
  if (requestedModel !== 'gemini-2.5-flash-lite') modelChain.push('gemini-2.5-flash-lite');

  let lastError = '';
  for (let mi = 0; mi < modelChain.length; mi++) {
    const tryModel = modelChain[mi];
    // 各モデルで最大3回リトライ（指数バックオフ: 2s, 4s, 8s）
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = GEMINI(prompt, tryModel, temperature);
      if (typeof text === 'string' && text.indexOf('[ERROR]') === 0) {
        lastError = text;
        const isRetryable =
          text.indexOf('503') >= 0 ||
          text.indexOf('429') >= 0 ||
          text.indexOf('UNAVAILABLE') >= 0 ||
          text.indexOf('RESOURCE_EXHAUSTED') >= 0 ||
          text.indexOf('high demand') >= 0 ||
          text.indexOf('overloaded') >= 0;
        if (!isRetryable) break; // 認証エラー等はリトライしてもムダ → 次のモデルへ
        if (attempt < 2) {
          Utilities.sleep(2000 * Math.pow(2, attempt)); // 2s → 4s → 8s
          continue;
        }
        // 3回失敗 → 次のモデルへフォールバック
        break;
      }
      // 成功
      return { ok: true, text: text, model: tryModel };
    }
  }
  return {
    ok: false,
    error:
      'Gemini API が現在混雑しています。指定モデルとフォールバック（flash / flash-lite）すべてで失敗しました。数分後に再試行してください。\n詳細: ' +
      lastError,
  };
}

// =====================================================
// 自動化モード用エンドポイント（v0.6 〜 後方互換）
// =====================================================
//   原本マスタードキュメントとは別に「DRAFT版マスタードキュメント」を新規作成し、
//   各フェーズの自動／半自動出力をそこに蓄積する。原本は人間判断で別途編集。
// =====================================================

function handle_createDraftDoc_(body) {
  let masterDoc;
  try {
    masterDoc = _getDoc_();
  } catch (e) {
    return { ok: false, error: 'マスタードキュメントへアクセスできません: ' + e.message };
  }

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd_HHmm');
  const title = '[DRAFT] ' + masterDoc.getName() + ' — ' + stamp;

  let newDoc;
  try {
    newDoc = DocumentApp.create(title);
  } catch (e) {
    return { ok: false, error: 'DRAFT Doc 作成失敗: ' + e.message };
  }

  // 取得は saveAndClose 前に
  const draftId = newDoc.getId();
  const draftUrl = newDoc.getUrl();

  // 本文初期化
  const body2 = newDoc.getBody();
  body2.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body2.appendParagraph('原本: ' + masterDoc.getName() + ' のDRAFT自動生成版').setItalic(true);
  body2.appendParagraph(
    '※このDRAFTは STRATEGY-KIT 自動化モードで生成されました。原本マスターには影響しません。' +
      '内容を確認のうえ、採用する部分を原本に手動で転記してください。'
  );
  body2.appendParagraph('');

  // 同フォルダへ移動（失敗しても致命傷ではない）
  try {
    const masterFile = DriveApp.getFileById(masterDoc.getId());
    const parents = masterFile.getParents();
    if (parents.hasNext()) {
      DriveApp.getFileById(draftId).moveTo(parents.next());
    }
  } catch (e) {}

  // 保存
  try {
    newDoc.saveAndClose();
  } catch (e) {}

  PropertiesService.getScriptProperties().setProperty('SK_DRAFT_DOC_ID', draftId);

  return {
    ok: true,
    draftDocId: draftId,
    draftDocUrl: draftUrl,
    title: title,
  };
}

function handle_appendDraftSection_(body) {
  const draftId = PropertiesService.getScriptProperties().getProperty('SK_DRAFT_DOC_ID');
  if (!draftId) return { ok: false, error: 'DRAFT Doc 未作成。先に createDraftDoc を呼んでください' };

  const sectionNoRaw = String(body.sectionNo || '');
  // 番号にハイフン付き（2-1, 90-mindmap 等）も許容。先頭の数字+ハイフン+英数字を保持
  const sectionNo = String(sectionNoRaw).trim() || '?';
  const title = String(body.title || '').trim();
  let text = String(body.body || '');
  const aiUsed = String(body.aiUsed || '');
  if (!text) return { ok: false, error: 'body is required' };

  // 共通整形（蓄積コンテキスト除去・前置き削除・★削除・連続空行圧縮）
  text = _cleanupAiText_(text);

  const draft = DocumentApp.openById(draftId);
  const docBody = draft.getBody();

  docBody.appendParagraph('§' + sectionNo + '. ' + title)
    .setHeading(DocumentApp.ParagraphHeading.HEADING1);

  if (aiUsed) {
    docBody.appendParagraph('（生成AI: ' + aiUsed + '）').setItalic(true);
  }

  // 段落ごとに追加（## / ### を見出し化）
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s+/.test(line)) {
      docBody.appendParagraph(line.replace(/^###\s+/, ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING3);
    } else if (/^##\s+/.test(line)) {
      docBody.appendParagraph(line.replace(/^##\s+/, ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    } else {
      docBody.appendParagraph(line);
    }
  }

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  docBody.appendParagraph('[最終更新: ' + today + ' ／ 担当: 自動]').setItalic(true);
  docBody.appendParagraph('');

  // saveAndClose前にURLを取得（close後のdraft参照は無効になるため）
  const draftDocUrl = draft.getUrl();
  draft.saveAndClose();

  return {
    ok: true,
    draftDocUrl: draftDocUrl,
    sectionNo: sectionNo,
  };
}

// AI出力テキストを綺麗にする共通整形
function _cleanupAiText_(rawText) {
  if (!rawText) return '';
  let text = String(rawText);

  // 蓄積コンテキスト／ユーザー初期入力／経過コンテキスト（リサーチサイクル）ブロックを削除
  text = text.replace(/\n*---\n+【蓄積コンテキスト】[\s\S]*$/m, '');
  text = text.replace(/\n*---\n+【ユーザー初期入力】[\s\S]*$/m, '');
  text = text.replace(/\n+【蓄積コンテキスト】[\s\S]*$/m, '');
  text = text.replace(/\n+【ユーザー初期入力】[\s\S]*$/m, '');
  text = text.replace(/\n+【自動化モード — 蓄積コンテキスト】[\s\S]*$/m, '');
  // R6: リサーチサイクルで埋め込んだ経過コンテキストが AI 出力に紛れ込んだ場合も除去
  text = text.replace(/\n*---\n+【これまでの経過・コンテキスト】[\s\S]*$/, '');
  text = text.replace(/\n+【これまでの経過・コンテキスト】\n+※このリサーチは[\s\S]*$/, '');
  text = text.replace(/\n*---\n+【元のフェーズの問い】\n+※このリサーチは[\s\S]*$/, '');

  // AIの定型前置き行を削除
  text = text.replace(/^(了解しました|承知しました|わかりました|了解です|承知いたしました)[。、！\.,].*\n+/gi, '');
  text = text.replace(/^以下(?:に|の|が).{0,80}?(?:を提示|を作成|します|です|となります)[。\.].*\n+/g, '');
  text = text.replace(/^はい、?(?:以下に)?.{0,80}?(?:を提示|を作成|します|です)[。\.].*\n+/g, '');

  // ★が残った行を削除（プレースホルダー残骸）
  text = text.replace(/^.*★[^★\n]+★.*$/gm, '');

  // 「（後段の【蓄積コンテキスト】参照）」のような置換残りを削除
  text = text.replace(/（後段の【[^】]+】参照）/g, '');
  text = text.replace(/（蓄積コンテキストを参照）/g, '');

  // 連続空行を 2行に圧縮
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// =====================================================
// DRAFT整形（章ごとに AI整形→新規 [CLEAN] Doc 出力）
// =====================================================
function handle_cleanupDraft_(body) {
  const draftId = PropertiesService.getScriptProperties().getProperty('SK_DRAFT_DOC_ID');
  if (!draftId) return { ok: false, error: 'DRAFT 未作成' };

  const draft = DocumentApp.openById(draftId);
  const draftBody = draft.getBody();

  // 章ごとに分割
  const sections = [];
  let current = null;
  const num = draftBody.getNumChildren();
  for (let i = 0; i < num; i++) {
    const child = draftBody.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    const txt = para.getText();
    if (para.getHeading() === DocumentApp.ParagraphHeading.HEADING1) {
      if (current) sections.push(current);
      current = { title: txt, lines: [] };
    } else if (current) {
      current.lines.push(txt);
    }
  }
  if (current) sections.push(current);

  if (!sections.length) return { ok: false, error: 'DRAFT に章がありません' };

  // 新規 [CLEAN] Doc 作成
  const cleanTitle = '[CLEAN] ' + draft.getName();
  const cleanDoc = DocumentApp.create(cleanTitle);
  const cleanId = cleanDoc.getId();
  const cleanUrl = cleanDoc.getUrl();
  const cleanBody = cleanDoc.getBody();
  cleanBody.appendParagraph(cleanTitle).setHeading(DocumentApp.ParagraphHeading.TITLE);
  cleanBody.appendParagraph('元: ' + draft.getName() + ' を整形した版').setItalic(true);
  cleanBody.appendParagraph(
    '※各章を Gemini で整形して再構成しています。原本マスター・DRAFT版とは別ファイルです。'
  );
  cleanBody.appendParagraph('');

  let processed = 0;
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s];
    const raw = sec.lines.join('\n').trim();
    if (!raw) continue;

    const formatPrompt =
      '以下のマーケ戦略マスタードキュメントの章テキストを、提案書として読みやすく整形してください。\n\n' +
      '【ルール】\n' +
      '- 見出しは ## と ### で階層化（H1は付けない）\n' +
      '- 箇条書きは - で統一\n' +
      '- 表はそのまま保持（| ... | 形式）\n' +
      '- 「了解しました」等の前置きは削除\n' +
      '- 重複部分は削除し1回にまとめる\n' +
      '- ★が残っていれば削除\n' +
      '- 元の論理構造は変えず、可読性のみ向上させる\n' +
      '- 出力は本文のみ（```で囲まない／メタ説明なし）\n\n' +
      '【元テキスト】\n' + raw;

    let formatted = raw;
    try {
      const result = GEMINI(formatPrompt, 'gemini-2.5-flash', 0.2);
      if (typeof result === 'string' && result.indexOf('[ERROR]') !== 0) {
        formatted = _cleanupAiText_(result);
      }
    } catch (e) {}

    cleanBody.appendParagraph(sec.title).setHeading(DocumentApp.ParagraphHeading.HEADING1);

    const lines = formatted.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (/^###\s+/.test(line)) {
        cleanBody.appendParagraph(line.replace(/^###\s+/, ''))
          .setHeading(DocumentApp.ParagraphHeading.HEADING3);
      } else if (/^##\s+/.test(line)) {
        cleanBody.appendParagraph(line.replace(/^##\s+/, ''))
          .setHeading(DocumentApp.ParagraphHeading.HEADING2);
      } else {
        cleanBody.appendParagraph(line);
      }
    }
    cleanBody.appendParagraph('');
    processed++;
  }

  cleanDoc.saveAndClose();

  // 同フォルダへ移動
  try {
    const draftFile = DriveApp.getFileById(draftId);
    const parents = draftFile.getParents();
    if (parents.hasNext()) {
      DriveApp.getFileById(cleanId).moveTo(parents.next());
    }
  } catch (e) {}

  return {
    ok: true,
    cleanDocId: cleanId,
    cleanDocUrl: cleanUrl,
    title: cleanTitle,
    processedSections: processed,
  };
}

// =====================================================
// マスタードキュメント切替（既存Docを指定）
// =====================================================
function handle_setMasterDoc_(body) {
  const url = String(body.url || '').trim();
  if (!url) return { ok: false, error: 'url is required' };

  // Doc ID 抽出（/document/d/<ID>/ 形式 or 直接ID）
  let docId = '';
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    docId = m[1];
  } else if (/^[a-zA-Z0-9_-]{20,}$/.test(url)) {
    docId = url;
  } else {
    return { ok: false, error: 'Doc IDをURLから抽出できません。Googleドキュメントの共有URL（/document/d/.../）を貼り付けてください' };
  }

  // 開けるか検証
  let doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    return { ok: false, error: 'このDocにアクセスできません: ' + e.message + '（権限／URLを確認してください）' };
  }

  PropertiesService.getScriptProperties().setProperty('SK_DOC_ID', docId);

  return {
    ok: true,
    docId: docId,
    docTitle: doc.getName(),
    docUrl: doc.getUrl(),
  };
}

function handle_getMasterDocInfo_(body) {
  const props = PropertiesService.getScriptProperties();
  const docId = props.getProperty('SK_DOC_ID');
  if (!docId) {
    return { ok: true, exists: false };
  }
  try {
    const doc = DocumentApp.openById(docId);
    return {
      ok: true,
      exists: true,
      docId: docId,
      docTitle: doc.getName(),
      docUrl: doc.getUrl(),
    };
  } catch (e) {
    return { ok: true, exists: false, error: 'マスターDocが見つかりません: ' + e.message };
  }
}

// =====================================================
// Executive Summary（A4 1枚相当の要約版を別Doc 出力）
// =====================================================
function handle_generateExecutiveSummary_(body) {
  const draftId = PropertiesService.getScriptProperties().getProperty('SK_DRAFT_DOC_ID');
  if (!draftId) return { ok: false, error: 'DRAFT 未作成' };

  const draft = DocumentApp.openById(draftId);
  const draftText = draft.getBody().getText();
  if (!draftText.trim()) return { ok: false, error: 'DRAFT が空です' };

  // 全文を Gemini に投げて要約を生成
  const prompt =
    '以下のマーケ戦略マスタードキュメント全体から、A4 1枚相当（800〜1200字）の Executive Summary を作成してください。\n\n' +
    '【構成】\n' +
    '## 1. 事業の現状（3行）\n' +
    '## 2. 市場と競合の理解（4行）\n' +
    '## 3. 勝ち筋となる戦略（USP含む・3行）\n' +
    '## 4. ターゲット（ペルソナ要約・3行）\n' +
    '## 5. 主要施策（Quick Win TOP3・各1行）\n' +
    '## 6. KGI/KPIサマリー（3行）\n\n' +
    '【ルール】\n' +
    '- 形容詞NG／名詞×数字\n' +
    '- 各章2-4行で要点のみ抽出\n' +
    '- 装飾的な前置きは不要\n' +
    '- 出力は本文のみ（```で囲まない）\n\n' +
    '【マスタードキュメント全文】\n' + draftText;

  let summary = '';
  try {
    let result = GEMINI(prompt, 'gemini-2.5-flash', 0.3);
    if (typeof result === 'string' && result.indexOf('[ERROR]') === 0) {
      result = GEMINI(prompt, 'gemini-2.5-flash-lite', 0.3);
    }
    if (typeof result === 'string' && result.indexOf('[ERROR]') !== 0 && result.length > 50) {
      summary = _cleanupAiText_(result);
    } else {
      return { ok: false, error: 'Gemini呼出失敗: ' + String(result).slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, error: 'Gemini呼出例外: ' + e.message };
  }

  // 新Doc 作成
  const sumTitle = '[SUMMARY] ' + draft.getName();
  const sumDoc = DocumentApp.create(sumTitle);
  const sumId = sumDoc.getId();
  const sumUrl = sumDoc.getUrl();
  const sumBody = sumDoc.getBody();
  sumBody.appendParagraph(sumTitle).setHeading(DocumentApp.ParagraphHeading.TITLE);
  sumBody.appendParagraph('元: ' + draft.getName() + ' を要約した Executive Summary').setItalic(true);
  sumBody.appendParagraph('');

  const lines = summary.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s+/.test(line)) {
      sumBody.appendParagraph(line.replace(/^###\s+/, ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING3);
    } else if (/^##\s+/.test(line)) {
      sumBody.appendParagraph(line.replace(/^##\s+/, ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    } else {
      sumBody.appendParagraph(line);
    }
  }

  sumDoc.saveAndClose();

  try {
    const draftFile = DriveApp.getFileById(draftId);
    const parents = draftFile.getParents();
    if (parents.hasNext()) {
      DriveApp.getFileById(sumId).moveTo(parents.next());
    }
  } catch (e) {}

  return {
    ok: true,
    summaryDocId: sumId,
    summaryDocUrl: sumUrl,
    title: sumTitle,
    charCount: summary.length,
  };
}

function handle_getDraftInfo_(body) {
  const draftId = PropertiesService.getScriptProperties().getProperty('SK_DRAFT_DOC_ID');
  if (!draftId) {
    return { ok: true, exists: false };
  }
  try {
    const draft = DocumentApp.openById(draftId);
    return {
      ok: true,
      exists: true,
      draftDocId: draftId,
      draftDocUrl: draft.getUrl(),
      title: draft.getName(),
    };
  } catch (e) {
    return { ok: true, exists: false, error: 'DRAFT Doc が見つかりません（削除済の可能性）' };
  }
}

// -----------------------------------------------------
// DRAFT Doc の記入済み章を検出して途中再開情報を返す
// -----------------------------------------------------
function handle_getDraftProgress_(body) {
  let draft;
  try { draft = _getDraftDoc_(); } catch (e) { return { ok: false, error: e.message }; }

  // DRAFT は appendDraftSection 経由で「§N. タイトル」HEADING1 + 本文 + 「[最終更新: ...]」で書かれる。
  // _getSections_ の filled 判定は原本マスター用（30字未満・★含む行を除外）で DRAFT 自動生成出力にはマッチしない。
  // DRAFT用に「§N見出し + 同章内に本文段落が1行以上ある」だけで filled と判定する。
  const docBody = draft.getBody();
  const num = docBody.getNumChildren();
  const filledMap = {};       // 親 sectionNo (number) → boolean（サブ無し本文有り or サブ1個以上記入有り）
  const filledSubMap = {};    // 親 sectionNo (number) → { subNo (number) → boolean }

  let currentNo = -1;
  let currentSubNo = -1;      // サブ無しの場合は -1
  let currentHasContent = false;
  function commitCurrent() {
    if (currentNo < 0 || !currentHasContent) return;
    if (currentSubNo >= 1) {
      if (!filledSubMap[currentNo]) filledSubMap[currentNo] = {};
      filledSubMap[currentNo][currentSubNo] = true;
      filledMap[currentNo] = true;
    } else {
      filledMap[currentNo] = true;
    }
  }

  for (let i = 0; i < num; i++) {
    const c = docBody.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = c.asParagraph();
    const heading = para.getHeading();
    const text = para.getText();

    if (heading === DocumentApp.ParagraphHeading.HEADING1) {
      // §N. または §N-M.（サブステップ）両対応
      const m = text.match(/^§(\d+)(?:-(\d+))?\.\s*(.*)$/);
      if (m) {
        commitCurrent();
        currentNo = parseInt(m[1], 10);
        currentSubNo = m[2] ? parseInt(m[2], 10) : -1;
        currentHasContent = false;
        continue;
      }
    }
    if (currentNo < 0) continue;

    // 本文判定（緩い版）: 空行・最終更新スタンプ・「（生成AI: ...）」イタリック行以外を1行でも持てば filled
    const trimmed = String(text || '').trim();
    if (!trimmed) continue;
    if (/^\[最終更新/.test(trimmed)) continue;
    if (/^（生成AI:/.test(trimmed)) continue;
    currentHasContent = true;
  }
  commitCurrent();

  // §99（決定ログ）は通常フェーズではないので除外して maxFilled を計算する
  const filledNos = Object.keys(filledMap).map(function(k) { return parseInt(k, 10); }).filter(function(n) { return !isNaN(n) && n !== 99; });
  const maxFilled = filledNos.length > 0 ? Math.max.apply(null, filledNos) : -1;

  // subFilledSections を文字列キーの配列形式に整形
  const subFilledSections = {};
  Object.keys(filledSubMap).forEach(function(k) {
    const n = parseInt(k, 10);
    if (isNaN(n) || n === 99) return;
    const subs = Object.keys(filledSubMap[k])
      .map(function(s) { return parseInt(s, 10); })
      .filter(function(s) { return !isNaN(s); })
      .sort(function(a, b) { return a - b; });
    if (subs.length > 0) subFilledSections[String(n)] = subs;
  });

  // GAS 側は素材データのみ返し、再開先の最終判定は拡張側で行う
  const nextSubSection = null;
  const nextSectionToWrite = maxFilled + 1;

  return {
    ok: true,
    draftDocId: draft.getId(),
    draftDocUrl: draft.getUrl(),
    draftDocTitle: draft.getName(),
    maxFilledSection: maxFilled,
    filledSections: filledNos.sort(function(a, b) { return a - b; }),
    subFilledSections: subFilledSections,
    nextSubSection: nextSubSection,
    nextSectionToWrite: nextSectionToWrite,
  };
}

// -----------------------------------------------------
// DRAFT Doc を URL/ID 指定で切り替える
// -----------------------------------------------------
function handle_setDraftDoc_(body) {
  const url = String(body.url || '').trim();
  if (!url) return { ok: false, error: 'url is required' };

  let docId = '';
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    docId = m[1];
  } else if (/^[a-zA-Z0-9_-]{20,}$/.test(url)) {
    docId = url;
  } else {
    return { ok: false, error: 'Doc IDをURLから抽出できません。Googleドキュメントの共有URL（/document/d/.../）を貼り付けてください' };
  }

  let doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    return { ok: false, error: 'このDocにアクセスできません: ' + e.message + '（権限／URLを確認してください）' };
  }

  PropertiesService.getScriptProperties().setProperty('SK_DRAFT_DOC_ID', docId);

  return {
    ok: true,
    draftDocId: docId,
    draftDocTitle: doc.getName(),
    draftDocUrl: doc.getUrl(),
  };
}

// =====================================================
// v0.10 新規ハンドラ
// =====================================================

/**
 * テンプレート原本 Doc ID を Web App 経由で登録する。
 * リクエスト body: { url } または { docId }
 */
function handle_setupTemplate_(body) {
  const raw = String((body && (body.url || body.docId)) || '').trim();
  if (!raw) return { ok: false, error: 'url または docId が必要です' };

  let docId = '';
  const m = raw.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    docId = m[1];
  } else if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) {
    docId = raw;
  } else {
    return { ok: false, error: 'Doc IDをURLから抽出できません。Googleドキュメントの共有URL を貼り付けてください' };
  }

  let file;
  try {
    file = DriveApp.getFileById(docId);
  } catch (e) {
    return { ok: false, error: 'テンプレート Doc にアクセスできません: ' + e.message };
  }

  PropertiesService.getScriptProperties().setProperty(SK_TEMPLATE_DOC_ID_KEY, docId);

  return {
    ok: true,
    templateDocId: docId,
    templateDocName: file.getName(),
    templateDocUrl: file.getUrl(),
  };
}

function handle_getTemplateInfo_(body) {
  const templateId = PropertiesService.getScriptProperties().getProperty(SK_TEMPLATE_DOC_ID_KEY);
  if (!templateId) return { ok: true, exists: false };
  try {
    const file = DriveApp.getFileById(templateId);
    return {
      ok: true,
      exists: true,
      templateDocId: templateId,
      templateDocName: file.getName(),
      templateDocUrl: file.getUrl(),
    };
  } catch (e) {
    return { ok: true, exists: false, error: 'テンプレートが見つかりません: ' + e.message };
  }
}

/**
 * Web App 経由でテンプレートから新規マスタードキュメントを生成。
 *
 * リクエスト body:
 *   {
 *     presetId: 'climbing-gym' | 'restaurant' | 'beauty-salon' | 'btob-creative' | 'retail' | 'generic',
 *     storeName, caseId, location, ownerName, stakeholders, monthlyBudget,
 *     businessType, periodStart, periodEnd,
 *     setActive: true  // 生成後に SK_DOC_ID を新Docへ切替（既定 false）
 *   }
 */
function handle_createMasterFromTemplate_(body) {
  const presetId = String((body && body.presetId) || 'generic');
  const setActive = !!(body && body.setActive);
  const inputs = {
    storeName: String((body && body.storeName) || '').trim(),
    caseId: String((body && body.caseId) || '').trim(),
    location: String((body && body.location) || '').trim(),
    ownerName: String((body && (body.ownerName || body.owner)) || '').trim(),
    stakeholders: String((body && body.stakeholders) || '').trim(),
    monthlyBudget: String((body && (body.monthlyBudget || body.budgetScale)) || '').trim(),
    businessType: String((body && body.businessType) || '').trim(),
    periodStart: String((body && body.periodStart) || '').trim(),
    periodEnd: String((body && body.periodEnd) || '').trim(),
  };

  let result;
  try {
    result = createMasterFromTemplate_(presetId, inputs);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 契約期間の追加差し替え（createMasterFromTemplate_ では未対応のため後処理）
  if (inputs.periodStart || inputs.periodEnd) {
    try {
      const newDoc = DocumentApp.openById(result.docId);
      _replaceContractPeriod_(newDoc.getBody(), inputs.periodStart, inputs.periodEnd);
      newDoc.saveAndClose();
    } catch (e) {
      Logger.log('contract-period replace failed: ' + e.message);
    }
  }

  if (setActive) {
    PropertiesService.getScriptProperties().setProperty('SK_DOC_ID', result.docId);
  }

  return {
    ok: true,
    docId: result.docId,
    docUrl: result.docUrl,
    name: result.name,
    presetId: presetId,
    activated: setActive,
  };
}

/**
 * §N 要点版を Web App 経由で追記。
 * リクエスト body: { sectionNo, summaryText, docId? }
 */
function handle_appendSectionSummary_(body) {
  const sectionNo = String((body && body.sectionNo) || '').replace(/[^0-9]/g, '');
  if (!sectionNo) return { ok: false, error: 'sectionNo is required' };
  const summaryText = String((body && (body.summaryText || body.summary || body.text)) || '').trim();
  if (!summaryText) return { ok: false, error: 'summaryText is required' };
  const docId = body && body.docId ? String(body.docId).trim() : '';

  try {
    const result = appendSectionSummary_(sectionNo, summaryText, docId);
    return { ok: true, sectionNo: sectionNo, action: result.action };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * §N 要点版を Web App 経由で取得。
 * リクエスト body: { sectionNo, docId? }
 */
function handle_getSectionSummary_(body) {
  const sectionNo = String((body && body.sectionNo) || '').replace(/[^0-9]/g, '');
  if (!sectionNo) return { ok: false, error: 'sectionNo is required' };
  const docId = body && body.docId ? String(body.docId).trim() : '';

  try {
    return getSectionSummary_(sectionNo, docId);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
