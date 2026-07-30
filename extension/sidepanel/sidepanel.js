// STRATEGY-KIT サイドパネル
// 役割:
//   1) prompts.json / industries.json をロード
//   2) 業種・店舗・現在フェーズ・リサーチ状態の管理
//   3) フェーズタブとリサーチサイクルタブの切替
//   4) プロンプトの★置換と挿入

const AI_URLS = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  manus: 'https://manus.im/',
  genspark: 'https://www.genspark.ai/',
  perplexity: 'https://www.perplexity.ai/',
  notebooklm: 'https://notebooklm.google.com/',
  grok: 'https://grok.com/',
  'google-docs': 'https://docs.google.com/',
};

const AI_LABELS = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  manus: 'Manus',
  genspark: 'Genspark',
  perplexity: 'Perplexity',
  notebooklm: 'NotebookLM',
  grok: 'Grok',
  'google-docs': 'Google Docs',
};

const DEFAULT_PHASE_TOTAL = 10;
const META_SYNC_DEBOUNCE_MS = 1000;
const ENGAGEMENT_MODE_KEY = 'sk_engagement_mode';
const HEARING_RAWTEXT_LOCAL_KEY = 'sk_hearing_rawtext_v012_local';
// HEARING_SUMMARY_KEY は in-memory の state.settings 上のキー（§1 注入の参照元）。
// v3.5: 保存先は chrome.storage.local の HEARING_SUMMARY_LOCAL_KEY に移行（sync 8KB/item クォータ回避）。
//   旧 sync キー sk_hearing_summary_v012 はマイグレーション元として残し、移行後に sync から削除する。
const HEARING_SUMMARY_KEY = 'sk_hearing_summary_v012';
const HEARING_SUMMARY_LOCAL_KEY = 'sk_hearing_summary_v013_local';
const HEARING_SUMMARY_LEGACY_SYNC_KEY = 'sk_hearing_summary_v012';
const HEARING_NOTES_KEY = 'sk_hearing_notes_v012';
// v0.13: 案件整合メタ + skip ack（F2: 別案件の古い要約で全自動が走る事故を防ぐ）
const HEARING_META_KEY = 'sk_hearing_meta_v013';
const HEARING_SKIP_ACK_KEY = 'sk_hearing_skip_ack_v013';
const HEARING_SUMMARY_HARD_LIMIT = 6000;

// hearing-readiness.js（純ロジック）は ESM。classic script の sidepanel.js からは
// 起動時に動的 import して同期参照できるよう保持する。
let hearingReadinessModule = null;
async function ensureHearingReadinessModule() {
  if (hearingReadinessModule) return hearingReadinessModule;
  hearingReadinessModule = await import(chrome.runtime.getURL('phase0/hearing-readiness.js'));
  return hearingReadinessModule;
}

function getAiOrigin(site) {
  const url = AI_URLS[site];
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

async function findExistingAiTab(site) {
  const origin = getAiOrigin(site);
  if (!origin) return null;
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  if (!tabs.length) return null;

  const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);
  if (focusedWindow?.id) {
    const inFocusedWindow = tabs.find((tab) => tab.windowId === focusedWindow.id);
    if (inFocusedWindow) return inFocusedWindow;
  }
  return tabs[0];
}

async function openOrFocusAiTab(site) {
  const url = AI_URLS[site];
  if (!url) return null;

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'OPEN_OR_FOCUS_AI_TAB',
      site,
      url,
    });
    if (resp?.ok) return resp;
  } catch (e) {
    // background 不達時はローカルでフォールバック
  }

  const existingTab = await findExistingAiTab(site);
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
    }
    return { ok: true, reused: true, tabId: existingTab.id };
  }
  const created = await chrome.tabs.create({ url });
  return { ok: true, created: true, tabId: created?.id || null };
}

let currentLocationState = null;

function renderCurrentLocationBar() {
  const bar = document.getElementById('current-location-bar');
  const text = document.getElementById('current-location-text');
  const eyebrow = document.getElementById('current-location-eyebrow');
  if (!bar || !text || !eyebrow) return;

  if (!currentLocationState || !currentLocationState.text) {
    bar.classList.add('hidden');
    text.textContent = '—';
    eyebrow.textContent = '現在地';
    return;
  }

  eyebrow.textContent = currentLocationState.eyebrow || '現在地';
  text.textContent = currentLocationState.text;
  bar.classList.remove('hidden');
}

function setCurrentLocation(payload) {
  currentLocationState = payload && payload.text ? payload : null;
  renderCurrentLocationBar();
}

function clearCurrentLocation() {
  currentLocationState = null;
  renderCurrentLocationBar();
}

function showSavingOverlay(title, text) {
  const overlay = document.getElementById('saving-overlay');
  const titleEl = document.getElementById('saving-overlay-title');
  const textEl = document.getElementById('saving-overlay-text');
  if (!overlay || !titleEl || !textEl) return;
  titleEl.textContent = title || '保存中…';
  textEl.textContent = text || 'Drive と DRAFT に書き込み中です';
  overlay.classList.remove('hidden');
}

function hideSavingOverlay() {
  const overlay = document.getElementById('saving-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// 全AIのリスト（プロンプトのfor属性に依存しない）
const ALL_AIS = ['claude', 'chatgpt', 'gemini', 'manus', 'genspark', 'perplexity', 'grok', 'notebooklm'];

const state = {
  industries: null,
  prompts: null,
  aiProfiles: null,
  platforms: null,
  productConfig: null,
  settings: {
    industry: 'generic',
    industryLabel: '',
    storeName: '',
    caseId: '',
    caseName: '',
    lastPhase: 'phase-0',
    lastTab: 'phases',
    researchTopic: '',
    researchNo: '01',
    researchPhaseLink: '',
    showSafetyNotice: true,
    setupCollapsed: true,
    missionHeaderCollapsed: false,
    [ENGAGEMENT_MODE_KEY]: '',
    [HEARING_SUMMARY_KEY]: '',
    [HEARING_NOTES_KEY]: '',
    [HEARING_META_KEY]: null,
    [HEARING_SKIP_ACK_KEY]: null,
  },
  modeLocal: {
    [HEARING_RAWTEXT_LOCAL_KEY]: '',
    automationExecutionMode: 'semi',
    hearingSummaryDraft: '',
    hearingStatus: 'idle',
    hearingStatusMessage: '',
    geminiSummarizerAvailable: false,
    geminiSummarizerChecked: false,
    modeSelectorExpanded: false,
    statusClusterExpanded: null,
  },
};

const MISSION_TASK_STORAGE_KEY = 'sk_task_monitor_v1';
let missionTaskSnapshot = null;

// 全画面コマンドセンター(mission.html)との受け渡し用キー(sk-state.ui.* 配下)。
//   - missionSnapshot: サイドパネル → mission (phases / 進捗 / 案件名 の raw 入力を publish)
//   - missionCommand : mission → サイドパネル (既存の実行・フェーズ・AI・Docs操作へ委譲)
//   - missionCommandResult: サイドパネル → mission (受付結果とユーザー向けメッセージ)
const MISSION_SNAPSHOT_STORAGE_KEY = 'sk-state.ui.missionSnapshot';
const MISSION_COMMAND_STORAGE_KEY = 'sk-state.ui.missionCommand';
const MISSION_COMMAND_RESULT_STORAGE_KEY = 'sk-state.ui.missionCommandResult';
const AUTOMATION_EXECUTION_MODE_PATH = 'automation.executionMode';
let lastMissionSnapshotSignature = '';
let lastMissionCommandTs = 0;

let metaSyncTimer = null;
let metaSyncInFlight = false;
let lastMetaSyncSignature = '';
let sidepanelInitialized = false;
let stableRenderRaf = 0;

async function loadJson(path) {
  const url = chrome.runtime.getURL(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('failed to load ' + path);
  return res.json();
}

// product.json を読んで製品設定を解決する（Webマーケ版 / SNS 版の間接化）。
// loadJson を注入式にして外部依存のない純関数に保つ（options.js と共有・テスト容易化）。
// product.json が無い・壊れている場合は現行ハードコードパスへ完全フォールバックする。
const PRODUCT_CONFIG_FALLBACK = {
  productLine: 'strategy-kit-v0.11',
  promptsPath: 'data/prompts.json',
  benchmarkSource: 'industry',
  benchmarkPath: 'data/industries.json',
  branding: { name: 'STRATEGY-KIT Helper', footerLabel: 'STRATEGY-KIT' },
};

// branding 各キーの解決ヘルパー（product.json 未読・欠落時は STRATEGY-KIT 文言へフォールバック）。
// state.productConfig.branding を単一情報源にして、表示文言を製品横断で間接化する。
function getBranding() {
  return (state.productConfig && state.productConfig.branding) || null;
}
function brandFooterLabel() {
  const b = getBranding();
  return (b && b.footerLabel) || 'STRATEGY-KIT';
}
function brandPurposeLabel() {
  const b = getBranding();
  return (b && b.purposeLabel) || 'マーケティング戦略立案';
}

async function resolveProductConfig(loadJsonFn) {
  let raw = null;
  try {
    raw = await loadJsonFn('product.json');
  } catch (e) {
    raw = null;
  }
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    productLine: cfg.productLine || PRODUCT_CONFIG_FALLBACK.productLine,
    promptsPath: cfg.promptsPath || PRODUCT_CONFIG_FALLBACK.promptsPath,
    benchmarkSource:
      cfg.benchmarkSource === 'platform' ? 'platform' : PRODUCT_CONFIG_FALLBACK.benchmarkSource,
    benchmarkPath: cfg.benchmarkPath || PRODUCT_CONFIG_FALLBACK.benchmarkPath,
    branding: cfg.branding && typeof cfg.branding === 'object'
      ? cfg.branding
      : PRODUCT_CONFIG_FALLBACK.branding,
  };
}

// 製品設定に従い prompts / industries / platforms / ai-profiles をまとめてロードする。
// industries.json と ai-profiles.json は両製品で常時ロード（業種プリセット UI が使うため）。
// benchmarkSource==="platform" のときのみ追加で platforms（benchmarkPath）をロードする。
async function loadProductData(loadJsonFn) {
  const config = await resolveProductConfig(loadJsonFn);
  const [industries, prompts, aiProfiles] = await Promise.all([
    loadJsonFn('data/industries.json'),
    loadJsonFn(config.promptsPath),
    loadJsonFn('data/ai-profiles.json'),
  ]);
  let platforms = null;
  if (config.benchmarkSource === 'platform') {
    try {
      platforms = await loadJsonFn(config.benchmarkPath);
    } catch (e) {
      platforms = null;
    }
  }
  return { config, industries, prompts, aiProfiles, platforms };
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'on')
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'text') node.textContent = v;
    else if (k === 'attrs')
      for (const [a, b] of Object.entries(v)) node.setAttribute(a, b);
    else if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else node[k] = v;
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// 専門用語ツールチップ定義
const GLOSSARY = {
  'マスタードキュメント': 'マーケ戦略の元になるGoogleドキュメント。§0〜§9 と §99 決定ログの記入欄が並び、AIの出力を確認しながら自分の言葉で転記・蓄積していく場所です。',
  'DRAFT': 'マスタードキュメントのコピー版。AIが書いた草稿を貼る場所。原本には直接書き込まず、DRAFTで確認してから転記します。',
  '§99 決定ログ': '章末に「いつ・なぜ・誰が決めたか」を記録する欄。後から判断の根拠を振り返れるようにするためのログです。',
  '★置換': 'プロンプト内の★店舗名★・★業種★などの穴埋め部分を、業種プリセットや入力値で自動的に置き換える仕組みです。',
  'クロス3C': 'Customer（顧客）・Competitor（競合）・Company（自社）の3つの重なる中心にある要素 ＝ KSF（重要成功要因）を見つける分析フレームです。',
  'KSF': 'Key Success Factor（重要成功要因）。その業界で勝つために必ず押さえておかなければならない要素のことです。',
  'USP': 'Unique Selling Proposition。他社にはない自社だけの独自の強み。お客様が「ここじゃないとダメ」と感じる理由です。',
  '4P': '4P＝Product（商品）・Price（価格）・Place（流通）・Promotion（販促）。マーケティング戦略を整理する4つの視点です。',
  '4C': '4C＝Customer Value（顧客価値）・Cost（顧客コスト）・Convenience（利便性）・Communication（対話）。4Pを顧客目線で言い換えたフレームです。',
  '4P/4C': '4P（Product/Price/Place/Promotion）と4C（Customer Value/Cost/Convenience/Communication）。企業視点と顧客視点の両側からマーケ戦略を整理するフレームです。',
  'STP': 'Segmentation（市場細分化）・Targeting（ターゲット選定）・Positioning（自社の立ち位置）の頭文字。誰に・どんな価値を・どう伝えるかを決める戦略手順です。',
  'Mermaid': 'テキストで図（フローチャート・マインドマップなど）を書く記法。Mermaid Live Editorにコードを貼ると画像として出力できます。',
  '半自動チェーン': '1フェーズずつAIに投げて、出力を確認・貼り付けしながら次に進む方式。全自動より時間はかかりますが、各ステップで内容を確認できます。',
  '業種プリセット': 'クライミングジム・飲食店など業種ごとに事前定義した想定値セット。選ぶとプロンプトの穴埋め（★業種★など）を自動で埋めます。',
  // R7: 追加
  '全自動モード': 'Gemini API一本で§0〜§9を順番に自動生成する方式。半自動チェーンより速いですが、各章の内容は事後確認が必要です。',
  'リサーチサイクル': '1次調査 → 2次調査 → ファクトチェック → 統合 の4ステップでフェーズを掘り下げる仕組み。半自動チェーンの中で発動できます。',
  'Executive Summary': 'A4 1枚相当に戦略全体を要約したドキュメント。経営者・上司への共有用です。DRAFT後処理から生成できます。',
  'SWOT': 'Strengths（強み）・Weaknesses（弱み）・Opportunities（機会）・Threats（脅威）の4軸で自社を分析する古典的フレームです。',
  '5Forces': 'マイケル・ポーターが提唱した業界構造分析の5つの力（新規参入／代替品／買い手／売り手／既存競合）。業界の魅力度を測ります。',
  'PEST': 'Politics（政治）・Economy（経済）・Society（社会）・Technology（技術）。自社を取り巻くマクロ環境を整理するフレームです。',
  'KPI': 'Key Performance Indicator（重要業績評価指標）。目標達成のために日々追う数値（来店数・リピート率等）。',
  'KGI': 'Key Goal Indicator（重要目標達成指標）。最終ゴールの数値（年間売上目標等）。KPIの上位概念です。',
};

/**
 * テキストノードを返す。glossaryに一致する用語があればツールチップspanに変換。
 * @param {string} text
 * @returns {Node}
 */
function makeGlossaryNode(text) {
  // 用語が含まれている場合はspanで囲む（最初に一致したものだけ）
  for (const [term, tip] of Object.entries(GLOSSARY)) {
    const idx = text.indexOf(term);
    if (idx !== -1) {
      const frag = document.createDocumentFragment();
      if (idx > 0) frag.appendChild(document.createTextNode(text.slice(0, idx)));
      const span = document.createElement('span');
      span.className = 'tooltip';
      span.dataset.tip = tip;
      span.textContent = term;
      const sup = document.createElement('sup');
      sup.textContent = '?';
      span.appendChild(sup);
      frag.appendChild(span);
      const after = text.slice(idx + term.length);
      if (after) frag.appendChild(document.createTextNode(after));
      return frag;
    }
  }
  return document.createTextNode(text);
}

function applyTemplate(text) {
  const mode = getEngagementMode();
  const businessContext = buildBusinessContextForMode(mode);
  const industry =
    state.settings.industryLabel ||
    state.industries?.items.find((i) => i.id === state.settings.industry)
      ?.label ||
    '';
  const store = state.settings.storeName || '';
  const topic = state.settings.researchTopic || '';
  const no = state.settings.researchNo || 'NN';
  // SNS 版トークン。★アカウント名★ は店舗名入力の読み替え（store を流用）。
  // ★プラットフォーム★ は state.platforms（benchmarkSource==="platform" でのみロード）の
  // default アイテムの label。platforms 未ロード時（Webマーケ版）は空 → 置換しない
  // （prompts.json は当該トークンを含まないため無害）。
  const platformLabel = (() => {
    const plats = state.platforms;
    if (!plats || !Array.isArray(plats.items)) return '';
    const def = plats.items.find((p) => p.id === plats.default) || plats.items[0];
    return (def && def.label) || '';
  })();

  let out = String(text || '');
  out = out
    .replaceAll('{{businessContext}}', businessContext)
    .replaceAll('{{ businessContext }}', businessContext);
  if (industry)
    out = out
      .replaceAll('★業種★', industry)
      .replaceAll('★業種（例: クライミングジム）★', industry);
  if (store)
    out = out
      .replaceAll('★店舗名★', store)
      .replaceAll('★店舗・屋号★', store)
      .replaceAll('★アカウント名★', store);
  if (platformLabel)
    out = out.replaceAll('★プラットフォーム★', platformLabel);
  if (industry && store)
    out = out.replaceAll('★業種・店舗★', `${industry} / ${store}`);
  if (topic)
    out = out
      .replaceAll('★テーマ★', topic)
      .replaceAll('★テーマ（例: 業種のPEST／競合A社の戦略／40代女性顧客の購買動機）★', topic)
      .replaceAll('★1次と同じテーマ★', topic);
  out = out
    .replaceAll('research-NN-primary.md', `research-${no}-primary.md`)
    .replaceAll('research-NN-secondary.md', `research-${no}-secondary.md`)
    .replaceAll('research-NN-factcheck.md', `research-${no}-factcheck.md`)
    .replaceAll('research-NN-integrated.md', `research-${no}-integrated.md`);
  return out;
}

const Q2_ACTION_CATEGORIES = [
  {
    id: 'quick_win_1',
    label: 'Quick Win 1',
    aliases: ['quick win 1', 'quickwin1', 'qw1', 'クイックウィン1', 'クイックウィン 1'],
  },
  {
    id: 'quick_win_2',
    label: 'Quick Win 2',
    aliases: ['quick win 2', 'quickwin2', 'qw2', 'クイックウィン2', 'クイックウィン 2'],
  },
  {
    id: 'steady',
    label: '地道',
    aliases: ['steady', 'jimidou', 'jimi', '地道施策'],
  },
  {
    id: 'mid_long',
    label: '中長期',
    aliases: ['mid_long', 'mid long', 'mid-long', 'long', '中長期施策'],
  },
  {
    id: 'worst_case',
    label: '最悪',
    aliases: ['worst', 'worst_case', 'worst case', '最悪シナリオ'],
  },
];

function normalizeQ2Header(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function normalizeQ2Category(raw) {
  const original = String(raw || '').trim();
  const key = original
    .replace(/\s+/g, ' ')
    .replace(/[（）()]/g, '')
    .trim()
    .toLowerCase();
  for (const category of Q2_ACTION_CATEGORIES) {
    if (key === category.label.toLowerCase()) {
      return { ok: true, id: category.id, label: category.label, warning: '' };
    }
    if (category.aliases.includes(key)) {
      return {
        ok: true,
        id: category.id,
        label: category.label,
        warning: `カテゴリ表記「${original}」を「${category.label}」として扱いました。`,
      };
    }
  }
  return { ok: false, id: '', label: original, warning: `カテゴリラベルが不正です: ${original || '空欄'}` };
}

function splitQ2MarkdownRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function isQ2SeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function parseQ2MarkdownTable(text, requiredColumns) {
  const lines = String(text || '').split(/\r?\n/);
  const required = requiredColumns.map(normalizeQ2Header);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const headerCells = splitQ2MarkdownRow(lines[i]);
    if (!headerCells.length) continue;
    const normalizedHeaders = headerCells.map(normalizeQ2Header);
    const hasAllRequired = required.every((column) => normalizedHeaders.includes(column));
    if (!hasAllRequired) continue;

    const headerIndexByKey = {};
    normalizedHeaders.forEach((key, index) => {
      if (!headerIndexByKey[key]) headerIndexByKey[key] = index;
    });
    const rows = [];
    let j = i + 1;
    while (j < lines.length) {
      const cells = splitQ2MarkdownRow(lines[j]);
      if (!cells.length) break;
      if (isQ2SeparatorRow(cells)) {
        j++;
        continue;
      }
      const row = {};
      normalizedHeaders.forEach((key, index) => {
        row[key] = cells[index] || '';
      });
      rows.push(row);
      j++;
    }
    tables.push({ headers: normalizedHeaders, headerIndexByKey, rows });
  }
  return tables;
}

function readQ2Cell(row, labels) {
  for (const label of labels) {
    const key = normalizeQ2Header(label);
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return String(row[key] || '').trim();
    }
  }
  return '';
}

function parseQ2Score(value) {
  const normalized = String(value || '').replace(/[^\d.]/g, '');
  if (!normalized) return null;
  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return num;
}

function normalizeQ2ComparisonValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseQ2ActionCandidates(text) {
  const tables = parseQ2MarkdownTable(text, [
    'candidate_id',
    'category_label',
    '詰まりポイント',
    'Reach_1_5',
    'Impact_1_5',
    'Confidence_1_5',
    'Effort_1_5',
  ]);
  const candidates = [];
  for (const table of tables) {
    for (const row of table.rows) {
      const candidateId = readQ2Cell(row, ['candidate_id']);
      if (!candidateId) continue;
      candidates.push({
        candidate_id: candidateId,
        category_label: readQ2Cell(row, ['category_label']),
        intent: readQ2Cell(row, ['戦略の意図']),
        bottleneck: readQ2Cell(row, ['詰まりポイント', 'ボトルネック', 'bottleneck']),
        action_name: readQ2Cell(row, ['施策名', '施策', '施策（具体アクション）']),
        channel: readQ2Cell(row, ['チャネル']),
        peso: readQ2Cell(row, ['PESO']),
        kpi: readQ2Cell(row, ['KPI', 'KPI（指標）']),
        budget: readQ2Cell(row, ['予算円', '予算（円）']),
        effort_work: readQ2Cell(row, ['工数人日月', '工数（人日/月）']),
        owner: readQ2Cell(row, ['担当']),
        dependency: readQ2Cell(row, ['依存条件']),
        reach: parseQ2Score(readQ2Cell(row, ['Reach_1_5'])),
        impact: parseQ2Score(readQ2Cell(row, ['Impact_1_5'])),
        confidence: parseQ2Score(readQ2Cell(row, ['Confidence_1_5'])),
        effort: parseQ2Score(readQ2Cell(row, ['Effort_1_5'])),
        rice_score: parseQ2Score(readQ2Cell(row, ['rice_score'])),
      });
    }
  }
  return candidates;
}

function computeQ2Rice(candidate) {
  const reach = Number(candidate.reach);
  const impact = Number(candidate.impact);
  const confidence = Number(candidate.confidence);
  const effort = Number(candidate.effort);
  if (![reach, impact, confidence, effort].every((num) => Number.isFinite(num) && num >= 1 && num <= 5)) {
    return null;
  }
  if (effort === 0) return null;
  return Math.round((reach * impact * confidence / effort) * 10) / 10;
}

function compareQ2Candidates(a, b) {
  const riceDiff = (b.computed_rice || 0) - (a.computed_rice || 0);
  if (riceDiff !== 0) return riceDiff;
  const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
  if (confidenceDiff !== 0) return confidenceDiff;
  const effortDiff = (a.effort || 0) - (b.effort || 0);
  if (effortDiff !== 0) return effortDiff;
  return String(a.candidate_id || '').localeCompare(String(b.candidate_id || ''), 'en');
}

function buildQ2RegenerationPrompt(errors) {
  return [
    '次の不備があるため、Phase 6 の施策ブレスト20案を同じ schema で再生成してください。',
    '',
    ...errors.map((error) => `- ${error}`),
    '',
    '必須条件:',
    '- 20案ちょうど',
    '- category_label は Quick Win 1 / Quick Win 2 / 地道 / 中長期 / 最悪 の5つだけ',
    '- 5カテゴリを最低1案ずつ含める',
    '- RICE = Reach x Impact x Confidence / Effort',
    '- 候補1個カテゴリは forced_single_candidate、候補2個以上は rice_top',
    '- Quick Win 2 は Quick Win 1 と異なる PESO / チャネル / 詰まりポイントにする',
  ].join('\n');
}

function buildQ2SelectionPlan(candidates) {
  const errors = [];
  const warnings = [];
  const normalized = [];
  const seenIds = new Set();

  if (candidates.length !== 20) {
    errors.push(`20案ちょうど必要です（現在 ${candidates.length} 案）`);
  }

  for (const candidate of candidates) {
    const id = String(candidate.candidate_id || '').trim();
    if (!/^C\d{2}$/i.test(id)) errors.push(`candidate_id が不正です: ${id || '空欄'}`);
    const idKey = id.toUpperCase();
    if (idKey && seenIds.has(idKey)) errors.push(`candidate_id が重複しています: ${id}`);
    if (idKey) seenIds.add(idKey);

    const category = normalizeQ2Category(candidate.category_label);
    if (!category.ok) errors.push(category.warning);
    else if (category.warning) warnings.push(category.warning);

    const computedRice = computeQ2Rice(candidate);
    if (computedRice === null) errors.push(`${id || 'candidate'} のRICE項目が不足しています`);
    if (!candidate.action_name || !candidate.bottleneck || !candidate.budget || !candidate.effort_work || !candidate.owner || !candidate.dependency) {
      errors.push(`${id || 'candidate'} の必須列に空欄があります`);
    }
    if (
      computedRice !== null &&
      Number.isFinite(candidate.rice_score) &&
      Math.abs(candidate.rice_score - computedRice) >= 0.2
    ) {
      warnings.push(`${id} の rice_score を ${candidate.rice_score} から ${computedRice} として再計算しました。`);
    }

    normalized.push({
      ...candidate,
      candidate_id: idKey || id,
      category_id: category.id,
      category_label: category.label,
      computed_rice: computedRice,
    });
  }

  const selected = [];
  const reserves = {};
  for (const category of Q2_ACTION_CATEGORIES) {
    const group = normalized.filter((candidate) => candidate.category_id === category.id);
    if (!group.length) {
      errors.push(`カテゴリ「${category.label}」の候補がありません`);
      continue;
    }
    const sorted = group.slice().sort(compareQ2Candidates);
    if (sorted.length === 1) {
      selected.push({
        slot: selected.length + 1,
        category_id: category.id,
        category_label: category.label,
        candidate: sorted[0],
        selection_type: 'forced_single_candidate',
        note: 'このカテゴリは候補が1個だけなので、自動採用しました。',
      });
      reserves[category.id] = [];
      continue;
    }
    selected.push({
      slot: selected.length + 1,
      category_id: category.id,
      category_label: category.label,
      candidate: sorted[0],
      selection_type: 'rice_top',
      note: 'このカテゴリは候補が2個以上あるため、RICE上位を採用しました。',
    });
    reserves[category.id] = sorted.slice(1, 2);
  }

  if (selected.length !== Q2_ACTION_CATEGORIES.length) {
    errors.push('Quick Win 1 / Quick Win 2 / 地道 / 中長期 / 最悪 の5枠が揃っていません');
  }

  const quickWin1 = selected.find((item) => item.category_id === 'quick_win_1')?.candidate || null;
  const quickWin2 = selected.find((item) => item.category_id === 'quick_win_2')?.candidate || null;
  if (quickWin1 && quickWin2) {
    const samePeso = normalizeQ2ComparisonValue(quickWin1.peso) &&
      normalizeQ2ComparisonValue(quickWin1.peso) === normalizeQ2ComparisonValue(quickWin2.peso);
    const sameChannel = normalizeQ2ComparisonValue(quickWin1.channel) &&
      normalizeQ2ComparisonValue(quickWin1.channel) === normalizeQ2ComparisonValue(quickWin2.channel);
    const sameBottleneck = normalizeQ2ComparisonValue(quickWin1.bottleneck) &&
      normalizeQ2ComparisonValue(quickWin1.bottleneck) === normalizeQ2ComparisonValue(quickWin2.bottleneck);
    if (samePeso && sameChannel && sameBottleneck) {
      errors.push('Quick Win 1 / Quick Win 2 は PESO / チャネル / 詰まりポイント のいずれかを必ず変えてください');
    }
  }

  if (errors.length) {
    return {
      ok: false,
      errors,
      warnings,
      candidates: normalized,
      selected: [],
      reserves: {},
      regenerationPrompt: buildQ2RegenerationPrompt(errors),
    };
  }

  return {
    ok: true,
    errors: [],
    warnings,
    candidates: normalized,
    selected: selected.map((item, index) => ({ ...item, slot: index + 1 })),
    reserves,
    regenerationPrompt: '',
  };
}

function validateQ2Phase7Output(text) {
  const missing = Q2_ACTION_CATEGORIES
    .filter((category) => !String(text || '').includes(category.label))
    .map((category) => category.label);
  if (missing.length) {
    const warnings = [`Phase 7 出力にカテゴリが不足しています: ${missing.join(' / ')}`];
    return {
      applies: true,
      ok: true,
      errors: [],
      warnings,
      regenerationPrompt: '',
      appendix: '',
      plan: null,
    };
  }
  return {
    applies: true,
    ok: true,
    errors: [],
    warnings: ['Phase 7 出力に5カテゴリ label が含まれています。§6-4 の5枠を維持しているか確認してください。'],
    regenerationPrompt: '',
    appendix: '',
    plan: null,
  };
}

function validateQ2FilteringOutput(text, phase) {
  const phaseNo = String(phase?.no ?? '');
  const phaseId = String(phase?.id || '');
  if (phaseNo !== '6' && phaseNo !== '7' && phaseId !== 'phase-6' && phaseId !== 'phase-7') {
    return { applies: false, ok: true, errors: [], warnings: [], appendix: '', regenerationPrompt: '', plan: null };
  }
  if (phaseNo === '7' || phaseId === 'phase-7') {
    return validateQ2Phase7Output(text);
  }
  const candidates = parseQ2ActionCandidates(text);
  const plan = buildQ2SelectionPlan(candidates);
  return {
    applies: true,
    ok: plan.ok,
    errors: plan.errors,
    warnings: plan.warnings,
    appendix: plan.ok ? formatQ2SelectionAppendix(plan) : '',
    regenerationPrompt: plan.regenerationPrompt,
    plan,
  };
}

