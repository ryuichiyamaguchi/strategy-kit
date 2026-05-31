import {
  buildReplaceSectionRequests,
  collectSectionMarkers,
  computeEndIndex,
  findSectionRange,
  getTextInRange,
} from './docs-sections.js';
import { copyFile } from './drive-client.js';

const DOC_ID_RE = /^[a-zA-Z0-9_-]{20,}$/;
const DOC_URL_RE = /\/document\/d\/([a-zA-Z0-9_-]+)/;

export function parseGoogleDocId(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const urlMatch = value.match(DOC_URL_RE);
  if (urlMatch) return urlMatch[1];
  if (DOC_ID_RE.test(value)) return value;
  return '';
}

export function buildGoogleDocUrl(documentId) {
  return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
}

export async function setDraftDocFromUrl(url, {
  docsClient,
  storageArea = chrome.storage.sync,
  now = () => new Date(),
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }

  const documentId = parseGoogleDocId(url);
  if (!documentId) {
    throw new Error('Doc IDをURLから抽出できません。Googleドキュメントの共有URL（/document/d/.../）を貼り付けてください');
  }

  const doc = await docsClient.getDocument(documentId, { fields: 'documentId,title' });
  const title = doc?.title || '(無題)';
  const draftInfo = {
    documentId,
    docUrl: buildGoogleDocUrl(documentId),
    title,
    source: 'manual-url',
    format: 'v012-full-port',
    updatedAt: now().toISOString(),
  };
  await storageArea.set({ sk_draft_doc_v012: draftInfo });

  return {
    ok: true,
    draftDocId: documentId,
    draftDocTitle: title,
    draftDocUrl: draftInfo.docUrl,
    draftInfo,
  };
}

export async function getDraftProgress({
  docsClient,
  storageArea = chrome.storage.sync,
  phases = [],
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }

  const stored = await storageArea.get(['sk_draft_doc_v012']);
  const draftInfo = stored?.sk_draft_doc_v012 || null;
  const documentId = draftInfo?.documentId;
  if (!documentId) {
    throw new Error('DRAFT Doc 未作成。DRAFT URLを指定するか、新規作成してください');
  }

  const doc = await docsClient.getDocument(documentId);
  return {
    ...buildDraftProgressResult(doc, phases),
    businessInfo: extractDraftBusinessInfo(doc),
    draftDocId: documentId,
    draftDocUrl: draftInfo.docUrl || buildGoogleDocUrl(documentId),
    draftDocTitle: draftInfo.title || doc?.title || '(無題)',
  };
}

export async function getStoredDraftInfo({
  docsClient,
  storageArea = chrome.storage.sync,
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }

  const stored = await storageArea.get(['sk_draft_doc_v012']);
  const draftInfo = stored?.sk_draft_doc_v012 || null;
  const documentId = draftInfo?.documentId;
  if (!documentId) {
    return { ok: true, exists: false };
  }

  try {
    const doc = await docsClient.getDocument(documentId, { fields: 'documentId,title' });
    return {
      ok: true,
      exists: true,
      draftDocId: documentId,
      draftDocUrl: draftInfo.docUrl || buildGoogleDocUrl(documentId),
      title: doc?.title || draftInfo.title || '(無題)',
    };
  } catch (error) {
    return {
      ok: true,
      exists: false,
      error: error?.message || String(error),
    };
  }
}

