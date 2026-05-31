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

export function buildUnitEconomicsRepairPrompt({
  originalPrompt = '',
  outputText = '',
  validation = { missing: [] },
  sectionLabel = 'ユニットエコノミクス',
} = {}) {
  const missing = (validation.missing || []).map((item) => `- ${item}`).join('\n');
  return [
    `Finance Gate 不合格です。以下の不足を修正し、${sectionLabel}だけを全文で書き直してください。`,
    '',
    '【不足項目】',
    missing || '- 不足項目を再確認してください',
    '',
    '【必須条件】',
    '- Quick Win 1 / Quick Win 2 / 地道 をすべて出す（旧表記の Quick Win 3 は地道として扱う）',
    '- 各短期枠に 投下予算 / CAC / 想定獲得人数 / LTV / Payback / 月間黒字化ライン / 採否判定 を必ず数値入りで出す',
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