function formatQ2SelectionAppendix(plan) {
  if (!plan || !plan.ok) return '';
  const lines = [
    '',
    '---',
    '',
    '## ' + brandFooterLabel() + ' 自動確認: 5枠選定',
    '| slot | category_label | selected_candidate_id | 施策名 | computed_rice | selection_type | note |',
    '|---:|---|---|---|---:|---|---|',
  ];
  for (const item of plan.selected) {
    lines.push([
      `| ${item.slot}`,
      item.category_label,
      item.candidate.candidate_id,
      item.candidate.action_name || '（施策名未入力）',
      String(item.candidate.computed_rice ?? ''),
      item.selection_type,
      item.note,
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderQ2FilteringPreview(container, result) {
  if (!container) return;
  clearChildren(container);
  if (!result || !result.applies) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const title = result.ok
    ? '5カテゴリの確認ができました。Quick Win 1 / Quick Win 2 / 地道 / 中長期 / 最悪 の5枠が揃っています。'
    : 'カテゴリラベル、RICE項目、candidate_id のいずれかが不足しています。再生成してから保存してください。';
  container.appendChild(el('div', {
    style: `font-size:11px;font-weight:700;margin-bottom:6px;color:${result.ok ? '#166534' : '#b91c1c'}`,
    text: title,
  }));
  const messages = []
    .concat(result.errors || [])
    .concat(result.warnings || []);
  if (messages.length) {
    const list = el('ul', { style: 'margin:0 0 6px 18px;padding:0;font-size:11px;line-height:1.5' });
    messages.slice(0, 8).forEach((message) => {
      list.appendChild(el('li', { text: message }));
    });
    container.appendChild(list);
  }
  if (result.plan?.ok) {
    const table = el('div', {
      style: 'font-size:10px;line-height:1.5;background:#f8fafc;border:1px solid #dbeafe;border-radius:5px;padding:6px;white-space:pre-wrap',
      text: formatQ2SelectionAppendix(result.plan).trim(),
    });
    container.appendChild(table);
  } else if (result.regenerationPrompt) {
    container.appendChild(el('textarea', {
      value: result.regenerationPrompt,
      readonly: true,
      style: 'width:100%;min-height:92px;box-sizing:border-box;font-size:10px;border:1px solid #fecaca;border-radius:5px;padding:6px;resize:vertical',
    }));
  }
}

// マスタードキュメント連携: 「【参照: §N 要点版】★貼付★」 を実値で展開
// 受講者がコピー / 挿入する直前に Google Docs API 経由でマスタードキュメントから §N
// 要点版を取得し、★貼付★ をその内容に置換する。
// 同じ章は複数回問い合わせない。サブ章番号（§2-1 等）は親章 §2 に丸める。
async function enrichWithMasterSummaries(text) {
  if (!text || !text.includes('★貼付★')) return text;

  const lines = text.split('\n');
  const cache = {};

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('★貼付★')) continue;

    // 直前 8 行から「【参照: §N...】」を逆引き
    let refLine = null;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const m = lines[j].match(/【参照[:：]\s*([^】]+)】/);
      if (m) { refLine = m[1]; break; }
    }
    if (!refLine) continue;

    // §N または §N-M を検出。M は無視し、N の重複除去
    const tops = [];
    const seen = new Set();
    const re = /§(\d+)(?:-\d+)?/g;
    let mm;
    while ((mm = re.exec(refLine)) !== null) {
      const n = mm[1];
      if (!seen.has(n)) { seen.add(n); tops.push(n); }
    }
    if (tops.length === 0) continue;

    const parts = [];
    for (const sec of tops) {
      let result = cache[sec];
      if (result === undefined) {
        try {
          result = await getMasterSectionSummary(sec);
        } catch (e) {
          result = { ok: false, error: e && e.message ? e.message : String(e) };
        }
        cache[sec] = result;
      }
      if (result && result.ok && result.summary && String(result.summary).trim()) {
        parts.push('【§' + sec + ' 要点版】\n' + String(result.summary).trim());
      } else {
        const reason = result && result.error ? '（' + result.error + '）' : '';
        parts.push('（§' + sec + ' 要点版を取得できませんでした' + reason + '。先にマスタードキュメントの §' + sec + ' に要点版を書いてください）');
      }
    }
    const replacement = parts.join('\n\n---\n\n');
    lines[i] = lines[i].replaceAll('★貼付★', replacement);
  }
  return lines.join('\n');
}

async function getMasterSectionSummary(sectionNo) {
  const [docsClient, docsSections] = await Promise.all([
    import(chrome.runtime.getURL('phase0/docs-client.js')),
    import(chrome.runtime.getURL('phase0/docs-sections.js')),
  ]);
  const stored = await chrome.storage.sync.get(['sk_master_doc_v012']);
  const masterInfo = stored.sk_master_doc_v012 || null;
  const documentId = masterInfo && masterInfo.documentId;
  if (!documentId) {
    return {
      ok: false,
      error: 'マスタードキュメント未設定',
    };
  }
  const doc = await docsClient.getDocument(documentId);
  const result = docsSections.getSectionText(doc, Number(sectionNo), { allowLastSectionNo: 99 });
  const summary = String(result.text || '').trim();
  if (result.status !== 'ok' || !summary) {
    return {
      ok: false,
      error: '該当章が未保存',
    };
  }
  return {
    ok: true,
    summary,
  };
}

let hearingRawDebounceTimer = null;
let hearingNotesDebounceTimer = null;

function getEngagementMode(modeOverride) {
  const raw = modeOverride || state.settings[ENGAGEMENT_MODE_KEY];
  return ['A', 'B', 'C'].includes(raw) ? raw : 'C';
}

function getModeReadout(mode) {
  const current = getEngagementMode(mode);
  if (current === 'A') return 'クライアントワーク・ヒアリング実施前';
  if (current === 'B') return 'クライアントワーク・ヒアリング済';
  return '自社事業';
}

function isModeSelectorExpanded(storedMode) {
  return !storedMode || state.modeLocal.modeSelectorExpanded === true;
}

function toggleModeSelector() {
  const storedMode = state.settings[ENGAGEMENT_MODE_KEY];
  state.modeLocal.modeSelectorExpanded = !isModeSelectorExpanded(storedMode);
  renderModeSelector();
}

function openEngagementModeSelector() {
  switchTab('phases');
  document.getElementById('tab-phases')?.classList.add('show-engagement-mode');
  state.modeLocal.modeSelectorExpanded = true;
  renderModeSelector();
  const modeCard = document.getElementById('engagement-mode');
  if (!modeCard) return;
  modeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const currentMode = state.settings[ENGAGEMENT_MODE_KEY];
  const preferredButton = currentMode
    ? modeCard.querySelector(`button[data-mode="${currentMode}"]`)
    : modeCard.querySelector('button[data-mode]');
  if (preferredButton) {
    setTimeout(() => preferredButton.focus({ preventScroll: true }), 250);
  }
}

function getRawPhases() {
  return state.prompts?.phases || [];
}

// 製品別の合成フェーズ文言を supplementary から引く（構造は変えず文言ソースのみ間接化）。
// state.prompts.supplementary に該当 id があれば body/title を採用、無ければ現行ハードコード
// （Webマーケ版互換）にフォールバックする。
function findSupplementaryEntry(supId) {
  const list = state.prompts?.supplementary;
  if (!Array.isArray(list)) return null;
  return list.find((s) => s && s.id === supId) || null;
}

function buildModeAHearingDesignPhase() {
  // Webマーケ版互換のデフォルト（supplementary に mode-a-hearing-design が無い場合に使用）
  const fallbackTitle = 'ヒアリング設計（30問 + 所感欄）';
  const fallbackBody = '{{businessContext}}\n\n業種「★業種★」／店舗「★店舗名★」について、クライアントワーク開始前のヒアリング設計を作成してください。6カテゴリ x 5問 = 30問に整理し、各質問に「質問の意図」を1行で付けてください。\n\n【質問カテゴリ】\n1. 事業・サービス全体像: 5問\n2. 顧客・市場: 5問\n3. 競合・差別化: 5問\n4. マーケティング・営業: 5問\n5. 数字・採算: 5問\n6. 組織・制約・意思決定: 5問\n\n【必須で聞く項目】\n- 予算\n- 意思決定者\n- 導入期限\n- 過去施策の実測値\n\n所感欄に書いた仮説は [仮説] タグにしてください。';
  const sup = findSupplementaryEntry('mode-a-hearing-design');
  const title = (sup && sup.title) || fallbackTitle;
  const body = (sup && sup.body) || fallbackBody;
  return {
    id: 'phase-0-mode-a-hearing-design',
    no: 0,
    title: title,
    frame: '6カテゴリ x 5問 = 30問',
    primaryAi: 'chatgpt',
    secondaryAi: 'claude',
    inputs: ['業種', '店舗・屋号', 'ヒアリング前の仮説', '所感欄'],
    outputs: ['ヒアリング質問30問', '質問の意図', '所感メモ', '§0 要点版'],
    prompts: [
      {
        id: 'phase-0-mode-a-hearing-design-prompt',
        label: 'ヒアリング質問30問を作る',
        for: 'chatgpt',
        body: body
      }
    ],
    modeKind: 'hearingDesign',
  };
}

function buildModeBHearingSummaryPhase() {
  return {
    id: 'phase-0-mode-b-hearing-summary',
    no: 0,
    title: 'ヒアリング要約を作る',
    frame: '録音文字起こし -> AI要約 -> businessContext 確定',
    primaryAi: 'gemini',
    secondaryAi: 'chatgpt',
    inputs: ['録音文字起こし・議事録・ヒアリングメモ', 'AI要約結果'],
    outputs: ['sk_hearing_summary_v012', '§1以降の一次情報 context'],
    prompts: [],
    modeKind: 'hearingSummary',
  };
}

function getModeAdjustedPhases(modeOverride) {
  const phases = getRawPhases().slice();
  const mode = getEngagementMode(modeOverride);
  if (mode === 'A') {
    return phases.map((phase) => String(phase.no) === '0' ? buildModeAHearingDesignPhase() : phase);
  }
  if (mode === 'B') {
    return phases.map((phase) => String(phase.no) === '0' ? buildModeBHearingSummaryPhase() : phase);
  }
  return phases;
}

function getVisiblePhases() {
  return getModeAdjustedPhases();
}

function findModeAdjustedPhaseById(phaseId, modeOverride) {
  const phases = getModeAdjustedPhases(modeOverride);
  const found = phases.find((phase) => phase.id === phaseId);
  if (found) return found;
  if (phaseId === 'phase-0' || String(phaseId || '').startsWith('phase-0-mode-')) {
    return phases.find((phase) => String(phase.no) === '0') || null;
  }
  return null;
}

function ensureVisibleLastPhase() {
  const phases = getModeAdjustedPhases();
  if (!phases.length) return;
  if (!findModeAdjustedPhaseById(state.settings.lastPhase)) {
    state.settings.lastPhase = phases[0].id;
  }
}

function buildBusinessContextForMode(mode) {
  // {{businessContext}} は applyTemplate() だけで同期置換する。
  if (mode === 'A') {
    const notes = String(state.settings[HEARING_NOTES_KEY] || '').trim();
    return [
      '【クライアントワーク / ヒアリング実施前】',
      'まだクライアントへのヒアリング前です。§0では戦略を確定せず、聞くべき質問を設計してください。',
      notes ? `受講者の所感・仮説: ${notes}` : '受講者の所感・仮説: 未入力',
    ].join('\n');
  }
  if (mode === 'B') {
    const summary = String(state.settings[HEARING_SUMMARY_KEY] || '').trim();
    if (!summary) {
      return '【クライアントワーク / ヒアリング済】ヒアリング要約が未確定です。§0で録音文字起こしを要約し、要約を確定してから§1以降へ進んでください。';
    }
    // R1: B も C と同様に「案件整合 OK のときのみ」注入する（設計 §3 F2）。
    // stale-summary（別案件の古い要約）やメタ無し（整合不明）は注入しない。
    // 注入しない場合はヒアリング未確定のプレースホルダを返す。
    if (!isHearingSummaryConsistentSync()) {
      return '【クライアントワーク / ヒアリング済】ヒアリング要約の案件整合が確認できません。§0でヒアリング要約を確認・確定してから§1以降へ進んでください。';
    }
    return [
      '【クライアントワーク / ヒアリング済】',
      '以下はヒアリング録音文字起こし等を要約した一次情報です。',
      '後続フェーズではこの要約を優先し、生データにない事実は推測しないでください。',
      '',
      summary,
    ].join('\n');
  }
  // F1: モードC（自社事業）でも、案件整合の取れた確定要約があれば注入する。
  // ラベルは B（クライアント文字起こし要約）と区別する。
  if (mode === 'C') {
    const summary = String(state.settings[HEARING_SUMMARY_KEY] || '').trim();
    if (summary && isHearingSummaryConsistentSync()) {
      // 壁打ち要約のラベル文言も製品別に差し替え可能化（構造は不変）。
      // supplementary id "mode-c-wallbounce" の body があればその行群を使い、
      // 無ければ現行ハードコード（Webマーケ版互換）にフォールバックする。
      const sup = findSupplementaryEntry('mode-c-wallbounce');
      const header = (sup && sup.body)
        ? sup.body
        : [
            '【自社事業ヒアリング（壁打ち）結果】',
            '以下は AI 壁打ち等で整理した自社事業の一次情報です。',
            '後続フェーズではこの要約を優先し、要約にない事実は推測で補完しないでください。',
          ].join('\n');
      return [header, '', summary].join('\n');
    }
    return '';
  }
  return '';
}

// F2: state.settings に保持した案件メタが現在の業種/店舗と一致するか（同期判定）。
// hearing-readiness.js が未ロードでも安全側（不整合）に倒す。
function isHearingSummaryConsistentSync() {
  if (!hearingReadinessModule) return false;
  return hearingReadinessModule.isHearingMetaConsistent(
    state.settings[HEARING_META_KEY],
    { storeName: state.settings.storeName, industryLabel: state.settings.industryLabel }
  );
}

// ゲート・next-action 誘導が共有するヒアリング準備状況（設計 §4-4）。
// module 未ロード時は安全側（ヒアリング未完）に倒し、誤ってゲートを素通りさせない。
function getHearingReadinessState(modeOverride) {
  const mode = getEngagementMode(modeOverride);
  if (!hearingReadinessModule) {
    return {
      mode,
      hasSummary: !!String(state.settings[HEARING_SUMMARY_KEY] || '').trim(),
      consistent: false,
      metaUnknown: false,
      skipAckValid: false,
      gateRequired: true,
      status: mode === 'A' ? 'mode-a-design' : 'needs-hearing',
      staleStoreName: '',
    };
  }
  return hearingReadinessModule.getHearingReadiness({
    mode,
    summary: state.settings[HEARING_SUMMARY_KEY],
    meta: state.settings[HEARING_META_KEY],
    skipAck: state.settings[HEARING_SKIP_ACK_KEY],
    settings: {
      storeName: state.settings.storeName,
      industryLabel: state.settings.industryLabel,
    },
  });
}

// F2: 「このまま進む」同意を案件スコープで記録する（別案件では再度ゲートを出す）。
async function persistHearingSkipAck() {
  let ack;
  try {
    const mod = await ensureHearingReadinessModule();
    ack = mod.buildHearingMeta({
      storeName: state.settings.storeName,
      industryLabel: state.settings.industryLabel,
    });
  } catch (_) {
    ack = {
      storeName: String(state.settings.storeName || '').trim(),
      industryLabel: String(state.settings.industryLabel || '').trim(),
      updatedAt: Date.now(),
    };
  }
  await chrome.storage.sync.set({ sk_hearing_skip_ack_v013: ack });
  state.settings[HEARING_SKIP_ACK_KEY] = ack;
  return ack;
}

// メタ無し既存要約（後方互換）/ 別案件メタを「現在の案件のもの」として整合化する。
// ゲートの「引き継ぐ / この要約のまま進む」で使う。
async function adoptHearingSummaryForCurrentCase() {
  let meta;
  try {
    const mod = await ensureHearingReadinessModule();
    meta = mod.buildHearingMeta({
      storeName: state.settings.storeName,
      industryLabel: state.settings.industryLabel,
    });
  } catch (_) {
    meta = {
      storeName: String(state.settings.storeName || '').trim(),
      industryLabel: String(state.settings.industryLabel || '').trim(),
      updatedAt: Date.now(),
    };
  }
  await chrome.storage.sync.set({ sk_hearing_meta_v013: meta });
  state.settings[HEARING_META_KEY] = meta;
  return meta;
}

async function loadModeLocalState() {
  const stored = await chrome.storage.local.get([
    'sk_hearing_rawtext_v012_local',
    HEARING_SUMMARY_LOCAL_KEY,
  ]);
  state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY] = String(stored.sk_hearing_rawtext_v012_local || '');

  // v3.5: 要約本体は local が正。旧 sync 本体（loadSettings で読んだ HEARING_SUMMARY_KEY）
  //   しか無ければ local へ移行し、移行成功後に旧 sync キーを削除（sync 全体クォータ100KBを解放）。
  await hydrateHearingSummaryBody(stored[HEARING_SUMMARY_LOCAL_KEY]);

  if (!state.modeLocal.hearingSummaryDraft) {
    state.modeLocal.hearingSummaryDraft = String(state.settings[HEARING_SUMMARY_KEY] || '');
  }
}

// v3.5: ローカル本体のハイドレーション＋後方互換マイグレーション。
//   local 値を優先。local 空で旧 sync 値があれば local へコピーし、成功後のみ sync 旧キーを削除。
async function hydrateHearingSummaryBody(localValue) {
  const legacySyncValue = String(state.settings[HEARING_SUMMARY_KEY] || '');
  let plan;
  try {
    const mod = await ensureHearingReadinessModule();
    plan = mod.planHearingSummaryMigration({ localValue, legacySyncValue });
  } catch (_) {
    // 純ロジック未ロード時のフォールバック（同等の方針: local 優先・旧 sync は移行）。
    const local = String(localValue || '').trim();
    const legacy = legacySyncValue.trim();
    plan = local
      ? { value: local, migrate: false, removeLegacy: false }
      : (legacy ? { value: legacy, migrate: true, removeLegacy: true } : { value: '', migrate: false, removeLegacy: false });
  }

  if (plan.migrate && plan.value) {
    try {
      await chrome.storage.local.set({ [HEARING_SUMMARY_LOCAL_KEY]: plan.value });
      if (plan.removeLegacy) {
        // 移行成功後のみ旧 sync キーを削除する（コピー前に消さない）。
        await chrome.storage.sync.remove([HEARING_SUMMARY_LEGACY_SYNC_KEY]);
      }
    } catch (e) {
      console.warn('[strategy-kit] hearing summary migration failed', e);
    }
  }
  // in-memory の正（§1 注入の参照元）を local 本体に揃える。
  state.settings[HEARING_SUMMARY_KEY] = plan.value;
}

function persistModeAuxInput(key, value, immediate = false) {
  if (key !== HEARING_NOTES_KEY) return;
  state.settings[HEARING_NOTES_KEY] = String(value || '').slice(0, 2000);
  const save = () => chrome.storage.sync.set({ sk_hearing_notes_v012: state.settings[HEARING_NOTES_KEY] });
  if (immediate) {
    if (hearingNotesDebounceTimer) clearTimeout(hearingNotesDebounceTimer);
    hearingNotesDebounceTimer = null;
    save();
    return;
  }
  if (hearingNotesDebounceTimer) clearTimeout(hearingNotesDebounceTimer);
  hearingNotesDebounceTimer = setTimeout(save, 500);
}

function persistHearingRawText(value, immediate = false) {
  state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY] = String(value || '');
  const save = () => chrome.storage.local.set({
    sk_hearing_rawtext_v012_local: state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY],
  });
  if (immediate) {
    if (hearingRawDebounceTimer) clearTimeout(hearingRawDebounceTimer);
    hearingRawDebounceTimer = null;
    save();
    return;
  }
  if (hearingRawDebounceTimer) clearTimeout(hearingRawDebounceTimer);
  hearingRawDebounceTimer = setTimeout(save, 500);
}

function buildHearingSummaryPrompt(rawText) {
  // ドメイン語は branding.purposeLabel に間接化（未設定時は STRATEGY-KIT の「マーケティング戦略立案」）。
  const purposeLabel = brandPurposeLabel();
  return [
    'SYSTEM:',
    'あなたは' + purposeLabel + 'のヒアリング記録を整理する編集者です。',
    '目的は、録音文字起こしや議事録の生データから、後続の戦略立案プロンプトに渡せる一次情報要約を作ることです。',
    '生データにない事実を作らないでください。外部調査で補完しないでください。',
    '不明点・矛盾・追加確認が必要な点は、推測で埋めず「要確認」に分けてください。',
    '数字、固有名詞、予算、期限、意思決定者、過去施策の実測値は優先して残してください。',
    '出力は日本語。全体で3000〜4500字を目安にし、最大6000字以内にしてください。',
    '',
    'USER:',
    '以下は、クライアントワークのヒアリング録音文字起こし、議事録、またはメモの生データです。',
    'ノイズ、言い淀み、重複、雑談を整理し、後続の' + purposeLabel + 'に使える要約にしてください。',
    '',
    '【出力フォーマット】',
    '## 1. 案件概要',
    '- 業種・店舗名・サービス:',
    '- 誰の発言/資料か:',
    '- ヒアリング日や前提:',
    '',
    '## 2. 事業・サービスの一次情報',
    '- 提供価値:',
    '- 商品/サービス構成:',
    '- 収益構造:',
    '- 現在の強み:',
    '',
    '## 3. 顧客・市場・競合',
    '- 主な顧客:',
    '- 顧客の悩み/購買動機:',
    '- 商圏/市場変化:',
    '- 競合名/比較軸:',
    '',
    '## 4. マーケティング・営業実績',
    '| 項目 | ヒアリング内容 | タグ |',
    '|---|---|---|',
    '| 流入経路 |  | [事実-一次/申告/要確認] |',
    '| 過去施策 |  |  |',
    '| 投下予算 |  |  |',
    '| CPA/獲得件数/継続率 |  |  |',
    '',
    '## 5. 数字・制約・意思決定',
    '| 項目 | 内容 | タグ |',
    '|---|---|---|',
    '| 売上/単価/粗利 |  |  |',
    '| 月予算上限 |  |  |',
    '| 意思決定者 |  |  |',
    '| 導入期限 |  |  |',
    '| 実行体制 |  |  |',
    '',
    '## 6. 課題・機会・リスク',
    '- 課題:',
    '- 機会:',
    '- リスク:',
    '- 先方の意向:',
    '',
    '## 7. 未確認・矛盾・追加ヒアリング',
    '- 要確認:',
    '- 矛盾:',
    '- 次回聞くべき質問:',
    '',
    '## 8. 後続フェーズ用 businessContext',
    '上記を500〜900字で凝縮。§1以降のAIが最初に読む前提情報として、重要な一次情報、数字、制約、先方の意向をまとめる。',
    '',
    '【タグルール】',
    '- [事実-一次]: ヒアリング内で明確に語られた事実',
    '- [申告]: 数字や実績が先方申告のみで、裏取り前のもの',
    '- [仮説]: 受講者や先方の見立て',
    '- [要確認]: 不明、矛盾、根拠不足',
    '',
    '【禁止】',
    '- 生データにない情報の追加',
    '- 外部Web調査',
    '- きれいな言葉での水増し',
    '- 6000字超過',
    '',
    '【生データ】',
    '<<<RAW_HEARING_TEXT',
    String(rawText || ''),
    'RAW_HEARING_TEXT',
  ].join('\n');
}

async function detectGeminiSummarizerAvailability() {
  try {
    const geminiClient = await import(chrome.runtime.getURL('phase0/gemini-client.js'));
    const [key, proxyState] = await Promise.all([
      geminiClient.getGeminiApiKey({ storage: chrome.storage.local }),
      geminiClient.getGeminiProxyConfig({
        storage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      }),
    ]);
    state.modeLocal.geminiSummarizerAvailable = !!(key || proxyState?.proxy);
    state.modeLocal.geminiSummarizerChecked = true;
    return state.modeLocal.geminiSummarizerAvailable;
  } catch (e) {
    state.modeLocal.geminiSummarizerAvailable = false;
    state.modeLocal.geminiSummarizerChecked = true;
    return false;
  }
}

async function summarizeHearingRawText(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) {
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = '録音文字起こしを貼り付けてください';
    renderModeSelector();
    return;
  }
  state.modeLocal.hearingStatus = 'processing';
  state.modeLocal.hearingStatusMessage = '要約処理中…';
  renderModeSelector();
  try {
    const geminiClient = await import(chrome.runtime.getURL('phase0/gemini-client.js'));
    const request = {
      prompt: buildHearingSummaryPrompt(raw),
      model: 'gemini-3.6-flash',
      temperature: 0.2,
    };
    const result = typeof geminiClient.generateSummary === 'function'
      ? await geminiClient.generateSummary(request, {
          storage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        })
      : await geminiClient.generateContent(request, {
          storage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
    state.modeLocal.hearingSummaryDraft = String(result?.text || '').trim();
    state.modeLocal.hearingStatus = 'complete';
    state.modeLocal.hearingStatusMessage = '要約完了。内容を確認して、必要なら編集してください';
  } catch (e) {
    console.warn('[strategy-kit] hearing summary failed', e);
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = '要約失敗。要約promptをコピーして、ChatGPT / Claude 等に貼り付けてください';
  }
  renderModeSelector();
}

async function copyHearingSummaryPrompt(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) {
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = '録音文字起こしを貼り付けてください';
    renderModeSelector();
    return;
  }
  try {
    await navigator.clipboard.writeText(buildHearingSummaryPrompt(raw));
    state.modeLocal.hearingStatus = 'copied';
    state.modeLocal.hearingStatusMessage = '要約promptをコピーしました。AIに貼り付け、返ってきた要約を下の欄に貼ってください';
    showToast('要約promptをコピーしました');
  } catch (e) {
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = 'コピーに失敗しました。ブラウザの権限を確認してください';
    showToast('コピーに失敗しました', true);
  }
  renderModeSelector();
}

async function persistHearingSummary(summary) {
  const value = String(summary || '').trim();
  if (!value) {
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = 'AI要約結果を貼り付けてください';
    renderModeSelector();
    return false;
  }
  if (value.length > HEARING_SUMMARY_HARD_LIMIT) {
    state.modeLocal.hearingStatus = 'error';
    state.modeLocal.hearingStatusMessage = '要約が長すぎます。6000字以内に短くしてください';
    renderModeSelector();
    return false;
  }
  try {
    // F2: 要約確定時に案件メタ（storeName/industryLabel/updatedAt）を併存保存する。
    let meta = null;
    try {
      const mod = await ensureHearingReadinessModule();
      meta = mod.buildHearingMeta({
        storeName: state.settings.storeName,
        industryLabel: state.settings.industryLabel,
      });
    } catch (_) {
      meta = {
        storeName: String(state.settings.storeName || '').trim(),
        industryLabel: String(state.settings.industryLabel || '').trim(),
        updatedAt: Date.now(),
      };
    }
    // v3.5 真因対応: 本体は chrome.storage.local（10MB級）へ。メタ＋lastPhase だけ sync。
    //   sync は QUOTA_BYTES_PER_ITEM=8192 のため日本語要約（最大18KB）は必ず reject されていた。
    await chrome.storage.local.set({ [HEARING_SUMMARY_LOCAL_KEY]: value });
    await chrome.storage.sync.set({
      sk_hearing_meta_v013: meta,
      lastPhase: 'phase-1',
    });
    state.settings[HEARING_SUMMARY_KEY] = value;
    state.settings[HEARING_META_KEY] = meta;
    state.settings.lastPhase = 'phase-1';
    state.modeLocal.hearingSummaryDraft = value;
    state.modeLocal.hearingStatus = 'saved';
    state.modeLocal.hearingStatusMessage = '要約を保存しました。§1 以降のAIプロンプトにこの要約が入ります';
    renderModeSelector();
    renderPhaseList();
    renderNextAction();
    showToast(value.length < 80 ? '短い要約として保存しました。内容確認を推奨します' : 'ヒアリング要約を保存しました');
    return true;
  } catch (e) {
    console.warn('[strategy-kit] hearing summary persist failed', e);
    state.modeLocal.hearingStatus = 'error';
    const reason = String((e && e.message) || e || '不明なエラー');
    state.modeLocal.hearingStatusMessage = `保存に失敗しました（${reason}）。`;
    renderModeSelector();
    return false;
  }
}

async function clearLocalHearingRawText() {
  await chrome.storage.local.remove(['sk_hearing_rawtext_v012_local']);
  state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY] = '';
  state.modeLocal.hearingStatus = 'idle';
  state.modeLocal.hearingStatusMessage = 'この端末の文字起こしを削除しました。要約は残っています';
  renderModeSelector();
}

function getHearingSummaryDraft() {
  return String(
    state.modeLocal.hearingSummaryDraft ||
    state.settings[HEARING_SUMMARY_KEY] ||
    ''
  );
}

function getHearingStatusMessage(rawText, summaryDraft) {
  if (state.modeLocal.hearingStatusMessage) return state.modeLocal.hearingStatusMessage;
  if (!rawText.trim()) return '録音文字起こしを貼り付けてください';
  if (!state.modeLocal.geminiSummarizerAvailable) {
    return 'Gemini API key が未設定です。要約promptをコピーして、ChatGPT / Claude 等で要約してください';
  }
  if (summaryDraft.trim()) return '要約完了。内容を確認して、必要なら編集してください';
  return '貼り付け内容を要約できます';
}

function refreshHearingPanelControls(panel) {
  if (!panel) return;
  const rawArea = panel.querySelector('[data-role="hearing-raw"]');
  const summaryArea = panel.querySelector('[data-role="hearing-summary"]');
  const statusEl = panel.querySelector('[data-role="hearing-status"]');
  const countEl = panel.querySelector('[data-role="hearing-count"]');
  const geminiBtn = panel.querySelector('[data-role="hearing-gemini"]');
  const copyBtn = panel.querySelector('[data-role="hearing-copy"]');
  const confirmBtn = panel.querySelector('[data-role="hearing-confirm"]');
  const rawText = String(rawArea?.value || '');
  const summaryDraft = String(summaryArea?.value || '');
  const summaryTooLong = summaryDraft.trim().length > HEARING_SUMMARY_HARD_LIMIT;
  const isProcessing = state.modeLocal.hearingStatus === 'processing';
  const hasRaw = !!rawText.trim();
  const hasSummary = !!summaryDraft.trim();
  if (statusEl) {
    const message = summaryTooLong
      ? '要約が長すぎます。6000字以内に短くしてください'
      : getHearingStatusMessage(rawText, summaryDraft);
    statusEl.textContent = message;
    statusEl.style.color = summaryTooLong || state.modeLocal.hearingStatus === 'error' ? '#b91c1c' : '#166534';
  }
  if (countEl) {
    countEl.textContent = `生データ ${rawText.length.toLocaleString()}字 / 要約 ${summaryDraft.trim().length.toLocaleString()}字（保存上限 ${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字）`;
  }
  if (geminiBtn) geminiBtn.disabled = !(hasRaw && state.modeLocal.geminiSummarizerAvailable && !isProcessing);
  if (copyBtn) copyBtn.disabled = !(hasRaw && !isProcessing);
  if (confirmBtn) confirmBtn.disabled = !(hasSummary && !summaryTooLong && !isProcessing);
}

