const SECTION_MARKER_RE = /\[\[SK-SECTION:§(-?\d+(?:-\d+)?)\]\]/g;

const TOP_LEVEL_KEY_RE = /^-?\d+$/;

function sectionNoFromKey(key) {
  // 先頭の(符号付き)整数部分のみをトップ番号として取り出す。§-1 → -1, §7-2 → 7。
  const match = String(key).match(/^-?\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

// サブ番号(§7-2 等)を含まない「トップ番号だけ」のキーか。§-1 等の負番号は true。
function isTopLevelKey(key) {
  return TOP_LEVEL_KEY_RE.test(String(key));
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
        const key = match[1];
        const no = sectionNoFromKey(key);
        const startIndex = elem.startIndex + match.index;
        markers.push({
          no,
          key,
          startIndex,
          markerEndIndex: startIndex + match[0].length,
        });
      }
    }
  }

  return markers.sort((a, b) => a.startIndex - b.startIndex);
}

export function computeEndIndex(doc) {
  const content = doc?.body?.content || [];
  if (!content.length) return 1;
  const last = content[content.length - 1];
  return Math.max(1, (last?.endIndex || 2) - 1);
}

export function findSectionRange(doc, sectionNo, { allowLastSectionNo = 99 } = {}) {
  const markers = collectSectionMarkers(doc);
  // トップ番号セクションの本体マーカーのみを current 対象とする。
  // §7-2 等のサブ番号マーカーは §7 の current ではなく、章境界としてのみ機能する。
  const current = markers.filter((m) => m.no === sectionNo && isTopLevelKey(m.key));

  if (current.length === 0) return { status: 'missing-current-marker', markers };
  if (current.length > 1) return { status: 'duplicate-current-marker', markers };

  const startIndex = current[0].markerEndIndex;
  const later = markers.filter((m) => m.startIndex > current[0].startIndex);

  if (later.length === 0) {
    if (sectionNo === allowLastSectionNo) {
      const endIndex = computeEndIndex(doc);
      return { status: 'ok', startIndex, endIndex: Math.max(startIndex, endIndex), markers };
    }
    return { status: 'missing-next-marker', markers };
  }

  return { status: 'ok', startIndex, endIndex: later[0].startIndex, markers };
}

export function buildReplaceSectionRequests(range, replacementText) {
  if (!range || range.status !== 'ok') {
    throw new Error(`Cannot replace section for range status: ${range?.status || 'unknown'}`);
  }

  const requests = [];
  if (range.endIndex > range.startIndex) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: range.startIndex,
          endIndex: range.endIndex,
        },
      },
    });
  }
  requests.push({
    insertText: {
      location: { index: range.startIndex },
      text: replacementText,
    },
  });
  return requests;
}

export function buildAppendToDocumentEndRequests(doc, text) {
  return [
    {
      insertText: {
        location: { index: computeEndIndex(doc) },
        text,
      },
    },
  ];
}

const PLACEHOLDER_BODY = '（未保存）';

// セクション本文から先頭の見出し行（"§7. タイトル" / "§7-4. タイトル" 等）を1行だけ落とす。
function stripLeadingSectionHeading(text) {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^§?-?\d+(?:-\d+)?[.．、）)\s]/.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

// 「本文がまだ書かれていない未保存プレースホルダ or 空」か。
// 保守的判定: 見出し行を除いた残りが空 or 「（未保存）」のときだけ true。
// 実データが入っているセクションを誤ってプレースホルダ扱いしないことを最優先する。
export function isPlaceholderSectionBody(text) {
  const body = stripLeadingSectionHeading(text);
  return body === '' || body === PLACEHOLDER_BODY;
}

