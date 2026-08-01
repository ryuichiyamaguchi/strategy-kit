import { batchUpdate, getDocument } from './docs-client.js';
import { computeEndIndex, findSectionRange, getSectionText } from './docs-sections.js';

export function chooseDecisionDocumentId({ masterDoc, draftDoc, chapterDoc } = {}) {
  return masterDoc?.documentId || chapterDoc?.documentId || draftDoc?.documentId || null;
}

export function buildDecisionEntry({ decision, reason, action, now = new Date() } = {}) {
  const lines = [
    '',
    `- ${formatLocalMinute(now)}`,
    `  - decision: ${String(decision || '').trim()}`,
  ];
  const trimmedReason = String(reason || '').trim();
  const trimmedAction = String(action || '').trim();
  if (trimmedReason) lines.push(`  - reason: ${trimmedReason}`);
  if (trimmedAction) lines.push(`  - action: ${trimmedAction}`);
  lines.push('');
  return lines.join('\n');
}

export function buildTimestampRefreshEntry({ now = new Date() } = {}) {
  return buildDecisionEntry({
    decision: 'timestamp refresh',
    reason: 'v0.12 direct Docs append',
    action: 'No full-chapter rewrite was performed',
    now,
  });
}

export function buildAppendDecisionRequests(doc, entryText) {
  const range = findSectionRange(doc, 99, { allowLastSectionNo: 99 });
  if (range.status === 'ok') {
    return [
      { insertText: { location: { index: range.endIndex }, text: entryText } },
    ];
  }

  if (range.status === 'missing-current-marker') {
    const endIndex = computeEndIndex(doc);
    return [
      {
        insertText: {
          location: { index: endIndex },
          text: `\n[[SK-SECTION:§99]]\n## §99 決定ログ\n${entryText}`,
        },
      },
    ];
  }

  throw new Error(`Cannot append decision log: ${range.status}`);
}

export async function appendDecisionLog(input, {
  storage = chrome.storage.sync,
  docs = { getDocument, batchUpdate },
} = {}) {
  const stored = await storage.get(['sk_master_doc_v012', 'sk_chapter_doc_v012', 'sk_draft_doc_v012']);
  const documentId = chooseDecisionDocumentId({
    masterDoc: stored.sk_master_doc_v012,
    draftDoc: stored.sk_draft_doc_v012,
    chapterDoc: stored.sk_chapter_doc_v012,
  });
  if (!documentId) throw new Error('マスタードキュメントが未作成です');

  const doc = await docs.getDocument(documentId);
  const entry = buildDecisionEntry(input);
  await docs.batchUpdate(documentId, buildAppendDecisionRequests(doc, entry));
  return {
    ok: true,
    documentId,
    date: formatLocalDate(input?.now || new Date()),
  };
}

export async function getDecisionLogText({
  storage = chrome.storage.sync,
  docs = { getDocument },
} = {}) {
  const stored = await storage.get(['sk_master_doc_v012', 'sk_chapter_doc_v012', 'sk_draft_doc_v012']);
  const documentId = chooseDecisionDocumentId({
    masterDoc: stored.sk_master_doc_v012,
    draftDoc: stored.sk_draft_doc_v012,
    chapterDoc: stored.sk_chapter_doc_v012,
  });
  if (!documentId) return { ok: true, documentId: null, text: '' };

  const doc = await docs.getDocument(documentId);
  const section = getSectionText(doc, 99, { allowLastSectionNo: 99 });
  return {
    ok: true,
    documentId,
    text: section.status === 'ok' ? section.text : '',
  };
}

export async function appendTimestampRefresh(input = {}, deps = {}) {
  return appendDecisionLog({
    decision: 'timestamp refresh',
    reason: 'v0.12 direct Docs append',
    action: 'No full-chapter rewrite was performed',
    now: input.now || new Date(),
  }, deps);
}

function formatLocalMinute(date) {
  const d = date instanceof Date ? date : new Date(date);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-') + ' ' + [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
  ].join(':');
}

function formatLocalDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}
