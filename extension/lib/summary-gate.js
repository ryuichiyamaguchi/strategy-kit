// STRATEGY-KIT — Summary Gate（要点版の忠実性ゲート・純ロジック）
//
// 目的: 各フェーズ出力の「要点版」ブロックが、同じ出力の分析本文に存在しない
// 数値や、格上げされた [タグ] を含んでいないかを決定的（非LLM）に照合する。
// 幻覚検出をLLMに任せない（検出器は難例で precision ~50%）。照合できる形の
// 検査はコードで行い、直せない場合は ⚠要確認 を付けて完走する（止めない）。
//
// Finance Gate（phase0/finance-gate.js・§7-4専用）の汎用版にあたる。
// ハンドオフ規約: 蓄積コンテキストへは「先頭N文字の切り詰め」ではなく
// 要点版ブロックを優先して渡す（preferSummaryForHandoff）。

const SUMMARY_HEADING_RE = /^\s{0,3}#{1,6}\s*.*要点版/;
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;

const KNOWN_TAGS = Object.freeze([
  '事実-一次',
  '事実-複数',
  '仮説',
  '要確認',
  '却下',
]);

// 数値照合の対象とする単位（データ値らしさの根拠になるもの）。
// 「字」「文字」（要約の字数指定）、§番号・日付・時刻は事前に除外する。
// 「案」「枠」「社」等の構造上の個数（3案・5枠・主要3社）は誤検知源になるため対象外。
const UNIT_RE = '(円|％|%|人|件|回|ヶ月|か月|ヵ月|倍|時間|分|日|週間|週|年|席|坪|km|m)';

function normalizeText(value) {
  let text = String(value == null ? '' : value);
  // 全角数字・全角記号を半角へ
  text = text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/％/g, '%').replace(/，/g, ',').replace(/．/g, '.');
  return text;
}

function stripNonDataTokens(text) {
  return String(text)
    .replace(/§\s*-?\d+(?:-\d+)?/g, ' ') // 節ID（§7-4 等）
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, ' ') // 日付
    .replace(/\d{1,2}:\d{2}/g, ' ') // 時刻
    .replace(/\d[\d,]*(?:\.\d+)?\s*(?:字|文字)/g, ' '); // 字数指定
}

function unitClass(unit) {
  const u = String(unit || '');
  if (u === '%' || u === '％') return '%';
  if (u === 'か月' || u === 'ヵ月' || u === 'ヶ月') return 'ヶ月';
  if (u === '週間') return '週';
  return u;
}

/**
 * テキストから照合対象の数値ファクトを抽出する。
 * 対象: 単位付きの数値／万・億スケール付きの数値／単位なしでも 1000 以上の数値。
 * @returns {Array<{raw: string, value: number, unit: string}>}
 */
export function collectNumericFacts(text) {
  const cleaned = stripNonDataTokens(normalizeText(text));
  const facts = [];
  const re = new RegExp('(\\d[\\d,]*(?:\\.\\d+)?)\\s*(万|億)?\\s*' + UNIT_RE + '?', 'g');
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const rawNum = match[1];
    const scale = match[2] || '';
    const unit = unitClass(match[3] || '');
    let value = parseFloat(rawNum.replace(/,/g, ''));
    if (!isFinite(value)) continue;
    if (scale === '万') value *= 10000;
    if (scale === '億') value *= 100000000;
    const hasUnit = unit !== '';
    const hasScale = scale !== '';
    if (!hasUnit && !hasScale && value < 1000) continue; // 「3案」「5枠」等の小さな裸数字は対象外
    facts.push({ raw: match[0].trim(), value, unit });
  }
  return facts;
}

export function collectTags(text) {
  const tags = new Set();
  const re = /\[(事実-一次|事実-複数|仮説|要確認|却下)\]/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) tags.add(match[1]);
  return tags;
}

/**
 * 出力テキストから「要点版」ブロック（最後に現れるもの）を抽出する。
 * ブロックは見出し行（## §N 要点版 …）から、次の見出し行または末尾まで。
 * 入力は改行 \n 正規化済みテキストを返す（offset 計算の安定のため）。
 */
export function extractSummaryBlock(text) {
  const normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (SUMMARY_HEADING_RE.test(lines[i])) headingIndex = i;
  }
  if (headingIndex < 0) {
    return { found: false, text: normalized, headingLine: '', summary: '', startIndex: -1, endIndex: -1 };
  }
  let endLine = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (ANY_HEADING_RE.test(lines[i])) { endLine = i; break; }
  }
  // 行番号 → 文字オフセット（\n 前提）
  let offset = 0;
  for (let i = 0; i < headingIndex; i += 1) offset += lines[i].length + 1;
  const startIndex = offset;
  let endOffset = startIndex + lines[headingIndex].length + 1;
  for (let i = headingIndex + 1; i < endLine; i += 1) endOffset += lines[i].length + 1;
  const endIndex = Math.min(endOffset, normalized.length);
  return {
    found: true,
    text: normalized,
    headingLine: lines[headingIndex],
    summary: lines.slice(headingIndex + 1, endLine).join('\n').trim(),
    startIndex,
    endIndex,
  };
}