function buildModeBHearingSummaryPanel() {
  const rawText = String(state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY] || '');
  const summaryDraft = getHearingSummaryDraft();
  const rawTrimmed = rawText.trim();
  const summaryTrimmed = summaryDraft.trim();
  const summaryTooLong = summaryTrimmed.length > HEARING_SUMMARY_HARD_LIMIT;
  const isProcessing = state.modeLocal.hearingStatus === 'processing';
  const canUseGemini = !!rawTrimmed && state.modeLocal.geminiSummarizerAvailable && !isProcessing;
  const canCopyPrompt = !!rawTrimmed && !isProcessing;
  const canConfirm = !!summaryTrimmed && !summaryTooLong && !isProcessing;

  const panel = el('div', {
    class: 'mode-b-summary-panel',
    style: 'display:grid;gap:8px;margin-top:10px',
  });
  panel.append(
    el('div', {
      class: 'hearing-import-heading',
      text: 'ヒアリング済み情報の進め方',
    }),
    el('ol', { class: 'hearing-import-steps' },
      el('li', { text: '文字起こし・議事録・メモをそのまま貼る' }),
      el('li', { text: 'Geminiで要約する、または外部AIで作った要約を貼る' }),
      el('li', { text: '要約を確認して「この要約で確定」を押す' }),
      el('li', { text: '半自動／全自動を選び、実行設定を入力して開始する' }),
    ),
  );
  const statusText = getHearingStatusMessage(rawText, summaryDraft);
  panel.appendChild(el('div', {
    attrs: { 'data-role': 'hearing-status' },
    style: `font-size:12px;font-weight:700;color:${summaryTooLong || state.modeLocal.hearingStatus === 'error' ? '#b91c1c' : '#166534'}`,
    text: summaryTooLong ? '要約が長すぎます。6000字以内に短くしてください' : statusText,
  }));
  if (rawTrimmed.length > 50000) {
    panel.appendChild(el('p', {
      style: 'font-size:11px;color:#92400e;margin:0',
      text: '50,000字を超えています。Gemini API が失敗した場合は、要約promptをコピーして外部AIへ貼ってください。',
    }));
  }
  panel.appendChild(el('label', { style: 'display:grid;gap:4px;font-size:12px;font-weight:700' },
    document.createTextNode('1. 文字起こし・議事録・ヒアリングメモを貼る'),
    el('textarea', {
      value: rawText,
      placeholder: 'Whisper 等の文字起こしをそのまま貼れます。10,000〜50,000 字級でも、この欄では要点化せず貼ってください。',
      attrs: { 'data-role': 'hearing-raw' },
      style: 'width:100%;min-height:120px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:12px;line-height:1.5;resize:vertical',
      on: {
        input: (event) => {
          persistHearingRawText(event.target.value);
          refreshHearingPanelControls(event.target.closest('.mode-b-summary-panel'));
        },
        blur: (event) => persistHearingRawText(event.target.value, true),
      },
    })
  ));
  panel.appendChild(el('label', { style: 'display:grid;gap:4px;font-size:12px;font-weight:700' },
    document.createTextNode('2. AI要約を確認・編集する'),
    el('textarea', {
      value: summaryDraft,
      placeholder: 'Geminiまたは外部AIの要約をここに貼り、確認してから確定します。',
      attrs: { 'data-role': 'hearing-summary' },
      style: 'width:100%;min-height:110px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:12px;line-height:1.5;resize:vertical',
      on: {
        input: (event) => {
          state.modeLocal.hearingSummaryDraft = event.target.value;
          state.modeLocal.hearingStatusMessage = event.target.value.trim().length > HEARING_SUMMARY_HARD_LIMIT
            ? '要約が長すぎます。6000字以内に短くしてください'
            : '';
          refreshHearingPanelControls(event.target.closest('.mode-b-summary-panel'));
        },
        blur: (event) => {
          // 状態の保存のみ。ここでパネルを全再描画すると、貼り付け直後に
          // 「この要約で確定」を押した際 blur が先に発火して押下中のボタンが破棄され
          // click が発火しない（モードC と同根のクリック飲み込み。2026-06-06）。
          state.modeLocal.hearingSummaryDraft = event.target.value;
        },
      },
    })
  ));
  panel.appendChild(el('div', {
    attrs: { 'data-role': 'hearing-count' },
    style: 'font-size:11px;color:#64748b',
    text: `生データ ${rawText.length.toLocaleString()}字 / 要約 ${summaryDraft.trim().length.toLocaleString()}字（保存上限 ${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字）`,
  }));

  const actions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
  actions.appendChild(el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: isProcessing ? '要約処理中…' : '2-A. Geminiで要約',
    disabled: !canUseGemini,
    attrs: { 'data-role': 'hearing-gemini' },
    on: { click: () => summarizeHearingRawText(state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY]) },
  }));
  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '2-B. 外部AI用プロンプトをコピー',
    disabled: !canCopyPrompt,
    attrs: { 'data-role': 'hearing-copy' },
    on: { click: () => copyHearingSummaryPrompt(state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY]) },
  }));
  actions.appendChild(el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: '3. この要約で確定',
    disabled: !canConfirm,
    attrs: { 'data-role': 'hearing-confirm' },
    on: { click: () => persistHearingSummary(getHearingSummaryDraft()) },
  }));
  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: 'この端末の文字起こしを削除',
    disabled: !rawText,
    on: { click: () => clearLocalHearingRawText() },
  }));
  panel.appendChild(actions);
  return panel;
}

// v3.2 FixA: モードC（自社事業）の壁打ち要約 取り込みパネル（B パネルの簡易版）。
// 壁打ち出力は既に8セクションなので Gemini 再要約は不要。貼って確定だけのシンプル導線。
// 確定は既存 persistHearingSummary 経路（6000字検証＋F2 メタ保存は persist 内）を共有する。
function buildModeCHearingSummaryPanel() {
  const summaryDraft = getHearingSummaryDraft();
  const summaryTrimmed = summaryDraft.trim();
  const summaryTooLong = summaryTrimmed.length > HEARING_SUMMARY_HARD_LIMIT;
  const storedSummary = String(state.settings[HEARING_SUMMARY_KEY] || '').trim();
  const confirmed = !!storedSummary && isHearingSummaryConsistentSync();
  const canConfirm = !!summaryTrimmed && !summaryTooLong;

  const panel = el('div', {
    class: 'mode-c-summary-panel',
    style: 'display:grid;gap:8px;margin-top:10px',
  });

  // 確定済み（この案件の要約あり・整合OK）のときは状態表示＋作り直し導線のみ。
  if (confirmed) {
    panel.appendChild(el('div', {
      style: 'font-size:12px;font-weight:700;color:#166534',
      text: '✓ この案件のヒアリング要約は確定済みです。このまま全自動を実行できます',
    }));
    panel.appendChild(el('div', {
      style: 'font-size:11px;color:#64748b',
      text: `現在の要約 ${storedSummary.length.toLocaleString()}字`,
    }));
    panel.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: '破棄して作り直す',
      style: 'justify-self:start',
      on: { click: () => discardHearingSummaryForRebuild() },
    }));
    return panel;
  }

  // 注意: blur で renderModeSelector() による全再描画をしてはいけない。
  //   貼り付け直後に「この要約で確定」を押すと、textarea の blur で押下中のボタン自体が
  //   破棄されて click が発火しない（実機 2026-06-06: ボタン無反応の原因）。
  //   入力のたびにボタン活性・文字数・状態行を「直接」更新し、再描画なしで反映する。
  // v3.5: persist 失敗時の hearingStatusMessage を表示する（B パネル同様）。
  //   旧実装は summaryTooLong しか見ず、保存失敗が「無反応」に見えていた（真因2）。
  const isError = state.modeLocal.hearingStatus === 'error';
  const statusRow = el('div', {
    attrs: { 'data-role': 'hearing-status' },
    style: `font-size:12px;font-weight:700;color:${(summaryTooLong || isError) ? '#b91c1c' : '#166534'}`,
    text: summaryTooLong
      ? '要約が長すぎます。6000字以内に短くしてください'
      : (isError && state.modeLocal.hearingStatusMessage)
        ? state.modeLocal.hearingStatusMessage
        : '壁打ちで作ったヒアリング要約を貼り付けて確定してください',
  });
  const counterRow = el('div', {
    style: 'font-size:11px;color:#64748b',
    text: `要約 ${summaryTrimmed.length.toLocaleString()}字（保存上限 ${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字）`,
  });
  const confirmBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: 'この要約で確定',
    disabled: !canConfirm,
    style: 'justify-self:start',
    on: { click: () => persistHearingSummary(getHearingSummaryDraft()) },
  });
  function syncConfirmUi(rawValue) {
    const trimmed = String(rawValue || '').trim();
    const tooLong = trimmed.length > HEARING_SUMMARY_HARD_LIMIT;
    confirmBtn.disabled = !trimmed || tooLong;
    counterRow.textContent = `要約 ${trimmed.length.toLocaleString()}字（保存上限 ${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字）`;
    statusRow.style.color = tooLong ? '#b91c1c' : '#166534';
    statusRow.textContent = tooLong
      ? '要約が長すぎます。6000字以内に短くしてください'
      : '壁打ちで作ったヒアリング要約を貼り付けて確定してください';
  }
  panel.appendChild(statusRow);
  panel.appendChild(el('label', { style: 'display:grid;gap:4px;font-size:12px;font-weight:700' },
    document.createTextNode('壁打ちで作ったヒアリング要約（8セクション）をここに貼り付け'),
    el('textarea', {
      value: summaryDraft,
      placeholder: 'AI（ChatGPT / Claude / Gemini）との壁打ちで出てきた8セクションのヒアリング要約を、そのまま貼り付けてください。',
      attrs: { 'data-role': 'hearing-summary' },
      style: 'width:100%;min-height:140px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:12px;line-height:1.5;resize:vertical',
      on: {
        input: (event) => {
          state.modeLocal.hearingSummaryDraft = event.target.value;
          syncConfirmUi(event.target.value);
        },
        blur: (event) => {
          // 状態の保存のみ。再描画しない（クリック飲み込み防止）。
          state.modeLocal.hearingSummaryDraft = event.target.value;
        },
      },
    })
  ));
  panel.appendChild(counterRow);
  panel.appendChild(confirmBtn);
  return panel;
}

// v3.2 FixA: モードC の確定済み要約を破棄して貼り直せる状態に戻す。
async function discardHearingSummaryForRebuild() {
  try {
    // v3.5: 本体は local、メタ（+旧 sync 本体の残骸があれば）は sync を消す。
    await chrome.storage.local.remove([HEARING_SUMMARY_LOCAL_KEY]);
    await chrome.storage.sync.remove([HEARING_SUMMARY_LEGACY_SYNC_KEY, HEARING_META_KEY]);
  } catch (_) {}
  state.settings[HEARING_SUMMARY_KEY] = '';
  state.settings[HEARING_META_KEY] = null;
  state.modeLocal.hearingSummaryDraft = '';
  state.modeLocal.hearingStatus = 'idle';
  state.modeLocal.hearingStatusMessage = '要約を破棄しました。壁打ちで作り直して貼り直してください';
  renderModeSelector();
  renderPhaseList();
  renderNextAction();
  showToast('ヒアリング要約を破棄しました');
}

function openExecutionSetup(mode) {
  setAutomationExecutionMode(mode, { openWorkspace: true });
  requestAnimationFrame(() => {
    const workspace = document.getElementById('mod-automation-slot')
      || document.getElementById('tab-automation');
    workspace?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    workspace?.querySelector('textarea, select, button')?.focus({ preventScroll: true });
  });
}

// 入口モードは「§0 の前提」、半自動/全自動は「実行方法」で別の設定。
// これまで両者の接続がなく、入口確定後に次の操作が消えていたため、
// ここで次の1操作を明示し、実行設定へ直接つなぐ。
function buildExecutionNextStep(mode) {
  const hearingReady = mode !== 'B' || isHearingSummaryConsistentSync();
  const guide = el('section', {
    class: 'entry-next-step',
    dataset: { state: hearingReady ? 'ready' : 'hearing-required' },
    attrs: { 'aria-label': '入口確定後の次の操作' },
  });

  guide.append(
    el('span', {
      class: 'entry-next-step-kicker',
      text: hearingReady ? '入口を確定しました' : '入口を確定しました · 次にヒアリング要約',
    }),
    el('strong', {
      class: 'entry-next-step-title',
      text: hearingReady
        ? '次は、半自動か全自動を選んで実行設定を入力します'
        : '文字起こし・議事録を貼り、要約を確定してください',
    }),
    el('p', {
      class: 'entry-next-step-copy',
      text: hearingReady
        ? '半自動は回答を確認しながら1段ずつ、全自動はGeminiでまとめて進めます。どちらも次の画面で現状メモを確認してから開始します。'
        : '「ヒアリング済み」は新しく壁打ちをする入口ではありません。すでにある録音文字起こし・議事録・メモを、下の1か所で要約・確定します。',
    }),
  );

  const actions = el('div', { class: 'entry-next-step-actions' });
  if (!hearingReady) {
    actions.appendChild(el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'ヒアリング要約を入力する',
      on: {
        click: () => {
          state.modeLocal.modeSelectorExpanded = true;
          renderModeSelector();
          requestAnimationFrame(() => {
            document.querySelector('.mode-b-summary-panel textarea')?.focus({ preventScroll: true });
          });
        },
      },
    }));
  } else {
    actions.append(
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '半自動の設定へ',
        on: { click: () => openExecutionSetup('semi') },
      }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '全自動の設定へ',
        on: { click: () => openExecutionSetup('full') },
      }),
    );
  }
  guide.appendChild(actions);
  return guide;
}

function renderModeSelector() {
  const mount = document.getElementById('engagement-mode');
  if (!mount) return;
  clearChildren(mount);
  const storedMode = state.settings[ENGAGEMENT_MODE_KEY];
  const mode = getEngagementMode();
  const expanded = isModeSelectorExpanded(storedMode);
  mount.className = expanded
    ? 'card engagement-mode-card is-expanded'
    : 'card engagement-mode-card is-collapsed';
  mount.setAttribute('aria-labelledby', 'engagement-mode-title');
  const hasProgress = !!((state.progressFilledNos || []).length || (state.progressPartialNos || []).length);

  const modeLabel = storedMode ? getModeReadout(mode) : '入口モード未選択';
  const indicatorText = storedMode
    ? (expanded ? '▼ ' : '▶ ') + modeLabel
    : '▼ まず、今回の進め方を選んでください';
  const toggle = el('button', {
    class: 'mode-selector-toggle',
    type: 'button',
    attrs: {
      'data-role': 'mode-toggle',
      'aria-expanded': String(expanded),
      'aria-controls': 'engagement-mode-options',
    },
    on: { click: toggleModeSelector },
  },
    el('span', { id: 'engagement-mode-title', class: 'mode-selector-current', text: indicatorText }),
    el('span', {
      class: 'mode-selector-caption',
      text: storedMode
        ? 'タップして入口モードを変更'
        : '選択後はここに1行表示で折りたたみます',
    })
  );
  mount.appendChild(toggle);

  if (!expanded) {
    if (storedMode) mount.appendChild(buildExecutionNextStep(mode));
    return;
  }

  const optionsWrap = el('div', { id: 'engagement-mode-options', class: 'mode-selector-body' });
  optionsWrap.appendChild(el('p', {
    class: 'muted',
    text: 'ここで選んだ内容に合わせて、最初のフェーズと AI に渡す前提文が変わります。あとから変更しても、入力済みの内容は消えません。',
  }));
  if (!storedMode) {
    optionsWrap.appendChild(el('p', {
      style: 'font-size:12px;color:#92400e;margin:0 0 8px',
      text: '入口を選ぶと、§0 の内容が今回の進め方に合います。',
    }));
  } else if (hasProgress) {
    optionsWrap.appendChild(el('p', {
      style: 'font-size:11px;color:#64748b;margin:0 0 8px',
      text: '進捗があります。入口モードを変える場合も入力済み内容や Google Docs は削除しません。',
    }));
  }

  const options = [
    ['A', 'クライアントワーク・ヒアリング実施前', 'まだヒアリングしていない案件です。先に質問項目を作り、聞くべきことを整理します。'],
    ['B', 'クライアントワーク・ヒアリング済', '録音の文字起こしや議事録をそのまま貼り付けて、AIで要約してから分析へ進みます。生データはこの端末だけに保存され、同期されるのは要約だけです。'],
    ['C', '自社事業', '自分の事業や手元の情報をもとに、今まで通り進めます。'],
  ];
  const group = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px',
  });
  options.forEach(([value, label, desc]) => {
    const selected = storedMode === value;
    const btn = el('button', {
      type: 'button',
      class: selected ? 'btn btn-primary' : 'btn btn-ghost',
      dataset: { mode: value },
      style: 'height:auto;text-align:left;display:grid;gap:4px;align-content:start;white-space:normal',
      on: { click: () => handleModeChange(value) },
    },
      el('strong', { text: label }),
      el('span', { style: 'font-size:11px;font-weight:400;line-height:1.5', text: desc })
    );
    group.appendChild(btn);
  });
  optionsWrap.appendChild(group);

  if (mode === 'A' && expanded) {
    const notes = String(state.settings[HEARING_NOTES_KEY] || '');
    optionsWrap.appendChild(el('label', {
      style: 'display:grid;gap:4px;font-size:12px;font-weight:700;margin-top:10px',
    },
      document.createTextNode('所感欄（ヒアリング前の仮説・気になる点）'),
      el('textarea', {
        value: notes,
        placeholder: '例: 先方は新規集客より既存客の再来が詰まりかもしれない。未確認の仮説として残す。',
        style: 'width:100%;min-height:90px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;padding:8px;font-size:12px;line-height:1.5;resize:vertical',
        on: {
          input: (event) => persistModeAuxInput(HEARING_NOTES_KEY, event.target.value),
          blur: (event) => persistModeAuxInput(HEARING_NOTES_KEY, event.target.value, true),
        },
      })
    ));
  }

  if (mode === 'B' && expanded) {
    optionsWrap.appendChild(buildModeBHearingSummaryPanel());
  }

  if (mode === 'C' && expanded) {
    optionsWrap.appendChild(buildModeCHearingSummaryPanel());
  }
  if (storedMode) {
    optionsWrap.appendChild(buildExecutionNextStep(mode));
  }
  mount.appendChild(optionsWrap);
}

async function handleModeChange(mode) {
  if (!['A', 'B', 'C'].includes(mode)) return false;
  // 実行中に入口モードを変えると、生成の途中で §0 と AI に渡す前提文が入れ替わる。
  // 表示は許すが、変更は実行が終わってからにしてもらう。
  if (isAutomationRunningNow()) {
    showToast('実行中は入口モードを変更できません。中断するか、完了してから変更してください。', true, 5000);
    renderModeSelector();
    return false;
  }
  const current = state.settings[ENGAGEMENT_MODE_KEY];
  if (current === mode) {
    state.modeLocal.modeSelectorExpanded = mode === 'B' && !isHearingSummaryConsistentSync();
    renderModeSelector();
    return true;
  }
  const hasProgress = !!((state.progressFilledNos || []).length || (state.progressPartialNos || []).length);
  if (hasProgress) {
    const ok = confirm('入口モードを変更します。これまでの入力や Google Docs は削除しませんが、表示される Phase 0 と AI に渡す前提文が変わります。変更しますか？');
    if (!ok) {
      renderModeSelector();
      return false;
    }
  }
  const previousPhase = findModeAdjustedPhaseById(state.settings.lastPhase);
  const nextPhases = getModeAdjustedPhases(mode);
  const shouldMoveToPhase0 = !previousPhase || String(previousPhase.no) === '0';
  state.settings[ENGAGEMENT_MODE_KEY] = mode;
  if (shouldMoveToPhase0 && nextPhases[0]) {
    state.settings.lastPhase = nextPhases[0].id;
  }
  await chrome.storage.sync.set({
    sk_engagement_mode: mode,
    lastPhase: state.settings.lastPhase,
  });
  // ヒアリング済み案件は、入口選択の直後に文字起こし入力欄まで続けて見せる。
  // 要約済みなら折りたたみ、次の「半自動/全自動」選択へ進める。
  state.modeLocal.modeSelectorExpanded = mode === 'B' && !isHearingSummaryConsistentSync();
  ensureVisibleLastPhase();
  renderModeSelector();
  renderPhaseList();
  renderCurrentPhase();
  renderContextBar();
  renderNextAction();
  emit('phase-changed', findModeAdjustedPhaseById(state.settings.lastPhase));
  return true;
}

async function createOrOpenDraftDoc() {
  const cancelMessage = 'DRAFT_DECISION_CANCELLED';
  showSavingOverlay('DRAFT を準備しています…');
  try {
    const [docsClient, driveClient, draftManager] = await Promise.all([
      import(chrome.runtime.getURL('phase0/docs-client.js')),
      import(chrome.runtime.getURL('phase0/drive-client.js')),
      import(chrome.runtime.getURL('phase0/draft-manager.js')),
    ]);
    const result = await draftManager.ensureDraftDoc({
      docsClient,
      driveClient,
      storageArea: chrome.storage.sync,
      phases: getVisiblePhases(),
      titleBase: buildDocTitle(),
      confirmUseExisting: async (existing) => {
        if (typeof window.SK_SHOW_DRAFT_DECISION_MODAL !== 'function') {
          throw new Error(cancelMessage);
        }
        const choice = await window.SK_SHOW_DRAFT_DECISION_MODAL({
          existingTitle: existing.title || '(無題)',
          onChoice: function (nextChoice) {
            if (nextChoice === 'create') {
              showSavingOverlay('新規 DRAFT を作成中…', '既存は残し、別 docId を作成しています');
            } else if (nextChoice === 'reuse') {
              showSavingOverlay('既存 DRAFT を開いています…', 'Drive にファイルは増えません');
            }
          },
        });
        if (choice === 'cancel') {
          throw new Error(cancelMessage);
        }
        if (choice === 'create') {
          showSavingOverlay('新規 DRAFT を作成中…', '既存は残し、別 docId を作成しています');
          return false;
        }
        return true;
      },
    });
    if (result?.draftDocUrl) {
      chrome.tabs.create({ url: result.draftDocUrl });
    }
    showToast(result?.action === 'reused' ? '既存DRAFTを開きました' : 'DRAFTを作成しました');
    return result;
  } catch (error) {
    if (error?.message === cancelMessage) {
      showToast('DRAFT の準備をやめました');
      return null;
    }
    console.error('[SK] createOrOpenDraftDoc failed:', error);
    showToast(error?.message || 'DRAFTの準備に失敗しました', true, 4500);
    return null;
  } finally {
    hideSavingOverlay();
  }
}

// =====================================================
// セットアップ（業種・店舗）
// =====================================================