// トップ番号セクション(§N)配下のサブマーカー(§N-1〜§N-M)の本文を連結して返す。
// 全自動で §7 が §7-1〜§7-5 に分割され、トップ級 §7 本体が「（未保存）」で残る構造に対応する。
export function aggregateSubsectionText(doc, sectionNo, markers) {
  const all = (markers && markers.length) ? markers : collectSectionMarkers(doc);
  const prefix = String(sectionNo) + '-';
  const subMarkers = all.filter((m) => {
    const key = String(m.key);
    return key.indexOf(prefix) === 0 && /^-?\d+-\d+$/.test(key);
  });
  if (!subMarkers.length) return { text: '', subKeys: [] };

  const parts = [];
  const subKeys = [];
  for (const sub of subMarkers) {
    const later = all.filter((m) => m.startIndex > sub.startIndex);
    const endIndex = later.length ? later[0].startIndex : computeEndIndex(doc);
    const raw = getTextInRange(doc, sub.markerEndIndex, endIndex).trim();
    if (raw && !isPlaceholderSectionBody(raw)) {
      parts.push(raw);
      subKeys.push(sub.key);
    }
  }
  return { text: parts.join('\n\n'), subKeys };
}

export function getSectionText(doc, sectionNo, options = {}) {
  const range = findSectionRange(doc, sectionNo, options);
  if (range.status === 'ok') {
    const text = getTextInRange(doc, range.startIndex, range.endIndex);
    // トップ級本文が未保存プレースホルダで、サブマーカー(§N-M)に実体があれば連結して返す。
    if (isPlaceholderSectionBody(text)) {
      const agg = aggregateSubsectionText(doc, sectionNo, range.markers);
      if (agg.text) {
        return { status: 'ok', text: agg.text, range, aggregatedSubsectionKeys: agg.subKeys };
      }
    }
    return { status: 'ok', text, range };
  }
  // トップ級マーカー自体が無くても、サブマーカーに実体があれば救済して連結する。
  if (range.status === 'missing-current-marker') {
    const agg = aggregateSubsectionText(doc, sectionNo, range.markers);
    if (agg.text) {
      return { status: 'ok', text: agg.text, range, aggregatedSubsectionKeys: agg.subKeys };
    }
  }
  return { status: range.status, text: '', range };
}

export function buildSectionTextMap(doc, sectionNos, options = {}) {
  const map = new Map();
  for (const no of sectionNos || []) {
    const result = getSectionText(doc, no, options);
    if (result.status === 'ok') map.set(no, result.text.trim());
  }
  return map;
}

export function buildProgressSections(doc, phaseDefs = []) {
  const sections = phaseDefs.map((phase) => {
    const no = Number(phase.no);
    const result = getSectionText(doc, no, { allowLastSectionNo: 99 });
    const normalizedText = normalizeProgressText(result.text);
    const charCount = normalizedText.length;
    const filled = charCount >= 80;
    const partial = !filled && charCount > 0;
    return {
      no,
      title: phase.title || '',
      filled,
      partial,
      charCount,
      lastUpdated: '',
    };
  });

  const filledCount = sections.filter((s) => s.filled).length;
  const partialCount = sections.filter((s) => s.partial).length;
  const totalChapters = sections.length;
  const progressRate = totalChapters
    ? Math.round(((filledCount + partialCount) / totalChapters) * 100)
    : 0;

  return {
    sections,
    filledCount,
    partialCount,
    totalChapters,
    completionRate: totalChapters ? Math.round((filledCount / totalChapters) * 100) : 0,
    progressRate,
  };
}

export function getTextInRange(doc, startIndex, endIndex) {
  const chunks = [];
  const content = doc?.body?.content || [];

  for (const block of content) {
    const elements = block?.paragraph?.elements || [];
    for (const elem of elements) {
      const tr = elem?.textRun;
      if (!tr || typeof elem.startIndex !== 'number' || typeof elem.endIndex !== 'number') continue;
      if (elem.endIndex <= startIndex || elem.startIndex >= endIndex) continue;

      const text = tr.content || '';
      const sliceStart = Math.max(0, startIndex - elem.startIndex);
      const sliceEnd = Math.min(text.length, endIndex - elem.startIndex);
      chunks.push(text.slice(sliceStart, sliceEnd));
    }
  }

  return chunks.join('');
}

function normalizeProgressText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed === '（未保存）') return '';
  return trimmed;
}