export async function createDraftDoc({
  docsClient,
  driveClient = { copyFile },
  storageArea = chrome.storage.sync,
  titleBase,
  now = () => new Date(),
} = {}) {
  if (!docsClient || typeof docsClient.createDocument !== 'function') {
    throw new Error('docsClient.createDocument is required');
  }

  const stored = await storageArea.get(['sk_master_doc_v012']);
  const masterInfo = stored?.sk_master_doc_v012 || null;
  const title = buildDraftTitle({
    masterTitle: masterInfo?.title,
    titleBase,
    now,
  });

  let draftInfo;
  if (masterInfo?.documentId && driveClient && typeof driveClient.copyFile === 'function') {
    try {
      const copied = await driveClient.copyFile(masterInfo.documentId, { name: title });
      draftInfo = {
        documentId: copied.id,
        docUrl: copied.webViewLink || buildGoogleDocUrl(copied.id),
        title: copied.name || title,
        masterDocumentId: masterInfo.documentId,
        source: 'master-copy',
        format: 'v012-full-port',
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
    } catch (error) {
      if (error?.status !== 403) throw error;
    }
  }

  if (!draftInfo) {
    const created = await docsClient.createDocument(title);
    const documentId = created.documentId;
    if (typeof docsClient.batchUpdate === 'function') {
      await docsClient.batchUpdate(documentId, [
        {
          insertText: {
            location: { index: 1 },
            text: buildBlankDraftIntro(title, masterInfo),
          },
        },
      ]);
    }
    draftInfo = {
      documentId,
      docUrl: buildGoogleDocUrl(documentId),
      title,
      masterDocumentId: masterInfo?.documentId || '',
      source: masterInfo?.documentId ? 'docs-create-fallback' : 'docs-create',
      format: 'v012-full-port',
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    };
  }

  await storageArea.set({ sk_draft_doc_v012: draftInfo });
  return {
    ok: true,
    action: 'created',
    draftDocId: draftInfo.documentId,
    draftDocUrl: draftInfo.docUrl,
    title: draftInfo.title,
    draftInfo,
  };
}

export async function ensureDraftDoc({
  docsClient,
  driveClient = { copyFile },
  storageArea = chrome.storage.sync,
  phases = [],
  titleBase,
  now = () => new Date(),
  confirmUseExisting = () => true,
} = {}) {
  const existing = await getStoredDraftInfo({ docsClient, storageArea });
  if (existing.exists) {
    let progress = null;
    try {
      progress = await getDraftProgress({ docsClient, storageArea, phases });
    } catch (_) {
      progress = null;
    }
    const hasContent = !!(
      progress &&
      (
        (typeof progress.completedCount === 'number' && progress.completedCount > 0) ||
        (typeof progress.maxFilledSection === 'number' && progress.maxFilledSection >= 0) ||
        Object.keys(progress.subFilledSections || {}).length > 0
      )
    );
    const useExisting = hasContent ? await confirmUseExisting(existing, progress) : true;
    if (useExisting) {
      return {
        ok: true,
        action: 'reused',
        draftDocId: existing.draftDocId,
        draftDocUrl: existing.draftDocUrl,
        title: existing.title,
        progress,
      };
    }
  }

  return await createDraftDoc({
    docsClient,
    driveClient,
    storageArea,
    titleBase,
    now,
  });
}

export async function appendDraftSection({
  docsClient,
  storageArea = chrome.storage.sync,
  sectionNo,
  title,
  body,
  aiUsed,
  now = () => new Date(),
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function' || typeof docsClient.batchUpdate !== 'function') {
    throw new Error('docsClient.getDocument and docsClient.batchUpdate are required');
  }
  const stored = await storageArea.get(['sk_draft_doc_v012']);
  const draftInfo = stored?.sk_draft_doc_v012 || null;
  const documentId = draftInfo?.documentId;
  if (!documentId) {
    throw new Error('DRAFT Doc 未作成。先にDRAFTを作成してください');
  }

  const updatedAt = now().toISOString();
  const doc = await docsClient.getDocument(documentId);
  const text = buildDraftSectionText({ sectionNo, title, body, aiUsed, updatedAt });
  await docsClient.batchUpdate(documentId, buildDraftSectionWriteRequests(doc, sectionNo, text));

  await storageArea.set({
    sk_draft_doc_v012: {
      ...draftInfo,
      updatedAt,
    },
  });

  return {
    ok: true,
    draftDocId: documentId,
    draftDocUrl: draftInfo.docUrl || buildGoogleDocUrl(documentId),
    sectionNo: String(sectionNo || ''),
  };
}

export async function getDraftText({
  docsClient,
  storageArea = chrome.storage.sync,
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }
  const stored = await storageArea.get(['sk_draft_doc_v012']);
  const draftInfo = stored?.sk_draft_doc_v012 || null;
  const documentId = draftInfo?.documentId;
  if (!documentId) {
    throw new Error('DRAFT Doc 未作成。先にDRAFTを作成してください');
  }
  const doc = await docsClient.getDocument(documentId);
  return {
    ok: true,
    documentId,
    docUrl: draftInfo.docUrl || buildGoogleDocUrl(documentId),
    title: draftInfo.title || doc?.title || '(無題)',
    text: extractDocumentText(doc),
  };
}

export async function createDerivedDraftDocument({
  docsClient,
  title,
  text,
} = {}) {
  if (!docsClient || typeof docsClient.createDocument !== 'function' || typeof docsClient.batchUpdate !== 'function') {
    throw new Error('docsClient.createDocument and docsClient.batchUpdate are required');
  }
  const safeTitle = String(title || 'STRATEGY-KIT generated document').trim();
  const created = await docsClient.createDocument(safeTitle);
  await docsClient.batchUpdate(created.documentId, [
    {
      insertText: {
        location: { index: 1 },
        text: String(text || ''),
      },
    },
  ]);
  return {
    ok: true,
    documentId: created.documentId,
    docUrl: buildGoogleDocUrl(created.documentId),
    title: safeTitle,
    charCount: String(text || '').length,
  };
}

export function buildDraftProgressResult(doc, phaseDefs = []) {
  const completedParents = new Set();
  const subFilledMap = {};
  const sections = [];

  const markerProgress = buildMarkerProgressSections(doc, phaseDefs || []);
  for (const section of markerProgress.sections || []) {
    if (section.no === 99) continue;
    sections.push(section);
    if (section.filled || section.partial) {
      completedParents.add(Number(section.no));
    }
  }

  for (const entry of collectLegacyDraftHeadingEntries(doc)) {
    if (entry.no === 99 || !entry.hasContent) continue;
    completedParents.add(entry.no);
    if (entry.subNo >= 1) {
      const key = String(entry.no);
      if (!subFilledMap[key]) subFilledMap[key] = new Set();
      subFilledMap[key].add(entry.subNo);
    }
  }

  const filledSections = Array.from(completedParents)
    .filter((no) => Number.isFinite(no) && no !== 99)
    .sort((a, b) => a - b);
  const subFilledSections = {};
  for (const key of Object.keys(subFilledMap).sort((a, b) => Number(a) - Number(b))) {
    const values = Array.from(subFilledMap[key]).sort((a, b) => a - b);
    if (values.length) subFilledSections[key] = values;
  }
  const maxFilledSection = filledSections.length ? Math.max(...filledSections) : -1;
  const totalChapters = (phaseDefs || []).filter((phase) => Number(phase.no) !== 99).length;
  const completedKnown = totalChapters
    ? filledSections.filter((no) => (phaseDefs || []).some((phase) => Number(phase.no) === no)).length
    : filledSections.length;

  return {
    ok: true,
    sections,
    filledSections,
    subFilledSections,
    maxFilledSection,
    nextSubSection: null,
    nextSectionToWrite: maxFilledSection + 1,
    completedCount: filledSections.length,
    totalChapters,
    completionRate: totalChapters ? Math.round((completedKnown / totalChapters) * 100) : 0,
    progressRate: totalChapters ? Math.round((completedKnown / totalChapters) * 100) : 0,
  };
}

export function extractDraftBusinessInfo(doc) {
  const source = extractDocumentText(doc);
  const chunks = [];
  const firstMarkerIndex = source.search(/\[\[SK-SECTION:§-?\d+\]\]/);
  chunks.push(firstMarkerIndex >= 0 ? source.slice(0, firstMarkerIndex) : source);

  const metaMatch = source.match(/(?:^|\n)§-1[.．]\s*[^\n]*\n([\s\S]*?)(?=\n§-?\d+(?:-\d+)?[.．]|\n\[\[SK-SECTION:§-?\d+\]\]|$)/);
  if (metaMatch) chunks.push(metaMatch[1]);

  const info = {};
  for (const chunk of chunks) {
    const lines = String(chunk || '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const tableCells = parseMarkdownTableLine(line);
      if (tableCells.length >= 2) {
        assignBusinessInfo(info, tableCells[0], tableCells[1]);
        continue;
      }
      const generatedContextMatch = line.match(/業種[「『]([^」』]+)[」』]\s*かつ\s*(?:店舗|店舗名|店舗名[／/・]屋号|屋号)[「『]([^」』]+)[」』]/);
      if (generatedContextMatch) {
        if (!info.industryLabel) info.industryLabel = normalizeBusinessMetaValue(generatedContextMatch[1]);
        if (!info.storeName) info.storeName = normalizeBusinessMetaValue(generatedContextMatch[2]);
        continue;
      }
      if (isBusinessInfoKey(line)) {
        const nextValue = normalizeBusinessMetaValue(lines[i + 1] || '');
        if (nextValue && !isBusinessInfoKey(nextValue)) {
          assignBusinessInfo(info, line, nextValue);
        }
        continue;
      }
      const titleMatch = line.match(/戦略マスタードキュメント\s*[—-]\s*([^／/]+)\s*[／/]\s*(.+)$/);
      if (titleMatch) {
        if (!info.industryLabel) info.industryLabel = normalizeBusinessMetaValue(titleMatch[1]);
        if (!info.storeName) info.storeName = normalizeBusinessMetaValue(titleMatch[2]);
        continue;
      }
      const industryMatch = line.match(/^業種\s*[:：]\s*(.+)$/);
      if (industryMatch) {
        const value = normalizeBusinessMetaValue(industryMatch[1]);
        if (value) info.industryLabel = value;
        continue;
      }
      const storeMatch = line.match(/^(?:店舗(?:・屋号|名)?|店舗名[／/・]屋号|屋号)\s*[:：]\s*(.+)$/);
      if (storeMatch) {
        const value = normalizeBusinessMetaValue(storeMatch[1]);
        if (value) info.storeName = value;
      }
    }
  }

  return {
    industryLabel: info.industryLabel || '',
    storeName: info.storeName || '',
  };
}

function parseMarkdownTableLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return [];
  if (/^\|[\s\-:|]+\|$/.test(text)) return [];
  return text
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function isIndustryKey(key) {
  return normalizeBusinessKey(key) === '業種';
}

function isStoreNameKey(key) {
  const normalized = normalizeBusinessKey(key);
  return /^(店舗名屋号|店舗屋号|店舗名|店舗|屋号)$/.test(normalized);
}

function isBusinessInfoKey(key) {
  return isIndustryKey(key) || isStoreNameKey(key);
}

function normalizeBusinessKey(key) {
  return String(key || '')
    .replace(/\s/g, '')
    .replace(/[|:：]/g, '')
    .replace(/[／/・]/g, '')
    .trim();
}

function assignBusinessInfo(info, key, value) {
  const normalizedValue = normalizeBusinessMetaValue(value);
  if (!normalizedValue) return;
  if (isIndustryKey(key)) info.industryLabel = normalizedValue;
  if (isStoreNameKey(key)) info.storeName = normalizedValue;
}

function normalizeBusinessMetaValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[（(]?\s*(未設定|未指定|なし|無し)\s*[）)]?$/.test(text)) return '';
  if (/\{\{[^}]+\}\}/.test(text)) return '';
  if (/^[-—]+$/.test(text)) return '';
  return text;
}