function renderIndustryOptions() {
  const sel = document.getElementById('industry-select');
  if (!sel) return;
  clearChildren(sel);
  for (const item of state.industries.items) {
    const opt = el('option', { value: item.id, text: item.label });
    if (item.id === state.settings.industry) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderIndustryHint() {
  const hintEl = document.getElementById('industry-hint');
  if (!hintEl) return;
  const item = state.industries.items.find(
    (i) => i.id === state.settings.industry
  );
  if (!item || !item.description) {
    hintEl.classList.add('hidden');
    return;
  }
  hintEl.classList.remove('hidden');
  hintEl.textContent = item.description;
}

function getIndustryDisplayLabel() {
  return state.settings.industryLabel ||
    (state.industries?.items || []).find((item) => item.id === state.settings.industry)?.label ||
    '';
}

function renderBusinessSettingsReadout() {
  const industryEl = document.getElementById('setup-business-industry');
  const storeEl = document.getElementById('setup-business-store');
  const helpEl = document.getElementById('setup-business-help');
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  if (industryEl) {
    industryEl.textContent = industry || '未設定';
    industryEl.classList.toggle('is-empty', !industry);
  }
  if (storeEl) {
    storeEl.textContent = store || '未設定';
    storeEl.classList.toggle('is-empty', !store);
  }
  if (helpEl) {
    helpEl.textContent = industry && store
      ? 'プロンプト内の ★業種★ / ★店舗名★ はこの値で置換されます。変更は設定ページで行います。'
      : '事業情報は設定ページで入力します。入力後、この表示は自動で更新されます。';
  }
}

function missionEl(id) {
  return document.getElementById(id);
}

function getLiveMissionTask() {
  const snapshot = missionTaskSnapshot;
  if (!snapshot || snapshot.visible === false || snapshot.status === 'idle') return null;
  const activeProjectId = window.SK_STATE?._activeProjectId || '';
  if (snapshot.projectId && activeProjectId && snapshot.projectId !== activeProjectId) return null;
  const updatedAt = Number(snapshot.updatedAt || 0);
  if (!updatedAt || Date.now() - updatedAt > 10 * 60 * 1000) return null;
  return snapshot;
}

// 実行中かどうかは automation.js の実フラグを見る。タスク監視スナップショットは
// 10 分で失効するため、半自動で受講者が長く考えていると「停止した」と誤判定され、
// 実行途中に入口モードカードが再び現れて §0 の前提を変えられてしまう。
function isAutomationRunningNow() {
  try {
    return window.SK_AUTOMATION?.isRunning?.() === true;
  } catch (_) {
    return false;
  }
}

function missionStatusLabel(status, mode) {
  const label = {
    running: '全自動 · 実行中',
    retrying: '全自動 · 再試行中',
    paused: '全自動 · 一時停止',
    blocked: '全自動 · 保留',
    completed: '全自動 · 完了',
    ready: '開始前',
  }[status] || '開始前';
  return mode === 'semi' ? label.replace('全自動', '半自動') : label;
}

function renderMissionRoute(phases, filledSet, partialSet, currentNo) {
  const route = missionEl('mission-phase-route');
  if (!route) return;
  clearChildren(route);
  for (const phase of phases) {
    const no = String(phase.no);
    const item = document.createElement('li');
    const isDone = filledSet.has(no);
    const isCurrent = !isDone && (partialSet.has(no) || no === currentNo);
    item.className = isDone ? 'is-done' : isCurrent ? 'is-current' : '';
    item.setAttribute('aria-label', `§${no} ${isDone ? '完了' : isCurrent ? '現在' : '未着手'}`);
    route.appendChild(item);
  }
}

function renderMissionDetails(title, items) {
  const titleEl = missionEl('mission-state-title');
  if (titleEl) titleEl.textContent = title;
  for (let index = 0; index < 3; index++) {
    const row = document.querySelector(`[data-mission-detail-row="${index + 1}"]`);
    const label = missionEl(`mission-detail-${index + 1}-label`);
    const value = missionEl(`mission-detail-${index + 1}-value`);
    const item = items[index];
    if (row) row.hidden = !item;
    if (label) label.textContent = item ? item[0] : '';
    if (value) value.textContent = item ? item[1] : '';
  }
}

function renderMissionActivity(phases, filledSet, currentPhase, task) {
  const list = missionEl('mission-activity-log');
  if (!list) return;
  clearChildren(list);
  const activity = [];
  const completed = phases.filter((phase) => filledSet.has(String(phase.no)));
  if (completed.length) {
    const phase = completed[completed.length - 1];
    activity.push({ done: true, title: `§${phase.no} ${phase.title}`, detail: 'Google Docsへ保存済み' });
  }
  if (task) {
    const taskModeLabel = task.mode === 'semi' ? '半自動' : '全自動';
    activity.push({
      done: task.status === 'completed',
      title: task.taskLabel || `§${currentPhase.no} ${currentPhase.title}`,
      detail: task.lastEvent || `${taskModeLabel}で処理中`,
    });
  } else if (currentPhase) {
    activity.push({ done: false, title: `§${currentPhase.no} ${currentPhase.title}`, detail: '次に進めるフェーズ' });
  }
  for (const item of activity.slice(-3)) {
    const row = document.createElement('li');
    if (item.done) row.className = 'is-done';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    row.append(title, detail);
    list.appendChild(row);
  }
}

function renderMissionActions(action, status) {
  const primary = missionEl('mission-primary-action');
  const secondary = missionEl('mission-secondary-actions');
  if (!primary || !secondary) return;
  const labels = {
    setup: '初期設定を完了する',
    automation: '実行詳細を見る',
    phase: 'このフェーズを開く',
    master: '戦略書を開く',
  };
  primary.textContent = labels[action] || labels.phase;
  primary.dataset.action = action;
  clearChildren(secondary);
  if (status === 'running' || status === 'retrying') {
    for (const [label, secondaryAction] of [['一時停止', 'pause'], ['停止', 'stop']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.action = secondaryAction;
      secondary.appendChild(button);
    }
    // 半自動／全自動の実行中は共通の全画面コマンドセンターへ移動できる。
    const fullscreenButton = document.createElement('button');
    fullscreenButton.type = 'button';
    fullscreenButton.textContent = '全画面で操作する';
    fullscreenButton.dataset.action = 'fullscreen';
    secondary.appendChild(fullscreenButton);
  } else if (status === 'blocked' || status === 'paused') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '再開';
    button.dataset.action = 'automation';
    secondary.appendChild(button);
  }
}

function renderMissionControl() {
  const phases = getVisiblePhases();
  if (!phases.length) return;
  const filledSet = new Set((state.progressFilledNos || []).map(String));
  const partialSet = new Set((state.progressPartialNos || []).map(String));
  const total = phases.length;
  const completed = phases.filter((phase) => filledSet.has(String(phase.no))).length;
  const partial = phases.filter((phase) => partialSet.has(String(phase.no)) && !filledSet.has(String(phase.no))).length;
  const currentPhase =
    phases.find((phase) => partialSet.has(String(phase.no)) && !filledSet.has(String(phase.no))) ||
    phases.find((phase) => !filledSet.has(String(phase.no))) ||
    phases[phases.length - 1];
  const percent = completed >= total ? 100 : Math.round(((completed + partial * 0.5) / total) * 100);
  const task = getLiveMissionTask();
  const status = completed >= total ? 'completed' : task?.status || 'ready';
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const selectedProject = document.querySelector('#project-select option:checked')?.textContent?.trim();
  const projectParts = [selectedProject, store].filter(Boolean);
  const projectName = projectParts.length ? projectParts.join(' / ') : industry || '新規プロジェクト';

  const projectEl = missionEl('mission-project-name');
  const percentEl = missionEl('mission-overall-percent');
  const metaEl = missionEl('mission-overall-meta');
  const progressEl = missionEl('mission-overall-progress');
  const progressBar = missionEl('mission-overall-progress-bar');
  const phaseTitle = missionEl('mission-current-phase-title');
  const phaseStatus = missionEl('mission-current-phase-status');
  const phaseDescription = missionEl('mission-current-phase-description');
  const collapsedProjectEl = missionEl('mission-collapsed-project');
  const collapsedPercentEl = missionEl('mission-collapsed-percent');
  if (projectEl) projectEl.textContent = projectName;
  if (collapsedProjectEl) collapsedProjectEl.textContent = projectName;
  if (percentEl) percentEl.textContent = `${percent}%`;
  if (collapsedPercentEl) collapsedPercentEl.textContent = `${percent}%`;
  if (metaEl) metaEl.textContent = `${completed} / ${total}フェーズ完了${partial ? ` · 下書き ${partial}` : ''}`;
  if (progressEl) progressEl.setAttribute('aria-valuenow', String(percent));
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (phaseTitle) phaseTitle.textContent = `§${currentPhase.no} ${currentPhase.title}`;
  if (phaseStatus) phaseStatus.textContent = missionStatusLabel(status, task?.mode);
  if (phaseDescription) {
    phaseDescription.textContent = task?.taskLabel || currentPhase.frame || `${currentPhase.title}を進めます。`;
  }
  renderMissionRoute(phases, filledSet, partialSet, String(currentPhase.no));

  let detailTitle = '次の一手';
  const executionMode = task?.mode === 'full' || task?.mode === 'semi'
    ? task.mode
    : getAutomationExecutionMode();
  const executionModeLabel = executionMode === 'full' ? '全自動' : '半自動';
  let details = [
    ['現在フェーズ', `§${currentPhase.no} ${currentPhase.title}`],
    ['実行方法', `${executionModeLabel}モード`],
  ];
  if (status === 'running') {
    detailTitle = `${executionModeLabel}の進行状況`;
    details = [
      ['全体の流れ', `${completed} / ${total}フェーズ完了`],
      ['現在地点', task.taskLabel || `§${currentPhase.no} ${currentPhase.title}`],
      ['直近', task.lastEvent || '処理中'],
    ];
  } else if (status === 'retrying') {
    detailTitle = '自動再試行の状況';
    details = [['現在地点', task.taskLabel], ['状況', task.lastEvent || '再試行中'], ['保存済み', `${completed}フェーズ`]];
  } else if (status === 'blocked' || status === 'paused') {
    detailTitle = '保存地点から再開できます';
    details = [['止まった地点', task.taskLabel], ['直近', task.lastEvent || '処理を停止'], ['保存済み', `${completed}フェーズ`]];
  } else if (status === 'completed') {
    detailTitle = '戦略書が完成しました';
    details = [['完成物', 'STRATEGY-KIT 戦略書'], ['種別', 'Google Docs'], ['要確認', '数値と固有名詞を最終確認']];
  }
  renderMissionDetails(detailTitle, details);
  renderMissionActivity(phases, filledSet, currentPhase, task);

  const hasBusiness = !!(industry && store);
  const action = !hasBusiness ? 'setup' : status === 'completed' ? 'master' : task ? 'automation' : 'phase';
  // 表示フック: 算出済み state を data 属性で外に出し、CSS が状態別アクセント（保留=amber/完了=mint 等）を
  // 引けるようにする。状態機械そのものは不変で、state→表示のマップは CSS 側が担う。
  const stateDetailsEl = missionEl('mission-state-details');
  if (stateDetailsEl) stateDetailsEl.dataset.status = hasBusiness ? status : 'setup';
  renderMissionActions(action, status);

  // 段階3: 全画面ページ向けに raw 入力を publish（変化時のみ）。表示計算は mission 側の
  // 共通 view-model が担うため、ここでは phases / 進捗 / 案件名 の一次情報だけ渡す。
  publishMissionSnapshot(phases, filledSet, partialSet, hasBusiness, projectName);
}

// mission.html は sk-state.ui.missionSnapshot を購読して描画する。renderMissionControl の
// たびに書くと storage 書き込みが増えるため、内容シグネチャが変わったときだけ set する。
function publishMissionSnapshot(phases, filledSet, partialSet, hasBusiness, projectName) {
  try {
    if (!chrome?.storage?.local) return;
    // 現在地（§N）統一: 全画面ホームが薄バーと同じフェーズを指せるよう、選択フェーズ(lastPhase)基準の
    // 番号を publish する（薄バー renderSlimBar と同一の findModeAdjustedPhaseById(lastPhase) || currentPhase）。
    const currentPhase =
      phases.find((phase) => partialSet.has(String(phase.no)) && !filledSet.has(String(phase.no))) ||
      phases.find((phase) => !filledSet.has(String(phase.no))) ||
      phases[phases.length - 1] ||
      null;
    const selected = findModeAdjustedPhaseById(state.settings.lastPhase) || currentPhase;
    const executionMode = getAutomationExecutionMode();
    // 進め方（入口モード）未選択の判定は renderCurrentPhaseCard の needs-mode 規則と同一。
    const total = phases.length;
    const completed = phases.filter((phase) => filledSet.has(String(phase.no))).length;
    const task = getLiveMissionTask();
    const running = task?.status === 'running' || task?.status === 'retrying' || isAutomationRunningNow();
    const needsMode =
      hasBusiness && !state.settings[ENGAGEMENT_MODE_KEY] && completed < total && !running;
    // 案件一覧は既にサイドパネルが同期している #project-select の DOM から読む（二重実装を避ける）。
    const projectSelect = document.getElementById('project-select');
    const projects = projectSelect
      ? [...projectSelect.options].filter((opt) => opt.value).map((opt) => ({ id: opt.value, label: opt.textContent || '' }))
      : [];
    const activeProjectId = projectSelect?.value || '';
    // 全画面の壁打ち欄が「出す/畳む/確定済み表示」を判断するための入口モードと要約状態。
    // 判定は既存の getEngagementMode / isHearingSummaryConsistentSync をそのまま使う（二重実装しない）。
    const hearingSummary = String(state.settings[HEARING_SUMMARY_KEY] || '').trim();
    const hearing = {
      mode: getEngagementMode(),
      hasSummary: !!hearingSummary,
      consistent: !!hearingSummary && isHearingSummaryConsistentSync(),
      summaryLength: hearingSummary.length,
    };
    // 壁打ちの汎用プロンプトに差し込む事業設定（全画面は state.settings を読めない）。
    const business = {
      industryLabel: String(state.settings.industryLabel || '').trim(),
      storeName: String(state.settings.storeName || '').trim(),
    };
    const snapshot = {
      phases: phases.map((phase) => ({ no: phase.no, title: phase.title, frame: phase.frame || '' })),
      filledNos: [...filledSet],
      partialNos: [...partialSet],
      hasBusiness: !!hasBusiness,
      projectName: projectName || '',
      selectedNo: selected ? String(selected.no) : '',
      needsMode: !!needsMode,
      executionMode,
      projects,
      activeProjectId,
      hearing,
      business,
      updatedAt: Date.now(),
    };
    const signature = JSON.stringify({ ...snapshot, updatedAt: 0 });
    if (signature === lastMissionSnapshotSignature) return;
    lastMissionSnapshotSignature = signature;
    chrome.storage.local.set({ [MISSION_SNAPSHOT_STORAGE_KEY]: snapshot });
  } catch (e) {
    /* publish 失敗は致命的でない（全画面ページが未起動なだけ） */
  }
}

async function publishMissionCommandResult(command, ok, message, extra = {}) {
  try {
    await chrome.storage.local.set({
      [MISSION_COMMAND_RESULT_STORAGE_KEY]: {
        commandTs: command?.ts || 0,
        action: command?.action || '',
        ok: !!ok,
        message: String(message || ''),
        ...extra,
        ts: Date.now(),
      },
    });
    await chrome.storage.local.remove([MISSION_COMMAND_STORAGE_KEY]);
  } catch (_) {
    /* 結果通知の失敗は既存処理を止めない */
  }
}

function applyMissionAutomationDraft(draft) {
  if (!draft || typeof draft !== 'object') return;
  // 受講者が全画面で意図的に消した欄は、空のまま反映する（そうしないと消した内容が復活する）。
  const clearedFields = new Set(Array.isArray(draft.clearedFields) ? draft.clearedFields : []);
  const values = [
    ['sk-auto-memo', draft.memo, 'input', 'memo'],
    ['sk-auto-context', draft.context, 'input', 'context'],
    ['sk-auto-model', draft.model, 'change', ''],
    ['sk-auto-finance-model', draft.financeModel, 'change', ''],
  ];
  for (const [id, value, eventName, field] of values) {
    const input = document.getElementById(id);
    if (!input || value === undefined || value === null) continue;
    // 空文字は原則「未指定」として扱い、サイドパネル側に入力済みの内容を消さない。
    // 全画面の入力欄が空のまま実行されたときに、現状メモごと失うのを防ぐ。
    if (String(value) === '' && String(input.value || '') !== '' && !clearedFields.has(field)) continue;
    input.value = String(value);
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
  }
  const requestedMode = draft.mode === 'semi' ? 'semi' : 'full';
  setAutomationExecutionMode(requestedMode, {
    persist: true,
    persistDraft: true,
    openWorkspace: false,
  });
}

async function ensureMissionAutomationUi() {
  switchTab('automation');
  const ready = await window.SK_AUTOMATION?.ensureReady?.();
  if (!ready) return false;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return true;
}

// 別案件のマスタードキュメントへ書き込む/読み出す可能性のある操作。projectId の一致を要求する。
const MISSION_PROJECT_SCOPED_ACTIONS = new Set([
  'startAutomation',
  'startFullAuto',
  'restartFromPhase',
  'openMaster',
  'copyPrompt',
  'openPhase',
  // 全画面から「ヒアリング済み情報」の貼付欄を開く操作も、別案件へ切り替えさせない。
  'openHearingImport',
  // 別案件のヒアリング要約を上書きさせない（要約は §0 シードと §1 以降の前提になる）。
  'confirmHearingSummary',
]);
// サイドパネルが閉じている間に書かれたコマンドの有効期限。これを過ぎたものは破棄する。
const MISSION_COMMAND_MAX_AGE_MS = 60 * 1000;

async function processMissionCommand(command) {
  if (!command || !command.action || !command.ts || command.ts === lastMissionCommandTs) return;
  lastMissionCommandTs = command.ts;
  // サイドパネルが閉じていた等でコマンドが storage に残り続けた場合、次回起動時に
  // 意図しない全自動が走らないよう、古いコマンドは実行せず捨てる。
  if (Date.now() - Number(command.ts) > MISSION_COMMAND_MAX_AGE_MS) {
    try {
      await chrome.storage.local.remove([MISSION_COMMAND_STORAGE_KEY]);
    } catch (_) {
      /* 破棄に失敗しても実行はしない */
    }
    return;
  }
  // 全画面が表示していた案件と、いまサイドパネルが開いている案件が違うなら実行しない。
  const activeProjectId = window.SK_STATE?._activeProjectId || '';
  if (command.projectId && activeProjectId && command.projectId !== activeProjectId
      && MISSION_PROJECT_SCOPED_ACTIONS.has(command.action)) {
    await publishMissionCommandResult(
      command,
      false,
      '表示中のプロジェクトとサイドパネルのプロジェクトが違います。全画面を再読み込みしてからお試しください。',
    );
    return;
  }
  try {
    if (command.action === 'pauseAutomation' || command.action === 'cancel') {
      const ready = await ensureMissionAutomationUi();
      const cancel = ready ? document.getElementById('sk-auto-cancel') : null;
      if (!cancel || cancel.disabled || cancel.style.display === 'none') {
        await publishMissionCommandResult(command, false, '現在、中断できる実行はありません。');
        return;
      }
      cancel.click();
      await publishMissionCommandResult(command, true, '現在地点を保存して中断します。');
      return;
    }

    if (command.action === 'startAutomation' || command.action === 'startFullAuto') {
      const ready = await ensureMissionAutomationUi();
      if (!ready) {
        await publishMissionCommandResult(command, false, 'Google連携を確認してから実行してください。');
        return;
      }
      const commandDraft = {
        ...(command.draft || {}),
        mode: command.action === 'startFullAuto'
          ? 'full'
          : command.draft?.mode === 'semi' ? 'semi' : 'full',
      };
      applyMissionAutomationDraft(commandDraft);
      const start = document.getElementById('sk-auto-start');
      if (!start || start.disabled) {
        await publishMissionCommandResult(command, false, '実行中か、開始条件を確認しています。少し待って再度お試しください。');
        return;
      }
      start.click();
      const modeLabel = commandDraft.mode === 'semi' ? '半自動' : '全自動';
      const suffix = commandDraft.mode === 'semi'
        ? 'サイドパネルでAIの回答を確認・貼り付けながら進めてください。'
        : '進行状況はこの全画面ダッシュボードにも同期されます。';
      await publishMissionCommandResult(command, true, `${modeLabel}を開始しました。${suffix}`);
      return;
    }

    if (command.action === 'restartFromPhase') {
      const ready = await ensureMissionAutomationUi();
      if (!ready || typeof window.SK_AUTOMATION?.runFromPhase !== 'function') {
        await publishMissionCommandResult(command, false, 'Google連携後にフェーズ再実行を利用できます。');
        return;
      }
      const phase = getVisiblePhases().find((item) => String(item.no) === String(command.phaseNo));
      if (!phase) {
        await publishMissionCommandResult(command, false, '指定したフェーズを確認できませんでした。');
        return;
      }
      applyMissionAutomationDraft(command.draft);
      await publishMissionCommandResult(
        command,
        true,
        `§${phase.no} ${phase.title} 以降の再実行を開始します。`,
      );
      await window.SK_AUTOMATION.runFromPhase(String(phase.no), {
        mode: command.draft?.mode === 'semi' ? 'semi' : 'full',
      });
      return;
    }

    if (command.action === 'openAutomation') {
      const ready = await ensureMissionAutomationUi();
      await publishMissionCommandResult(
        command,
        !!ready,
        ready ? '実行設定をサイドパネルに表示しました。' : 'Google連携後に実行設定を利用できます。',
      );
      return;
    }

    if (command.action === 'openPhase') {
      const phase = getVisiblePhases().find((item) => String(item.no) === String(command.phaseNo));
      if (!phase) {
        await publishMissionCommandResult(command, false, '指定したフェーズを確認できませんでした。');
        return;
      }
      state.settings.lastPhase = phase.id;
      persistSettings();
      switchTab('phases');
      emit('phase-changed', phase);
      renderCurrentPhaseCard();
      renderMissionControl();
      await publishMissionCommandResult(command, true, `§${phase.no} ${phase.title} を操作対象にしました。`);
      return;
    }

    if (command.action === 'copyPrompt') {
      const phase = findModeAdjustedPhaseById(state.settings.lastPhase) || getNextStatusPhase();
      if (!phase) {
        await publishMissionCommandResult(command, false, 'コピーできるフェーズがありません。');
        return;
      }
      const rawPrompt = phase.prompts?.[0]?.body || phase.prompts?.[0]?.text || '';
      if (!rawPrompt) {
        await publishMissionCommandResult(command, false, 'このフェーズにコピーできるプロンプトがありません。');
        return;
      }
      // クリップボードへの書き込みは、フォーカスを持っている全画面タブ側で行う。
      // サイドパネルは非フォーカスなので navigator.clipboard.writeText が必ず失敗する。
      const promptText = await enrichWithMasterSummaries(rawPrompt);
      await publishMissionCommandResult(command, true, '', { promptText, phaseNo: String(phase.no) });
      return;
    }

    if (command.action === 'openHearingImport') {
      if (isAutomationRunningNow()) {
        await publishMissionCommandResult(
          command,
          false,
          '実行中は入口モードを変更できません。中断するか、完了してからヒアリング済み情報を取り込んでください。',
        );
        return;
      }
      if (state.settings[ENGAGEMENT_MODE_KEY] !== 'B') {
        const changed = await handleModeChange('B');
        if (!changed) {
          await publishMissionCommandResult(
            command,
            false,
            '入口モードの変更を完了できませんでした。サイドパネルで「ヒアリング済み」を選び直してください。',
          );
          return;
        }
      }
      switchTab('phases');
      document.getElementById('tab-phases')?.classList.add('show-engagement-mode');
      state.modeLocal.modeSelectorExpanded = true;
      renderModeSelector();
      requestAnimationFrame(() => {
        const field = document.querySelector('.mode-b-summary-panel [data-role="hearing-raw"]');
        field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        field?.focus({ preventScroll: true });
      });
      await publishMissionCommandResult(
        command,
        true,
        'ヒアリング済み情報の貼り付け欄を開きました。文字起こし・議事録・メモを「1」の欄へ貼ってください。',
      );
      return;
    }

    // 全画面の壁打ち欄で作った要約を確定する。保存本体は既存の persistHearingSummary に
    // 委ねる（6000字検証・案件メタ生成・lastPhase 更新・再描画を二重実装しないため）。
    if (command.action === 'confirmHearingSummary') {
      const text = String(command.text || '').trim();
      if (!text) {
        await publishMissionCommandResult(command, false, '確定する要約が空でした。');
        return;
      }
      const saved = await persistHearingSummary(text);
      await publishMissionCommandResult(
        command,
        saved,
        saved
          ? 'ヒアリング要約を確定しました。§0 と §1 以降のプロンプトにこの要約が入ります。'
          : (state.modeLocal.hearingStatusMessage || '要約を保存できませんでした。'),
      );
      return;
    }

    if (command.action === 'openAi') {
      const phase = findModeAdjustedPhaseById(state.settings.lastPhase) || getNextStatusPhase();
      const ai = phase?.primaryAi || 'gemini';
      await openOrFocusAiTab(ai);
      await publishMissionCommandResult(command, true, `${ai} を作業用に開きました。`);
      return;
    }

    if (command.action === 'openMaster') {
      document.getElementById('open-master-doc')?.click();
      await publishMissionCommandResult(command, true, 'マスタードキュメントを確認します。');
      return;
    }

    if (command.action === 'switchProject' && command.projectId && window.SK_STATE?.project) {
      // 実行中かどうかは実フラグで見る。10分で失効するスナップショットで判定すると、
      // 半自動で長く考えている間にガードを素通りし、reload で実行中のチェーンが消える。
      if (isAutomationRunningNow()) {
        await publishMissionCommandResult(command, false, '実行中はプロジェクトを切り替えられません。先に中断してください。');
        return;
      }
      await window.SK_STATE.project.activate(command.projectId);
      await publishMissionCommandResult(command, true, 'プロジェクトを切り替えました。');
      window.location.reload();
      return;
    }

    if (command.action === 'createProject' && window.SK_STATE?.project) {
      if (isAutomationRunningNow()) {
        await publishMissionCommandResult(command, false, '実行中は新しいプロジェクトへ切り替えられません。先に中断してください。');
        return;
      }
      const label = String(command.label || '').trim();
      if (!label) {
        await publishMissionCommandResult(command, false, 'プロジェクト名を入力してください。');
        return;
      }
      await window.SK_STATE.project.create(label);
      await publishMissionCommandResult(command, true, `「${label}」を作成しました。`);
      window.location.reload();
      return;
    }

    await publishMissionCommandResult(command, false, 'この操作には対応していません。');
  } catch (error) {
    console.warn('[STRATEGY-KIT] mission command failed:', command.action, error);
    await publishMissionCommandResult(command, false, '操作を完了できませんでした。サイドパネルで状態を確認してください。');
  }
}

// コマンドセンターを同じChromeウィンドウの通常タブで開く。
// メイン領域は mission.html、右側はサイドパネルのままなので、進捗と詳細操作を同時に扱える。
// 旧版の popup に既存タブが残っている場合は、現在の通常ウィンドウへ移して再利用する。
async function openMissionFullscreen() {
  try {
    const url = chrome.runtime.getURL('sidepanel/mission.html');
    const currentWindow = await chrome.windows.getCurrent();
    const targetWindowId = currentWindow?.type === 'normal' ? currentWindow.id : undefined;
    const existing = await chrome.tabs.query({ url });
    if (existing && existing.length) {
      let tab = existing[0];
      if (targetWindowId && tab.windowId !== targetWindowId) {
        const moved = await chrome.tabs.move(tab.id, {
          windowId: targetWindowId,
          index: -1,
        });
        tab = Array.isArray(moved) ? moved[0] : moved;
      }
      await chrome.tabs.update(tab.id, { active: true });
      if (targetWindowId) {
        await chrome.windows.update(targetWindowId, { focused: true }).catch(() => {});
      }
      return tab;
    }
    return await chrome.tabs.create({
      url,
      active: true,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
    });
  } catch (e) {
    console.warn('[STRATEGY-KIT] openMissionFullscreen failed:', e);
    // ウィンドウ情報の取得・移動に失敗しても、通常タブで開く導線は失わない。
    try {
      return await chrome.tabs.create({
        url: chrome.runtime.getURL('sidepanel/mission.html'),
        active: true,
      });
    } catch (_) {
      return null;
    }
  }
}

function applyMissionHeaderCollapsed() {
  const header = document.getElementById('mission-header');
  const toggle = document.getElementById('mission-header-toggle');
  const collapsed = state.settings.missionHeaderCollapsed === true;
  if (header) header.classList.toggle('is-collapsed', collapsed);
  if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
}

function setMissionMenuOpen(open) {
  const menu = document.getElementById('mission-menu');
  if (!menu) return;
  const next = open === undefined ? menu.classList.contains('hidden') : !!open;
  menu.classList.toggle('hidden', !next);
  // 旧ヘッダ（非表示）と、常設する唯一の ☰ の aria-expanded を同期する。
  for (const id of ['mission-settings', 'slim-menu']) {
    document.getElementById(id)?.setAttribute('aria-expanded', String(next));
  }
}

function bindMissionControl() {
  // ••• メニュー: トグル / 外側クリック・Esc で閉じる / 主要アクション押下で閉じる
  missionEl('mission-settings')?.addEventListener('click', function (event) {
    event.stopPropagation();
    setMissionMenuOpen();
  });
  document.addEventListener('click', function (event) {
    const menu = document.getElementById('mission-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(event.target) || event.target.closest('#mission-settings, #slim-menu')) return;
    setMissionMenuOpen(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') setMissionMenuOpen(false);
  });
  document.getElementById('mission-menu')?.addEventListener('click', function (event) {
    if (event.target.closest('#open-master-doc, #open-setup, #reset-state, #open-options')) {
      setMissionMenuOpen(false);
    }
  });

  // ヘッダ折りたたみ（状態は settings に保存・復元）
  missionEl('mission-header-toggle')?.addEventListener('click', function () {
    state.settings.missionHeaderCollapsed = state.settings.missionHeaderCollapsed !== true;
    applyMissionHeaderCollapsed();
    persistSettings();
  });
  applyMissionHeaderCollapsed();

  missionEl('mission-primary-action')?.addEventListener('click', function () {
    const action = this.dataset.action || 'phase';
    if (action === 'setup') return openBusinessSettings();
    if (action === 'master') return document.getElementById('open-master-doc')?.click();
    switchTab(action === 'automation' ? 'automation' : 'phases');
  });
  missionEl('mission-secondary-actions')?.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'fullscreen') {
      openMissionFullscreen();
      return;
    }
    switchTab('automation');
    if (action === 'pause' || action === 'stop') {
      requestAnimationFrame(() => document.getElementById('sk-auto-cancel')?.click());
    }
  });

  // 全自動管理ビュー内の「全画面で操作する」ボタン。
  document.getElementById('mission-fullscreen-open')?.addEventListener('click', openMissionFullscreen);

  // 薄型パネル v2: 薄バーの ☰ → ドロワー、中央タップ → 全画面ホーム
  document.getElementById('slim-menu')?.addEventListener('click', function (event) {
    event.stopPropagation();
    setMissionMenuOpen();
  });
  document.getElementById('slim-center')?.addEventListener('click', openMissionFullscreen);
  document.getElementById('slim-dashboard-open')?.addEventListener('click', openMissionFullscreen);

  // ドロワーの「実行モードを管理」→ 半自動／全自動の共通設定へ。
  // ドロワーの「入口モードを変える」→ 戦略タブの入口モードカードを開く。
  // 現在フェーズカードの常設ボタンと同じ関数を使い、導線ごとの挙動差を作らない。
  document.getElementById('menu-engagement-mode')?.addEventListener('click', function () {
    setMissionMenuOpen(false);
    openEngagementModeSelector();
  });

  document.getElementById('menu-automation')?.addEventListener('click', function () {
    setMissionMenuOpen(false);
    switchTab('automation');
  });

  // 戦略タブ: 現在のフェーズ ⇄ フェーズ一覧 セグメントトグル
  for (const btn of document.querySelectorAll('#strategy-phase-toggle .phase-toggle-btn')) {
    btn.addEventListener('click', () => setPhaseView(btn.dataset.phaseView));
  }
}

function renderStableShell(reason) {
  renderIndustryOptions();
  renderIndustryHint();
  renderBusinessSettingsReadout();
  renderAutomationModeControls();
  renderModeSelector();
  renderPhaseList();
  renderResearchTab();
  renderPrinciples();
  renderContextBar();
  renderStatusCluster();
  renderCurrentLocationBar();
  renderMissionControl();
  renderSlimBar();
  renderCurrentPhaseCard();
  syncEmptyStates();
}

function scheduleStableRender(reason) {
  if (!sidepanelInitialized) return;
  if (stableRenderRaf) return;
  stableRenderRaf = requestAnimationFrame(function () {
    stableRenderRaf = 0;
    renderStableShell(reason);
  });
}

function openBusinessSettings() {
  chrome.runtime.openOptionsPage?.();
}

function normalizeAutomationExecutionMode(mode) {
  return mode === 'full' ? 'full' : 'semi';
}

function automationExecutionModeStorageKey(projectId) {
  return projectId
    ? `sk-state.projects.${projectId}.${AUTOMATION_EXECUTION_MODE_PATH}`
    : `sk-state.${AUTOMATION_EXECUTION_MODE_PATH}`;
}

function getAutomationExecutionMode() {
  return normalizeAutomationExecutionMode(state.modeLocal.automationExecutionMode);
}

function renderAutomationModeControls() {
  const mode = getAutomationExecutionMode();
  for (const button of document.querySelectorAll('[data-automation-mode]')) {
    const selected = button.dataset.automationMode === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function setAutomationExecutionMode(mode, options = {}) {
  const normalized = normalizeAutomationExecutionMode(mode);
  state.modeLocal.automationExecutionMode = normalized;
  renderAutomationModeControls();

  if (window.SK_AUTOMATION && typeof window.SK_AUTOMATION.setMode === 'function') {
    window.SK_AUTOMATION.setMode(normalized, {
      persistMode: false,
      persistDraft: options.persistDraft !== false,
    });
  }
  if (options.persist !== false && window.SK_STATE) {
    window.SK_STATE.save(AUTOMATION_EXECUTION_MODE_PATH, normalized);
  }
  if (options.openWorkspace === true) {
    switchTab('automation');
  }
  renderMissionControl();
  renderCurrentPhaseCard();
}

function applyAutomationExecutionModeFromStorage(mode) {
  setAutomationExecutionMode(mode, {
    persist: false,
    persistDraft: true,
    openWorkspace: false,
  });
}

// =====================================================
// タブ切替 (Wave 4: セグメント廃止、3タブ単段化)
// =====================================================

function switchTab(name, options = {}) {
  state.settings.lastTab = name;
  const navigationName = name === 'automation' ? 'phases' : name;
  const shouldPersist = options.persist !== false && sidepanelInitialized;
  if (shouldPersist) {
    persistSettings();
    if (window.SK_STATE) window.SK_STATE.save('ui.activeTab', name);
  }
  requestAnimationFrame(function () {
    for (const btn of document.querySelectorAll('.tab-btn')) {
      const isOn = btn.dataset.tab === navigationName;
      btn.classList.toggle('is-active', isOn);
      btn.setAttribute('aria-selected', String(isOn));
    }
    renderAutomationModeControls();
    for (const cnt of document.querySelectorAll('.tab-content')) {
      cnt.classList.toggle('is-active', cnt.id === `tab-${name}`);
    }
    // Wave 5: スライドタブ初期化
    if (name === 'diagram' && window.SlidesHandoff) {
      window.SlidesHandoff.init();
    }
    // 修正A: 自動化タブをアクティブにしたタイミングで OAuth を再評価し、
    //   連携済みなら（未構築のとき）スロットを構築する。連携後の拡張リロードを不要にする。
    if (name === 'automation' && window.SK_AUTOMATION && typeof window.SK_AUTOMATION.ensureReady === 'function') {
      Promise.resolve(window.SK_AUTOMATION.ensureReady())
        .then(syncEmptyStates)
        .catch(() => {});
    }
    syncEmptyStates();
  });
}

function bindTabs() {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // R9: キーボードナビ — tabs (循環)
  const allTabs = Array.from(document.querySelectorAll('.tab-btn'));
  for (const tb of allTabs) {
    tb.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const idx = allTabs.indexOf(tb);
      if (idx < 0) return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = allTabs[(idx + dir + allTabs.length) % allTabs.length];
      // v0.9.14: バグC対策 — preventScroll で自動スクロール抑制
      next.focus({ preventScroll: true });
      switchTab(next.dataset.tab);
    });
  }

  for (const btn of document.querySelectorAll('[data-automation-mode]')) {
    btn.addEventListener('click', () => {
      setAutomationExecutionMode(btn.dataset.automationMode, {
        persist: true,
        openWorkspace: true,
      });
    });
  }

  switchTab(state.settings.lastTab || 'phases', { persist: false });
}

// =====================================================
// コンテキストバー(コンパクト事業情報) と Setup card 折畳
// =====================================================

function getStatusProgressSnapshot() {
  const total = getPhaseTotal();
  const filled = (state.progressFilledNos || []).length;
  const partial = (state.progressPartialNos || []).length;
  return { total, filled, partial };
}

function getNextStatusPhase() {
  const phases = getVisiblePhases();
  const filledSet = new Set((state.progressFilledNos || []).map(String));
  const partialSet = new Set((state.progressPartialNos || []).map(String));
  return (
    phases.find((phase) => partialSet.has(String(phase.no))) ||
    phases.find((phase) => !filledSet.has(String(phase.no))) ||
    null
  );
}

function shouldAutoExpandStatusCluster() {
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBusiness = !!industry && !!store;
  if (!hasBusiness) return true;
  if (!state.settings[ENGAGEMENT_MODE_KEY]) return true;
  const { filled, partial } = getStatusProgressSnapshot();
  if (filled === 0 && partial === 0) return true;
  return false;
}

function isStatusClusterExpanded() {
  if (state.modeLocal.statusClusterExpanded === false) return false;
  if (state.modeLocal.statusClusterExpanded === true) return true;
  return shouldAutoExpandStatusCluster();
}

function renderStatusCluster() {
  const cluster = document.getElementById('status-cluster');
  const toggle = document.getElementById('status-compact-toggle');
  const storeEl = document.getElementById('status-compact-store');
  const progressEl = document.getElementById('status-compact-progress');
  const nextEl = document.getElementById('status-compact-next');
  const modeEl = document.getElementById('status-compact-mode');
  const cta = document.getElementById('status-compact-cta');
  const ctaLabel = document.getElementById('status-compact-cta-label');
  const toggleLabel = document.getElementById('status-compact-toggle-label');
  if (!cluster || !toggle) return;

  const expanded = isStatusClusterExpanded();
  cluster.classList.toggle('is-expanded', expanded);
  cluster.classList.toggle('is-collapsed', !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));

  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const businessLabel = store || industry || '未設定';
  const { total, filled } = getStatusProgressSnapshot();
  const nextPhase = getNextStatusPhase();
  const nextLabel = nextPhase ? `次:§${nextPhase.no}` : '完了';
  const modeLabel = state.settings[ENGAGEMENT_MODE_KEY]
    ? getModeReadout()
    : '未選択';
  const action = computeNextAction();

  if (storeEl) storeEl.textContent = businessLabel;
  if (progressEl) progressEl.textContent = `${filled}/${total}`;
  if (nextEl) nextEl.textContent = nextLabel;
  if (modeEl) modeEl.textContent = `入口:${modeLabel}`;
  if (toggleLabel) toggleLabel.textContent = expanded ? '▲ たたむ' : '▼ 展開';
  if (cta && ctaLabel) {
    if (action) {
      cta.classList.remove('hidden');
      ctaLabel.textContent = action.cta || '開く';
      cta.dataset.action = action.action || '';
      cta.dataset.phaseId = action.phaseId || '';
    } else {
      cta.classList.add('hidden');
      cta.dataset.action = '';
      cta.dataset.phaseId = '';
    }
  }
}

