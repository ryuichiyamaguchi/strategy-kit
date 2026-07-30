import {
  computeEndIndex,
  getTextInRange,
} from './docs-sections.js';

const SECTION_MARKER_RE = /\[\[SK-SECTION:§(-?\d+(?:-\d+)?)\]\]/g;
const STATUS_MARKER_RE = /\[\[SK-STATUS:§(-?\d+(?:-\d+)?)([^\]]*)\]\]/g;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9_-]*)=("[^"]*"|'[^']*'|[^\s\]]+)/g;
const VALID_STATUSES = new Set(['done', 'failed', 'todo', 'partial']);
const DEFAULT_DONE_CHAR_COUNT = 80;

export function normalizeSectionKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  const text = String(value || '').trim();
  if (!text) return '';

  const markerMatch = text.match(/\[\[SK-(?:SECTION|STATUS):§(-?\d+(?:-\d+)?)/);
  if (markerMatch) return markerMatch[1];

  const bareMatch = text.match(/^§?(-?\d+(?:-\d+)?)$/);
  if (bareMatch) return bareMatch[1];

  return '';
}

export function parseStatusMarker(text) {
  const source = String(text || '');
  const match = source.match(/\[\[SK-STATUS:§(-?\d+(?:-\d+)?)([^\]]*)\]\]/);
  if (!match) return null;

  const attrs = {};
  let attrMatch;
  ATTR_RE.lastIndex = 0;
  while ((attrMatch = ATTR_RE.exec(match[2] || '')) !== null) {
    attrs[attrMatch[1]] = stripAttrQuotes(attrMatch[2]);
  }

  return {
    key: match[1],
    status: VALID_STATUSES.has(attrs.status) ? attrs.status : '',
    updatedAt: attrs.updatedAt || '',
    ai: attrs.ai || '',
    code: attrs.code || '',
  };
}

export function collectSectionMarkers(doc) {
  const markers = [];
  const content = doc?.body?.content || [];

  for (const block of content) {
    const elements = block?.paragraph?.elements || [];
    for (const elem of elements) {
      const tr = elem?.textRun;
      if (!tr || typeof elem.startIndex !== 'number') continue;

      const text = tr.content || '';
      let match;
      SECTION_MARKER_RE.lastIndex = 0;
      while ((match = SECTION_MARKER_RE.exec(text)) !== null) {
        const markerKey = match[1];
        const startIndex = elem.startIndex + match.index;
        markers.push({
          key: markerKey,
          no: sectionNoFromKey(markerKey),
          startIndex,
          markerEndIndex: startIndex + match[0].length,
        });
      }
    }
  }

  return markers.sort((a, b) => a.startIndex - b.startIndex);
}

export function buildSectionState(doc, sectionDefs = [], {
  doneCharCount = DEFAULT_DONE_CHAR_COUNT,
} = {}) {
  const markers = collectSectionMarkers(doc);
  const markerEntries = buildMarkerEntries(doc, markers);
  const legacyEntries = collectLegacySectionEntries(doc);
  const markerMap = new Map();
  for (const entry of markerEntries) {
    const markerKey = entry['key'];
    if (!markerMap.has(markerKey)) markerMap.set(markerKey, []);
    markerMap.get(markerKey).push(entry);
  }
  const legacyMap = new Map();
  for (const entry of legacyEntries) {
    const legacyKey = entry['key'];
    if (!legacyMap.has(legacyKey)) legacyMap.set(legacyKey, []);
    legacyMap.get(legacyKey).push(entry);
  }

  const definitions = normalizeSectionDefs(sectionDefs, markers, legacyEntries);
  const sections = definitions.map((def) => {
    // 新形式 marker を正とし、その章だけ marker が無い場合に旧 §N 見出しへ戻る。
    // これにより、旧マスターへ新しい章を1つ追記した後も、残りの旧章が進捗から消えない。
    const entries = markerMap.get(def['key']) || legacyMap.get(def['key']) || [];
    if (!entries.length) {
      return {
        key: def['key'],
        no: def.no,
        title: def.title,
        status: 'todo',
        source: 'missing',
        charCount: 0,
        updatedAt: '',
        ai: '',
        code: '',
      };
    }

    return classifySectionEntry(entries[0], def, { doneCharCount });
  });

  const counts = { done: 0, failed: 0, partial: 0, todo: 0, total: sections.length };
  for (const section of sections) {
    if (Object.prototype.hasOwnProperty.call(counts, section.status)) counts[section.status] += 1;
  }

  const next = sections.find((section) => section.status !== 'done') || null;

  return {
    ok: true,
    sections,
    counts,
    nextSection: next
      ? {
          key: next['key'],
          no: next.no,
          title: next.title,
          status: next.status,
        }
      : null,
  };
}

