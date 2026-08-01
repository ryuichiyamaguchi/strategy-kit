export const FINANCE_GATE_PROMPT_ID = 'phase-7-unit-economics';
export const FINANCE_GATE_RECOMMENDED_MODEL = 'gemini-3.6-flash';

const DEFERRAL_PATTERN = /詳細な試算数値.*PDCA|PDCA.*更新|測定結果に基づき.*アップデート|後日.*更新|後で.*確認/;
const PLACEHOLDER_PATTERN = /[◯〇○]|空欄|未設定|N\/A|TBD/i;
const EXPLICIT_UNKNOWN_PATTERN = /\bunknown\b|不明|未取得|要確認|測定前|データなし/i;

const REQUIRED_METRICS = [
  {
    label: '投下予算',
    aliases: ['投下予算', '月予算', '予算'],
    units: ['円', '¥'],
  },
  {
    label: 'CAC',
    aliases: ['CAC', '業界平均CAC'],
    units: ['円', '¥'],
  },
  {
    label: '想定獲得人数',
    aliases: ['想定獲得人数', '獲得人数'],
    units: ['人', '件'],
  },
  {
    label: 'LTV',
    aliases: ['LTV'],
    units: ['円', '¥'],
  },
  {
    label: 'Payback',
    aliases: ['Payback', 'Payback月数', '回収期間'],
    units: ['ヶ月', 'か月', '月'],
  },
  {
    label: '月間黒字化ライン',
    aliases: ['月間黒字化ライン', '黒字化ライン'],
    units: ['人', '件'],
  },
];

const DEFAULT_REQUIRED_SLOTS = [
  {
    label: 'Quick Win 1',
    patterns: [/(?:quick\s*win|qw)\s*1\b/i, /クイックウィン\s*1/],
  },
  {
    label: 'Quick Win 2',
    patterns: [/(?:quick\s*win|qw)\s*2\b/i, /クイックウィン\s*2/],
  },
  {
    label: '地道',
    patterns: [/地道/, /steady/i, /(?:quick\s*win|qw)\s*3\b/i, /クイックウィン\s*3/],
  },
];