/**
 * 要点版の忠実性を検査する。
 * - fabricatedNumbers: 要点版にあるが本文（sourceText）に値が存在しない数値
 * - escalatedTags: 要点版にあるが本文に存在しないタグ（例: [仮説]→[事実-一次] への格上げ）
 * 値の照合は単位に依存しない値集合で行う（レンジ・表記揺れの誤検知を避ける保守設計）。
 */
export function validateSummaryFidelity({ summaryText = '', sourceText = '' } = {}) {
  const sourceValues = new Set(collectNumericFacts(sourceText).map((f) => f.value));
  const fabricatedNumbers = [];
  const seen = new Set();
  for (const fact of collectNumericFacts(summaryText)) {
    if (sourceValues.has(fact.value)) continue;
    if (seen.has(fact.raw)) continue;
    seen.add(fact.raw);
    fabricatedNumbers.push(fact.raw);
  }
  const sourceTags = collectTags(sourceText);
  const escalatedTags = [...collectTags(summaryText)].filter((t) => !sourceTags.has(t));
  const ok = fabricatedNumbers.length === 0 && escalatedTags.length === 0;
  const parts = [];
  if (fabricatedNumbers.length) parts.push('本文に無い数値: ' + fabricatedNumbers.slice(0, 5).join(' / '));
  if (escalatedTags.length) parts.push('本文に無いタグ: ' + escalatedTags.map((t) => '[' + t + ']').join(' '));
  return {
    ok,
    fabricatedNumbers,
    escalatedTags,
    report: parts.join('　').slice(0, 220),
  };
}

/**
 * 要点版ブロックの本文を newSummary で差し替えたテキストを返す。
 * newSummary が見出し行（…要点版…）から始まっている場合は重複させず剥がす。
 */
export function replaceSummaryBlock(text, block, newSummary) {
  if (!block || !block.found) return String(text == null ? '' : text);
  const normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  let body = String(newSummary == null ? '' : newSummary).replace(/\r\n/g, '\n').trim();
  const bodyLines = body.split('\n');
  if (bodyLines.length && SUMMARY_HEADING_RE.test(bodyLines[0])) {
    body = bodyLines.slice(1).join('\n').trim();
  }
  const before = normalized.slice(0, block.startIndex);
  const after = normalized.slice(block.endIndex);
  const rebuilt = before + block.headingLine + '\n' + body + '\n' + (after.startsWith('\n') ? after.slice(1) : after);
  return rebuilt.replace(/\n{4,}/g, '\n\n\n');
}

/** 不一致が残った要点版に ⚠要確認 注記を付ける（完走優先・情報は消さない）。 */
export function applySummaryWarning({ summaryText = '', validation = null } = {}) {
  const report = (validation && validation.report) || '本文との照合に失敗しました';
  return String(summaryText).trim() + '\n\n⚠要確認（Summary Gate）: ' + report + '。本文の値と突き合わせて修正してください。';
}

/** 修復プロンプト（要点版ブロックのみを再出力させる）。 */
export function buildSummaryRepairPrompt({ headingLine = '', summaryText = '', validation = null, sourceText = '' } = {}) {
  const issues = [];
  if (validation && validation.fabricatedNumbers && validation.fabricatedNumbers.length) {
    issues.push('- 分析本文に存在しない数値が要点版に含まれています: ' + validation.fabricatedNumbers.join(' / '));
  }
  if (validation && validation.escalatedTags && validation.escalatedTags.length) {
    issues.push('- 分析本文に存在しないタグへの格上げ・付け替えがあります: ' + validation.escalatedTags.map((t) => '[' + t + ']').join(' '));
  }
  return [
    'あなたが直前に出力した「要点版」に、分析本文と一致しない記述があります。要点版ブロックだけを修正して再出力してください。',
    '',
    '【検出された問題】',
    issues.join('\n') || '- 本文との不一致',
    '',
    '【修正ルール】',
    '- 数値・固有名詞・タグは、下の分析本文から逐語コピーする（丸め・言い換え・推測での補完は禁止）',
    '- 本文に無い数値は書かない。どうしても必要な項目が本文に無い場合は「未確認」とする',
    '- 出力は見出し行「' + headingLine.trim() + '」から始め、そのブロックのみを出力する（他の章・解説は出力しない）',
    '- ブロック内に # で始まる見出しを作らない。500字以内',
    '',
    '【現在の要点版（修正対象）】',
    summaryText,
    '',
    '【分析本文（値の正）】',
    String(sourceText || '').slice(0, 8000),
  ].join('\n');
}

/**
 * ハンドオフ（蓄積コンテキスト）用のテキストを返す。
 * 要点版ブロックがあれば「見出し＋要点版」を優先し、無ければ従来どおり先頭 limit 文字。
 * 先頭切り詰めは要点版（出力末尾にある）を切り落とすため、ここで反転させる。
 */
export function preferSummaryForHandoff(text, limit = 2000) {
  const block = extractSummaryBlock(text);
  if (block.found && block.summary) {
    return (block.headingLine + '\n' + block.summary).slice(0, limit);
  }
  return String(text == null ? '' : text).slice(0, limit);
}
