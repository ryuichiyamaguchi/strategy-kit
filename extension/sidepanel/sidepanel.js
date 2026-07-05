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
    [ENGAGEMENT_MODE_KEY]: '',
    [HEARING_SUMMARY_KEY]: '',
    [HEARING_NOTES_KEY]: '',
    [HEARING_META_KEY]: null,
    [HEARING_SKIP_ACK_KEY]: null,
  },
  modeLocal: {
    [HEARING_RAWTEXT_LOCAL_KEY]: '',
    hearingSummaryDraft: '',
    hearingStatus: 'idle',
    hearingStatusMessage: '',
    geminiSummarizerAvailable: false,
    geminiSummarizerChecked: false,
    modeSelectorExpanded: false,
    statusClusterExpanded: null,
  },
};

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
      model: 'gemini-3.5-flash',
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
    document.createTextNode('録音文字起こし・議事録・ヒアリングメモ'),
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
    document.createTextNode('AI 要約結果（確認して編集できます）'),
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
    text: isProcessing ? '要約処理中…' : 'Geminiで要約',
    disabled: !canUseGemini,
    attrs: { 'data-role': 'hearing-gemini' },
    on: { click: () => summarizeHearingRawText(state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY]) },
  }));
  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '要約promptをコピー',
    disabled: !canCopyPrompt,
    attrs: { 'data-role': 'hearing-copy' },
    on: { click: () => copyHearingSummaryPrompt(state.modeLocal[HEARING_RAWTEXT_LOCAL_KEY]) },
  }));
  actions.appendChild(el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    text: 'この要約で確定',
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
  mount.appendChild(optionsWrap);
}

async function handleModeChange(mode) {
  if (!['A', 'B', 'C'].includes(mode)) return;
  const current = state.settings[ENGAGEMENT_MODE_KEY];
  if (current === mode) {
    state.modeLocal.modeSelectorExpanded = false;
    renderModeSelector();
    return;
  }
  const hasProgress = !!((state.progressFilledNos || []).length || (state.progressPartialNos || []).length);
  if (hasProgress) {
    const ok = confirm('入口モードを変更します。これまでの入力や Google Docs は削除しませんが、表示される Phase 0 と AI に渡す前提文が変わります。変更しますか？');
    if (!ok) {
      renderModeSelector();
      return;
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
  state.modeLocal.modeSelectorExpanded = false;
  ensureVisibleLastPhase();
  renderModeSelector();
  renderPhaseList();
  renderCurrentPhase();
  renderContextBar();
  renderNextAction();
  emit('phase-changed', findModeAdjustedPhaseById(state.settings.lastPhase));
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

function renderStableShell(reason) {
  renderIndustryOptions();
  renderIndustryHint();
  renderBusinessSettingsReadout();
  renderModeSelector();
  renderPhaseList();
  renderResearchTab();
  renderPrinciples();
  renderContextBar();
  renderStatusCluster();
  renderCurrentLocationBar();
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

// =====================================================
// タブ切替 (Wave 4: セグメント廃止、3タブ単段化)
// =====================================================

function switchTab(name, options = {}) {
  state.settings.lastTab = name;
  const shouldPersist = options.persist !== false && sidepanelInitialized;
  if (shouldPersist) {
    persistSettings();
    if (window.SK_STATE) window.SK_STATE.save('ui.activeTab', name);
  }
  requestAnimationFrame(function () {
    for (const btn of document.querySelectorAll('.tab-btn')) {
      const isOn = btn.dataset.tab === name;
      btn.classList.toggle('is-active', isOn);
      btn.setAttribute('aria-selected', String(isOn));
    }
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

function renderContextBar() {
  const bar = document.getElementById('contextbar');
  const setupCard = document.getElementById('setup');
  const setupBody = document.getElementById('setup-body');
  const setupCollapseBtn = document.getElementById('setup-collapse');
  // Lane A: #onboarding は廃止。setup-status-strip の表示状態は別管理のため参照しない

  const industry = getIndustryDisplayLabel();
  const store = state.settings.storeName || '';
  const hasBoth = !!industry && !!store;

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

  // 既存カウンタ更新
  clearChildren(countEl);
  countEl.appendChild(document.createTextNode(String(filled)));
  const t = document.createElement('span');
  t.className = 'contextbar-progress-total';
  t.textContent = `/${totalPhases}`;
  countEl.appendChild(t);

  // 進捗バー fill 更新
  const barFill = document.getElementById('contextbar-bar-fill');
  if (barFill) {
    const rate = totalPhases > 0 ? Math.min(100, Math.round((filled / totalPhases) * 100)) : 0;
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

function renderCurrentPhase() {
  // Wave 4 Phase 1: current-phase section 廃止。展開エリアは phase-list の selected row に統合済み。
  // renderPhaseList() が accordion を含めて描画するので、単独呼び出しは renderPhaseList に委譲する。
  // ただし renderPhaseList() の直後に呼ばれる場合は二重描画を避けるため、
  // phase-list に selected row が既にあれば何もしない。
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

async function persistSettings() {
  await chrome.storage.sync.set(state.settings);
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
    const resetBtn = el('button', { class: 'btn', text: 'リセット', style: 'background:#c0392b;color:#fff' });
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
	    await loadSettings();
	    await loadModeLocalState();
	    await detectGeminiSummarizerAvailability();
	    // ヒアリング準備状況の純ロジックを先読み（buildBusinessContextForMode が同期参照する）
	    await ensureHearingReadinessModule().catch(() => {});
	    ensureVisibleLastPhase();

	    // SK_STATE から補足状態を復元（chrome.storage.sync の設定を上書きしない）
    if (window.SK_STATE) {
      // v0.12: activeProjectId を同期キャッシュへロードしてからアクセスする
      if (typeof window.SK_STATE.init === 'function') {
        await window.SK_STATE.init();
      }
      // v0.12: アクティブ案件が無ければデフォルト案件を自動作成
      if (window.SK_STATE.project) {
        const currentActive = await window.SK_STATE.project.getActiveId();
        if (!currentActive) {
          await window.SK_STATE.project.create('新規プロジェクト');
        }
      }
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
          await window.SK_STATE.project.activate(id);
          window.location.reload();
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
    bindTabs();
    bindCommandPalette();
    bindGlobalKeys();
    bindRowContextMenu();
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    sidepanelInitialized = true;
    renderStableShell('init-ready');
    document.body.classList.remove('sk-booting');
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