// 段階5: 初期設定の完了判定（Google 連携済み＋事業情報設定済み）。
// oauthConnected は init 時に silent 取得され window._setupStripCfg に保持される。
function isInitialSetupComplete() {
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBusiness = !!industry && !!store;
  const oauthConnected = !!(window._setupStripCfg && window._setupStripCfg.oauthConnected);
  return hasBusiness && oauthConnected;
}

function renderContextBar() {
  const bar = document.getElementById('contextbar');
  const setupCard = document.getElementById('setup');
  const setupBody = document.getElementById('setup-body');
  const setupCollapseBtn = document.getElementById('setup-collapse');
  // Lane A: #onboarding は廃止。setup-status-strip の表示状態は別管理のため参照しない

  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBoth = !!industry && !!store;

  // 段階5: 初期設定が完了していて、かつユーザーが明示展開(setupCollapsed===false)
  // していない限り、常設のオンボーディング系(#setup / setup-status-strip)を退避する。
  // 折りたたみ機構(setupCollapsed)は温存し、•••「初期設定を開く」から再表示できる。
  const setupExplicitlyOpen = state.settings.setupCollapsed === false;
  if (isInitialSetupComplete() && !setupExplicitlyOpen) {
    const strip = document.getElementById('setup-status-strip');
    if (strip) strip.classList.add('hidden');
  }

  if (!bar || !setupCard || !setupBody || !setupCollapseBtn) return;

  if (hasBoth) {
    // コンテキストバーに値を入れて表示
    document.getElementById('contextbar-industry').textContent = industry;
    document.getElementById('contextbar-store').textContent = store;
    bar.classList.remove('hidden');
    setupCollapseBtn.classList.remove('hidden');
    // setup card 自体は常に表示し、bodyを折畳
    setupCard.classList.remove('hidden');
    if (state.settings.setupCollapsed !== false) {
      // 折畳済 → setup card 全体も非表示にする(コンテキストバーで代替)
      setupCard.classList.add('hidden');
      setupCollapseBtn.setAttribute('aria-expanded', 'false');
    } else {
      setupCard.classList.remove('hidden');
      setupBody.removeAttribute('hidden');
      setupCollapseBtn.setAttribute('aria-expanded', 'true');
    }
  } else {
    // 未設定 or オンボーディング表示中
    bar.classList.add('hidden');
    setupCard.classList.remove('hidden');
    setupBody.removeAttribute('hidden');
    setupCollapseBtn.classList.add('hidden');
  }
  renderContextBarProgress();
  renderNextAction();
  renderStatusCluster();
}

function getPhaseTotal() {
  return getVisiblePhases().length || DEFAULT_PHASE_TOTAL;
}

async function readOAuthReadyForSetup() {
  try {
    const { getAuthToken } = await import(chrome.runtime.getURL('phase0/auth.js'));
    const token = await getAuthToken({ interactive: false });
    return { oauthReady: !!token, oauthError: null };
  } catch (error) {
    return { oauthReady: false, oauthError: error };
  }
}

async function readMasterDocForSetup() {
  try {
    const [docsClient, masterDocManager] = await Promise.all([
      import(chrome.runtime.getURL('phase0/docs-client.js')),
      import(chrome.runtime.getURL('phase0/master-doc-manager.js')),
    ]);
    const result = await masterDocManager.getStoredMasterDocInfo({
      docsClient,
      storageArea: chrome.storage.sync,
    });
    if (result.exists) {
      return {
        masterDoc: {
          documentId: result.documentId,
          title: result.title,
          docUrl: result.docUrl,
        },
        masterError: null,
      };
    }
    return {
      masterDoc: null,
      masterError: result.error ? new Error(result.error) : null,
    };
  } catch (error) {
    return { masterDoc: null, masterError: error };
  }
}

async function readGeminiAvailabilityForSetup() {
  try {
    const geminiClient = await import(chrome.runtime.getURL('phase0/gemini-client.js'));
    const [key, proxyState] = await Promise.all([
      geminiClient.getGeminiApiKey({ storage: chrome.storage.local }),
      geminiClient.getGeminiProxyConfig({
        storage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      }),
    ]);
    return {
      geminiKeyPresent: !!key,
      geminiProxyPresent: !!proxyState.proxy,
    };
  } catch (_) {
    return { geminiKeyPresent: false, geminiProxyPresent: false };
  }
}

function getChecklistIconId(status) {
  return status === 'ok' ? '#i-check' : '#i-warn';
}

function buildChecklistItem(item) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon icon-xs');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', getChecklistIconId(item.status));
  svg.appendChild(use);

  const actionBtn = item.action
    ? el('button', {
        class: 'btn btn-ghost btn-xs setup-checklist-action',
        type: 'button',
        text: item.actionLabel || '確認する',
        dataset: { action: item.action },
      })
    : null;

  return el(
    'div',
    { class: `setup-checklist-item is-${item.status}` },
    el('div', { class: 'setup-checklist-mark', attrs: { 'aria-hidden': 'true' } }, svg),
    el(
      'div',
      { class: 'setup-checklist-body' },
      el(
        'div',
        { class: 'setup-checklist-row' },
        el('span', { class: 'setup-checklist-label', text: item.title }),
        el('span', { class: 'setup-checklist-chip', text: item.label })
      ),
      el('p', { class: 'setup-checklist-detail', text: item.detail }),
      actionBtn
    )
  );
}

async function buildCurrentSetupChecklistItems() {
  const [setupStatus, oauthState, masterState, geminiAvailability] = await Promise.all([
    import(chrome.runtime.getURL('phase0/setup-status.js')),
    readOAuthReadyForSetup(),
    readMasterDocForSetup(),
    readGeminiAvailabilityForSetup(),
  ]);
  window._setupStripCfg = window._setupStripCfg || {};
  window._setupStripCfg.oauthConnected = oauthState.oauthReady;
  return setupStatus.buildSetupChecklistItems({
    industryLabel: state.settings.industryLabel,
    storeName: state.settings.storeName,
    oauthReady: oauthState.oauthReady,
    oauthError: oauthState.oauthError,
    masterDoc: masterState.masterDoc,
    masterError: masterState.masterError,
    geminiKeyPresent: geminiAvailability.geminiKeyPresent,
    geminiProxyPresent: geminiAvailability.geminiProxyPresent,
  });
}

function describeChecklistSummary(items) {
  const blocking = items.find((item) => item.status === 'error');
  if (blocking) {
    return `まず「${blocking.title}」の ${blocking.label} を解消してください。`;
  }
  const next = items.find((item) => item.status === 'warn');
  if (next) {
    if (next.title === 'Gemini 実行可否' && next.label === '未実行') {
      return '接続まわりは確認済みです。Gemini を使う前だけ「Gemini 実行確認」を行ってください。';
    }
    return `次は「${next.title}」の ${next.label} を整えると導入が完了します。`;
  }
  return '初回導入に必要な項目は揃っています。次は §0 から開始できます。';
}

async function refreshSetupChecklist() {
  const list = document.getElementById('setup-checklist-list');
  const statusEl = document.getElementById('setup-checklist-status');
  if (!list || !statusEl) return;

  statusEl.textContent = 'Google 連携状態を確認しています…';
  statusEl.className = 'setup-checklist-status';

  const items = await buildCurrentSetupChecklistItems();

  clearChildren(list);
  items.forEach((item) => list.appendChild(buildChecklistItem(item)));
  refreshSetupStatusStrip();

  const hasError = items.some((item) => item.status === 'error');
  const hasWarn = items.some((item) => item.status === 'warn');
  if (!hasError && !hasWarn) {
    statusEl.textContent = describeChecklistSummary(items);
    statusEl.className = 'setup-checklist-status is-ok';
  } else if (hasError) {
    statusEl.textContent = describeChecklistSummary(items);
    statusEl.className = 'setup-checklist-status is-warn';
  } else {
    statusEl.textContent = describeChecklistSummary(items);
    statusEl.className = 'setup-checklist-status is-warn';
  }
}

function bindSetupChecklist() {
  const refreshBtn = document.getElementById('setup-checklist-refresh');
  const list = document.getElementById('setup-checklist-list');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshSetupChecklist());
  }
  if (list) {
    list.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'open-options') {
        chrome.runtime.openOptionsPage?.();
      } else if (action === 'run-gemini-probe') {
        chrome.runtime.openOptionsPage?.();
      } else if (action === 'open-setup') {
        document.getElementById('contextbar-edit')?.click();
      } else if (action === 'open-master-doc') {
        document.getElementById('open-master-doc')?.click();
      } else if (action === 'refresh-setup-checklist') {
        refreshSetupChecklist();
      }
    });
  }

  // Lane A: 統合セットアップカードの折りたたみアコーディオン
  ['business', 'checklist'].forEach(function (key) {
    const toggle = document.querySelector('#setup-section-' + key + ' .setup-section-toggle');
    const body = document.getElementById('setup-section-' + key + '-body');
    if (!toggle || !body) return;
    toggle.addEventListener('click', function () {
      const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isExpanded));
      if (isExpanded) {
        body.setAttribute('hidden', '');
      } else {
        body.removeAttribute('hidden');
      }
    });
  });
}

// Lane A: setup-status-strip の状態更新
function refreshSetupStatusStrip() {
  const strip = document.getElementById('setup-status-strip');
  if (!strip) return;

  const oauthConnected = !!(window._setupStripCfg && window._setupStripCfg.oauthConnected);
  const hasBusiness = !!(state.settings.industryLabel && state.settings.storeName);
  const phase0Done = !!(state.progressFilledNos && state.progressFilledNos.includes('0'));

  const steps = [
    { key: 'oauth', done: oauthConnected },
    { key: 'business', done: hasBusiness },
    { key: 'phase0', done: phase0Done },
  ];

  let doneCount = 0;
  steps.forEach(function (step) {
    const item = strip.querySelector('[data-step="' + step.key + '"]');
    if (!item) return;
    const icon = item.querySelector('.setup-status-strip-icon');
    if (step.done) {
      item.classList.remove('is-todo');
      item.classList.add('is-done');
      if (icon) icon.textContent = '☑';
      doneCount++;
    } else {
      item.classList.remove('is-done');
      item.classList.add('is-todo');
      if (icon) icon.textContent = '☐';
    }
  });

  const progressEl = document.getElementById('setup-status-strip-progress');
  if (progressEl) progressEl.textContent = doneCount + '/3';

  // 事業情報セクションのステータスアイコン更新
  const bizIcon = document.getElementById('setup-section-business-icon');
  if (bizIcon) {
    bizIcon.textContent = hasBusiness ? '☑' : '☐';
    const bizSection = document.getElementById('setup-section-business');
    if (bizSection) {
      bizSection.classList.toggle('is-done', hasBusiness);
      bizSection.classList.toggle('is-warn', !hasBusiness);
    }
  }

  // Google 連携セクションのステータスアイコン更新
  const oauthIcon = document.getElementById('setup-section-checklist-icon');
  if (oauthIcon) {
    oauthIcon.textContent = oauthConnected ? '☑' : '☐';
    const oauthSection = document.getElementById('setup-section-checklist');
    if (oauthSection) {
      oauthSection.classList.toggle('is-done', !!oauthConnected);
      oauthSection.classList.toggle('is-warn', !oauthConnected);
    }
  }

  // 全完了で自動非表示
  if (doneCount >= 3) {
    strip.classList.add('hidden');
  }
}

// =====================================================
// Next Action Banner — 「次の一手」を1箇所で示す主導線
// =====================================================
function computeNextAction() {
  const industry = state.settings.industryLabel || '';
  const store = state.settings.storeName || '';
  const hasBusiness = !!industry && !!store;
  const filled = new Set(state.progressFilledNos || []);
  const partial = new Set(state.progressPartialNos || []);
  const totalPhases = getPhaseTotal();

  if (!hasBusiness) {
    return {
      eyebrow: 'まず最初に',
      parts: ['', '事業情報', 'を入れて土台を作ります'],
      cta: '入力する',
      action: 'open-setup',
    };
  }

  if (filled.size >= totalPhases) {
    return {
      eyebrow: '完了おめでとうございます',
      parts: ['', 'マスタードキュメント', 'を開いて成果を確認しましょう'],
      cta: '開く',
      action: 'open-master-doc',
    };
  }

  const phases = getVisiblePhases();
  if (!state.settings[ENGAGEMENT_MODE_KEY]) {
    return {
      eyebrow: 'まず最初に',
      parts: ['', '入口モード', 'を選びます'],
      cta: '入口を選ぶ',
      action: 'open-mode',
    };
  }
  // ヒアリング誘導は停止ゲートと同じ共有判定（getHearingReadinessState）を参照し、
  // 文言・発火条件の二重化/矛盾を防ぐ（設計 §4-4）。
  // 進捗がまだ無い段階でのみ §0 ヒアリングへ誘導する（着手後の動線は不変）。
  const hearingReadiness = getHearingReadinessState();
  const mode = getEngagementMode();
  if ((mode === 'B' || mode === 'C') && hearingReadiness.gateRequired && filled.size === 0 && partial.size === 0) {
    const summaryPhase = phases.find((p) => String(p.no) === '0');
    if (mode === 'B') {
      return {
        eyebrow: 'ヒアリング済み案件',
        parts: ['', '§0 ヒアリング要約', 'を確定します'],
        cta: '要約する',
        action: 'open-phase',
        phaseId: summaryPhase?.id || 'phase-0-mode-b-hearing-summary',
      };
    }
    // モードC（自社事業）: 全自動タブへ誘導（全自動開始時にヒアリングゲートが案内する）
    return {
      eyebrow: 'まず最初に',
      parts: ['全自動を開始すると', 'ヒアリング入力', 'を案内します'],
      cta: '自動化タブへ',
      action: 'open-automation',
    };
  }
  const partialPhase = phases.find((p) => partial.has(String(p.no)));
  if (partialPhase) {
    const phaseLabel = `§${partialPhase.no} ${partialPhase.title}`;
    return {
      eyebrow: `下書きあり ${partial.size}章`,
      parts: ['次は', phaseLabel, 'を仕上げます'],
      cta: '仕上げる',
      action: 'open-phase',
      phaseId: partialPhase.id,
    };
  }
  const nextPhase = phases.find((p) => !filled.has(String(p.no)));
  if (nextPhase) {
    const phaseLabel = `§${nextPhase.no} ${nextPhase.title}`;
    if (filled.size === 0) {
      return {
        eyebrow: 'next move',
        parts: ['', phaseLabel, 'から始めます'],
        cta: '開く',
        action: 'open-phase',
        phaseId: nextPhase.id,
      };
    }
    return {
      eyebrow: `${filled.size} / ${totalPhases} 完了`,
      parts: ['次は', phaseLabel, 'です'],
      cta: '続ける',
      action: 'open-phase',
      phaseId: nextPhase.id,
    };
  }
  return null;
}

function renderNextAction() {
  const banner = document.getElementById('nextaction');
  if (!banner) return;
  // Lane A: #onboarding 廃止。setup-status-strip はサイドバー上部に常設のため nextaction をブロックしない
  const action = computeNextAction();
  if (!action) {
    banner.classList.add('hidden');
    return;
  }
  const eyebrow = document.getElementById('nextaction-eyebrow');
  const text = document.getElementById('nextaction-text');
  const ctaLabel = document.getElementById('nextaction-cta-label');
  if (eyebrow) eyebrow.textContent = action.eyebrow;
  if (text) {
    clearChildren(text);
    const [pre, strong, post] = action.parts;
    if (pre) text.appendChild(document.createTextNode(pre));
    const strongEl = document.createElement('strong');
    strongEl.textContent = strong;
    text.appendChild(strongEl);
    if (post) text.appendChild(document.createTextNode(post));
  }
  if (ctaLabel) ctaLabel.textContent = action.cta;
  banner.dataset.action = action.action;
  banner.dataset.phaseId = action.phaseId || '';
  banner.classList.remove('hidden');
}

function renderContextBarProgress() {
  const countEl = document.getElementById('contextbar-progress-count');
  if (!countEl) return;
  const totalPhases = getPhaseTotal();
  const filledNos = state.progressFilledNos || [];
  const partialNos = state.progressPartialNos || [];
  const filled = filledNos.length;
  const partial = partialNos.length;
  const remaining = Math.max(0, totalPhases - filled - partial);
  const rate = totalPhases > 0 ? Math.min(100, Math.round((filled / totalPhases) * 100)) : 0;

  // Mission Control は全体率、内訳は下の説明行に集約する。
  countEl.textContent = `${rate}%`;

  // 進捗バー fill 更新
  const barFill = document.getElementById('contextbar-bar-fill');
  if (barFill) {
    barFill.style.width = rate + '%';
  }

  // 内訳テキスト更新
  const breakdownEl = document.getElementById('contextbar-breakdown');
  if (breakdownEl) {
    const parts = [`${filled}/${totalPhases} 完了`];
    if (partial > 0) parts.push(`下書き ${partial}`);
    parts.push(`残り ${remaining}`);
    breakdownEl.textContent = parts.join(' · ');
  }

  // 10ドット行更新
  const dotsEl = document.getElementById('contextbar-dots');
  if (dotsEl) {
    clearChildren(dotsEl);
    const phases = getVisiblePhases();
    const filledSet = new Set(filledNos.map(String));
    const partialSet = new Set(partialNos.map(String));
    for (let i = 0; i < totalPhases; i++) {
      const phase = phases[i];
      const no = phase ? String(phase.no) : String(i + 1);
      const isFilled = filledSet.has(no);
      const isPartial = !isFilled && partialSet.has(no);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'contextbar-dot' + (isFilled ? ' is-filled' : isPartial ? ' is-partial' : '');
      btn.textContent = isFilled ? '●' : isPartial ? '◐' : '○';
      const phaseTitle = phase ? `§${phase.no} ${phase.title}` : `§${i + 1}`;
      const stateLabel = isFilled ? ' 完了' : isPartial ? ' 下書き' : ' 未着手';
      btn.setAttribute('aria-label', phaseTitle + stateLabel);
      btn.setAttribute('title', phaseTitle + stateLabel);
      btn.setAttribute('role', 'listitem');
      if (phase) {
        btn.addEventListener('click', () => {
          state.settings.lastPhase = phase.id;
          persistSettings();
          switchTab('phases');
          renderPhaseList();
          renderCurrentPhase();
        });
      }
      dotsEl.appendChild(btn);
    }
  }

  // 「次は §N」表示更新
  const nextEl = document.getElementById('contextbar-next');
  if (nextEl) {
    const phases = getVisiblePhases();
    const filledSet = new Set(filledNos.map(String));
    const partialSet = new Set(partialNos.map(String));
    // 部分入力フェーズ優先、次に未着手フェーズ
    const nextPhase =
      phases.find((p) => partialSet.has(String(p.no))) ||
      phases.find((p) => !filledSet.has(String(p.no)));
    clearChildren(nextEl);
    if (nextPhase && filled < totalPhases) {
      nextEl.appendChild(document.createTextNode('次: '));
      const strong = document.createElement('strong');
      strong.textContent = `§${nextPhase.no} ${nextPhase.title}`;
      nextEl.appendChild(strong);
    }
  }
}

function activateNextActionFromHost(host) {
  if (!host) return;
  const act = host.dataset.action;
  if (act === 'open-mode') {
    switchTab('phases');
    state.modeLocal.statusClusterExpanded = true;
    renderStatusCluster();
    renderModeSelector();
    const modeCard = document.getElementById('engagement-mode');
    if (modeCard) {
      modeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const firstBtn = modeCard.querySelector('button[data-mode]');
      if (firstBtn) setTimeout(() => firstBtn.focus({ preventScroll: true }), 250);
    }
  } else if (act === 'open-setup') {
    openBusinessSettings();
  } else if (act === 'open-phase' && host.dataset.phaseId) {
    switchTab('phases');
    state.settings.lastPhase = host.dataset.phaseId;
    persistSettings();
    renderPhaseList();
    const activeRow = document.querySelector(`.phase-row[data-phase-id="${host.dataset.phaseId}"]`);
    if (activeRow) {
      setTimeout(() => activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
    }
  } else if (act === 'open-master-doc') {
    // Wave 4: 図解タブ廃止に伴い、完了時はマスタードキュメントを開く
    const masterBtn = document.getElementById('open-master-doc');
    if (masterBtn) masterBtn.click();
  } else if (act === 'open-automation') {
    // C モード・ヒアリング誘導: 自動化タブへ移動（全自動開始時にゲートが案内）
    switchTab('automation');
  }
}

function bindNextAction() {
  const cta = document.getElementById('nextaction-cta');
  const banner = document.getElementById('nextaction');
  if (cta && banner) {
    cta.addEventListener('click', () => {
      activateNextActionFromHost(banner);
    });
  }
}

function bindStatusCluster() {
  const toggle = document.getElementById('status-compact-toggle');
  const cta = document.getElementById('status-compact-cta');
  if (toggle) {
    toggle.addEventListener('click', () => {
      state.modeLocal.statusClusterExpanded = !isStatusClusterExpanded();
      renderStatusCluster();
      renderModeSelector();
    });
  }
  if (cta) {
    cta.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateNextActionFromHost(cta);
    });
  }
}

// =====================================================
// Empty State 切替 — mod-slot が hidden のとき empty-card を表示
// =====================================================
function syncEmptyStates() {
  // Wave 4: 図解タブ廃止により automation のみ
  const slot = document.getElementById('mod-automation-slot');
  const empty = document.getElementById('automation-empty');
  if (!slot || !empty) return;
  // slot が hidden = モジュール未ロード → empty を表示
  if (slot.classList.contains('hidden')) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
}

function bindEmptyStates() {
  const handler = () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  };
  const btn = document.getElementById('automation-empty-cta');
  if (btn) btn.addEventListener('click', handler);
  // mod-slot のクラス変化を監視 → empty-state を再計算
  const targets = ['mod-automation-slot']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (targets.length && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(syncEmptyStates);
    for (const t of targets) {
      obs.observe(t, { attributes: true, attributeFilter: ['class'] });
    }
  }
}

function bindContextBar() {
  const bar = document.getElementById('contextbar');
  const editBtn = document.getElementById('contextbar-edit');
  const setupCard = document.getElementById('setup');
  const setupCollapseBtn = document.getElementById('setup-collapse');

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      openBusinessSettings();
    });
  }
  if (setupCollapseBtn) {
    setupCollapseBtn.addEventListener('click', () => {
      const expanded = setupCollapseBtn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        // 折畳む
        state.settings.setupCollapsed = true;
        setupCard.classList.add('hidden');
        setupCollapseBtn.setAttribute('aria-expanded', 'false');
        renderContextBar();
      } else {
        state.settings.setupCollapsed = false;
        setupCard.classList.remove('hidden');
        setupCollapseBtn.setAttribute('aria-expanded', 'true');
      }
      persistSettings();
    });
  }
}

// =====================================================
// フェーズタブ
// =====================================================

function renderPhaseList() {
  // Wave 4 Phase 1: accordion 風 — 選択行が展開して AI rec / prompts をインライン表示
  const list = document.getElementById('phase-list');
  if (!list) return;
  clearChildren(list);
  const filledNos = new Set(state.progressFilledNos || []);
  const partialNos = new Set(state.progressPartialNos || []);
  ensureVisibleLastPhase();
  const phases = getVisiblePhases();
  for (const phase of phases) {
    const isFilled = filledNos.has(String(phase.no));
    const isPartial = !isFilled && partialNos.has(String(phase.no));
    const isActive = phase.id === state.settings.lastPhase;
    const dataState = isFilled ? 'filled' : isPartial ? 'partial' : 'todo';
    const select = () => {
      state.settings.lastPhase = phase.id;
      persistSettings();
      renderPhaseList();
      renderCurrentPhaseCard();
      renderSlimBar();
      // 一覧から行を選んだら、そのフェーズの現在フェーズカードへ戻る（設計 §2-4）。
      setPhaseView('card');
      emit('phase-changed', phase);
    };
    const statusLabel = isFilled ? ' 完了' : isPartial ? ' 入力あり・仕上げ待ち' : ' 未着手';
    const titleAttr = isFilled
      ? `§${phase.no} ${phase.title} 完了`
      : isPartial
        ? `§${phase.no} ${phase.title} 入力あり。あと1〜2文で仕上げ候補`
        : `§${phase.no} ${phase.title} 未着手`;

    // status SVG (checkmark for filled / partial / empty circle for todo)
    const statusSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    statusSvg.setAttribute('class', 'phase-row-check');
    statusSvg.setAttribute('viewBox', '0 0 24 24');
    statusSvg.setAttribute('aria-hidden', 'true');
    if (isFilled || isPartial) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M4 12l5 5L20 6');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      statusSvg.appendChild(p);
    } else {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '12');
      c.setAttribute('r', '7');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', 'currentColor');
      c.setAttribute('stroke-width', '1.4');
      statusSvg.appendChild(c);
    }

    // ── ヘッド行 ──
    const head = el(
      'div',
      {
        class: 'phase-row-head',
        attrs: { 'aria-hidden': 'true' },
      },
      el('span', { class: 'phase-row-marker', text: `§${phase.no}` }),
      el(
        'div',
        { class: 'phase-row-body' },
        el('span', { class: 'phase-row-title', text: phase.title }),
        el('span', {
          class: 'phase-row-meta',
          text: `${phase.estimatedMinutes ? phase.estimatedMinutes + '分' : '—'} · ${
            isFilled ? '記入済み' : isPartial ? '下書き' : '未着手'
          }`,
        })
      ),
      el('span', { class: 'phase-row-status', attrs: { 'aria-hidden': 'true' } }, statusSvg)
    );

    // ── 展開エリア (selected 時のみ表示) ──
    const expanded = el('div', { class: 'phase-row-expanded' });
    if (!isActive) expanded.hidden = true;

    const row = el(
      'li',
      {
        class: 'phase-row',
        dataset: { phaseId: phase.id, state: dataState },
        attrs: Object.assign(
          {
            role: 'button',
            tabindex: isActive ? '0' : '-1',
            'aria-label': `フェーズ${phase.no} ${phase.title}` + statusLabel + (isActive ? ' 現在のフェーズ' : ''),
            title: titleAttr,
            'aria-pressed': String(isActive),
            'aria-expanded': String(isActive),
          },
          isActive ? { 'aria-current': 'step' } : {}
        ),
        on: {
          click: (e) => {
            // expanded の内部ボタンクリックはトグルしない
            if (e.target.closest('.phase-row-expanded')) return;
            select();
          },
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              select();
              return;
            }
            const rows = Array.from(list.querySelectorAll('.phase-row'));
            const idx = rows.indexOf(e.currentTarget);
            if (idx < 0) return;
            let next = idx;
            if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, idx + 1);
            else if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = rows.length - 1;
            else return;
            e.preventDefault();
            const target = rows[next];
            if (target) target.focus({ preventScroll: true });
          },
        },
      },
      head,
      expanded
    );

    // active な行は展開コンテンツをすぐ埋める
    if (isActive) {
      _fillPhaseExpanded(expanded, phase);
    }

    list.appendChild(row);
  }
}

