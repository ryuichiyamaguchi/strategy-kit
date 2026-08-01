import { buildGoogleDocUrl } from './draft-manager.js';
import { computeEndIndex, getTextInRange } from './docs-sections.js';
import { normalizeResearchNo } from './research-store.js';
import { collectSectionMarkers, normalizeSectionKey } from './section-state.js';

const MASTER_KEY = 'sk_master_doc_v012';

export function buildResearchAddendumId({ phaseKey, researchNo, content } = {}) {
  const key = requirePhaseKey(phaseKey);
  const no = normalizeResearchNo(researchNo);
  const normalizedContent = normalizeContent(content);
  return `${key}-${no}-${fnv1a(normalizedContent)}`;
}

export function buildResearchAddendumBlock({
  phaseKey,
  phaseTitle = '',
  researchNo = 'NN',
  title = '',
  content,
  researchFileUrl = '',
  addendumId,
  updatedAt,
} = {}) {
  const key = requirePhaseKey(phaseKey);
  const no = normalizeResearchNo(researchNo);
  const body = normalizeContent(content);
  const id = String(addendumId || buildResearchAddendumId({ phaseKey: key, researchNo: no, content: body })).trim();
  const date = String(updatedAt || '').trim();
  const safeTitle = String(title || '').trim() || String(phaseTitle || '').trim() || '深掘りリサーチ';
  const marker = `[[SK-RESEARCH-ADDENDUM:phase=${key} id=${id} researchNo=${no}${date ? ` updatedAt=${date}` : ''}]]`;
  const heading = `追加リサーチ ${no}｜${safeTitle}\n`;
  const sourceLine = String(researchFileUrl || '').trim()
    ? `[リサーチ原本: ${String(researchFileUrl).trim()}]`
    : '[リサーチ原本: Drive保存なし]';
  const updatedLine = date ? `[追加日: ${date}]` : '';
  const text = `\n${marker}\n${heading}${body}\n${sourceLine}${updatedLine ? `\n${updatedLine}` : ''}\n`;
  const headingStartOffset = 1 + marker.length + 1;

  return {
    id,
    marker,
    text,
    headingStyle: 'HEADING_3',
    headingStartOffset,
    headingEndOffset: headingStartOffset + heading.length,
  };
}

export function buildResearchAppendRequests(doc, {
  phaseKey,
  addendumBlock,
} = {}) {
  const key = requirePhaseKey(phaseKey);
  const phaseNo = Number.parseInt(key, 10);
  if (!Number.isFinite(phaseNo) || String(phaseNo) !== key) {
    throw new Error('追加先はトップレベルのフェーズを指定してください');
  }
  const block = normalizeAddendumBlock(addendumBlock);
  const docText = getTextInRange(doc, 1, computeEndIndex(doc));
  const duplicatePrefix = `[[SK-RESEARCH-ADDENDUM:phase=${key} id=${block.id} `;
  if (docText.includes(duplicatePrefix)) {
    return { action: 'duplicate', requests: [], insertIndex: null, addendumId: block.id };
  }

  const markers = collectSectionMarkers(doc);
  const phaseMarkers = markers.filter((marker) => marker.no === phaseNo);
  if (!phaseMarkers.length) {
    throw new Error(`対象フェーズ §${key} が見つかりません。旧形式のマスターは先に取り込み・変換してください`);
  }

  const phaseStartIndex = phaseMarkers[0].startIndex;
  const successor = markers.find((marker) => marker.startIndex > phaseStartIndex && marker.no !== phaseNo) || null;
  const insertIndex = successor ? successor.startIndex : computeEndIndex(doc);
  const headingLength = block.headingEndOffset - block.headingStartOffset;
  const requests = [
    {
      insertText: {
        location: { index: insertIndex },
        text: block.text,
      },
    },
    {
      updateParagraphStyle: {
        range: {
          startIndex: insertIndex + block.headingStartOffset,
          endIndex: insertIndex + block.headingStartOffset + headingLength,
        },
        paragraphStyle: { namedStyleType: block.headingStyle },
        fields: 'namedStyleType',
      },
    },
  ];

  return { action: 'append', requests, insertIndex, addendumId: block.id };
}

export async function appendResearchToMaster({
  docsClient,
  driveClient,
  storageArea = chrome.storage.sync,
  phaseKey,
  phaseTitle = '',
  researchNo = 'NN',
  title = '',
  content,
  researchFileUrl = '',
  now = () => new Date(),
} = {}) {
  assertDependencies({ docsClient });
  const key = requirePhaseKey(phaseKey);
  const stored = await storageArea.get([MASTER_KEY]);
  const masterInfo = stored?.[MASTER_KEY] || null;
  const documentId = masterInfo?.documentId;
  if (!documentId) {
    throw new Error('マスター Doc 未設定。先にマスターを作成または選択してください');
  }

  const updatedAt = now().toISOString();
  const addendumBlock = buildResearchAddendumBlock({
    phaseKey: key,
    phaseTitle,
    researchNo,
    title,
    content,
    researchFileUrl,
    updatedAt,
  });
  const doc = await docsClient.getDocument(documentId);
  const plan = buildResearchAppendRequests(doc, { phaseKey: key, addendumBlock });
  const masterDocUrl = masterInfo.docUrl || buildGoogleDocUrl(documentId);

  if (plan.action === 'duplicate') {
    return {
      ok: true,
      action: 'duplicate',
      masterDocId: documentId,
      masterDocUrl,
      phaseKey: key,
      addendumId: addendumBlock.id,
    };
  }

  await docsClient.batchUpdate(documentId, plan.requests);
  await storageArea.set({
    [MASTER_KEY]: {
      ...masterInfo,
      docUrl: masterDocUrl,
      updatedAt,
    },
  });

  return {
    ok: true,
    action: 'appended',
    masterDocId: documentId,
    masterDocUrl,
    phaseKey: key,
    addendumId: addendumBlock.id,
    backup: null,
    updatedAt,
  };
}

function normalizeAddendumBlock(block) {
  if (!block || typeof block.text !== 'string' || !block.marker || !block.id) {
    throw new Error('addendumBlock is required');
  }
  return {
    id: String(block.id),
    marker: String(block.marker),
    text: block.text,
    headingStyle: block.headingStyle || 'HEADING_3',
    headingStartOffset: Number(block.headingStartOffset) || 0,
    headingEndOffset: Number(block.headingEndOffset) || 0,
  };
}

function requirePhaseKey(value) {
  const key = normalizeSectionKey(value);
  if (!key) throw new Error('phaseKey is required');
  return key;
}

function normalizeContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('リサーチ結果が空です');
  return text.replace(/\r\n?/g, '\n');
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function assertDependencies({ docsClient }) {
  if (!docsClient || typeof docsClient.getDocument !== 'function' || typeof docsClient.batchUpdate !== 'function') {
    throw new Error('docsClient.getDocument and docsClient.batchUpdate are required');
  }
}