function normalizeDigits(text) {
  return String(text || '').replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function hasNumber(text) {
  return /[0-9][0-9,，.\s]*(?:[-~〜～][0-9][0-9,，.\s]*)?/.test(normalizeDigits(text));
}

function lineHasUsableNumber(line, units) {
  const text = String(line || '');
  if (PLACEHOLDER_PATTERN.test(text)) return false;
  if (!hasNumber(text)) return false;
  return units.some((unit) => text.includes(unit));
}

function includesAlias(line, alias) {
  return String(line || '').toLowerCase().includes(alias.toLowerCase());
}

function findMetricLine(lines, aliases) {
  return lines.find((line) => aliases.some((alias) => includesAlias(line, alias))) || '';
}

function headingMatchesSlot(heading, slot) {
  const normalized = normalizeDigits(heading || '');
  return (slot.patterns || []).some((pattern) => pattern.test(normalized));
}

function buildQuickWinSlots(expectedQuickWins) {
  const count = Number.isFinite(expectedQuickWins) ? expectedQuickWins : 3;
  return Array.from({ length: count }, (_, index) => {
    const no = index + 1;
    return {
      label: `Quick Win ${no}`,
      patterns: [
        new RegExp(`(?:quick\\s*win|qw)\\s*${no}\\b`, 'i'),
        new RegExp(`クイックウィン\\s*${no}`),
      ],
    };
  });
}

function getRequiredSlots(options = {}) {
  if (Array.isArray(options.slots) && options.slots.length) return options.slots;
  if (Number.isFinite(options.expectedQuickWins)) return buildQuickWinSlots(options.expectedQuickWins);
  return DEFAULT_REQUIRED_SLOTS;
}

function findSlotSections(text, slots) {
  const source = String(text || '');
  const pattern = /^#{1,6}\s*([^\n]+)$/gm;
  const matches = [...source.matchAll(pattern)];
  const sections = new Map();

  matches.forEach((match, index) => {
    const heading = match[1] || '';
    const slot = slots.find((item) => headingMatchesSlot(heading, item));
    if (!slot || sections.has(slot.label)) return;
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    sections.set(slot.label, source.slice(start, end).trim());
  });

  slots.forEach((slot) => {
    if (!sections.has(slot.label)) sections.set(slot.label, '');
  });
  return sections;
}

function validateSlot(label, section) {
  const missing = [];
  if (!section) {
    return [`${label}: セクションがありません`];
  }
  if (DEFERRAL_PATTERN.test(section)) {
    missing.push(`${label}: 数値試算の先送り文を削除してください`);
  }

  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  REQUIRED_METRICS.forEach((metric) => {
    const line = findMetricLine(lines, metric.aliases);
    if (!lineHasUsableNumber(line, metric.units)) {
      missing.push(`${label}: ${metric.label} の数値レンジがありません`);
    }
  });

  if (!/(採否判定|GO|NO-GO|条件付GO|採用|却下)/i.test(section)) {
    missing.push(`${label}: ファイナンス観点の採否判定がありません`);
  }

  return missing;
}

export function isFinanceGatePrompt(prompt) {
  return prompt?.id === FINANCE_GATE_PROMPT_ID;
}

export function validateUnitEconomicsOutput(text, options = {}) {
  const source = String(text || '');
  const missing = [];
  const slots = getRequiredSlots(options);

  if (DEFERRAL_PATTERN.test(source)) {
    missing.push('全体: 数値試算の先送り文があります');
  }

  const sections = findSlotSections(source, slots);
  slots.forEach((slot) => {
    missing.push(...validateSlot(slot.label, sections.get(slot.label)));
  });

  return {
    ok: missing.length === 0,
    missing,
  };
}

// ---------------------------------------------------------------------------
// 算術整合検証（F4/G1）: §7-4 出力の「ユニットエコノミクス要約表」を機械パースし、
// 記入漏れだけでなく「数字どうしの矛盾」を検出する。
//   ① 想定獲得人数 ≈ 投下予算 ÷ CAC（3=1÷2 の手入力書き換え検出。レンジは許容幅つき）
//   ② 粗利LTV ≤ 売上LTV（粗利率の掛け忘れ検出）
//   ③ LTV_CAC比(粗利) ≈ 粗利LTV ÷ CAC
//   ④ 粗利LTV/CAC < 3 なのに GO / Payback が NO-GO 閾値超なのに GO（誤 GO 検出）
// これらの「ラベル文字列」は Finance Gate と図解カードの双方が参照する契約であり、
// 変更してはならない（安定文字列）。
export const UNIT_ECONOMICS_SUMMARY_LABELS = [
  '投下予算',
  'CAC',
  '想定獲得人数',
  '売上LTV',
  '粗利LTV',
  'LTV_CAC比(粗利)',
  'Payback月数',
  '損益分岐',
  '採否判定',
];

const ARITHMETIC_DEFAULTS = {
  minGrossLtvCac: 3, // 粗利LTV/CAC の採用最低倍率
  goPaybackMonths: 12, // これ以下なら無条件 GO 可
  noGoPaybackMonths: 18, // これを超えたら NO-GO
  tolerance: 0.25, // レンジ整合の許容幅（±25%）
};

// 要約表が持つべき短期枠の下限。プロンプト（phase-7-unit-economics）は
// 「短期3枠（Quick Win 1 / Quick Win 2 / 地道）」を必須とし要約表テンプレートも 3列固定なので 3。
// 存在する枠だけ算術検査すると 1列表でも 9行が合えば通ってしまう穴を塞ぐ（DoD2「9ラベル×3枠」）。
const DEFAULT_MIN_SUMMARY_SLOTS = 3;

const NUMERIC_SUMMARY_LABELS = [
  '投下予算',
  'CAC',
  '想定獲得人数',
  '売上LTV',
  '粗利LTV',
  'LTV_CAC比(粗利)',
  'Payback月数',
  '損益分岐',
];

function numbersIn(text) {
  const cleaned = normalizeDigits(text || '').replace(/[,，]/g, '');
  const matches = cleaned.match(/\d+(?:\.\d+)?/g);
  return matches ? matches.map(Number).filter((n) => Number.isFinite(n)) : [];
}

function parseRange(cell) {
  if (PLACEHOLDER_PATTERN.test(String(cell || ''))) return null;
  const nums = numbersIn(cell);
  if (!nums.length) return null;
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

function classifyVerdict(cell) {
  const text = normalizeDigits(cell || '');
  const isNoGo = /no-?go|却下|不採用/i.test(text);
  const isConditional = /条件付/.test(text);
  const isHold = /判定保留|保留|pending|unknown/i.test(text);
  const isGo = /\bgo\b|採用|ＧＯ|GO/i.test(text) && !isNoGo;
  return {
    raw: String(cell || '').trim(),
    isNoGo,
    isConditional,
    isHold,
    isGo,
    plainGo: isGo && !isConditional,
    known: isNoGo || isGo || isConditional || isHold,
  };
}

// 要約表（| 指標 | Quick Win 1 | … | の形式）を抽出し、列=枠 / 行=指標 のマップにする。
// ヘッダ検出は堅牢化してある（A1 対策）:
//   - 先頭セルが「指標」または「項目」（項目名 等の前方一致も含む）ならヘッダ行とみなす。
//   - 明示ヘッダが無くても、ブロック内に既知ラベルが 2 つ以上並ぶ表なら先頭行をヘッダにフォールバック。
// いずれも「先頭セルの語」を検出キーにしているだけで、9固定ラベル契約（行ラベル）は不変。
export function parseUnitEconomicsSummary(text) {
  const lines = String(text || '').split(/\r?\n/);
  // 連続する表行を1ブロックにまとめる（区切り行 |---| は捨てるがブロックは分断しない）。
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (current && current.length) { blocks.push(current); current = null; }
      continue;
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 区切り行
    if (!current) current = [];
    current.push(cells);
  }
  if (current && current.length) blocks.push(current);

  const norm = (s) => String(s || '').replace(/\s/g, '');
  const HEADER_FIRST = /指標|項目/;
  // 長いラベルを優先（"LTV_CAC比(粗利)" が "CAC" に食われないよう完全一致→前方一致の順で照合）。
  const labelsByLen = UNIT_ECONOMICS_SUMMARY_LABELS.slice().sort((a, b) => norm(b).length - norm(a).length);
  const matchLabel = (cell) => {
    const rl = norm(cell);
    return (
      UNIT_ECONOMICS_SUMMARY_LABELS.find((l) => rl === norm(l)) ||
      labelsByLen.find((l) => rl.startsWith(norm(l))) ||
      null
    );
  };

  // 要約表とみなせる最初のブロックを採用する。
  for (const rows of blocks) {
    let headerIndex = rows.findIndex((cells) => HEADER_FIRST.test(cells[0] || ''));
    if (headerIndex === -1) {
      // フォールバック: 既知ラベルが 2 つ以上並ぶブロックは先頭行をヘッダ扱いにする。
      const knownLabelCount = rows.filter((cells) => matchLabel(cells[0])).length;
      if (knownLabelCount >= 2) headerIndex = 0;
      else continue;
    }
    const headerCols = rows[headerIndex].slice(1).filter(Boolean);
    if (!headerCols.length) continue;

    const rowByLabel = new Map();
    for (const cells of rows.slice(headerIndex + 1)) {
      const matched = matchLabel(cells[0]);
      if (matched && !rowByLabel.has(matched)) rowByLabel.set(matched, cells.slice(1));
    }
    if (!rowByLabel.has('採否判定') || !rowByLabel.has('投下予算')) continue;

    const slots = headerCols.map((name, j) => {
      const metrics = {};
      for (const label of UNIT_ECONOMICS_SUMMARY_LABELS) {
        const row = rowByLabel.get(label);
        metrics[label] = row ? (row[j] || '') : '';
      }
      return { name, metrics };
    });
    return { found: true, slots };
  }
  return { found: false, slots: [] };
}

function rangesOverlap(a, b, tolerance) {
  if (!a || !b) return false;
  const lo = b.low * (1 - tolerance);
  const hi = b.high * (1 + tolerance);
  return a.high >= lo && a.low <= hi;
}

export function validateUnitEconomicsArithmetic(text, options = {}) {
  const cfg = Object.assign({}, ARITHMETIC_DEFAULTS, options.arithmetic || {});
  const violations = [];
  const parsed = parseUnitEconomicsSummary(text);
  if (!parsed.found) {
    return {
      ok: false,
      violations: ['要約表: 機械可読の「ユニットエコノミクス要約表」が見つかりません（ラベル固定の表を必ず出力してください）'],
    };
  }

  for (const slot of parsed.slots) {
    const name = slot.name || '枠';
    const m = slot.metrics;
    const range = {};
    const explicitUnknowns = [];
    // 欠損／プレースホルダ検出
    for (const label of NUMERIC_SUMMARY_LABELS) {
      const cell = String(m[label] || '');
      const explicitlyUnknown = EXPLICIT_UNKNOWN_PATTERN.test(cell) && !hasNumber(cell);
      const r = parseRange(cell);
      range[label] = r;
      if (explicitlyUnknown) {
        explicitUnknowns.push(label);
      } else if (!r) {
        violations.push(`${name}: ${label} が数値または明示的な unknown で埋まっていません（◯・空欄・TBDのままにしない）`);
      }
    }
    const verdict = classifyVerdict(m['採否判定']);
    if (!verdict.known) {
      violations.push(`${name}: 採否判定が GO / 条件付GO / NO-GO / 判定保留 のいずれでもありません`);
    }
    if (explicitUnknowns.length && !verdict.isHold) {
      violations.push(`${name}: ${explicitUnknowns.join('・')} が unknown のため、採否は「判定保留」にしてください`);
    }

    const budget = range['投下予算'];
    const cac = range['CAC'];
    const acq = range['想定獲得人数'];
    const revLtv = range['売上LTV'];
    const grossLtv = range['粗利LTV'];
    const ratio = range['LTV_CAC比(粗利)'];
    const payback = range['Payback月数'];

    // ① 想定獲得人数 ≈ 予算 ÷ CAC
    if (budget && cac && acq && cac.low > 0 && cac.high > 0) {
      const expected = { low: budget.low / cac.high, high: budget.high / cac.low };
      if (!rangesOverlap(acq, expected, cfg.tolerance)) {
        violations.push(
          `${name}: 想定獲得人数 ${fmt(acq)}人 が 予算÷CAC の計算値 ${fmt(expected)}人 と一致しません（3=1÷2 を手入力で書き換えた疑い）`
        );
      }
    }

    // ② 粗利LTV ≤ 売上LTV
    if (revLtv && grossLtv && grossLtv.low > revLtv.high * (1 + cfg.tolerance)) {
      violations.push(`${name}: 粗利LTV(${fmt(grossLtv)}) が売上LTV(${fmt(revLtv)}) を上回っています（粗利率の掛け忘れ）`);
    }

    // ③ LTV_CAC比(粗利) ≈ 粗利LTV ÷ CAC
    let computedRatio = null;
    if (grossLtv && cac && cac.low > 0 && cac.high > 0) {
      computedRatio = { low: grossLtv.low / cac.high, high: grossLtv.high / cac.low };
      if (ratio && !rangesOverlap(ratio, computedRatio, cfg.tolerance)) {
        violations.push(
          `${name}: LTV_CAC比(粗利) ${fmt(ratio)}倍 が 粗利LTV÷CAC の計算値 ${fmt(computedRatio)}倍 と一致しません`
        );
      }
    }

    // ④a 粗利LTV/CAC と採否の矛盾。レンジは不利側（下限）で判定する —
    // 楽観側（上限）で判定すると「2-20倍でGO」のような誤GOが通ってしまう。
    // 表記値を優先し、無ければ 粗利LTV÷CAC の計算レンジで判定。
    const ratioRange = ratio || computedRatio;
    if (ratioRange && verdict.isGo) {
      if (ratioRange.high < cfg.minGrossLtvCac) {
        violations.push(
          `${name}: 粗利LTV/CAC が最良ケースでも${cfg.minGrossLtvCac}倍未満（${fmt(ratioRange)}倍）なのに「${verdict.raw}」判定です`
        );
      } else if (ratioRange.low < cfg.minGrossLtvCac && verdict.plainGo) {
        violations.push(
          `${name}: 粗利LTV/CAC の下限が${cfg.minGrossLtvCac}倍未満（${fmt(ratioRange)}倍）なのに無条件GO（前提を絞るか 条件付GO にすべき）`
        );
      }
    }

    // ④b Payback 閾値と採否の矛盾。レンジは不利側（上限）で判定する。
    if (payback && verdict.isGo) {
      if (payback.low > cfg.noGoPaybackMonths) {
        violations.push(
          `${name}: Payback ${fmt(payback)}ヶ月 は最良ケースでも NO-GO 閾値(${cfg.noGoPaybackMonths}ヶ月)超なのに「${verdict.raw}」判定です`
        );
      } else if (payback.high > cfg.noGoPaybackMonths && verdict.plainGo) {
        violations.push(
          `${name}: Payback 上限 ${fmt(payback)}ヶ月 が NO-GO 閾値(${cfg.noGoPaybackMonths}ヶ月)を超えるのに無条件GO（前提を絞るか 条件付GO にすべき）`
        );
      } else if (payback.high > cfg.goPaybackMonths && verdict.plainGo) {
        violations.push(
          `${name}: Payback ${fmt(payback)}ヶ月 は${cfg.goPaybackMonths}ヶ月超なのに無条件GO（条件付GO / NO-GO にすべき）`
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function fmt(range) {
  if (!range) return '—';
  const round = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  return range.low === range.high ? String(round(range.low)) : `${round(range.low)}-${round(range.high)}`;
}

// 総合検証（automation.js の Finance Gate はこれを使う）。表基準（機械可読の「ユニットエコノミクス
// 要約表」= 9固定ラベル）を単一の真実源にする。合否（ok）の材料は次の3つだけ:
//   1. arithmetic（9ラベル×各枠の数値有無・採否・算術一致）
//   2. 列(枠)契約 — 短期3枠（Quick Win 1 / Quick Win 2 / 地道）が揃っているか
//   3. 全体の先送り文（DEFERRAL）検出
//
// 返り値の振り分け（repair プロンプト / 安全網の注記の質を上げるため）:
//   - missing（記入漏れ）… 空セル指摘「◯が数値で埋まっていません」＋ 全体 DEFERRAL ＋ 欠落枠
//   - violations（数値矛盾）… 上記以外の算術整合違反（獲得人数=予算÷CAC 不一致・誤GO 等）
//
// 旧 prose-presence（validateUnitEconomicsOutput の枠内メトリクス検査）は返り値からも外す。理由:
// プロンプトが枠本文を `### 入力` サブ見出しの下に置くため findSlotSections がスロットを切り詰め、
// プロンプト完全準拠の出力ですら偽の「◯の数値レンジがありません／セクションがありません」を大量に生む。
// これを repair/warning に流すと修復の注意を削り、安全網の本文注記を誤らせるため排除する。
export function validateUnitEconomics(text, options = {}) {
  const source = String(text || '');
  const arithmetic = validateUnitEconomicsArithmetic(source, options);
  const allViolations = arithmetic.violations || [];

  const isEmptyCell = (v) => v.indexOf('数値で埋まっていません') !== -1;
  const missing = [];
  const violations = [];
  if (DEFERRAL_PATTERN.test(source)) {
    missing.push('全体: 数値試算の先送り文があります');
  }
  for (const v of allViolations) {
    (isEmptyCell(v) ? missing : violations).push(v);
  }

  // 列(枠)契約: 存在する枠だけ検査すると 1列表でも 9行が合えば通ってしまうので、枠数の下限を課す。
  const minSlots = Number.isFinite(options.minSlots) ? options.minSlots : DEFAULT_MIN_SUMMARY_SLOTS;
  const parsed = parseUnitEconomicsSummary(source);
  if (parsed.found && parsed.slots.length < minSlots) {
    const names = parsed.slots.map((s) => s.name).filter(Boolean).join(' / ') || '（なし）';
    missing.push(
      `要約表: 短期${minSlots}枠（Quick Win 1 / Quick Win 2 / 地道）が必要ですが ${parsed.slots.length} 枠しかありません（検出: ${names}／欠落した枠を数値入りで追加してください）`
    );
  }

  return {
    ok: missing.length === 0 && violations.length === 0,
    missing,
    violations,
  };
}

export function buildUnitEconomicsRepairPrompt({
  originalPrompt = '',
  outputText = '',
  validation = { missing: [] },
  sectionLabel = 'ユニットエコノミクス',
} = {}) {
  const missing = (validation.missing || []).map((item) => `- ${item}`).join('\n');
  const violations = (validation.violations || []).map((item) => `- ${item}`).join('\n');
  return [
    `Finance Gate 不合格です。以下の不足・数値矛盾を修正し、${sectionLabel}だけを全文で書き直してください。`,
    '下記は自動検査が検出した未解決項目です。ここが埋まる／整合するまで直してください（特に【数値矛盾】は電卓で計算し直してから要約表へ転記）。',
    '',
    '【不足項目（記入漏れ・未解決）】',
    missing || '- なし',
    '',
    '【数値矛盾（算術整合違反・未解決）】',
    violations || '- なし',
    '',
    '【要約表の構造例（数値は説明用であり、自案件へ転記禁止）】',
    '| 指標 | Quick Win 1 | Quick Win 2 | 地道 |',
    '|---|---|---|---|',
    '| 投下予算 | 100,000-200,000円 | 80,000-150,000円 | 30,000-60,000円 |',
    '| CAC | 8,000-12,000円 | 6,000-10,000円 | 3,000-6,000円 |',
    '| 想定獲得人数 | 8-25人 | 8-25人 | 5-20人 |',
    '| 売上LTV | 200,000-300,000円 | 180,000-260,000円 | 150,000-220,000円 |',
    '| 粗利LTV | 80,000-120,000円 | 72,000-104,000円 | 60,000-88,000円 |',
    '| LTV_CAC比(粗利) | 7-15倍 | 7-17倍 | 10-29倍 |',
    '| Payback月数 | 1-3ヶ月 | 1-3ヶ月 | 1-2ヶ月 |',
    '| 損益分岐 | 20-30人 | 20-30人 | 15-25人 |',
    '| 採否判定 | 判定保留 | 判定保留 | 判定保留 |',
    '※ ヘッダと9行の構造だけを使う。数値が取得できないセルは `unknown [不明]` とし、その列の採否を「判定保留」にする。サンプル数値を転記しない。',
    '',
    '【必須条件】',
    '- Quick Win 1 / Quick Win 2 / 地道 をすべて出す（旧表記の Quick Win 3 は地道として扱う）',
    '- 各短期枠に 投下予算 / CAC / 想定獲得人数 / 売上LTV / 粗利LTV / Payback / 損益分岐 / 採否判定 を出す。取得済みの値は数値、未取得は `unknown [不明]`',
    '- ラベル固定の「ユニットエコノミクス要約表」を必ず出力する（ラベル文字列は変更しない）',
    '- 想定獲得人数 = 投下予算 ÷ CAC（手入力で書き換えない）／ 粗利LTV = 売上LTV × 粗利率',
    '- 採否は「粗利LTV/CAC ≥ 3」かつ「Payback ≤ 12ヶ月」で GO。満たさなければ 条件付GO / NO-GO にする',
    '- 空欄、◯円、TBDは禁止。不明なら理由付きの `unknown [不明]` とし、必要な計測と判定条件を書く',
    '- 実測がない項目は、業種別ベンチマークの適用条件と出典を確認できる場合だけ [仮説] レンジに使う。確認できなければ unknown',
    '- 出力はMarkdownのみ。HTMLは出さない',
    '',
    `【元の${sectionLabel}プロンプト】`,
    originalPrompt,
    '',
    '【前回の不合格出力】',
    outputText,
  ].join('\n');
}

export function appendUnitEconomicsWarning({
  bodyText = '',
  validation = { missing: [] },
} = {}) {
  const missing = Array.isArray(validation.missing) ? validation.missing : [];
  const violations = Array.isArray(validation.violations) ? validation.violations : [];
  const warningLines = [
    '⚠ 要確認: Finance Gate 警告',
    '以下の項目が自動検査で未解決のまま、全自動は完走を優先して続行しました。曖昧な数字を確定させるため、後でこの章を確認してください。',
  ];
  if (missing.length) {
    warningLines.push('【記入漏れ】', ...missing.map((item) => `- ${item}`));
  }
  if (violations.length) {
    warningLines.push('【数値矛盾（算術整合違反）】', ...violations.map((item) => `- ${item}`));
  }
  if (!missing.length && !violations.length) {
    warningLines.push('- 不足項目を再確認してください');
  }
  warningLines.push('', '---', '');
  return warningLines.join('\n') + String(bodyText || '').trim();
}