// expanded div に AI rec / prompts / DRAFT ボタンを描画
function _fillPhaseExpanded(expanded, phase) {
  clearChildren(expanded);

  // メタ情報行 (frame / inputs / outputs)
  const meta = el('div', { class: 'phase-row-meta-detail' });
  const frameSpan = el('span', {});
  frameSpan.appendChild(el('strong', { text: 'フレーム: ' }));
  frameSpan.appendChild(makeGlossaryNode(phase.frame || '—'));
  meta.appendChild(frameSpan);
  meta.appendChild(
    el('span', {},
      el('strong', { text: '入力: ' }),
      document.createTextNode(phase.inputs?.length ? phase.inputs.join(' / ') : '（なし）')
    )
  );
  meta.appendChild(
    el('span', {},
      el('strong', { text: '出力: ' }),
      document.createTextNode(phase.outputs?.length ? phase.outputs.join(' → ') : '—')
    )
  );
  expanded.appendChild(meta);

  if (phase.modeKind === 'hearingSummary') {
    expanded.appendChild(buildModeBHearingSummaryPanel());
    return;
  }

  // AI rec インライン
  const aiRec = el('div', { class: 'phase-row-ai' });

  const primaryLabel = AI_LABELS[phase.primaryAi] || phase.primaryAi || '—';
  const secondaryLabel = AI_LABELS[phase.secondaryAi] || phase.secondaryAi || '—';

  const openPrimBtn = el('button', {
    class: 'link-btn',
    type: 'button',
    attrs: { 'aria-label': `${primaryLabel} を開く` },
  });
  openPrimBtn.appendChild(document.createTextNode('開く'));
  const extSvg1 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  extSvg1.setAttribute('class', 'icon icon-xs');
  extSvg1.setAttribute('aria-hidden', 'true');
  const extUse1 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  extUse1.setAttribute('href', '#i-external');
  extSvg1.appendChild(extUse1);
  openPrimBtn.appendChild(extSvg1);
  openPrimBtn.addEventListener('click', (e) => { e.stopPropagation(); openOrFocusAiTab(phase.primaryAi); });

  const openSecBtn = el('button', {
    class: 'link-btn',
    type: 'button',
    attrs: { 'aria-label': `${secondaryLabel} を開く` },
  });
  openSecBtn.appendChild(document.createTextNode('開く'));
  const extSvg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  extSvg2.setAttribute('class', 'icon icon-xs');
  extSvg2.setAttribute('aria-hidden', 'true');
  const extUse2 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  extUse2.setAttribute('href', '#i-external');
  extSvg2.appendChild(extUse2);
  openSecBtn.appendChild(extSvg2);
  openSecBtn.addEventListener('click', (e) => { e.stopPropagation(); openOrFocusAiTab(phase.secondaryAi); });

  aiRec.appendChild(el('span', { class: 'ai-rec-label', text: '第1推奨' }));
  aiRec.appendChild(el('span', { class: 'ai-pill', text: primaryLabel }));
  aiRec.appendChild(openPrimBtn);
  aiRec.appendChild(el('span', { class: 'ai-rec-sep', attrs: { 'aria-hidden': 'true' } }));
  aiRec.appendChild(el('span', { class: 'ai-rec-label', text: '第2推奨' }));
  aiRec.appendChild(el('span', { class: 'ai-pill ai-pill-sub', text: secondaryLabel }));
  aiRec.appendChild(openSecBtn);
  expanded.appendChild(aiRec);

  // プロンプトリスト
  const promptsList = el('div', { class: 'prompts-list' });
  for (const prompt of phase.prompts || []) {
    promptsList.appendChild(buildPromptItem(prompt, prompt.for));
  }
  expanded.appendChild(promptsList);

  // DRAFT ボタン + 転記ガイド tooltip
  const footerRow = el('div', { class: 'phase-row-footer' });
  footerRow.dataset.q2Filtering = (phase?.no === 6 || phase?.no === 7) ? 'available' : 'none';

  const draftBtn = el('button', {
    class: 'btn btn-ghost btn-sm phase-row-draft-btn',
    type: 'button',
    text: 'DRAFT を作る',
    attrs: {
      title: 'マスタードキュメントのコピーを開き、AIの出力を貼る作業ドキュメント',
    },
  });
  draftBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    createOrOpenDraftDoc();
  });

  const guideBtn = el('button', {
    class: 'btn btn-quiet btn-sm phase-row-guide-btn tooltip',
    type: 'button',
    text: '?',
    dataset: {
      tip: '① AIの出力は必ず DRAFT ファイルに貼る（マスター直書き禁止）②自分が腹落ちした行だけマスタードキュメントへ転記 ③§99 決定ログに日付・決めたこと・理由を1行追記',
    },
    attrs: { 'aria-label': '転記ガイドを表示' },
  });

  const chapterSaveBtn = el('button', {
    class: 'btn btn-primary btn-sm phase-row-chapter-save-btn',
    type: 'button',
    text: 'Google Docs に章を保存',
    attrs: {
      title: `現在のフェーズ §${phase.no} の内容を Google Docs に保存します`,
      'aria-label': `§${phase.no} を Google Docs に保存`,
    },
    dataset: { phaseId: phase.id, phaseNo: String(phase.no) },
  });
  chapterSaveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveChapterToDocs(phase).catch((err) => {
      console.error('[strategy-kit] saveChapterToDocs unhandled', err);
    });
  });

  footerRow.appendChild(draftBtn);
  footerRow.appendChild(guideBtn);
  footerRow.appendChild(chapterSaveBtn);
  expanded.appendChild(footerRow);
}

// =====================================================
// MVP v0.12: Google Docs 章別記録 (本 MVP の核心)
// Cycle 1 RED 吸収版: marker 全件 index 化 / atomic storage.set / F-N 末尾 append
// =====================================================

async function saveChapterToDocs(phase) {
  let token;
  try {
    const authUrl = chrome.runtime.getURL('phase0/auth.js');
    const authMod = await import(authUrl);
    try {
      token = await authMod.getAuthToken({ interactive: false });
    } catch (silentErr) {
      token = await authMod.getAuthToken({ interactive: true });
    }
  } catch (e) {
    if (e && e.code === 'F-1') {
      showToast('Google 連携が必要です。設定を確認してください', true, 3500);
      return;
    }
    if (e && e.code === 'F-2') {
      showToast('キャンセルされました', true, 2200);
      return;
    }
    if (e && e.code === 'F-3') {
      showToast('ネットワークエラー、しばらくしてから再試行してください', true, 3500);
      return;
    }
    showToast('Google 認証に失敗しました、コンソールを確認してください', true, 3500);
    console.error('[strategy-kit] saveChapterToDocs OAuth phase failed', e);
    return;
  }

  try {
    const stored = await chrome.storage.sync.get(['sk_chapter_doc_v012']);
    let docInfo = stored.sk_chapter_doc_v012 || null;

    const docsUrl = chrome.runtime.getURL('phase0/docs-client.js');
    const docsMod = await import(docsUrl);
    const sectionsUrl = chrome.runtime.getURL('phase0/docs-sections.js');
    const sectionsMod = await import(sectionsUrl);

    if (!docInfo || !docInfo.documentId) {
      const title = buildDocTitle();
      const created = await docsMod.createDocument(title);

      const phases = getVisiblePhases();
      const initialText = phases
        .map((p) => `\n[[SK-SECTION:§${p.no}]]\n## §${p.no} ${p.title}\n（未保存）\n`)
        .join('');
      await docsMod.batchUpdate(created.documentId, [
        { insertText: { location: { index: 1 }, text: initialText } },
      ]);

      docInfo = {
        documentId: created.documentId,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        format: 'v012-mvp',
      };
      await chrome.storage.sync.set({ sk_chapter_doc_v012: docInfo });
    }

    const doc = await docsMod.getDocument(docInfo.documentId);
    const replacement = buildChapterText(phase);
    const markerText = `[[SK-SECTION:§${phase.no}]]`;
    const range = sectionsMod.findSectionRange(doc, phase.no, { allowLastSectionNo: 9 });

    if (range.status === 'ok') {
      const requests = sectionsMod.buildReplaceSectionRequests(range, replacement);
      await docsMod.batchUpdate(docInfo.documentId, requests);
      showToast(`§${phase.no} を Google Docs に保存しました`, false, 2200);
    } else if (range.status === 'missing-current-marker') {
      const endIndex = sectionsMod.computeEndIndex(doc);
      await docsMod.batchUpdate(docInfo.documentId, [
        { insertText: { location: { index: endIndex }, text: `\n${markerText}\n${replacement}` } },
      ]);
      showToast(`§${phase.no} のマーカーが消失していたため末尾に追記しました`, true, 3500);
    } else if (range.status === 'missing-next-marker') {
      const endIndex = sectionsMod.computeEndIndex(doc);
      await docsMod.batchUpdate(docInfo.documentId, [
        { insertText: { location: { index: endIndex }, text: `\n${markerText}\n${replacement}` } },
      ]);
      showToast(`§${phase.no + 1} のマーカー欠損のため末尾に追記しました`, true, 3500);
    } else if (range.status === 'duplicate-current-marker') {
      showToast(`§${phase.no} のマーカーが複数あります。Drive で Docs を確認してください`, true, 4000);
      return;
    }

    docInfo.lastUpdatedAt = new Date().toISOString();
    await chrome.storage.sync.set({ sk_chapter_doc_v012: docInfo });
  } catch (e) {
    if (e && e.apiName) {
      showToast(`Docs API エラー (HTTP ${e.status})。再試行してください`, true, 3500);
    } else {
      showToast('保存に失敗しました、コンソールを確認してください', true, 3500);
    }
    console.error('[strategy-kit] saveChapterToDocs API phase failed', e);
  }
}

function buildDocTitle() {
  const store = state.settings?.storeName || '案件名未設定';
  const date = new Date().toISOString().slice(0, 10);
  return `${brandFooterLabel()} 章別記録 ${store} ${date}`;
}

function buildChapterText(phase) {
  const lines = [];
  lines.push(`## §${phase.no} ${phase.title}`);
  lines.push('');
  if (phase.frame) lines.push(`**フレーム**: ${phase.frame}`);
  if (Array.isArray(phase.inputs) && phase.inputs.length) {
    lines.push(`**入力**: ${phase.inputs.join(' / ')}`);
  }
  if (Array.isArray(phase.outputs) && phase.outputs.length) {
    lines.push(`**出力**: ${phase.outputs.join(' → ')}`);
  }
  lines.push('');
  if (Array.isArray(phase.prompts) && phase.prompts.length) {
    lines.push('### 推奨プロンプト');
    phase.prompts.forEach((p, i) => {
      const raw = p.body || p.text || '';
      const body = (typeof applyTemplate === 'function') ? applyTemplate(raw) : raw;
      lines.push(`#### プロンプト ${i + 1}${p.for ? ` (${p.for})` : ''}`);
      lines.push(body);
      lines.push('');
    });
  }
  lines.push(`_最終保存: ${new Date().toISOString()}_`);
  return lines.join('\n') + '\n';
}

function collectSectionMarkers(doc) {
  const markers = [];
  const content = doc?.body?.content || [];
  const re = /\[\[SK-SECTION:§(\d+)\]\]/g;
  for (const block of content) {
    const elements = block?.paragraph?.elements || [];
    for (const elem of elements) {
      const tr = elem?.textRun;
      if (!tr || typeof elem.startIndex !== 'number') continue;
      const text = tr.content || '';
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const no = parseInt(m[1], 10);
        const offset = m.index;
        markers.push({
          no,
          startIndex: elem.startIndex + offset,
          markerEndIndex: elem.startIndex + offset + m[0].length,
        });
      }
    }
  }
  return markers.sort((a, b) => a.startIndex - b.startIndex);
}

function computeEndIndex(doc) {
  const content = doc?.body?.content || [];
  if (!content.length) return 1;
  const last = content[content.length - 1];
  return Math.max(1, (last?.endIndex || 2) - 1);
}

function findChapterRange(doc, phaseNo) {
  const markers = collectSectionMarkers(doc);
  const current = markers.filter((m) => m.no === phaseNo);

  if (current.length === 0) return { status: 'missing-current-marker', markers };
  if (current.length > 1) return { status: 'duplicate-current-marker', markers };

  const startIndex = current[0].markerEndIndex;
  const later = markers.filter((m) => m.no > phaseNo).sort((a, b) => a.startIndex - b.startIndex);

  if (later.length === 0) {
    if (phaseNo === 9) {
      const endIndex = computeEndIndex(doc);
      return { status: 'ok', startIndex, endIndex: Math.max(startIndex, endIndex) };
    }
    return { status: 'missing-next-marker', markers };
  }

  return { status: 'ok', startIndex, endIndex: later[0].startIndex };
}

// =====================================================
// 薄型パネル v2: 薄バー + 現在フェーズカード（1画面1目的）
// 既存の renderMissionControl / phase 選択(lastPhase) が算出する state を
// そのまま表示に写す（新しい状態機械は作らない）。描画先を薄バー・カードへ振り替える。
// =====================================================

function _skIcon(hrefId, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls || 'icon icon-xs');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', hrefId);
  svg.appendChild(use);
  return svg;
}

// 薄バー/カードが共有する進捗・現在フェーズ算出（renderMissionControl と同じ規則）。
function getSlimProgressModel() {
  const phases = getVisiblePhases();
  const filledSet = new Set((state.progressFilledNos || []).map(String));
  const partialSet = new Set((state.progressPartialNos || []).map(String));
  const total = phases.length || DEFAULT_PHASE_TOTAL;
  const completed = phases.filter((p) => filledSet.has(String(p.no))).length;
  const partial = phases.filter((p) => partialSet.has(String(p.no)) && !filledSet.has(String(p.no))).length;
  const percent = completed >= total ? 100 : Math.round(((completed + partial * 0.5) / total) * 100);
  const currentPhase =
    phases.find((p) => partialSet.has(String(p.no)) && !filledSet.has(String(p.no))) ||
    phases.find((p) => !filledSet.has(String(p.no))) ||
    phases[phases.length - 1] || null;
  return { phases, filledSet, partialSet, total, completed, partial, percent, currentPhase };
}

function getSetupDoneCount() {
  const oauthConnected = !!(window._setupStripCfg && window._setupStripCfg.oauthConnected);
  const hasBusiness = !!(state.settings.industryLabel && state.settings.storeName);
  const phase0Done = !!(state.progressFilledNos && state.progressFilledNos.map(String).includes('0'));
  return [oauthConnected, hasBusiness, phase0Done].filter(Boolean).length;
}

// 薄バー中央の「§N タイトル ％」＋進捗ヘアラインを更新（状態別ラベル: 設計 §2-6）。
function renderSlimBar() {
  const phaseEl = document.getElementById('slim-center-phase');
  const percentEl = document.getElementById('slim-center-percent');
  const fill = document.getElementById('slim-progress-fill');
  const prog = document.getElementById('slim-progress');
  if (!phaseEl || !percentEl) return;
  const { percent, currentPhase, completed, total } = getSlimProgressModel();
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBusiness = !!(industry && store);
  const task = getLiveMissionTask();
  const status = completed >= total ? 'completed' : task?.status || 'ready';
  const selected = findModeAdjustedPhaseById(state.settings.lastPhase) || currentPhase;

  let phaseLabel;
  if (!hasBusiness) {
    phaseLabel = '準備';
  } else if (status === 'completed') {
    phaseLabel = '戦略完成';
  } else if (status === 'running' || status === 'retrying') {
    phaseLabel = currentPhase ? `§${currentPhase.no} 実行中` : '実行中';
  } else if (selected) {
    phaseLabel = `§${selected.no} ${selected.title}`;
  } else {
    phaseLabel = 'STRATEGY-KIT';
  }
  phaseEl.textContent = phaseLabel;
  percentEl.textContent = hasBusiness ? `${percent}%` : `${getSetupDoneCount()}/3`;
  if (fill) fill.style.width = `${percent}%`;
  if (prog) prog.setAttribute('aria-valuenow', String(percent));
}

// 戦略タブの表示モード切替（現在フェーズカード ⇄ フェーズ一覧）。
function setPhaseView(view) {
  const tab = document.getElementById('tab-phases');
  if (!tab) return;
  const isList = view === 'list';
  tab.classList.toggle('is-phase-list', isList);
  tab.classList.toggle('is-phase-card', !isList);
  for (const btn of document.querySelectorAll('#strategy-phase-toggle .phase-toggle-btn')) {
    const on = btn.dataset.phaseView === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (isList) renderPhaseList();
}

// カードの「プロンプトをコピー」: 選択フェーズの第1プロンプトを ★置換/要約付与してコピー
// （右クリックメニュー・Cmd+Enter と同一挙動）。
async function copyPhasePrompt(phase) {
  if (!phase || !phase.prompts || !phase.prompts.length) {
    showToast('このフェーズにコピー可能なプロンプトがありません', true);
    return false;
  }
  const raw = phase.prompts[0].body || phase.prompts[0].text || '';
  if (!raw) return false;
  try {
    const text = await enrichWithMasterSummaries(raw);
    await navigator.clipboard.writeText(text);
    showToast('プロンプトをコピーしました');
    return true;
  } catch (_) {
    showToast('コピーに失敗しました', true);
    return false;
  }
}

function _cardActionBtn(label, hrefId, cls, onClick) {
  const btn = el('button', { class: cls, type: 'button' });
  if (hrefId) btn.appendChild(_skIcon(hrefId, 'icon icon-xs'));
  btn.appendChild(el('span', { text: label }));
  btn.addEventListener('click', onClick);
  return btn;
}

// カード下ミニナビ: ‹ §N-1 / フェーズ一覧 ▾ / §N+1 ›
function _cardMiniNav(selected, phases) {
  const idx = phases.findIndex((p) => p.id === selected.id);
  const prev = idx > 0 ? phases[idx - 1] : null;
  const next = idx >= 0 && idx < phases.length - 1 ? phases[idx + 1] : null;
  const selectPhase = (phase) => {
    state.settings.lastPhase = phase.id;
    persistSettings();
    renderPhaseList();
    renderCurrentPhaseCard();
    renderSlimBar();
    emit('phase-changed', phase);
  };
  const prevBtn = el('button', {
    class: 'current-phase-nav-btn is-prev',
    type: 'button',
    attrs: prev ? { 'aria-label': `§${prev.no} ${prev.title} へ戻る` } : { disabled: 'true' },
  }, '‹ ' + (prev ? `§${prev.no} ${prev.title}` : ''));
  if (prev) prevBtn.addEventListener('click', () => selectPhase(prev));
  const listBtn = el('button', {
    class: 'current-phase-nav-btn is-list',
    type: 'button',
    text: 'フェーズ一覧 ▾',
    attrs: { 'aria-label': 'フェーズ一覧を開く' },
  });
  listBtn.addEventListener('click', () => setPhaseView('list'));
  const nextBtn = el('button', {
    class: 'current-phase-nav-btn is-next',
    type: 'button',
    attrs: next ? { 'aria-label': `§${next.no} ${next.title} へ進む` } : { disabled: 'true' },
  }, (next ? `§${next.no} ${next.title}` : '') + ' ›');
  if (next) nextBtn.addEventListener('click', () => selectPhase(next));
  return el('div', { class: 'current-phase-nav' }, prevBtn, listBtn, nextBtn);
}

// 現在フェーズカード本体（状態別: 未設定/手動/全自動/完了 = 設計 §2-6）。
function renderCurrentPhaseCard() {
  const card = document.getElementById('current-phase-card');
  if (!card) return;
  const { phases, filledSet, partialSet, total, completed, currentPhase } = getSlimProgressModel();
  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBusiness = !!(industry && store);
  const task = getLiveMissionTask();
  const status = completed >= total ? 'completed' : task?.status || 'ready';

  const tab = document.getElementById('tab-phases');
  if (tab) {
    tab.classList.toggle('needs-mode',
      hasBusiness && !state.settings[ENGAGEMENT_MODE_KEY] && completed < total &&
      status !== 'running' && status !== 'retrying' && !isAutomationRunningNow());
  }

  clearChildren(card);
  const quickMount = document.getElementById('phase-ai-quick');
  if (quickMount) clearChildren(quickMount);

  // 未設定: はじめに 3ステップ CTA
  if (!hasBusiness) {
    card.dataset.cardState = 'setup';
    card.append(
      el('span', { class: 'cpc-eyebrow', text: 'はじめに · 3ステップ' }),
      el('h2', { class: 'cpc-title', text: '戦略づくりの準備をしましょう' }),
      el('p', { class: 'current-phase-desc', text: 'Google 連携・事業情報・§0 の3つを整えると、プロンプト操作を始められます。' })
    );
    const bar = el('div', { class: 'current-phase-actions' });
    bar.appendChild(_cardActionBtn('初期設定を開く', '#i-check', 'current-phase-primary', () => {
      document.getElementById('open-setup')?.click();
    }));
    card.appendChild(bar);
    return;
  }

  const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const projectHead = el('div', { class: 'cpc-project-head' });
  const projectCopy = el('div', { class: 'cpc-project-copy' });
  projectCopy.append(
    el('span', { class: 'cpc-project-kicker', text: 'PROJECT' }),
    el('strong', { class: 'cpc-project-name', text: store }),
    el('span', { class: 'cpc-project-industry', text: industry })
  );
  const projectProgress = el('div', { class: 'cpc-project-progress' });
  projectProgress.append(
    el('span', { class: 'cpc-project-progress-value', text: String(completed) }),
    el('span', { class: 'cpc-project-progress-total', text: `/ ${total}` })
  );
  projectHead.append(projectCopy, projectProgress);
  const projectRail = el('div', {
    class: 'cpc-project-rail',
    attrs: {
      role: 'progressbar',
      'aria-label': 'プロジェクト進捗',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(progressPercent),
    },
  });
  projectRail.appendChild(el('span', {
    class: 'cpc-project-rail-fill',
    attrs: { style: `width:${progressPercent}%` },
  }));
  card.append(projectHead, projectRail);

  // 入口モードは §0 と AI に渡す前提を決める重要設定なので、メニューの奥へ隠さない。
  // 案件データや Google Docs を消さずに何度でも選び直せる既存 handleModeChange を開く。
  const storedEngagementMode = state.settings[ENGAGEMENT_MODE_KEY];
  const entryModeControl = el('div', {
    class: 'cpc-entry-mode',
    attrs: { 'data-role': 'entry-mode-control' },
  });
  entryModeControl.append(
    el('span', { class: 'cpc-entry-mode-label', text: '今回の入口' }),
    el('strong', {
      class: 'cpc-entry-mode-value',
      text: storedEngagementMode ? getModeReadout(storedEngagementMode) : '未選択',
    }),
    el('button', {
      type: 'button',
      class: 'cpc-entry-mode-change',
      text: storedEngagementMode ? '選び直す' : '選ぶ',
      attrs: {
        'data-action': 'change-entry-mode',
        'aria-label': storedEngagementMode
          ? `入口モード「${getModeReadout(storedEngagementMode)}」を選び直す`
          : '入口モードを選ぶ',
      },
      on: { click: openEngagementModeSelector },
    }),
  );
  card.appendChild(entryModeControl);

  // 完了: 完了カード
  if (status === 'completed') {
    card.dataset.cardState = 'completed';
    card.append(
      el('span', { class: 'cpc-eyebrow', text: '戦略完成 · 100%' }),
      el('h2', { class: 'cpc-title', text: '戦略書が完成しました' }),
      el('p', { class: 'current-phase-desc', text: '数値と固有名詞を最終確認し、戦略書・成果物として書き出せます。' })
    );
    const bar = el('div', { class: 'current-phase-actions' });
    bar.appendChild(_cardActionBtn('戦略書を開く', '#i-doc', 'current-phase-primary', () => {
      document.getElementById('open-master-doc')?.click();
    }));
    const sub = el('div', { class: 'current-phase-subactions' });
    sub.appendChild(_cardActionBtn('成果物タブ', '#i-diagram', 'current-phase-secondary', () => switchTab('diagram')));
    card.append(bar, sub);
    return;
  }

  // 半自動 / 全自動: 実行中カード。task.mode を表示と操作の共通ソースにする。
  if (task && (status === 'running' || status === 'retrying' || status === 'blocked' || status === 'paused')) {
    card.dataset.cardState = 'automation';
    const runningish = status === 'running' || status === 'retrying';
    const runningModeLabel = task.mode === 'semi' ? '半自動' : '全自動';
    card.append(
      el('span', { class: 'cpc-eyebrow', text: missionStatusLabel(status, task?.mode) }),
      el('h2', { class: 'cpc-title', text: task.taskLabel || (currentPhase ? `§${currentPhase.no} ${currentPhase.title}` : `${runningModeLabel}で処理中`) }),
      el('p', { class: 'current-phase-desc', text: task.lastEvent || `${runningModeLabel}で処理を進めています。` })
    );
    const bar = el('div', { class: 'current-phase-actions' });
    bar.appendChild(_cardActionBtn('全画面で操作する', '#i-auto', 'current-phase-primary', openMissionFullscreen));
    const sub = el('div', { class: 'current-phase-subactions' });
    if (runningish) {
      sub.appendChild(_cardActionBtn('一時停止 / 停止', '#i-warn', 'current-phase-secondary', () => {
        switchTab('automation');
        requestAnimationFrame(() => document.getElementById('sk-auto-cancel')?.click());
      }));
    } else {
      sub.appendChild(_cardActionBtn('再開', '#i-arrow', 'current-phase-secondary', () => switchTab('automation')));
    }
    card.append(bar, sub);
    return;
  }

  // 実行前: プロジェクト共通の実行モードに合わせて、次の操作を明示する。
  card.dataset.cardState = 'phase';
  const selected = findModeAdjustedPhaseById(state.settings.lastPhase) || currentPhase || phases[0];
  if (!selected) return;
  const executionMode = getAutomationExecutionMode();
  const executionModeLabel = executionMode === 'full' ? '全自動モード' : '半自動モード';
  const isFilled = filledSet.has(String(selected.no));
  const isPartial = !isFilled && partialSet.has(String(selected.no));

  card.appendChild(el('span', { class: 'cpc-eyebrow', text: `選択中 · ${executionModeLabel}` }));
  card.appendChild(el('h2', { class: 'cpc-title', text: `§${selected.no} ${selected.title}` }));
  card.appendChild(el('p', {
    class: 'current-phase-desc',
    text: executionMode === 'full'
      ? 'Geminiで各フェーズを順番に生成します。開始前にモデルと入力内容を確認してください。'
      : (selected.frame || 'AIの回答を確認・貼り付けしながら、1ステップずつ進めます。'),
  }));

  const chips = el('div', { class: 'current-phase-chips' });
  if (selected.estimatedMinutes) chips.appendChild(el('span', { class: 'current-phase-chip', text: `所要 ${selected.estimatedMinutes}分` }));
  chips.appendChild(el('span', {
    class: 'current-phase-chip ' + (isFilled ? 'is-filled' : isPartial ? 'is-partial' : 'is-todo'),
    text: isFilled ? '記入済み' : isPartial ? '下書きあり' : '未着手',
  }));
  card.appendChild(chips);

  // next move 行を吸収（選択フェーズに即した1行）
  const nm = el('div', { class: 'current-phase-nextmove' });
  nm.appendChild(_skIcon('#i-spark', 'icon icon-sm current-phase-nextmove-mark'));
  const nmBody = el('div', { class: 'current-phase-nextmove-body' });
  nmBody.appendChild(el('span', { class: 'current-phase-nextmove-eyebrow', text: 'NEXT MOVE' }));
  nmBody.appendChild(el('span', {
    class: 'current-phase-nextmove-text',
    text: executionMode === 'full'
      ? '実行設定を確認して、全自動を開始します。'
      : isFilled
        ? '記入済み。内容を見直すか、次のフェーズへ進めます。'
        : isPartial
          ? '下書きを仕上げます。AIの回答を確認して貼り付けます。'
          : '半自動の実行画面で、AIの回答を確認しながら進めます。',
  }));
  nm.appendChild(nmBody);
  card.appendChild(nm);

  // 主アクション: 選択中の実行モードと同じ設定画面へ進む。
  const primaryBar = el('div', { class: 'current-phase-actions' });
  primaryBar.appendChild(_cardActionBtn(
    `${executionModeLabel}の設定を開く`,
    '#i-auto',
    'current-phase-primary',
    () => switchTab('automation')
  ));
  card.appendChild(primaryBar);

  // 副アクション: フェーズ単体の手動操作も残す。
  const aiTarget = selected.prompts?.[0]?.for || selected.defaultFor;
  const sub = el('div', { class: 'current-phase-subactions' });
  sub.appendChild(_cardActionBtn('プロンプトをコピー', '#i-copy', 'current-phase-secondary', () => copyPhasePrompt(selected)));
  sub.appendChild(_cardActionBtn('AIで開く', '#i-external', 'current-phase-secondary', () => openOrFocusAiTab(aiTarget)));
  sub.appendChild(_cardActionBtn('DRAFT保存', '#i-edit', 'current-phase-secondary', () => createOrOpenDraftDoc()));
  card.appendChild(sub);

  const quickAccess = el('div', { class: 'cpc-ai-quick' });
  quickAccess.appendChild(el('span', { class: 'cpc-ai-quick-label', text: 'AI QUICK ACCESS' }));
  const quickButtons = el('div', { class: 'cpc-ai-quick-buttons' });
  for (const [id, label, mark] of [
    ['gemini', 'Gemini', '✦'],
    ['chatgpt', 'ChatGPT', '◎'],
    ['claude', 'Claude', '✺'],
    ['perplexity', 'Perplexity', '⌁'],
    ['genspark', 'Genspark', '↗'],
  ]) {
    const button = el('button', {
      class: `cpc-ai-quick-btn is-${id}`,
      type: 'button',
      attrs: { 'aria-label': `${label} を開く` },
    },
      el('span', { class: 'cpc-ai-quick-mark', text: mark }),
      el('span', { class: 'cpc-ai-quick-name', text: label })
    );
    button.addEventListener('click', () => openOrFocusAiTab(id));
    quickButtons.appendChild(button);
  }
  quickAccess.appendChild(quickButtons);
  if (quickMount) {
    clearChildren(quickMount);
    quickMount.appendChild(quickAccess);
  } else {
    card.appendChild(quickAccess);
  }

  // カード下ミニナビ
  card.appendChild(_cardMiniNav(selected, phases));
}

function renderCurrentPhase() {
  // 薄型パネル v2: 選択変更のたびに現在フェーズカードと薄バーを更新する。
  renderCurrentPhaseCard();
  renderSlimBar();
  // フェーズ一覧(アコーディオン)は選択行を展開して表示するため、未描画なら list を作る。
  const activeRow = document.querySelector('.phase-row[aria-current="step"] .phase-row-expanded');
  if (activeRow) return; // 既に描画済み
  renderPhaseList();
}

// =====================================================
// プロンプトアイテム共通
// =====================================================

function buildAiSelector(initialAi, recommendedAi) {
  const select = el('select', { class: 'ai-selector' });
  for (const aiId of ALL_AIS) {
    const profile = state.aiProfiles?.ais?.find((a) => a.id === aiId);
    const label = profile?.label || AI_LABELS[aiId] || aiId;
    const isRecommended = aiId === recommendedAi;
    const opt = el('option', {
      value: aiId,
      text: label + (isRecommended ? '（推奨）' : ''),
    });
    if (aiId === initialAi) opt.selected = true;
    select.appendChild(opt);
  }
  return select;
}

function buildPromptItem(prompt, defaultFor) {
  const recommended = prompt.for || defaultFor;
  const body = applyTemplate(prompt.body || prompt.text || '');
  const bodyEl = el('div', { class: 'prompt-body', text: body });

  const aiSelect = buildAiSelector(recommended, recommended);

  const aiHint = el('div', { class: 'ai-hint' });
  function updateHint() {
    const profile = state.aiProfiles?.ais?.find((a) => a.id === aiSelect.value);
    aiHint.textContent = profile?.comment || '';
  }
  aiSelect.addEventListener('change', updateHint);
  updateHint();

  const promptLabelEl = el('div', { class: 'prompt-label' });
  promptLabelEl.appendChild(makeGlossaryNode(prompt.label));

  // =========================================================
  // Lane C: inline 警告エリア（主ボタン押下時に動的更新）
  // =========================================================
  const inlineWarningEl = el('div', { class: 'prompt-inline-warning hidden' });

  function showInlineWarnings() {
    const msgs = [];
    const hasBusiness = !!(state.settings.industryLabel && state.settings.storeName);
    if (!state.settings.industryLabel) msgs.push({ text: '業種が未設定です', target: 'business' });
    if (!state.settings.storeName) msgs.push({ text: '店舗名が未設定です', target: 'business' });

    clearChildren(inlineWarningEl);
    if (msgs.length === 0) {
      inlineWarningEl.classList.add('hidden');
      return;
    }

    for (const { text, target } of msgs) {
      const line = el('button', {
        class: 'prompt-inline-warning-line',
        type: 'button',
      });
      line.textContent = '⚠ ' + text;
      line.addEventListener('click', () => {
        // Lane A の #setup-status-strip があればその data-step 項目へ、なければ #setup へ
        const strip = document.getElementById('setup-status-strip');
        if (strip) {
          const item = strip.querySelector('[data-step="' + target + '"]') || strip;
          item.scrollIntoView({ behavior: 'smooth', block: 'start' });
          item.classList.add('is-highlight');
          setTimeout(() => item.classList.remove('is-highlight'), 1800);
        } else {
          const setupEl = document.getElementById('setup');
          if (setupEl) setupEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      inlineWarningEl.appendChild(line);
    }
    inlineWarningEl.classList.remove('hidden');
  }

  // =========================================================
  // Lane C: サブメニュー [⋯] ポップオーバー
  // =========================================================
  const submenuEl = el('div', { class: 'prompt-submenu hidden' });

  function closeSubmenu() {
    submenuEl.classList.add('hidden');
  }

  function buildSubmenuItem(label, onClick) {
    const btn = el('button', { class: 'prompt-submenu-item', type: 'button', text: label });
    btn.addEventListener('click', () => {
      closeSubmenu();
      onClick();
    });
    return btn;
  }

  // 「コピーだけ」
  submenuEl.appendChild(
    buildSubmenuItem('コピーだけ', async () => {
      const raw = bodyEl.textContent;
      const text = await enrichWithMasterSummaries(raw);
      try {
        await navigator.clipboard.writeText(text);
        showToast('クリップボードにコピーしました');
      } catch (e) {
        showToast('コピーに失敗しました', true);
      }
    })
  );

  // 「AI タブだけ開く」
  submenuEl.appendChild(
    buildSubmenuItem('AI タブだけ開く', () => {
      openOrFocusAiTab(aiSelect.value);
    })
  );

  // 「プロンプト全文を表示」
  submenuEl.appendChild(
    buildSubmenuItem('プロンプト全文を表示', () => {
      const raw = bodyEl.textContent;
      const backdrop = el('div', { class: 'modal-backdrop' });
      const modal = el('div', { class: 'modal' });
      modal.appendChild(el('h3', { text: 'プロンプト全文' }));
      const pre = el('div', { class: 'prompt-fulltext' });
      pre.textContent = raw;
      modal.appendChild(pre);
      const closeBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '閉じる' });
      closeBtn.addEventListener('click', () => backdrop.remove());
      const modalActions = el('div', { class: 'modal-actions' });
      modalActions.appendChild(closeBtn);
      modal.appendChild(modalActions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    })
  );

  const moreBtn = el('button', {
    class: 'btn btn-quiet btn-sm prompt-more-btn',
    type: 'button',
    text: '⋯',
    attrs: { 'aria-label': 'その他の操作', 'aria-haspopup': 'true' },
  });
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = submenuEl.classList.contains('hidden');
    document.querySelectorAll('.prompt-submenu').forEach((m) => m.classList.add('hidden'));
    if (isHidden) submenuEl.classList.remove('hidden');
  });

  // クリック外でサブメニューを閉じる（capture フェーズで登録し passive に設定）
  const outsideClickHandler = () => closeSubmenu();
  document.addEventListener('click', outsideClickHandler, { capture: true, passive: true });

  // =========================================================
  // Lane C: 主ボタン「AI に入れる」
  // =========================================================
  const insertBtn = el('button', {
    class: 'btn btn-primary btn-sm prompt-insert-btn',
    type: 'button',
    text: 'AI に入れる',
  });

  insertBtn.addEventListener('click', async () => {
    showInlineWarnings();

    const raw = bodyEl.textContent;
    const text = await enrichWithMasterSummaries(raw);

    async function doInsert() {
      try { await navigator.clipboard.writeText(text); } catch (_) {}
      await openOrFocusAiTab(aiSelect.value);
      insertIntoActiveTab(text, aiSelect.value);
    }

    const handled = checkStarPlaceholders(text, doInsert, () => bodyEl.focus({ preventScroll: true }));
    if (!handled) doInsert();
  });

  // =========================================================
  // カード組み立て
  // =========================================================
  const primaryGroup = el('div', { class: 'prompt-actions-primary' });
  primaryGroup.appendChild(insertBtn);
  primaryGroup.appendChild(moreBtn);
  primaryGroup.appendChild(submenuEl);

  const senderRow = el(
    'div',
    { class: 'prompt-for' },
    document.createTextNode('送り先: '),
    aiSelect
  );

  const actionsRow = el('div', { class: 'prompt-actions prompt-actions-v2' });
  actionsRow.appendChild(primaryGroup);
  actionsRow.appendChild(senderRow);

  return el(
    'div',
    { class: 'prompt-item' },
    el('div', { class: 'prompt-head' }, promptLabelEl),
    aiHint,
    bodyEl,
    inlineWarningEl,
    actionsRow
  );
}

// =====================================================
// リサーチサイクルタブ
// =====================================================

function renderResearchTab() {
  const rc = state.prompts.researchCycle;
  if (!rc) return;

  document.getElementById('research-desc').textContent = rc.description || '';

  const principlesEl = document.getElementById('research-principles');
  clearChildren(principlesEl);
  for (const p of rc.principles || []) {
    principlesEl.appendChild(el('li', { text: p }));
  }

  // フェーズリンク選択
  const linkSel = document.getElementById('research-phase-link');
  clearChildren(linkSel);
  linkSel.appendChild(el('option', { value: '', text: '— 選択しない —' }));
  for (const map of rc.applicableTo || []) {
    const phase = findModeAdjustedPhaseById(map.phase);
    if (!phase) continue;
    const opt = el('option', {
      value: map.phase,
      text: `フェーズ${phase.no}：${phase.title} — ${map.topicHint}`,
    });
    if (map.phase === state.settings.researchPhaseLink) opt.selected = true;
    linkSel.appendChild(opt);
  }

  document.getElementById('research-topic').value =
    state.settings.researchTopic || '';
  document.getElementById('research-no').value =
    state.settings.researchNo || '01';

  linkSel.onchange = () => {
    state.settings.researchPhaseLink = linkSel.value;
    const map = rc.applicableTo?.find((m) => m.phase === linkSel.value);
    if (map?.topicHint && !state.settings.researchTopic) {
      state.settings.researchTopic = map.topicHint;
      document.getElementById('research-topic').value = map.topicHint;
    }
    persistSettings();
    renderResearchSteps();
  };
  document.getElementById('research-topic').oninput = (e) => {
    state.settings.researchTopic = e.target.value;
    persistSettings();
    renderResearchSteps();
  };
  document.getElementById('research-no').oninput = (e) => {
    state.settings.researchNo = e.target.value || 'NN';
    persistSettings();
    renderResearchSteps();
  };

  renderResearchSteps();
}

function renderResearchSteps() {
  const rc = state.prompts.researchCycle;
  const list = document.getElementById('research-steps-list');
  clearChildren(list);

  for (const step of rc.steps) {
    const aiSelect = buildAiSelector(step.for, step.for);

    const meta = el(
      'div',
      { class: 'research-step-meta' },
      el('strong', { text: '出力ファイル: ' }),
      document.createTextNode(
        (step.outputFile || '').replace(
          'NN',
          state.settings.researchNo || 'NN'
        )
      ),
      document.createTextNode('　／　'),
      el('strong', { text: '目安: ' }),
      document.createTextNode((step.estimatedMinutes || '?') + '分')
    );

    const altText =
      step.alternativeFor && step.alternativeFor.length
        ? '代替候補: ' +
          step.alternativeFor.map((s) => AI_LABELS[s] || s).join(' / ')
        : '';

    const aiHint = el('div', { class: 'ai-hint' });
    function updateHint() {
      const profile = state.aiProfiles?.ais?.find((a) => a.id === aiSelect.value);
      aiHint.textContent = profile?.comment || '';
    }
    aiSelect.addEventListener('change', updateHint);
    updateHint();

    const body = applyTemplate(step.body);
    const bodyEl = el('div', { class: 'prompt-body', text: body });

    const card = el(
      'div',
      { class: 'prompt-item' },
      el(
        'div',
        { class: 'prompt-head' },
        el(
          'div',
          { class: 'prompt-label' },
          el('span', { class: 'research-step-no', text: String(step.no) }),
          step.label
        ),
        el(
          'div',
          { class: 'prompt-for' },
          document.createTextNode('送り先: '),
          aiSelect
        )
      ),
      meta,
      aiHint,
      bodyEl,
      el(
        'div',
        { class: 'prompt-actions' },
        el('button', {
          class: 'btn',
          text: '挿入',
          on: {
            click: () => {
              const text = bodyEl.textContent;
              const handled = checkStarPlaceholders(
                text,
                () => insertIntoActiveTab(text, aiSelect.value),
                () => bodyEl.focus({ preventScroll: true })
              );
              if (!handled) insertIntoActiveTab(text, aiSelect.value);
            },
          },
        }),
        el('button', {
          class: 'btn btn-ghost',
          text: 'コピー',
          on: {
            click: async () => {
              const text = bodyEl.textContent;
              const doCopy = async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  showToast('コピーしました');
                } catch (e) {
                  showToast('コピーに失敗しました', true);
                }
              };
              const handled = checkStarPlaceholders(
                text,
                doCopy,
                () => bodyEl.focus({ preventScroll: true })
              );
              if (!handled) doCopy();
            },
          },
        }),
        el('button', {
          class: 'btn btn-ghost',
          text: 'タブを開く',
          on: {
            click: () => openOrFocusAiTab(aiSelect.value),
          },
        })
      )
    );

    if (altText) {
      card.appendChild(el('div', { class: 'research-step-meta', text: altText }));
    }

    list.appendChild(card);
  }
}