function normalizeSectionDefs(sectionDefs, markers, legacyEntries = []) {
  const defs = (sectionDefs || [])
    .map((def) => {
      const rawKey = def?.['key'] ?? def?.sectionKey ?? def?.no;
      const sectionKey = normalizeSectionKey(rawKey);
      if (!sectionKey) return null;
      return {
        key: sectionKey,
        no: sectionNoFromKey(sectionKey),
        title: String(def?.title || '').trim(),
      };
    })
    .filter(Boolean);

  if (defs.length) return defs;

  const byKey = new Map();
  for (const item of markers.concat(legacyEntries)) {
    if (!item?.['key'] || byKey.has(item['key'])) continue;
    byKey.set(item['key'], {
      key: item['key'],
      no: item.no,
      title: item.title || '',
    });
  }
  return Array.from(byKey.values());
}

function buildMarkerEntries(doc, markers) {
  const endIndex = computeEndIndex(doc);
  return markers.map((marker, index) => {
    const next = markers[index + 1];
    const range = {
      startIndex: marker.markerEndIndex,
      endIndex: next ? next.startIndex : endIndex,
    };
    const text = getTextInRange(doc, range.startIndex, range.endIndex);
    return {
      ...marker,
      range,
      text,
    };
  });
}

// v0.12 より前のマスタードキュメントは [[SK-SECTION:...]] を持たず、
// 「§0. 事業理解」のような見出しだけで章を分けていた。本文を変更せず読み取る。
export function collectLegacySectionEntries(doc) {
  const headings = [];
  for (const block of doc?.body?.content || []) {
    if (!block?.paragraph || typeof block.startIndex !== 'number') continue;
    const text = getParagraphText(block);
    let offset = 0;
    for (const line of text.split(/(?<=\n)/)) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(?:[#＃]+\s*)?§\s*(-?\d+(?:-\d+)?)\s*[.．]\s*([^\n]*)/);
      if (match) {
        const sectionKey = normalizeSectionKey(match[1]);
        if (sectionKey) {
          headings.push({
            key: sectionKey,
            no: sectionNoFromKey(sectionKey),
            title: String(match[2] || '').trim(),
            startIndex: block.startIndex + offset,
            bodyStartIndex: block.startIndex + offset + line.length,
          });
        }
      }
      offset += line.length;
    }
  }

  const endIndex = computeEndIndex(doc);
  return headings.map((heading, index) => {
    const next = headings[index + 1];
    return {
      ...heading,
      source: 'legacy',
      range: {
        startIndex: heading.bodyStartIndex,
        endIndex: next ? next.startIndex : endIndex,
      },
      text: getTextInRange(
        doc,
        heading.bodyStartIndex,
        next ? next.startIndex : endIndex,
      ),
    };
  });
}

function getParagraphText(block) {
  return (block?.paragraph?.elements || [])
    .map((elem) => elem?.textRun?.content || '')
    .join('');
}

function classifySectionEntry(entry, def, { doneCharCount }) {
  const marker = findStatusMarkerForKey(entry.text, entry['key']);
  const normalizedText = normalizeSectionBodyText(entry.text, entry['key']);
  const charCount = normalizedText.length;

  if (marker?.status) {
    return {
      key: def['key'],
      no: def.no,
      title: def.title,
      status: marker.status,
      source: entry.source === 'legacy' ? 'legacy-status' : 'marker',
      charCount,
      updatedAt: marker.updatedAt,
      ai: marker.ai,
      code: marker.code,
    };
  }

  return {
    key: def['key'],
    no: def.no,
    title: def.title,
    status: inferStatusFromContent(normalizedText, doneCharCount),
    source: entry.source === 'legacy' ? 'legacy-content' : 'content',
    charCount,
    updatedAt: '',
    ai: '',
    code: '',
  };
}

function findStatusMarkerForKey(text, sectionKey) {
  let match;
  let found = null;
  STATUS_MARKER_RE.lastIndex = 0;
  while ((match = STATUS_MARKER_RE.exec(String(text || ''))) !== null) {
    const parsed = parseStatusMarker(match[0]);
    if (parsed?.['key'] === sectionKey) found = parsed;
  }
  return found;
}

function normalizeSectionBodyText(text, sectionKey) {
  const headingRe = new RegExp(`^§${escapeRegExp(sectionKey)}[.．]\\s*.*$`);
  return String(text || '')
    .replace(STATUS_MARKER_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (headingRe.test(line)) return false;
      if (isPlaceholderLine(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function inferStatusFromContent(text, doneCharCount) {
  if (isFailureText(text)) return 'failed';
  if (!text) return 'todo';
  if (text.length >= doneCharCount) return 'done';
  return 'partial';
}

function isFailureText(text) {
  return /(生成失敗|失敗|エラー|⚠)/.test(String(text || ''));
}

function isPlaceholderLine(line) {
  return /^[（(]?\s*(未保存|未着手|todo)\s*[）)]?$/i.test(String(line || '').trim());
}

function sectionNoFromKey(sectionKey) {
  const no = Number(String(sectionKey || '').split('-')[0]);
  return Number.isFinite(no) ? no : null;
}

function stripAttrQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
