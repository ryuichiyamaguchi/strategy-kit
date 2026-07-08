export const FINANCE_GATE_PROMPT_ID = 'phase-7-unit-economics';
export const FINANCE_GATE_RECOMMENDED_MODEL = 'gemini-3.1-pro-preview';

const DEFERRAL_PATTERN = /詳細な試算数値.*PDCA|PDCA.*更新|測定結果に基づき.*アップデート|後日.*更新|後で.*確認/;
const PLACEHOLDER_PATTERN = /[◯〇○]|空欄|未設定|N\/A|TBD/i;

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
  const isGo = /\bgo\b|採用|ＧＯ|GO/i.test(text) && !isNoGo;
  return {
    raw: String(cell || '').trim(),
    isNoGo,
    isConditional,
    isGo,
    plainGo: isGo && !isConditional,
    known: isNoGo || isGo || isConditional,
  };
}

// 要約表（| 指標 | Quick Win 1 | … | の形式）を抽出し、列=枠 / 行=指標 のマップにする。
export function parseUnitEconomicsSummary(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tableRows = [];
  let headerCols = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (headerCols && tableRows.length) break; // 表が途切れたら終了
      continue;
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 区切り行
    const first = cells[0] || '';
    if (!headerCols) {
      if (/指標/.test(first)) {
        headerCols = cells.slice(1).filter(Boolean);
      }
      continue;
    }
    tableRows.push(cells);
  }
  if (!headerCols || !headerCols.length) return { found: false, slots: [] };

  const norm = (s) => String(s || '').replace(/\s/g, '');
  // 長いラベルを優先（"LTV_CAC比(粗利)" が "CAC" に食われないよう完全一致→前方一致の順で照合）。
  const labelsByLen = UNIT_ECONOMICS_SUMMARY_LABELS.slice().sort((a, b) => norm(b).length - norm(a).length);
  const rowByLabel = new Map();
  for (const cells of tableRows) {
    const rl = norm(cells[0]);
    const matched =
      UNIT_ECONOMICS_SUMMARY_LABELS.find((l) => rl === norm(l)) ||
      labelsByLen.find((l) => rl.startsWith(norm(l)));
    if (matched && !rowByLabel.has(matched)) rowByLabel.set(matched, cells.slice(1));
  }
  if (!rowByLabel.has('採否判定') || !rowByLabel.has('投下予算')) {
    return { found: false, slots: [] };
  }

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
    // 欠損／プレースホルダ検出
    for (const label of NUMERIC_SUMMARY_LABELS) {
      const r = parseRange(m[label]);
      range[label] = r;
      if (!r) violations.push(`${name}: ${label} が数値で埋まっていません（◯・空欄・要確認のままにしない）`);
    }
    const verdict = classifyVerdict(m['採否判定']);
    if (!verdict.known) {
      violations.push(`${name}: 採否判定が GO / 条件付GO / NO-GO のいずれでもありません`);
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

// 記入漏れ（presence）と算術整合（arithmetic）を束ねた総合検証。
// automation.js の Finance Gate はこれを使う。
export function validateUnitEconomics(text, options = {}) {
  const presence = validateUnitEconomicsOutput(text, options);
  const arithmetic = validateUnitEconomicsArithmetic(text, options);
  const missing = presence.missing || [];
  const violations = arithmetic.violations || [];
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
    '',
    '【不足項目（記入漏れ）】',
    missing || '- なし',
    '',
    '【数値矛盾（算術整合違反）】',
    violations || '- なし',
    '',
    '【必須条件】',
    '- Quick Win 1 / Quick Win 2 / 地道 をすべて出す（旧表記の Quick Win 3 は地道として扱う）',
    '- 各短期枠に 投下予算 / CAC / 想定獲得人数 / 売上LTV / 粗利LTV / Payback / 損益分岐 / 採否判定 を必ず数値入りで出す',
    '- ラベル固定の「ユニットエコノミクス要約表」を必ず出力する（ラベル文字列は変更しない）',
    '- 想定獲得人数 = 投下予算 ÷ CAC（手入力で書き換えない）／ 粗利LTV = 売上LTV × 粗利率',
    '- 採否は「粗利LTV/CAC ≥ 3」かつ「Payback ≤ 12ヶ月」で GO。満たさなければ 条件付GO / NO-GO にする',
    '- 空欄、◯円、後で確認、PDCAで更新、測定後に更新、という先送りは禁止',
    '- 実測がない項目は、元プロンプトの業種別ベンチマーク low/mid/high から [仮説] として仮置きする',
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
  const warningLines = [
    '⚠ 要確認: Finance Gate 警告',
    '以下の数値項目が不足しています。全自動は完走優先で続行しました。後でこの章を確認してください。',
    ...(missing.length
      ? missing.map((item) => `- ${item}`)
      : ['- 不足項目を再確認してください']),
    '',
    '---',
    '',
  ];
  return warningLines.join('\n') + String(bodyText || '').trim();
}
