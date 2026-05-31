/**
 * STRATEGY-KIT shim — 受講者貼付用（v0.11.0）
 *
 * このファイルは1回だけ貼ればOK。以降のロジック更新は StrategyKitLib
 * ライブラリ側で行われ、自動的に反映されます（developmentMode: true）。
 *
 * 必要事項:
 *   1) Apps Script のメニュー「ライブラリ → ライブラリを追加」で
 *      StrategyKitLib のスクリプトIDを入力し、識別子は `StrategyKitLib`
 *      バージョンは「HEAD（開発モード）」を選ぶ
 *   2) スクリプトプロパティに `GEMINI_API_KEY` を追加（任意）
 *   3) このファイルを Apps Script プロジェクトに貼り付け
 *   4) 「ウェブアプリとしてデプロイ」→ アクセス権限「Google アカウントを持っているユーザー」
 *   5) 発行された URL を Chrome 拡張のオプション画面に登録
 */

// =====================================================
// 1. メニュー
// =====================================================

function onOpen() {
  try {
    const active = DocumentApp.getActiveDocument();
    if (!active) return;
    const props = PropertiesService.getScriptProperties();
    const activeId = active.getId();
    const templateId = props.getProperty('SK_TEMPLATE_DOC_ID');
    // テンプレート原本を SK_DOC_ID に設定すると、メニューから「テンプレート原本に書き込む」
    // 操作が走って原本を破壊するリスクがある。テンプレート原本では SK_DOC_ID を上書きしない。
    if (activeId !== templateId) {
      props.setProperty('SK_DOC_ID', activeId);
    }

    const ui = DocumentApp.getUi();
    ui.createMenu('STRATEGY-KIT')
      .addItem('テンプレート原本セットアップ（初回のみ）', 'sk_setupTemplate')
      .addSeparator()
      .addSubMenu(
        ui.createMenu('新規マスタードキュメント作成')
          .addItem('クライミングジム', 'sk_createMasterClimbingGym')
          .addItem('飲食店', 'sk_createMasterRestaurant')
          .addItem('美容室・整体院', 'sk_createMasterBeautySalon')
          .addItem('BtoB制作・受託', 'sk_createMasterBtobCreative')
          .addItem('小売・物販', 'sk_createMasterRetail')
          .addSeparator()
          .addItem('汎用（業種非依存）', 'sk_createMasterGeneric')
      )
      .addSeparator()
      .addItem('§99 決定ログに追記', 'sk_appendDecision')
      .addItem('章末タイムスタンプを更新', 'sk_updateTimestamps')
      .addItem('§N 要点版を生成・追記（手動）', 'sk_appendSectionSummary')
      .addSeparator()
      .addItem('使い方', 'sk_showHelp')
      .addToUi();
  } catch (e) {
    Logger.log('onOpen skipped: ' + e.message);
  }
}

// =====================================================
// 2. メニューハンドラ（ライブラリへの委譲）
// =====================================================

function sk_setupTemplate() { return StrategyKitLib.uiSetupTemplate(_props_()); }
function sk_createMasterGeneric() { return StrategyKitLib.uiCreateMaster('generic', _props_()); }
function sk_createMasterClimbingGym() { return StrategyKitLib.uiCreateMaster('climbing-gym', _props_()); }
function sk_createMasterRestaurant() { return StrategyKitLib.uiCreateMaster('restaurant', _props_()); }
function sk_createMasterBeautySalon() { return StrategyKitLib.uiCreateMaster('beauty-salon', _props_()); }
function sk_createMasterBtobCreative() { return StrategyKitLib.uiCreateMaster('btob-creative', _props_()); }
function sk_createMasterRetail() { return StrategyKitLib.uiCreateMaster('retail', _props_()); }
function sk_appendDecision() { return StrategyKitLib.uiAppendDecision(_props_()); }
function sk_updateTimestamps() { return StrategyKitLib.uiUpdateTimestamps(_props_()); }
function sk_appendSectionSummary() { return StrategyKitLib.uiAppendSectionSummary(_props_()); }
function sk_showHelp() { return StrategyKitLib.uiShowHelp(_props_()); }

// =====================================================
// 3. Web App エンドポイント
// =====================================================

function doPost(e) { return StrategyKitLib.route(e, _props_()); }
function doGet(e) { return StrategyKitLib.route(e, _props_()); }

// =====================================================
// 4. シート用カスタム関数（任意・スプレッドシートから使うとき）
// =====================================================

/**
 * @customfunction
 */
function GEMINI(prompt, model, temperature) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  return StrategyKitLib.geminiCustom(prompt, model, temperature, apiKey);
}

/**
 * @customfunction
 */
function GEMINI_BATCH(range, prefix, model) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  return StrategyKitLib.geminiBatchCustom(range, prefix, model, apiKey);
}

// =====================================================
// 5. プロパティアクセスヘルパ
// =====================================================

function _props_() {
  const p = PropertiesService.getScriptProperties();
  return {
    SK_DOC_ID: p.getProperty('SK_DOC_ID'),
    SK_DRAFT_DOC_ID: p.getProperty('SK_DRAFT_DOC_ID'),
    SK_TEMPLATE_DOC_ID: p.getProperty('SK_TEMPLATE_DOC_ID'),
    GEMINI_API_KEY: p.getProperty('GEMINI_API_KEY'),
    setProperty: function(k, v) { p.setProperty(k, v); },
    getProperty: function(k) { return p.getProperty(k); },
  };
}
