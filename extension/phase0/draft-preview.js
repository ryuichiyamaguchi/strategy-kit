export const PREVIEW_STORAGE_KEY_PREFIX = 'sk_draft_preview_v012_';

function normalizeLine(line) {
  return String(line || '').replace(/\u200B/g, '').trim();
}

function parseHeading(line) {
  const markdown = line.match(/^(#{1,6})\s+(.+)$/);
  if (markdown) {
    return {
      level: markdown[1].length,
      text: normalizeLine(markdown[2]),
    };
  }

  const section = line.match(/^(§\s*[\d-]+(?:\.[\d-]+)?)[\s:：]*(.+)?$/);
  if (section) {
    return {
      level: 2,
      text: normalizeLine([section[1], section[2] || ''].join(' ')),
    };
  }

  const bracket = line.match(/^【(.+)】$/);
  if (bracket) {
    return {
      level: 2,
      text: normalizeLine(bracket[1]),
    };
  }

  return null;
}

function parseBullet(line) {
  const bullet = line.match(/^(?:[-*・●○]|(?:\d+|[a-zA-Z])[\.)])\s*(.+)$/);
  return bullet ? normalizeLine(bullet[1]) : '';
}

function createSection(heading) {
  return {
    heading,
    paragraphs: [],
    bullets: [],
    tables: [],
    framework: null,
  };
}

function isTableLine(line) {
  return /^\|.*\|$/.test(String(line || '').trim());
}

function splitTableLine(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => normalizeLine(cell.replace(/<br\s*\/?>/gi, ' / ')));
}