// =====================================================
// 安全注意
// =====================================================

function renderPrinciples() {
  const ul = document.querySelector('#safety .principles');
  clearChildren(ul);
  for (const p of state.prompts.principles || []) {
    ul.appendChild(el('li', { text: p }));
  }
  if (!state.settings.showSafetyNotice) {
    document.getElementById('safety').classList.add('hidden');
  }
}

// =====================================================
// 挿入処理（共通）
// =====================================================

async function insertIntoActiveTab(text, preferredSite) {
  chrome.runtime.sendMessage(
    { type: 'INSERT_PROMPT', text, site: preferredSite },
    async (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        console.error('[STRATEGY-KIT] 挿入エラー:', chrome.runtime.lastError?.message || resp?.error);
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {}

        if (resp?.error === 'site-tab-not-found') {
          showToast(
            `${AI_LABELS[preferredSite] || preferredSite} の既存タブが見つかりません。コピー済みです。「タブを開く」で開いてから貼り付けてください。`,
            'warn',
            5000
          );
        } else {
          showToast(
            '挿入に失敗しました。コピー済みです。AIタブを開いて貼り付けてください。',
            true,
            4000
          );
        }
      } else {
        showToast('既存タブに挿入しました（送信は手動で）');
      }
    }
  );
}

// =====================================================
// ★プレースホルダ バリデーション
// =====================================================

/**
 * content 内の ★〜★ パターンを検出し、残っていれば警告モーダルを表示する。
 * @param {string} content - チェック対象のプロンプト文字列
 * @param {Function} onProceed - 「このまま実行」を選んだときのコールバック
 * @param {Function} [onCancel] - 「修正する」を選んだときのコールバック（省略可）
 * @returns {boolean} - ★が残っていれば true（モーダル表示）、なければ false（即実行）
 */
function checkStarPlaceholders(content, onProceed, onCancel) {
  const stars = content.match(/★[^★\n]+★/g);
  if (!stars || stars.length === 0) return false;

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' });

  modal.appendChild(el('h3', { text: '⚠️ 未入力のプレースホルダがあります' }));
  modal.appendChild(
    el('p', {
      class: 'star-validator-desc',
      text: '★で囲まれた部分（例: ★店舗名★）が残っています。空欄のままAIに送ると正しい結果が出ない場合があります。',
    })
  );

  const list = el('ul', { class: 'star-validator-list' });
  const shown = stars.slice(0, 3);
  for (const s of shown) {
    list.appendChild(el('li', { text: s }));
  }
  if (stars.length > 3) {
    list.appendChild(
      el('li', { class: 'star-validator-more', text: `…他 ${stars.length - 3} 件` })
    );
  }
  modal.appendChild(list);

  const actions = el('div', { class: 'modal-actions' });

  const proceedBtn = el('button', { class: 'btn', text: 'このまま実行' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '修正する' });

  function closeStarModal() {
    backdrop.remove();
  }

  proceedBtn.addEventListener('click', function () {
    closeStarModal();
    onProceed();
  });

  cancelBtn.addEventListener('click', function () {
    closeStarModal();
    if (onCancel) onCancel();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(proceedBtn);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) {
      closeStarModal();
      if (onCancel) onCancel();
    }
  });

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      closeStarModal();
      document.removeEventListener('keydown', onKeyDown);
      if (onCancel) onCancel();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  return true;
}

function showToast(text, isError = false, duration = 2200) {
  const id = 'sk-toast';
  document.getElementById(id)?.remove();

  const t = document.createElement('div');
  t.id = id;
  // 第2引数は boolean(isError) または string(level: 'success'|'error'|'info'|'warn') を許容
  let level = 'success';
  if (typeof isError === 'string') level = isError;
  else if (isError === true) level = 'error';
  t.className = 'sk-toast sk-toast-' + level;
  t.setAttribute('role', level === 'error' || level === 'warn' ? 'alert' : 'status');
  t.setAttribute('aria-live', level === 'error' || level === 'warn' ? 'assertive' : 'polite');

  // SVGアイコン（HTML側のシンボルを safe DOM API で参照）
  const iconWrap = document.createElement('span');
  iconWrap.className = 'sk-toast-icon';
  const iconId = level === 'error' || level === 'warn' ? '#i-warn' : (level === 'info' ? '#i-info' : '#i-check');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', iconId);
  use.setAttributeNS(XLINK_NS, 'xlink:href', iconId);
  svg.appendChild(use);
  iconWrap.appendChild(svg);

  const msgEl = document.createElement('span');
  msgEl.className = 'sk-toast-msg';
  msgEl.textContent = text;

  t.appendChild(iconWrap);
  t.appendChild(msgEl);
  document.body.appendChild(t);

  // 入場アニメーション
  requestAnimationFrame(() => t.classList.add('is-shown'));

  setTimeout(() => {
    t.classList.remove('is-shown');
    t.classList.add('is-hiding');
    setTimeout(() => t.remove(), 220);
  }, duration);
}

// =====================================================
// 永続化
// =====================================================

let workspaceSaveWarningShown = false;

async function persistSettings() {
  // 保存領域が誰のものか確定していない間は、sync への書き込みごと見送る。
  // 先に書いてしまうと、切替先の案件の領域へこちらの事業情報が上書きされる。
  const busy = await window.SK_STATE?.project?.workspaceBusyReason?.();
  if (busy === 'switching') return; // 切替側が退避を済ませているので、黙って見送ってよい
  if (busy === 'unsettled') {
    // 切替が途中で終わっている／別ウィンドウが切替中。ここで書くと別案件を汚す。
    if (!workspaceSaveWarningShown) {
      workspaceSaveWarningShown = true;
      showToast('この案件の変更はまだ保存されていません。編集を止めてからサイドパネルを開き直してください（開き直すと直前の変更は失われます）。', true, 10000);
    }
    return;
  }
  await chrome.storage.sync.set(state.settings);
  const saved = await window.SK_STATE?.project?.saveWorkspace?.();
  // 判定と書き込みの間に切替が始まった場合の取りこぼし。同じ文言で知らせる。
  if (saved && saved.ok === false && !workspaceSaveWarningShown) {
    workspaceSaveWarningShown = true;
    showToast('この案件の変更はまだ保存されていません。編集を止めてからサイドパネルを開き直してください（開き直すと直前の変更は失われます）。', true, 10000);
  }
}

async function hydrateBusinessInfoFromMasterIfMissing() {
  if (String(state.settings.industryLabel || '').trim() && String(state.settings.storeName || '').trim()) return false;
  try {
    const [docsClient, masterDocManager] = await Promise.all([
      import(chrome.runtime.getURL('phase0/docs-client.js')),
      import(chrome.runtime.getURL('phase0/master-doc-manager.js')),
    ]);
    const result = await masterDocManager.getStoredMasterDocInfo({
      docsClient,
      storageArea: chrome.storage.sync,
      includeBusinessInfo: true,
    });
    const industryLabel = String(result?.businessInfo?.industryLabel || '').trim();
    const storeName = String(result?.businessInfo?.storeName || '').trim();
    if (!industryLabel && !storeName) return false;
    if (industryLabel) state.settings.industryLabel = industryLabel;
    if (storeName) state.settings.storeName = storeName;
    await chrome.storage.sync.set({
      ...(industryLabel ? { industryLabel } : {}),
      ...(storeName ? { storeName } : {}),
    });
    await window.SK_STATE?.project?.saveWorkspace?.();
    return true;
  } catch (_) {
    return false;
  }
}

function getMetaSyncPayload() {
  const industry = String(state.settings.industryLabel || '').trim();
  const storeName = String(state.settings.storeName || '').trim();
  if (!industry || !storeName) return null;

  return {
    industry,
    storeName,
    caseId: String(state.settings.caseId || '').trim() || ('case-' + Date.now()),
    caseName: String(state.settings.caseName || '').trim() || storeName,
  };
}

async function syncMetaToDraft() {
  const payload = getMetaSyncPayload();
  if (!payload || metaSyncInFlight) return;

  const signature = [payload.industry, payload.storeName, payload.caseId, payload.caseName].join('||');
  if (signature === lastMetaSyncSignature) return;

  metaSyncInFlight = true;
  try {
    const draftManager = await import(chrome.runtime.getURL('phase0/draft-manager.js'));
    const docsClient = await import(chrome.runtime.getURL('phase0/docs-client.js'));
    const res = await draftManager.appendDraftSection({
      docsClient,
      storageArea: chrome.storage.sync,
      sectionNo: '-1',
      title: '案件メタ情報',
      body: [
        `業種: ${payload.industry}`,
        `店舗・屋号: ${payload.storeName}`,
        `案件ID: ${payload.caseId}`,
        `案件名: ${payload.caseName}`,
      ].join('\n'),
      aiUsed: 'system',
    });
    if (res && res.ok) {
      lastMetaSyncSignature = signature;
      let needsPersist = false;
      if (!state.settings.caseId && res.caseId) {
        state.settings.caseId = res.caseId;
        needsPersist = true;
      }
      if (!state.settings.caseName) {
        state.settings.caseName = payload.caseName;
        needsPersist = true;
      }
      if (needsPersist) await persistSettings();
      showToast('§-1 案件メタ情報を自動で書き込みました', false, 3000);
    }
  } catch (e) {
    console.warn('[SK] metadata sync failed:', e);
  } finally {
    metaSyncInFlight = false;
  }
}

function scheduleMetaSyncToDraft() {
  if (metaSyncTimer) clearTimeout(metaSyncTimer);
  metaSyncTimer = setTimeout(() => {
    metaSyncTimer = null;
    syncMetaToDraft();
  }, META_SYNC_DEBOUNCE_MS);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get([
    'industry',
    'industryLabel',
    'storeName',
    'caseId',
    'caseName',
    'lastPhase',
    'lastTab',
    'researchTopic',
    'researchNo',
    'researchPhaseLink',
    'showSafetyNotice',
    'setupCollapsed',
    'missionHeaderCollapsed',
    'sk_engagement_mode',
    'sk_hearing_summary_v012',
    'sk_hearing_notes_v012',
    HEARING_META_KEY,
    HEARING_SKIP_ACK_KEY,
  ]);
  state.settings = { ...state.settings, ...stored };
}

function bindSetupForm() {
  const select = document.getElementById('industry-select');
  const indInput = document.getElementById('industry-input');
  const storeInput = document.getElementById('store-input');
  const openBusinessBtn = document.getElementById('open-business-settings');

  renderBusinessSettingsReadout();
  if (openBusinessBtn) {
    openBusinessBtn.addEventListener('click', openBusinessSettings);
  }

  if (indInput) indInput.value = state.settings.industryLabel || '';
  if (storeInput) storeInput.value = state.settings.storeName || '';

  if (select) {
    select.addEventListener('change', () => {
      state.settings.industry = select.value;
      const item = state.industries.items.find((i) => i.id === select.value);
      if (item && indInput && !state.settings.industryLabel) {
        indInput.value = item.label;
        state.settings.industryLabel = item.label;
      }
      persistSettings();
      renderIndustryHint();
      renderBusinessSettingsReadout();
      renderCurrentPhase();
      renderResearchSteps();
      renderContextBar();
      refreshSetupChecklist();
      scheduleMetaSyncToDraft();
    });
  }

  if (indInput) {
    indInput.addEventListener('input', () => {
      state.settings.industryLabel = indInput.value;
      persistSettings();
      renderBusinessSettingsReadout();
      renderCurrentPhase();
      renderResearchSteps();
      renderContextBar();
      refreshSetupChecklist();
      scheduleMetaSyncToDraft();
    });
  }

  if (storeInput) {
    storeInput.addEventListener('input', () => {
      state.settings.storeName = storeInput.value;
      persistSettings();
      renderBusinessSettingsReadout();
      renderCurrentPhase();
      renderResearchSteps();
      renderContextBar();
      refreshSetupChecklist();
      scheduleMetaSyncToDraft();
    });
  }

  document.getElementById('dismiss-safety').addEventListener('click', () => {
    state.settings.showSafetyNotice = false;
    persistSettings();
    document.getElementById('safety').classList.add('hidden');
  });

  document.getElementById('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage?.();
  });

  // 段階5: •••「初期設定を開く」— 完了後に退避した #setup カードをインラインで再表示する。
  // 折りたたみ機構(setupCollapsed)を温存したまま明示展開扱いにして戻す導線。
  document.getElementById('open-setup')?.addEventListener('click', () => {
    state.settings.setupCollapsed = false;
    persistSettings();
    const setupCard = document.getElementById('setup');
    const setupBody = document.getElementById('setup-body');
    const setupCollapseBtn = document.getElementById('setup-collapse');
    if (setupCard) setupCard.classList.remove('hidden');
    if (setupBody) setupBody.removeAttribute('hidden');
    if (setupCollapseBtn) {
      setupCollapseBtn.classList.remove('hidden');
      setupCollapseBtn.setAttribute('aria-expanded', 'true');
    }
    renderContextBar();
    if (setupCard) {
      setTimeout(() => setupCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    }
  });

  // リセットボタン
  document.getElementById('reset-state').addEventListener('click', () => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });

    modal.appendChild(el('h3', { text: '全状態をリセット' }));
    modal.appendChild(
      el('p', {
        text: 'すべての作業状態（業種・店舗・テーマ・進捗・生成結果）をリセットしますか？\nこの操作は取り消せません。',
        style: 'white-space:pre-line;font-size:13px;margin:8px 0 12px',
      })
    );

    const actions = el('div', { class: 'modal-actions' });
    const resetBtn = el('button', { class: 'btn btn-caution', text: 'リセット' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: 'キャンセル' });

    function closeResetModal() { backdrop.remove(); }

    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true;
      resetBtn.textContent = 'リセット中…';
      await window.SK_STATE.reset();
      // 業務情報だけを chrome.storage.sync から消す（Google 連携と文書設定は維持）
      try {
        await chrome.storage.sync.remove([
          'industry',
          'industryLabel',
          'storeName',
          'caseId',
          'caseName',
          'lastPhase',
          'lastTab',
          'researchTopic',
          'researchNo',
	          'researchPhaseLink',
	          'showSafetyNotice',
	          'sk_engagement_mode',
	          'sk_hearing_summary_v012',
	          'sk_hearing_notes_v012',
	          'sk_hearing_meta_v013',
	          'sk_hearing_skip_ack_v013',
	        ]);
	        await chrome.storage.local.remove(['sk_hearing_rawtext_v012_local', 'sk_hearing_summary_v013_local']);
	      } catch (e) {
        console.error('[STRATEGY-KIT] sync.remove エラー:', e);
      }
      location.reload();
    });

    cancelBtn.addEventListener('click', closeResetModal);

    actions.appendChild(cancelBtn);
    actions.appendChild(resetBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeResetModal();
    });
    function onKeyDownReset(e) {
      if (e.key === 'Escape') {
        closeResetModal();
        document.removeEventListener('keydown', onKeyDownReset);
      }
    }
    document.addEventListener('keydown', onKeyDownReset);
  });

  document.getElementById('open-master-doc').addEventListener('click', async () => {
    try {
      const [docsClient, masterDocManager] = await Promise.all([
        import(chrome.runtime.getURL('phase0/docs-client.js')),
        import(chrome.runtime.getURL('phase0/master-doc-manager.js')),
      ]);
      const res = await masterDocManager.getStoredMasterDocInfo({
        docsClient,
        storageArea: chrome.storage.sync,
      });
      if (res && res.exists && res.docUrl) {
        chrome.tabs.create({ url: res.docUrl });
      } else {
        showToast('マスタードキュメントが未設定です。設定画面でURL確認または新規作成をしてください', true, 4000);
        chrome.runtime.openOptionsPage?.();
      }
    } catch (e) {
      showToast('マスタードキュメントを確認できませんでした。設定画面を確認してください', true, 4000);
      chrome.runtime.openOptionsPage?.();
    }
  });
}

// =====================================================
// 簡易イベントバス（モジュール間連携用）
// =====================================================

const _listeners = {};
function on(event, handler) {
  (_listeners[event] = _listeners[event] || []).push(handler);
}
function emit(event, payload) {
  for (const h of _listeners[event] || []) {
    try { h(payload); } catch (e) { console.warn('[SK]', event, e); }
  }
}

// =====================================================
// SK_CORE — 各モジュール（section-loader等）が呼ぶ公開API
// =====================================================

window.SK_CORE = {
  // データ
  getState: () => state,
  // ブランド表記の間接化ヘルパー（automation.js / diagram.js が生成物タイトル等に使う）。
  // product.json 未読・branding 欠落時は STRATEGY-KIT の現状文言へフォールバックする。
  getBranding: () => getBranding(),
  getFooterLabel: () => brandFooterLabel(),
  getCurrentPhase: () =>
    findModeAdjustedPhaseById(state.settings.lastPhase),
  getPhases: () => getVisiblePhases(),
  // SNS 版のプラットフォーム別ベンチマーク（automation.js の findPlatform が参照）。
  // benchmarkSource==="platform" 以外（Webマーケ版）では null。
  getPlatforms: () => state.platforms || null,
  getResearchCycle: () => state.prompts?.researchCycle || null,
  q2Filtering: {
    normalizeQ2Category,
    parseQ2ActionCandidates,
    buildQ2SelectionPlan,
    validateQ2FilteringOutput,
    renderQ2FilteringPreview,
    formatQ2SelectionAppendix,
  },

  // ユーティリティ
  applyTemplate,
  el,
  clearChildren,
  showToast,
  openOrFocusAiTab,
  setCurrentLocation,
  clearCurrentLocation,
  showSavingOverlay,
  hideSavingOverlay,
  openMissionFullscreen,

  // イベント
  on,
  emit,

  // 永続化
  persistSettings,

  // ヒアリング停止ゲート（automation.js が参照）
  getHearingReadinessState,
  persistHearingSkipAck,
  adoptHearingSummaryForCurrentCase,
  ensureHearingReadinessModule,

  // 状態永続化（state-persistence.js が先行ロードされていれば）
  get stateStore() {
    return window.SK_STATE || null;
  },
};

