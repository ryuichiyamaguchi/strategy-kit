import {
  collectSectionMarkers,
  normalizeSectionKey,
} from './section-state.js';
import { computeEndIndex, getTextInRange } from './docs-sections.js';
import { buildGoogleDocUrl } from './draft-manager.js';

const MASTER_KEY = 'sk_master_doc_v012';
const VALID_STATUSES = new Set(['done', 'failed', 'todo', 'partial']);

export function buildMasterSectionBlock({
  sectionKey,
  displayKey,
  title,
  body = '',
  status = 'done',
  aiUsed = '',
  errorCode = '',
  errorMessage = '',
  updatedAt,
} = {}) {
  const key = requireSectionKey(sectionKey);
  // 見出しに出す「番号」は displayKey（表示専用・§7-4 等の実番号）を優先し、無ければ内部キー key。
  // SK-SECTION / SK-STATUS マーカー・章順比較・retry 突合は全て key（内部キー=sectionNo）のまま
  // なので、既存 §7-2 文書との互換（マーカー一致で in-place 置換）を壊さない。
  const headingKey = (displayKey != null && String(displayKey).trim()) ? String(displayKey).trim() : key;
  const safeStatus = VALID_STATUSES.has(status) ? status : 'done';
  const safeTitle = String(title || '').trim() || '(無題)';
  const heading = `§${headingKey}. ${safeTitle}\n`;
  const statusMarker = buildStatusMarker({
    key,
    status: safeStatus,
    updatedAt,
    aiUsed,
    errorCode,
  });
  const content = safeStatus === 'failed'
    ? buildFailureBody(errorMessage)
    : normalizeBody(body);
  const lines = [
    '',
    heading.trimEnd(),
    statusMarker,
    content,
    `[最終更新: ${updatedAt || ''} ／ 担当: 自動]`,
    '',
  ];
  const text = lines.join('\n');

  return {
    text,
    headingStyle: 'HEADING_2',
    headingStartOffset: 1,
    headingEndOffset: 1 + heading.length,
    status: safeStatus,
  };
}

export function compareSectionKeys(a, b) {
  const partsA = sectionKeyParts(a);
  const partsB = sectionKeyParts(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function sectionKeyParts(value) {
  return String(value ?? '')
    .trim()
    .split('-')
    .map((part) => {
      const num = Number(part);
      return Number.isFinite(num) ? num : 0;
    });
}

export function buildMasterSectionWriteRequests(doc, {
  sectionKey,
  sectionBlock,
} = {}) {
  const key = requireSectionKey(sectionKey);
  const block = normalizeSectionBlock(sectionBlock);
  const markers = collectSectionMarkers(doc);

  const sameKey = markers.filter((marker) => marker['key'] === key);
  if (sameKey.length > 1) {
    throw new Error(`マスター内に §${key} marker が複数あります。重複を整理してから再実行してください`);
  }
  const existing = sameKey[0] || null;

  // 「正しい挿入位置」= 章番号順で自分より後ろに来る最小キーのマーカー startIndex。
  // 自分自身（同キー）は除外する。該当が無ければ末尾。
  const successor = markers
    .filter((marker) => marker !== existing && compareSectionKeys(marker['key'], key) > 0)
    .sort((a, b) => compareSectionKeys(a['key'], b['key']) || (a.startIndex - b.startIndex))[0] || null;
  const baseInsertIndex = successor ? successor.startIndex : computeEndIndex(doc);

  const headingBaseOffset = `\n[[SK-SECTION:§${key}]]`.length + block.headingStartOffset;
  const headingLength = block.headingEndOffset - block.headingStartOffset;

  const requests = [];

  // 既存ブロックを削除する範囲 [deleteStart, deleteEnd)。マーカー自体も含めて消す。
  let deleteStart = null;
  let deleteEnd = null;
  if (existing) {
    deleteStart = existing.startIndex;
    const laterInDoc = markers.find((marker) => marker.startIndex > existing.startIndex);
    deleteEnd = laterInDoc ? laterInDoc.startIndex : computeEndIndex(doc);
  }

  // 対象フェーズに後から追記されたリサーチブロックは、章の再実行時も保持する。
  // 通常本文は従来どおり置換するが、SK-RESEARCH-ADDENDUM 以降だけを
  // 新しい章ブロックの末尾へ戻し、深掘り結果の消失を防ぐ。
  const preservedResearch = existing
    ? extractResearchAddenda(doc, deleteStart, deleteEnd, key)
    : '';

  // 章ブロックは常にマーカー付きで丸ごと挿入する（移動を伴うため）。
  const insertText = `\n[[SK-SECTION:§${key}]]${block.text}${preservedResearch}`;

  // batchUpdate は配列順に逐次適用される。delete を先に適用し、
  // 挿入位置が削除範囲より後方なら削除長ぶんだけインデックスを補正する。
  let insertIndex = baseInsertIndex;
  if (existing && deleteEnd > deleteStart) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: deleteStart,
          endIndex: deleteEnd,
        },
      },
    });
    if (baseInsertIndex >= deleteEnd) {
      insertIndex = baseInsertIndex - (deleteEnd - deleteStart);
    }
  }

  requests.push({
    insertText: {
      location: { index: insertIndex },
      text: insertText,
    },
  });

  requests.push({
    updateParagraphStyle: {
      range: {
        startIndex: insertIndex + headingBaseOffset,
        endIndex: insertIndex + headingBaseOffset + headingLength,
      },
      paragraphStyle: {
        namedStyleType: block.headingStyle,
      },
      fields: 'namedStyleType',
    },
  });

  return requests;
}