function buildDraftSectionWriteRequests(doc, sectionNo, text) {
  const sectionKey = String(sectionNo || '').trim();
  if (isDigitsOnly(sectionKey)) {
    const markerRange = findSectionRange(doc, Number(sectionKey), { allowLastSectionNo: 9 });
    if (markerRange.status === 'ok') return buildReplaceSectionRequests(markerRange, text);
    if (markerRange.status === 'duplicate-current-marker') {
      throw new Error(`DRAFT内に §${sectionKey} marker が複数あります。重複を整理してから再実行してください`);
    }
  }

  const legacyRange = findLegacyDraftSectionRange(doc, sectionKey);
  if (legacyRange.status === 'ok') return buildReplaceSectionRequests(legacyRange, text);
  if (legacyRange.status === 'duplicate-current-heading') {
    throw new Error(`DRAFT内に §${sectionKey} 見出しが複数あります。重複を整理してから再実行してください`);
  }

  return [{ insertText: { location: { index: computeEndIndex(doc) }, text } }];
}

function buildDraftSectionText({ sectionNo, title, body, aiUsed, updatedAt }) {
  const safeSectionNo = String(sectionNo || '?').trim() || '?';
  const safeTitle = String(title || '').trim() || '(無題)';
  const lines = [
    `\n§${safeSectionNo}. ${safeTitle}`,
  ];
  if (aiUsed) lines.push(`（生成AI: ${String(aiUsed).trim()}）`);
  lines.push(String(body || '').trim());
  lines.push(`[最終更新: ${updatedAt} ／ 担当: 自動]`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function buildDraftTitle({ masterTitle, titleBase, now }) {
  const base = String(masterTitle || titleBase || 'STRATEGY-KIT DRAFT').trim();
  const stamp = now().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  return `[DRAFT] ${base} - ${stamp}`;
}

function buildBlankDraftIntro(title, masterInfo) {
  return [
    `${title}\n`,
    masterInfo?.title ? `原本: ${masterInfo.title} のDRAFT自動生成版\n` : '原本: 未設定のDRAFT自動生成版\n',
    '※このDRAFTは STRATEGY-KIT 自動化モードで生成されました。原本マスターには影響しません。\n',
    '\n',
  ].join('');
}

function collectLegacyDraftHeadingEntries(doc) {
  const entries = [];
  let current = null;

  function commitCurrent() {
    if (current) {
      const normalizedText = normalizeProgressText(current.bodyChunks.join('\n'), { no: current.no });
      entries.push({
        no: current.no,
        subNo: current.subNo,
        hasContent: normalizedText.length > 0,
        charCount: normalizedText.length,
      });
    }
    current = null;
  }

  for (const block of doc?.body?.content || []) {
    const text = getParagraphText(block);
    const trimmed = text.trim();
    const headingMatch = trimmed.match(/^§(\d+)(?:-(\d+))?\.\s*(.*)$/);
    const isHeading1 = block?.paragraph?.paragraphStyle?.namedStyleType === 'HEADING_1';

    if (headingMatch && (isHeading1 || !current || isLegacyDraftSectionHeading(trimmed))) {
      commitCurrent();
      current = {
        no: parseInt(headingMatch[1], 10),
        subNo: headingMatch[2] ? parseInt(headingMatch[2], 10) : -1,
        hasContent: false,
        bodyChunks: [],
      };
      continue;
    }

    if (!current || !trimmed) continue;
    current.bodyChunks.push(getStructuralElementText(block));
  }

  commitCurrent();
  return entries;
}

function isLegacyDraftSectionHeading(text) {
  return /^§\d+(?:-\d+)?[.．]\s+/.test(String(text || '').trim());
}

function buildMarkerProgressSections(doc, phaseDefs) {
  const markers = collectSectionMarkers(doc);
  return {
    sections: phaseDefs.map((phase) => {
      const no = Number(phase.no);
      const current = markers.find((marker) => marker.no === no);
      if (!current) {
        return {
          no,
          title: phase.title || '',
          filled: false,
          partial: false,
          charCount: 0,
          lastUpdated: '',
        };
      }
      const next = markers.find((marker) => marker.startIndex > current.startIndex);
      const endIndex = next ? next.startIndex : computeEndIndex(doc);
      const normalizedText = normalizeProgressText(getTextInRange(doc, current.markerEndIndex, endIndex), phase);
      const charCount = normalizedText.length;
      return {
        no,
        title: phase.title || '',
        filled: charCount >= 80,
        partial: charCount > 0 && charCount < 80,
        charCount,
        lastUpdated: '',
      };
    }),
  };
}

function normalizeProgressText(text, phase = null) {
  // Master template lines are not user-written draft content. Keep this filter narrow:
  // only remove the generated section title/status and obvious placeholder/help lines.
  const raw = String(text || '');
  const userLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^[（(]\s*未保存\s*[）)]$/.test(line)) return false;
      if (isMasterSectionTitleLine(line, phase)) return false;
      if (isTemplateScaffoldLine(line)) return false;
      if (isTemplateTableLine(line)) return false;
      if (line.startsWith('>')) return false;
      if (/\{\{[^}]+\}\}/.test(line)) return false;
      if (/^〔.*〕$/.test(line)) return false;
      if (/^[#＃]+\s/.test(line)) return false;
      if (/^\[[^\]]+\]$/.test(line)) return false;
      if (/^`?\[最終更新/.test(line)) return false;
      if (/^（生成AI:/.test(line)) return false;
      if (/^[（(]生成エラー[）)]$/.test(line)) return false;
      if (/^理由\s*[:：]/.test(line)) return false;
      if (/^この章は\s*primary CTA\s*から埋め直せます/.test(line)) return false;
      if (/^\|[\s\-:|]+\|$/.test(line)) return false;
      return true;
    })
    .join('\n');
  return userLines.trim();
}

function isMasterSectionTitleLine(line, phase) {
  const no = Number(phase?.no);
  if (!Number.isFinite(no)) return false;
  return new RegExp(`^[§$]\\s*${no}\\s*[.．]\\s+`).test(line);
}

function isTemplateScaffoldLine(line) {
  const text = String(line || '').trim();
  if (!text) return true;
  if (/^\d+-\d+\s+/.test(text)) return true;
  if (/^§\d+\s*要点版/.test(text)) return true;
  if (/^[-*]\s*$/.test(text)) return true;
  if (/^[-*]\s*〔.*〕$/.test(text)) return true;
  if (/^[-*]\s*(?:機会|課題|リスク)\s*[:：]\s*$/.test(text)) return true;
  if (/^[-*]\s*\*\*[^*]+\*\*\s*[:：]\s*$/.test(text)) return true;
  if (/^\d+[.．]\s*$/.test(text)) return true;
  if (/^→/.test(text)) return true;
  if (/^(?:優先順位付き|5〜8個|5～8個)/.test(text)) return true;
  if (/記入/.test(text) && /必須|出典|以内|例/.test(text)) return true;
  if (/含めること/.test(text)) return true;
  if (/直接使用$/.test(text)) return true;
  return false;
}

function isTemplateTableLine(line) {
  const cells = parseMarkdownTableLine(line);
  if (!cells.length) return false;
  return cells.every(isTemplateTableCell);
}

function isTemplateTableCell(cell) {
  const text = String(cell || '').trim();
  if (!text) return true;
  if (/\{\{[^}]+\}\}/.test(text)) return true;
  if (/^\[[^\]]+\]$/.test(text)) return true;
  if (/^\[事実-/.test(text)) return true;
  const normalized = text
    .replace(/\s/g, '')
    .replace(/[（）()／/・]/g, '')
    .trim();
  return /^(社名|戦略仮説|USP仮説|価格帯|出典URLor§章番号|タグ|項目|内容)$/.test(normalized);
}

function getParagraphText(block) {
  const elements = block?.paragraph?.elements || [];
  return elements.map((element) => element?.textRun?.content || '').join('');
}

function getStructuralElementText(block) {
  if (!block) return '';
  if (block.paragraph) return getParagraphText(block);
  if (!block.table) return '';

  const rows = block.table.tableRows || [];
  return rows
    .map((row) => (row.tableCells || [])
      .map((cell) => (cell.content || []).map(getStructuralElementText).join('').trim())
      .filter(Boolean)
      .join('\n'))
    .filter(Boolean)
    .join('\n') + '\n';
}

function extractDocumentText(doc) {
  const chunks = [];
  for (const block of doc?.body?.content || []) {
    chunks.push(getStructuralElementText(block));
  }
  return chunks.join('');
}

function isDigitsOnly(value) {
  const text = String(value || '');
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseLegacyHeadingKey(text) {
  if (!text || text[0] !== '§') return '';
  const dotIndex = text.indexOf('.');
  if (dotIndex < 0) return '';
  return normalizeLegacySectionKey(text.slice(1, dotIndex));
}

function normalizeLegacySectionKey(value) {
  const parts = String(value || '').trim().split('-');
  if (!isDigitsOnly(parts[0])) return '';
  if (parts.length === 1) return String(Number(parts[0]));
  if (parts.length === 2 && isDigitsOnly(parts[1])) {
    return String(Number(parts[0])) + '-' + String(Number(parts[1]));
  }
  return '';
}

function findLegacyDraftSectionRange(doc, sectionKey) {
  const headings = [];
  const normalizedTarget = normalizeLegacySectionKey(sectionKey);
  if (!normalizedTarget) return { status: 'missing-current-heading' };
  const content = (doc && doc.body && doc.body.content) || [];
  for (const block of content) {
    const parsed = parseLegacyHeadingKey(getParagraphText(block).trim());
    if (!parsed || typeof block.startIndex !== 'number') continue;
    headings.push({ key: parsed, startIndex: block.startIndex });
  }
  return findLegacyDraftSectionRangeFromHeadings(doc, normalizedTarget, headings);
}

function findLegacyDraftSectionRangeFromHeadings(doc, normalizedTarget, headings) {
  const current = [];
  const first = headings[0];
  const firstKey = first && first.key;
  if (first && firstKey === normalizedTarget) current.push(first);
  for (const item of headings.slice(1)) {
    const itemKey = item && item.key;
    if (item && itemKey === normalizedTarget) current.push(item);
  }
  if (!current[0]) return { status: 'missing-current-heading' };
  if (current[1]) return { status: 'duplicate-current-heading' };
  return buildLegacyRangeFromCurrent(doc, current[0], headings);
}

function buildLegacyRangeFromCurrent(doc, current, headings) {
  const startIndex = current.startIndex;
  let endIndex = computeEndIndex(doc);
  for (const item of headings) {
    if (item.startIndex <= startIndex) continue;
    if (item.startIndex < endIndex) endIndex = item.startIndex;
  }
  return { status: 'ok', startIndex, endIndex: Math.max(startIndex, endIndex) };
}