function isSeparatorLine(line) {
  if (!isTableLine(line)) return false;
  return splitTableLine(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTable(lines, startIndex) {
  if (!isTableLine(lines[startIndex]) || !isSeparatorLine(lines[startIndex + 1])) {
    return null;
  }
  const headers = splitTableLine(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length && isTableLine(lines[index])) {
    if (!isSeparatorLine(lines[index])) rows.push(splitTableLine(lines[index]));
    index += 1;
  }
  return {
    table: { headers, rows },
    nextIndex: index,
  };
}

function firstReadableLine(sections) {
  for (const section of sections) {
    if (section.paragraphs[0]) return section.paragraphs[0];
    if (section.bullets[0]) return section.bullets[0];
  }
  return '';
}

function sectionText(section) {
  return [
    section.heading,
    ...section.paragraphs,
    ...section.bullets,
    ...section.tables.flatMap((table) => [
      ...table.headers,
      ...table.rows.flat(),
    ]),
  ].join('\n');
}

function findTableByHeader(section, pattern) {
  return section.tables.find((table) => table.headers.some((header) => pattern.test(header))) || null;
}

function rowByFirstCell(table, pattern) {
  return table?.rows.find((row) => pattern.test(row[0] || '')) || null;
}

function detectSwot(section) {
  const text = sectionText(section);
  if (!/SWOT/i.test(text) || /クロス\s*SWOT/i.test(section.heading)) return null;
  const table = section.tables[0];
  const plus = rowByFirstCell(table, /プラス|plus/i);
  const minus = rowByFirstCell(table, /マイナス|minus/i);
  return {
    type: 'swot',
    quadrants: {
      strengths: plus?.[1] || '',
      opportunities: plus?.[2] || '',
      weaknesses: minus?.[1] || '',
      threats: minus?.[2] || '',
    },
  };
}

function detectCrossSwot(section) {
  const text = sectionText(section);
  if (!/クロス\s*SWOT|(?:^|[\s|（(])(?:SO|WO|ST|WT)[）):：\s|]/i.test(text)) return null;
  const table = findTableByHeader(section, /区分|一手|採用判定/);
  const actions = (table?.rows || [])
    .filter((row) => /^(SO|WO|ST|WT)/i.test(row[0] || ''))
    .map((row) => ({
      name: row[0] || '',
      action: row[1] || '',
      verdict: row[row.length - 1] || '',
    }));
  return { type: 'cross-swot', actions };
}

function detectFiveForces(section) {
  const text = sectionText(section);
  if (!/5\s*Forces|5フォース|ファイブフォース/i.test(text)) return null;
  const table = findTableByHeader(section, /要素|強度|force/i);
  const forces = (table?.rows || [])
    .filter((row) => row[0])
    .map((row) => ({
      name: row[0] || '',
      detail: row[1] || '',
      strength: row[2] || '',
    }));
  return { type: 'five-forces', forces };
}

function detectCross3c(section) {
  const text = sectionText(section);
  if (!/クロス\s*3C|cross\s*3c/i.test(text)) return null;
  const table = findTableByHeader(section, /重なり|該当|解釈/);
  const overlaps = (table?.rows || [])
    .filter((row) => row[0])
    .map((row) => ({
      name: row[0] || '',
      detail: row[1] || '',
      interpretation: row[2] || '',
    }));
  return { type: 'cross-3c', overlaps };
}

function detectThreeC(section) {
  if (/クロス\s*3C/i.test(sectionText(section))) return null;
  const table = section.tables[0];
  const rows = table?.rows || [];
  const has3cHeading = /(^|\s)3C|Customer\s*\/\s*Competitor\s*\/\s*Company/i.test(section.heading);
  const hasCustomer = rows.some((row) => /Customer|顧客/i.test(row[0] || ''));
  const hasCompetitor = rows.some((row) => /Competitor|競合/i.test(row[0] || ''));
  const hasCompany = rows.some((row) => /Company|自社/i.test(row[0] || ''));
  if (!has3cHeading && !(hasCustomer && hasCompetitor && hasCompany)) return null;
  const find = (pattern) => {
    const row = rows.find((item) => pattern.test(item[0] || item.join(' ')));
    return row ? row.slice(1).filter(Boolean).join(' / ') || row.join(' / ') : '';
  };
  return {
    type: 'three-c',
    cards: [
      { name: 'Customer', label: '顧客', detail: find(/Customer|顧客/i) },
      { name: 'Competitor', label: '競合', detail: find(/Competitor|競合/i) },
      { name: 'Company', label: '自社', detail: find(/Company|自社/i) },
    ],
  };
}

function detectUnitEconomics(section) {
  const text = sectionText(section);
  if (!/ユニットエコノミクス|CAC|LTV|Payback|CPA|粗利率/i.test(text)) return null;
  const metricNames = ['CAC', 'LTV', 'Payback', 'CPA', '粗利率', '顧客単価'];
  const metrics = metricNames
    .map((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = text.match(new RegExp(`${escaped}[^\\n/|:：]*[:：]?\\s*([^\\n/|]+)`, 'i'));
      return match ? { label, value: normalizeLine(match[1]) } : null;
    })
    .filter(Boolean);
  return { type: 'unit-economics', metrics };
}

function detectFramework(section) {
  return (
    detectCross3c(section) ||
    detectCrossSwot(section) ||
    detectFiveForces(section) ||
    detectSwot(section) ||
    detectUnitEconomics(section) ||
    detectThreeC(section) ||
    null
  );
}

export function buildDraftPreviewModel({
  title = 'STRATEGY-KIT DRAFT',
  text = '',
  kind = 'cleanup',
} = {}) {
  const safeTitle = normalizeLine(title) || 'STRATEGY-KIT DRAFT';
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);
  const sections = [];
  let current = null;
  let displayTitle = safeTitle.replace(/^\[(?:CLEAN|SUMMARY)\]\s*/i, '').trim() || safeTitle;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = parseHeading(line);
    if (heading) {
      if (!sections.length && heading.level === 1) {
        displayTitle = heading.text;
      }
      current = createSection(heading.text);
      sections.push(current);
      continue;
    }

    if (!current) {
      current = createSection('概要');
      sections.push(current);
    }

    const parsedTable = parseTable(lines, i);
    if (parsedTable) {
      current.tables.push(parsedTable.table);
      i = parsedTable.nextIndex - 1;
      continue;
    }

    const bullet = parseBullet(line);
    if (bullet) {
      current.bullets.push(bullet);
    } else {
      current.paragraphs.push(line);
    }
  }

  if (!sections.length) {
    sections.push(createSection('概要'));
  }

  sections.forEach((section) => {
    section.framework = detectFramework(section);
  });

  const summary = firstReadableLine(sections);

  return {
    title: safeTitle,
    displayTitle,
    kind,
    kindLabel: kind === 'summary' ? 'Executive Summary' : 'DRAFTクリーン版',
    summary,
    sections,
    charCount: String(text || '').length,
  };
}

export function buildDraftPreviewRecord({
  title,
  text,
  kind = 'cleanup',
  sourceDocUrl = '',
  now = () => new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    createdAt: now(),
    sourceDocUrl: String(sourceDocUrl || ''),
    model: buildDraftPreviewModel({ title, text, kind }),
  };
}

export function buildDraftPreviewId({
  now = () => new Date().toISOString(),
  random = Math.random,
} = {}) {
  const stamp = String(now()).replace(/[:.]/g, '-');
  const suffix = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `${stamp}-${suffix}`;
}