export async function writeMasterSection({
  docsClient,
  storageArea = chrome.storage.sync,
  sectionKey,
  sectionNo,
  displayNo,
  title,
  body,
  status = 'done',
  aiUsed = '',
  errorCode = '',
  errorMessage = '',
  now = () => new Date(),
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function' || typeof docsClient.batchUpdate !== 'function') {
    throw new Error('docsClient.getDocument and docsClient.batchUpdate are required');
  }

  const key = requireSectionKey(sectionKey ?? sectionNo);
  const stored = await storageArea.get([MASTER_KEY]);
  const masterInfo = stored?.[MASTER_KEY] || null;
  const documentId = masterInfo?.documentId;
  if (!documentId) {
    throw new Error('マスター Doc 未設定。先にマスターを作成または選択してください');
  }

  const updatedAt = now().toISOString();
  const doc = await docsClient.getDocument(documentId);
  const sectionBlock = buildMasterSectionBlock({
    sectionKey: key,
    displayKey: displayNo, // 見出し表示専用（§7-4 等）。マーカー/突合キーは key のまま。
    title,
    body,
    status,
    aiUsed,
    errorCode,
    errorMessage,
    updatedAt,
  });
  const requests = buildMasterSectionWriteRequests(doc, {
    sectionKey: key,
    sectionBlock,
  });

  await docsClient.batchUpdate(documentId, requests);
  await storageArea.set({
    [MASTER_KEY]: {
      ...masterInfo,
      docUrl: masterInfo.docUrl || buildGoogleDocUrl(documentId),
      updatedAt,
    },
  });

  return {
    ok: true,
    masterDocId: documentId,
    masterDocUrl: masterInfo.docUrl || buildGoogleDocUrl(documentId),
    sectionKey: key,
    status: sectionBlock.status,
    updatedAt,
  };
}

function buildStatusMarker({ key, status, updatedAt, aiUsed, errorCode }) {
  const attrs = [
    `status=${status}`,
  ];
  if (updatedAt) attrs.push(`updatedAt=${formatAttrValue(updatedAt)}`);
  if (aiUsed) attrs.push(`ai=${formatAttrValue(aiUsed)}`);
  if (errorCode) attrs.push(`code=${formatAttrValue(errorCode)}`);
  return `[[SK-STATUS:§${key} ${attrs.join(' ')}]]`;
}

function normalizeBody(body) {
  const text = String(body || '').trim();
  return text || '（未保存）';
}

function buildFailureBody(errorMessage) {
  const reason = String(errorMessage || '').trim() || '不明なエラー';
  return `⚠ 生成失敗 — 理由: ${reason}`;
}

function normalizeSectionBlock(block) {
  if (!block || typeof block.text !== 'string') {
    throw new Error('sectionBlock.text is required');
  }
  return {
    text: block.text,
    headingStyle: block.headingStyle || 'HEADING_2',
    headingStartOffset: Number.isFinite(block.headingStartOffset) ? block.headingStartOffset : 0,
    headingEndOffset: Number.isFinite(block.headingEndOffset) ? block.headingEndOffset : 0,
  };
}

function extractResearchAddenda(doc, startIndex, endIndex, sectionKey) {
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex) || endIndex <= startIndex) return '';
  const phaseKey = String(sectionKey).split('-')[0];
  const text = getTextInRange(doc, startIndex, endIndex);
  const marker = `[[SK-RESEARCH-ADDENDUM:phase=${phaseKey} `;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return '';
  return `\n${text.slice(markerIndex).trim()}\n`;
}

function requireSectionKey(value) {
  const key = normalizeSectionKey(value);
  if (!key) throw new Error('sectionKey is required');
  return key;
}

function formatAttrValue(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\[\]]/g, '');
}