(async function init() {
  try {
    // v0.12.1: バージョン文字列はハードコードせず manifest から動的取得
    // SNS 版対応: ブランド表記は product.json の branding.footerLabel に間接化。
    // product.json ロード前なので一旦フォールバック表記で描画し、ロード後に上書きする。
    const footerVersionEl = document.getElementById('footer-version');
    let manifestVersionStr = '';
    try {
      manifestVersionStr = chrome?.runtime?.getManifest?.()?.version || '';
      if (footerVersionEl && manifestVersionStr) {
        // product.json ロード前なので brandFooterLabel() は null→'STRATEGY-KIT' を返す（ロード後 4216 で上書き）。
        footerVersionEl.textContent = brandFooterLabel() + ' v' + manifestVersionStr;
      }
    } catch (_) {
      /* manifest 取得失敗時はフォールバックでそのまま */
    }

    // product.json 経由で製品設定を解決し、prompts / industries / platforms をロードする。
    // product.json が無い／読めない場合は data/prompts.json + data/industries.json へ
    // 完全フォールバックする（既存 Webマーケ版を一切壊さない）。
    const productData = await loadProductData(loadJson);
    state.productConfig = productData.config;
    state.industries = productData.industries;
    state.prompts = productData.prompts;
    state.aiProfiles = productData.aiProfiles;
    state.platforms = productData.platforms;

    // フッター表記を product.json の branding.footerLabel に間接化（不読時は STRATEGY-KIT）。
    try {
      const footerLabel = brandFooterLabel();
      if (footerVersionEl) {
        footerVersionEl.textContent = manifestVersionStr
          ? footerLabel + ' v' + manifestVersionStr
          : footerLabel;
      }
    } catch (_) {
      /* branding 解決失敗時はフォールバック表記のまま */
    }

    // ヘッダーのブランド表記（ロゴ monogram / 2段テキスト / aria-label / タイトル）を
    // product.json の branding に間接化（各キー欠落時は STRATEGY-KIT の現状文言を維持）。
    try {
      const branding = getBranding();
      const logoMonogram = (branding && branding.logoMonogram) || 'SK';
      const brandLines =
        branding && Array.isArray(branding.brandLines) && branding.brandLines.length >= 2
          ? branding.brandLines
          : ['STRATEGY', 'kit'];
      const brandName = (branding && branding.name) || 'STRATEGY-KIT';
      const logoEl = document.getElementById('brand-logo');
      const mainEl = document.getElementById('brand-text-main');
      const subEl = document.getElementById('brand-text-sub');
      const rootEl = document.getElementById('brand-root');
      if (logoEl) logoEl.textContent = logoMonogram;
      if (mainEl) mainEl.textContent = brandLines[0];
      if (subEl) subEl.textContent = brandLines[1];
      if (rootEl) rootEl.setAttribute('aria-label', brandName);
      if (document.title === 'STRATEGY-KIT') document.title = brandName;
    } catch (_) {
      /* branding 解決失敗時はフォールバック表記のまま */
    }
	    // 保存領域とアクティブ案件の整合を、画面へ何かを読み込む前に確定させる。
	    // loadSettings() を先に走らせると、中断された切替の復旧が storage を書き戻す前に
	    // 別案件の値を state.settings へ取り込んでしまい、次の persistSettings() で
	    // その値が現在の案件へ保存される（案件データの取り違え）。
	    if (window.SK_STATE) {
	      if (typeof window.SK_STATE.init === 'function') {
	        await window.SK_STATE.init();
	      }
	      // アクティブ案件が無ければデフォルト案件を自動作成（作成も storage を書き換える）。
	      // 作成に失敗しても起動は続ける。ここで throw すると renderStableShell / bindTabs へ
	      // 到達せず、タブもボタンも描画されない画面になってしまう。
	      if (window.SK_STATE.project) {
	        try {
	          const currentActive = await window.SK_STATE.project.getActiveId();
	          if (!currentActive) {
	            await window.SK_STATE.project.create('新規プロジェクト');
	          }
	        } catch (error) {
	          console.warn('[STRATEGY-KIT] initial project create failed:', error);
	        }
	      }
	    }
	    await loadSettings();
	    await loadModeLocalState();
	    try {
	      const missionStored = await chrome.storage.local.get(MISSION_TASK_STORAGE_KEY);
	      missionTaskSnapshot = missionStored?.[MISSION_TASK_STORAGE_KEY] || null;
	    } catch (_) {
	      missionTaskSnapshot = null;
	    }
	    await detectGeminiSummarizerAvailability();
	    // ヒアリング準備状況の純ロジックを先読み（buildBusinessContextForMode が同期参照する）
	    await ensureHearingReadinessModule().catch(() => {});
	    ensureVisibleLastPhase();

	    // SK_STATE から補足状態を復元（chrome.storage.sync の設定を上書きしない）
    if (window.SK_STATE) {
      // init と既定案件の作成は loadSettings より前に済ませている（起動順序を参照）
      state.modeLocal.automationExecutionMode = normalizeAutomationExecutionMode(
        await window.SK_STATE.load(AUTOMATION_EXECUTION_MODE_PATH, 'semi')
      );
      await new Promise(function (resolve) {
        window.SK_STATE.loadAll(function (saved) {
          // 業種・店舗・テーマ（sync 未設定なら local から補完）
          if (!state.settings.industryLabel && saved['placeholders.industryLabel']) {
            state.settings.industryLabel = saved['placeholders.industryLabel'];
          }
          if (!state.settings.storeName && saved['placeholders.storeName']) {
            state.settings.storeName = saved['placeholders.storeName'];
          }
          if (!state.settings.researchTopic && saved['placeholders.researchTopic']) {
            state.settings.researchTopic = saved['placeholders.researchTopic'];
          }
          // アクティブタブ（sync 側の lastTab を優先、なければ local から）
          if (!state.settings.lastTab && saved['ui.activeTab']) {
            state.settings.lastTab = saved['ui.activeTab'];
          }
          resolve();
        });
      });
      await hydrateBusinessInfoFromMasterIfMissing();
    }

    // v0.12: 案件セレクタの初期化（topbar の project-switcher）
    if (window.SK_STATE && window.SK_STATE.project) {
      const populateProjectSelect = async function () {
        const select = document.getElementById('project-select');
        if (!select) return;
        const projects = await window.SK_STATE.project.list();
        const activeId = await window.SK_STATE.project.getActiveId();
        select.replaceChildren();
        if (projects.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '（案件未作成）';
          select.appendChild(opt);
          return;
        }
        for (const p of projects) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.label || '無題プロジェクト';
          if (p.id === activeId) opt.selected = true;
          select.appendChild(opt);
        }
      };
      await populateProjectSelect();

      const select = document.getElementById('project-select');
      const newBtn = document.getElementById('project-new');
      if (select) {
        select.addEventListener('change', async function () {
          const id = select.value;
          if (!id) return;
          // 実行中の切替は、reload で実行中のチェーンを壊すので受け付けない。
          if (isAutomationRunningNow()) {
            select.value = window.SK_STATE._activeProjectId || '';
            showToast('実行中は案件を切り替えられません。中断するか、完了してから切り替えてください。', true, 5000);
            return;
          }
          // 切替中の再操作を防ぐ。並走すると案件のデータが混ざるため、
          // 失敗したときは選択を戻して、何が起きたかを画面に出す。
          select.disabled = true;
          if (newBtn) newBtn.disabled = true;
          try {
            await window.SK_STATE.project.activate(id);
            window.location.reload();
          } catch (error) {
            select.disabled = false;
            if (newBtn) newBtn.disabled = false;
            select.value = window.SK_STATE._activeProjectId || '';
            showToast('案件を切り替えられませんでした。もう一度お試しください。', true, 5000);
            console.warn('[STRATEGY-KIT] project activate failed:', error);
          }
        });
      }
      // v0.12.1: window.prompt は拡張サイドパネルで動作が不安定なため、インライン入力フォームに差し替え
      const newForm = document.getElementById('project-new-form');
      const newInput = document.getElementById('project-new-input');
      const newCancel = document.getElementById('project-new-cancel');
      const projectLabel = document.querySelector('.project-switcher-label');
      const showNewForm = function () {
        if (!newForm) return;
        if (select) select.classList.add('hidden');
        if (newBtn) newBtn.classList.add('hidden');
        if (projectLabel) projectLabel.classList.add('hidden');
        newForm.classList.remove('hidden');
        if (newInput) {
          newInput.value = '';
          newInput.focus();
        }
      };
      const hideNewForm = function () {
        if (!newForm) return;
        newForm.classList.add('hidden');
        if (select) select.classList.remove('hidden');
        if (newBtn) newBtn.classList.remove('hidden');
        if (projectLabel) projectLabel.classList.remove('hidden');
      };
      if (newBtn) {
        newBtn.addEventListener('click', showNewForm);
      }
      if (newCancel) {
        newCancel.addEventListener('click', hideNewForm);
      }
      if (newInput) {
        newInput.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.preventDefault();
            hideNewForm();
          }
        });
      }
      if (newForm) {
        newForm.addEventListener('submit', async function (e) {
          e.preventDefault();
          const trimmed = (newInput?.value || '').trim();
          if (!trimmed) {
            newInput?.focus();
            return;
          }
          await window.SK_STATE.project.create(trimmed);
          window.location.reload();
        });
      }
    }

    renderStableShell('init');
    bindSetupForm();
    bindSetupChecklist();
    bindContextBar();
    bindStatusCluster();
    bindNextAction();
    bindEmptyStates();
    bindMissionControl();
    bindTabs();
    bindCommandPalette();
    bindGlobalKeys();
    bindRowContextMenu();
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    sidepanelInitialized = true;
    renderStableShell('init-ready');
    document.body.classList.remove('sk-booting');
    // 全画面からの操作でサイドパネルを今開いた場合、起動前に保存されたコマンドも拾う。
    chrome.storage.local.get([MISSION_COMMAND_STORAGE_KEY]).then((values) => {
      processMissionCommand(values?.[MISSION_COMMAND_STORAGE_KEY]);
    }).catch(() => {});
    await refreshSetupChecklist();
    renderCurrentLocationBar();
    syncEmptyStates();

    // フェーズ変更/進捗更新で next-action を再評価
    on('phase-changed', () => {
      scheduleStableRender('event-phase-changed');
    });
    on('progress-updated', () => {
      scheduleStableRender('event-progress-updated');
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!sidepanelInitialized) return;
      if (areaName === 'local' && changes[MISSION_TASK_STORAGE_KEY]) {
        missionTaskSnapshot = changes[MISSION_TASK_STORAGE_KEY].newValue || null;
        renderMissionControl();
        renderSlimBar();
        renderCurrentPhaseCard();
      }
      if (areaName === 'local' && changes.sk_hearing_rawtext_v012_local) {
        state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY] = String(changes.sk_hearing_rawtext_v012_local.newValue || '');
        scheduleStableRender('storage-hearing-raw');
      }
      // v3.5: 要約本体は local に保存されるので、別コンテキストからの変更を local 側で拾う。
      if (areaName === 'local' && changes[HEARING_SUMMARY_LOCAL_KEY]) {
        state.settings[HEARING_SUMMARY_KEY] = String(changes[HEARING_SUMMARY_LOCAL_KEY].newValue || '');
        state.modeLocal.hearingSummaryDraft = state.settings[HEARING_SUMMARY_KEY];
        scheduleStableRender('storage-hearing-summary');
      }
      // 全画面コマンドセンターからの操作を既存UI/自動化ロジックへ委譲する。
      if (areaName === 'local' && changes[MISSION_COMMAND_STORAGE_KEY]) {
        const command = changes[MISSION_COMMAND_STORAGE_KEY].newValue;
        processMissionCommand(command);
      }
      if (areaName === 'local') {
        const modeStorageKey = automationExecutionModeStorageKey(window.SK_STATE?._activeProjectId || '');
        if (changes[modeStorageKey]) {
          applyAutomationExecutionModeFromStorage(changes[modeStorageKey].newValue);
        }
      }
      if (areaName !== 'sync') return;
      let needsChecklist = false;
      let needsBusinessRefresh = false;
      let needsModeRefresh = false;
      if (changes.sk_engagement_mode) {
        state.settings[ENGAGEMENT_MODE_KEY] = changes.sk_engagement_mode.newValue || '';
        ensureVisibleLastPhase();
        needsModeRefresh = true;
      }
      // v3.5: 要約本体は local 監視へ移行（上の local ブロック）。sync 側の旧キー変化（移行時の削除等）は
      //   in-memory を上書きしない（移行で local に揃えた値を消さないため）。
      if (changes.sk_hearing_notes_v012) {
        state.settings[HEARING_NOTES_KEY] = changes.sk_hearing_notes_v012.newValue || '';
        needsModeRefresh = true;
      }
      if (changes.industryLabel) {
        state.settings.industryLabel = changes.industryLabel.newValue || '';
        needsChecklist = true;
        needsBusinessRefresh = true;
      }
      if (changes.storeName) {
        state.settings.storeName = changes.storeName.newValue || '';
        needsChecklist = true;
        needsBusinessRefresh = true;
      }
      if (changes.industry) {
        state.settings.industry = changes.industry.newValue || state.settings.industry;
        const select = document.getElementById('industry-select');
        if (select && state.settings.industry) select.value = state.settings.industry;
        renderIndustryHint();
        needsBusinessRefresh = true;
      }
      if (changes.sk_oauth_ready || changes.sk_master_doc_v012) {
        needsChecklist = true;
      }
      // マスタードキュメントが新規作成・変更されたら、進捗トラッカーに再取得を促す。
      // （最上部の進捗チップ/ドット/「次は §N」が前案件の値のまま固まるのを防ぐ）
      if (changes.sk_master_doc_v012) {
        emit('master-doc-changed');
      }
      // 修正A: options 側で Google 連携が完了した（sk_oauth_ready 変化）瞬間に
      //   自動化スロットを再評価・構築する。拡張/サイドパネルのリロードを不要にする。
      if (changes.sk_oauth_ready && window.SK_AUTOMATION && typeof window.SK_AUTOMATION.ensureReady === 'function') {
        Promise.resolve(window.SK_AUTOMATION.ensureReady())
          .then(syncEmptyStates)
          .catch(() => {});
      }
      if (needsBusinessRefresh) {
        renderResearchSteps();
        scheduleStableRender('storage-business');
      }
      if (needsModeRefresh) {
        scheduleStableRender('storage-mode');
      }
      if (needsChecklist) {
        refreshSetupChecklist();
      }
    });

    // setup フォームの入力変更を SK_STATE にも保存する
    if (window.SK_STATE) {
      const industryInput = document.getElementById('industry-input');
      const storeInput = document.getElementById('store-input');
      const industrySelect = document.getElementById('industry-select');
      const researchTopic = document.getElementById('research-topic');

      if (industryInput) {
        industryInput.addEventListener('input', function () {
          window.SK_STATE.debounceSave('placeholders.industryLabel', industryInput.value);
        });
      }
      if (storeInput) {
        storeInput.addEventListener('input', function () {
          window.SK_STATE.debounceSave('placeholders.storeName', storeInput.value);
        });
      }
      if (industrySelect) {
        industrySelect.addEventListener('change', function () {
          window.SK_STATE.save('placeholders.industryId', industrySelect.value);
        });
      }
      if (researchTopic) {
        researchTopic.addEventListener('input', function () {
          window.SK_STATE.debounceSave('placeholders.researchTopic', researchTopic.value);
        });
      }
    }

    // 各モジュールに「初期化していいよ」を通知
    emit('core-ready');

    chrome.storage.onChanged.addListener((changes, areaName) => {
	      if (!sidepanelInitialized) return;
	      if (
	        (areaName === 'local' && (changes.sk_gemini_api_key_v012 || changes.sk_gemini_proxy_token_v012)) ||
	        (areaName === 'sync' && changes.sk_gemini_proxy_v012)
	      ) {
	        refreshSetupChecklist();
	        detectGeminiSummarizerAvailability().then(function () {
	          scheduleStableRender('storage-gemini');
	        }).catch(() => {});
	      }
	    });

    // Lane A: setup-status-strip の初期化と制御
    // Google 連携 OR 業種 OR 店舗が未設定のとき表示、全完了 or「あとで」で非表示
    try {
      const stripDismissed = window.SK_STATE
        ? await window.SK_STATE.load('ui.onboardingDismissed', false)
        : false;

      window._setupStripCfg = window._setupStripCfg || {};

      const strip = document.getElementById('setup-status-strip');

      // OAuth 接続有無を silent 取得して setup strip に反映
      let oauthConnected = false;
      try {
        const authUrl = chrome.runtime.getURL('phase0/auth.js');
        const { getAuthToken } = await import(authUrl);
        const token = await getAuthToken({ interactive: false });
        oauthConnected = !!token;
      } catch (e) {
        oauthConnected = false;
        if (e instanceof TypeError || (e && e.name === 'SyntaxError')) {
          console.warn('[strategy-kit] phase0/auth.js のロード失敗 (未配置 or 構文エラー)', e);
        } else if (e && e.code === 'F-1') {
          console.warn('[strategy-kit] OAuth 未連携: manifest.oauth2.client_id を確認してください', e);
        } else if (e && e.code === 'F-3') {
          console.warn('[strategy-kit] OAuth network エラー、未連携扱いで継続', e);
        } else {
          console.warn('[strategy-kit] OAuth silent 取得失敗 (想定外、未連携扱いで継続)', e);
        }
      }
      window._setupStripCfg.oauthConnected = oauthConnected;

      const needsSetup = !oauthConnected || !state.settings.industryLabel || !state.settings.storeName;

      if (strip && needsSetup && !stripDismissed) {
        strip.classList.remove('hidden');
        refreshSetupStatusStrip();

        // 「あとで」ボタン
        const dismissBtn = document.getElementById('setup-status-strip-dismiss');
        if (dismissBtn) {
          dismissBtn.addEventListener('click', function () {
            strip.classList.add('hidden');
            if (window.SK_STATE) {
              window.SK_STATE.save('ui.onboardingDismissed', true);
            }
          });
        }

        // 各ステップボタンのクリックで該当箇所へスクロール or 遷移
        const oauthItem = strip.querySelector('[data-step="oauth"]');
        if (oauthItem) {
          oauthItem.querySelector('button').addEventListener('click', function () {
            if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
          });
        }

        const bizItem = strip.querySelector('[data-step="business"]');
        if (bizItem) {
          bizItem.querySelector('button').addEventListener('click', function () {
            openBusinessSettings();
          });
        }

        const phase0Item = strip.querySelector('[data-step="phase0"]');
        if (phase0Item) {
          phase0Item.querySelector('button').addEventListener('click', function () {
            switchTab('phases');
            const list = document.getElementById('phase-list');
            if (list) setTimeout(function () { list.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
          });
        }
      } else if (strip) {
        // 全設定済み or 既に dismiss 済みなら非表示
        strip.classList.add('hidden');
      }

      // progress-updated イベントでストリップも更新
      on('progress-updated', function () {
        window._setupStripCfg = window._setupStripCfg || {};
        refreshSetupStatusStrip();
      });

    } catch (e) {
      console.warn('[STRATEGY-KIT] setup-status-strip init failed:', e);
    }

  } catch (e) {
    document.body.classList.remove('sk-booting');
    document.body.appendChild(
      el('div', {
        class: 'card',
        text: '初期化に失敗しました: ' + e.message,
      })
    );
  }
})();

// =====================================================
// Command Palette (Cmd+K) — Wave 4 Phase 2
// state / switchTab / renderCurrentPhase / persistSettings は
// 上のグローバルスコープで定義済みのため直接参照可能
// =====================================================

var _cmdk = (function () {
  'use strict';

  // ── 内部状態 ────────────────────────────────────────
  var _isOpen = false;
  var _filtered = [];
  var _selectedIdx = 0;

  // ── アクション定義 (open 時に毎回構築) ───────────────
  function _buildActions() {
    var actions = [];

    // §N を開く: visible phases から動的生成
    var phases = getVisiblePhases();
    phases.forEach(function (phase) {
      var secLabel = '§' + phase.no + (phase.title ? ' ' + phase.title : '');
      actions.push({
        id: 'open-phase-' + phase.id,
        label: secLabel + ' を開く',
        icon: '§',
        run: (function (ph) {
          return function () {
            state.settings.lastPhase = ph.id;
            persistSettings();
            switchTab('phases');
            renderPhaseList();
            renderCurrentPhase();
            var row = document.querySelector('[data-phase-id="' + ph.id + '"]');
            if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          };
        }(phase)),
      });
    });

    // 次の§へ進む
    actions.push({
      id: 'next-phase',
      label: '次の § へ進む',
      icon: '▶',
      run: function () {
        var cta = document.getElementById('nextaction-cta');
        if (cta) cta.click();
      },
    });

    // マスタードキュメントを開く
    actions.push({
      id: 'open-master-doc',
      label: 'マスタードキュメントを開く',
      icon: '📄',
      run: function () {
        var btn = document.getElementById('open-master-doc');
        if (btn) btn.click();
      },
    });

    // 案件を新規作成
    actions.push({
      id: 'project-new',
      label: '案件を新規作成',
      icon: '+',
      run: function () {
        var btn = document.getElementById('project-new');
        if (btn) btn.click();
      },
    });

    // 全状態をリセット
    actions.push({
      id: 'reset-state',
      label: '全状態をリセット',
      icon: '↺',
      run: function () {
        var btn = document.getElementById('reset-state');
        if (btn) btn.click();
      },
    });

    // 設定を開く
    actions.push({
      id: 'open-options',
      label: '設定を開く',
      icon: '⚙',
      shortcut: '⌘.',
      run: function () {
        var btn = document.getElementById('open-options');
        if (btn) btn.click();
      },
    });

    return actions;
  }

  // ── DOM ヘルパー ──────────────────────────────────
  function _backdrop() { return document.getElementById('cmdk-backdrop'); }
  function _searchEl() { return document.getElementById('cmdk-search'); }
  function _listEl()   { return document.getElementById('cmdk-list'); }

  // ── open ─────────────────────────────────────────
  function _open() {
    _filtered = _buildActions();
    _selectedIdx = 0;
    _isOpen = true;
    var bd = _backdrop();
    if (!bd) return;
    bd.classList.remove('hidden');
    _renderList('');
    var s = _searchEl();
    if (s) {
      s.value = '';
      s.focus();
    }
    _trapFocus(true);
  }

  // ── close ────────────────────────────────────────
  function _close() {
    _isOpen = false;
    var bd = _backdrop();
    if (!bd) return;
    bd.classList.add('hidden');
    _trapFocus(false);
  }

  // ── リスト描画 ───────────────────────────────────
  function _renderList(query) {
    var list = _listEl();
    if (!list) return;
    var q = query.trim().toLowerCase();
    var allActions = _buildActions();
    _filtered = q
      ? allActions.filter(function (a) { return a.label.toLowerCase().indexOf(q) !== -1; })
      : allActions.slice();
    _selectedIdx = 0;

    // DOM を手動構築 (innerHTML 不使用)
    while (list.firstChild) list.removeChild(list.firstChild);

    _filtered.forEach(function (action, idx) {
      var li = document.createElement('li');
      li.className = 'cmdk-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', idx === _selectedIdx ? 'true' : 'false');
      li.dataset.idx = String(idx);

      var iconSpan = document.createElement('span');
      iconSpan.className = 'cmdk-item-icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.textContent = action.icon || '›';
      li.appendChild(iconSpan);

      var labelSpan = document.createElement('span');
      labelSpan.className = 'cmdk-item-label';
      labelSpan.textContent = action.label;
      li.appendChild(labelSpan);

      if (action.shortcut) {
        var kbd = document.createElement('kbd');
        kbd.className = 'cmdk-item-shortcut';
        kbd.textContent = action.shortcut;
        li.appendChild(kbd);
      }

      li.addEventListener('click', (function (act) {
        return function () { _close(); act.run(); };
      }(action)));

      li.addEventListener('mousemove', (function (i) {
        return function () {
          if (_selectedIdx !== i) { _selectedIdx = i; _updateSelected(); }
        };
      }(idx)));

      list.appendChild(li);
    });

    _updateSelected();
  }

  function _updateSelected() {
    var list = _listEl();
    if (!list) return;
    var items = list.querySelectorAll('.cmdk-item');
    items.forEach(function (item, i) {
      var sel = (i === _selectedIdx);
      item.setAttribute('aria-selected', sel ? 'true' : 'false');
      if (sel) item.scrollIntoView({ block: 'nearest' });
    });
  }

  // ── フォーカストラップ ────────────────────────────
  var _trapHandler = null;
  function _trapFocus(enable) {
    if (_trapHandler) {
      document.removeEventListener('keydown', _trapHandler, true);
      _trapHandler = null;
    }
    if (!enable) return;
    _trapHandler = function (e) {
      if (e.key !== 'Tab') return;
      var modal = document.getElementById('cmdk-modal');
      if (!modal) return;
      var focusable = Array.from(modal.querySelectorAll('input, button'));
      if (!focusable.length) { e.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', _trapHandler, true);
  }

  // ── 検索欄 keydown ────────────────────────────────
  function _onSearchKey(e) {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        _close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        _selectedIdx = Math.min(_selectedIdx + 1, _filtered.length - 1);
        _updateSelected();
        break;
      case 'ArrowUp':
        e.preventDefault();
        _selectedIdx = Math.max(_selectedIdx - 1, 0);
        _updateSelected();
        break;
      case 'Enter':
        e.preventDefault();
        var act = _filtered[_selectedIdx];
        if (act) { _close(); act.run(); }
        break;
    }
  }

  // ── グローバル keydown (Cmd+K / Ctrl+K) ──────────
  function _onGlobalKey(e) {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      _isOpen ? _close() : _open();
      return;
    }
    if (_isOpen && e.key === 'Escape') {
      e.preventDefault();
      _close();
    }
  }

  // ── 公開: bindCommandPalette ──────────────────────
  function bindCommandPalette() {
    document.addEventListener('keydown', _onGlobalKey);

    var s = _searchEl();
    if (s) {
      s.addEventListener('keydown', _onSearchKey);
      s.addEventListener('input', function () { _renderList(s.value); });
    }

    var bd = _backdrop();
    if (bd) {
      bd.addEventListener('click', function (e) {
        if (e.target === bd) _close();
      });
    }
  }

  return { bindCommandPalette: bindCommandPalette };
}());

// IIFE 内の bindCommandPalette() 呼び出しから参照できるようグローバルに公開
function bindCommandPalette() {
  _cmdk.bindCommandPalette();
}

// =====================================================
// Wave 4 Phase 3a: グローバルキーボードショートカット
// =====================================================
function bindGlobalKeys() {
  document.addEventListener('keydown', function (e) {
    // input/textarea/contenteditable 中は J/K を無視
    const tag = document.activeElement && document.activeElement.tagName;
    const isEditable =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      (document.activeElement && document.activeElement.isContentEditable);

    // Cmd/Ctrl + . → 設定を開く
    if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      var optBtn = document.getElementById('open-options');
      if (optBtn) optBtn.click();
      return;
    }

    // Cmd/Ctrl + Enter → 選択中フェーズの第1プロンプトをコピー
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (async function () {
        var phase = findModeAdjustedPhaseById(state.settings.lastPhase);
        if (!phase || !phase.prompts || !phase.prompts.length) return;
        var raw = phase.prompts[0].body || phase.prompts[0].text || '';
        if (!raw) return;
        try {
          var text = await enrichWithMasterSummaries(raw);
          await navigator.clipboard.writeText(text);
          showToast('第1推奨プロンプトをコピーしました');
        } catch (_) {
          showToast('コピーに失敗しました', true);
        }
      })();
      return;
    }

    // J → phase-list 下へ移動 (input 中は無視)
    if (e.key === 'j' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable) {
      e.preventDefault();
      var list = document.getElementById('phase-list');
      if (!list) return;
      var rows = Array.from(list.querySelectorAll('.phase-row'));
      if (!rows.length) return;
      var focused = document.activeElement;
      var idx = rows.indexOf(focused);
      var next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
      rows[next].focus({ preventScroll: false });
      return;
    }

    // K → phase-list 上へ移動 (input 中は無視)
    if (e.key === 'k' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable) {
      e.preventDefault();
      var list2 = document.getElementById('phase-list');
      if (!list2) return;
      var rows2 = Array.from(list2.querySelectorAll('.phase-row'));
      if (!rows2.length) return;
      var focused2 = document.activeElement;
      var idx2 = rows2.indexOf(focused2);
      var prev = idx2 <= 0 ? 0 : idx2 - 1;
      rows2[prev].focus({ preventScroll: false });
      return;
    }
  });
}

// =====================================================
// Wave 4 Phase 3b: 右クリックコンテキストメニュー
// =====================================================
function bindRowContextMenu() {
  var menu = document.getElementById('phase-row-menu');
  if (!menu) return;

  var _targetPhaseId = null;

  function closeMenu() {
    menu.classList.add('hidden');
    menu.hidden = true;
    _targetPhaseId = null;
  }

  function showMenu(x, y, phaseId) {
    _targetPhaseId = phaseId;
    menu.innerHTML = '';

    var phase = findModeAdjustedPhaseById(phaseId);

    // 「開く」
    var itemOpen = document.createElement('button');
    itemOpen.className = 'rowmenu-item';
    itemOpen.textContent = '開く';
    itemOpen.addEventListener('click', function () {
      closeMenu();
      if (!phase) return;
      state.settings.lastPhase = phase.id;
      persistSettings();
      renderPhaseList();
      renderCurrentPhase();
      emit('phase-changed', phase);
    });
    menu.appendChild(itemOpen);

    // 「プロンプトをコピー」
    var itemCopy = document.createElement('button');
    itemCopy.className = 'rowmenu-item';
    itemCopy.textContent = 'プロンプトをコピー';
    itemCopy.addEventListener('click', function () {
      closeMenu();
      if (!phase || !phase.prompts || !phase.prompts.length) return;
      var raw = phase.prompts[0].body || phase.prompts[0].text || '';
      (async function () {
        try {
          var text = await enrichWithMasterSummaries(raw);
          await navigator.clipboard.writeText(text);
          showToast('プロンプトをコピーしました');
        } catch (_) {
          showToast('コピーに失敗しました', true);
        }
      })();
    });
    menu.appendChild(itemCopy);

    // 「マスタードキュメントを開く」
    var itemMaster = document.createElement('button');
    itemMaster.className = 'rowmenu-item';
    itemMaster.textContent = 'マスタードキュメントを開く';
    itemMaster.addEventListener('click', function () {
      closeMenu();
      var masterBtn = document.getElementById('open-master-doc');
      if (masterBtn) masterBtn.click();
    });
    menu.appendChild(itemMaster);

    // セパレーター
    var sep = document.createElement('div');
    sep.className = 'rowmenu-sep';
    menu.appendChild(sep);

    // 「リセット（この行のみ）」
    var itemReset = document.createElement('button');
    itemReset.className = 'rowmenu-item rowmenu-item--danger';
    itemReset.textContent = 'リセット（この行のみ）';
    itemReset.addEventListener('click', function () {
      closeMenu();
      if (!phase) return;
      var no = String(phase.no);
      state.progressFilledNos = (state.progressFilledNos || []).filter(function (n) { return n !== no; });
      state.progressPartialNos = (state.progressPartialNos || []).filter(function (n) { return n !== no; });
      persistSettings();
      renderPhaseList();
      showToast('§' + phase.no + ' をリセットしました');
    });
    menu.appendChild(itemReset);

    // 位置計算: ビューポート端で fold
    var menuW = 180;
    var menuH = 170;
    var vpW = window.innerWidth;
    var vpH = window.innerHeight;
    var left = x + menuW > vpW ? vpW - menuW - 4 : x;
    var top  = y + menuH > vpH ? vpH - menuH - 4 : y;

    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
    menu.hidden = false;
    menu.classList.remove('hidden');
  }

  // phase-list の contextmenu イベントを委譲で捕捉
  var phaseList = document.getElementById('phase-list');
  if (phaseList) {
    phaseList.addEventListener('contextmenu', function (e) {
      var row = e.target.closest('.phase-row');
      if (!row) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, row.dataset.phaseId);
    });
  }

  // Esc / 画面外クリックで閉じる
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      closeMenu();
    }
  }, true);

  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target)) {
      closeMenu();
    }
  });

  document.addEventListener('contextmenu', function (e) {
    if (!menu.hidden && !menu.contains(e.target)) {
      closeMenu();
    }
  });
}
