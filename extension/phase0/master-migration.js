import { computeEndIndex } from './docs-sections.js';
import {
  collectSectionMarkers,
  normalizeSectionKey,
  parseStatusMarker,
} from './section-state.js';
import { buildGoogleDocUrl } from './draft-manager.js';

const MASTER_BACKUP_KEY = 'sk_master_backup_v012';
const IMPORTABLE_STATUSES = new Set(['done', 'failed']);
const FAILURE_ERROR_CODE = 'DRAFT_IMPORT_FAIL';

export function hasMasterSectionMarkers(doc) {
  return collectSectionMarkers(doc).length > 0;
}

export function extractDraftSections(doc, phases = []) {
  return collectDraftSectionCandidates(doc, phases)
    .filter((section) => IMPORTABLE_STATUSES.has(section.status))
    .map(toPublicSection);
}

export function buildDraftImportPlan({
  draftDoc,
  masterDoc,
  phases = [],
} = {}) {
  const candidates = collectDraftSectionCandidates(draftDoc, phases);
  const sections = candidates
    .filter((section) => IMPORTABLE_STATUSES.has(section.status))
    .map(toPublicSection);
  const masterFormat = hasMasterSectionMarkers(masterDoc) ? 'new' : 'legacy';

  return {
    ok: true,
    masterFormat,
    sections,
    hasImportableSections: sections.length > 0,
    skippedCount: candidates.length - sections.length,
    warnings: masterFormat === 'legacy'
      ? ['マスターに SK-SECTION marker がないため、既存本文を残して marker 付きセクションを末尾に追記します']
      : [],
  };
}

export async function importDraftToMaster({
  docsClient,
  driveClient,
  draftManager,
  masterDocManager,
  masterSectionWriter,
  storageArea = chrome.storage.sync,
  phases = [],
  now = () => new Date(),
} = {}) {
  assertImportDeps({ docsClient, driveClient, draftManager, masterDocManager, masterSectionWriter });

  const draftInfo = await draftManager.getStoredDraftInfo({
    docsClient,
    storageArea,
  });
  if (!draftInfo?.exists || !draftInfo.draftDocId) {
    throw new Error('DRAFT Doc 未設定。DRAFT URLを指定するか、新規作成してください');
  }

  const masterInfo = await masterDocManager.getStoredMasterDocInfo({
    docsClient,
    storageArea,
  });
  if (!masterInfo?.exists || !masterInfo.documentId) {
    throw new Error('マスター Doc 未設定。先にマスターを作成または選択してください');
  }

  const [draftDoc, masterDoc] = await Promise.all([
    docsClient.getDocument(draftInfo.draftDocId),
    docsClient.getDocument(masterInfo.documentId),
  ]);
  const plan = buildDraftImportPlan({ draftDoc, masterDoc, phases });
  if (!plan.sections.length) {
    return {
      ok: true,
      action: 'noop',
      importedCount: 0,
      failedCount: 0,
      sections: [],
      skippedCount: plan.skippedCount,
      masterFormat: plan.masterFormat,
      backup: null,
      draftDocUrl: draftInfo.draftDocUrl || buildGoogleDocUrl(draftInfo.draftDocId),
      masterDocUrl: masterInfo.docUrl || buildGoogleDocUrl(masterInfo.documentId),
      title: masterInfo.title || 'STRATEGY-KIT Master',
      warnings: plan.warnings,
    };
  }

  const backup = await createMasterBackupCopy({
    driveClient,
    storageArea,
    masterInfo: masterInfo.masterInfo || masterInfo,
    now,
  });

  const written = [];
  for (const section of plan.sections) {
    try {
      const result = await masterSectionWriter.writeMasterSection({
        docsClient,
        storageArea,
        sectionKey: section['key'],
        title: section.title,
        body: section.body,
        status: section.status,
        errorCode: section.status === 'failed' ? FAILURE_ERROR_CODE : '',
        errorMessage: section.errorMessage || '',
        aiUsed: 'draft-import',
        now,
      });
      written.push({
        key: section['key'],
        title: section.title,
        status: section.status,
        result,
      });
    } catch (cause) {
      // 途中失敗: フルロールバックは大工事のため行わない。done マーカー書き込みは冪等で
      // 再取り込みにより回復可能（永久損失ではない=RED ではない）ため、「どこまで書けたか」と
      // 復旧導線（再取り込みで冪等に続行 / 取り込み前バックアップ Doc あり）を伝えるエラーへ包む。
      throw buildPartialImportError({ cause, section, writtenCount: written.length, backup });
    }
  }

  const failedCount = plan.sections.filter((section) => section.status === 'failed').length;
  return {
    ok: true,
    action: 'imported',
    importedCount: plan.sections.length,
    failedCount,
    sections: written,
    skippedCount: plan.skippedCount,
    masterFormat: plan.masterFormat,
    backup,
    draftDocUrl: draftInfo.draftDocUrl || buildGoogleDocUrl(draftInfo.draftDocId),
    draftDocTitle: draftInfo.title || draftDoc?.title || 'DRAFT',
    masterDocUrl: masterInfo.docUrl || buildGoogleDocUrl(masterInfo.documentId),
    title: masterInfo.title || masterDoc?.title || 'STRATEGY-KIT Master',
    warnings: plan.warnings,
  };
}

export async function createMasterBackupCopy({
  driveClient,
  storageArea = chrome.storage.sync,
  masterInfo,
  now = () => new Date(),
} = {}) {
  if (!driveClient || typeof driveClient.copyFile !== 'function') {
    throw new Error('driveClient.copyFile is required');
  }
  const documentId = masterInfo?.documentId;
  if (!documentId) throw new Error('マスター Doc が未設定です');

  const createdAt = now().toISOString();
  const baseTitle = masterInfo.title || 'STRATEGY-KIT Master';
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const copied = await driveClient.copyFile(documentId, {
    name: '[BACKUP before draft import] ' + baseTitle + ' ' + timestamp,
  });
  const backup = {
    documentId: copied.id,
    docUrl: copied.webViewLink || buildGoogleDocUrl(copied.id),
    title: copied.name || '',
    sourceMasterDocumentId: documentId,
    reason: 'draft-import',
    createdAt,
  };
  await storageArea.set({ [MASTER_BACKUP_KEY]: backup });
  return backup;
}

// 途中失敗を「途中まで書き込み済み + 再取り込みで復旧可能」と伝わるエラーへ包む。
// UI 側 describeAutomationError は既定分岐で message を 120 字トリムするため、主要導線
// （再取り込みで復旧）を先頭へ寄せ、503/429 等の生ステータス語は本文に混ぜない
// （それらのキーワードで別分類に丸められ、復旧導線が消えるのを避ける）。原因は cause に保持。
function buildPartialImportError({ cause, section, writtenCount, backup } = {}) {
  const label = ('§' + (section?.['key'] || '') + ' ' + (section?.title || '')).trim().slice(0, 14);
  const message = 'DRAFT取り込みが途中で失敗しました（' + label + '）。'
    + 'マスターに' + writtenCount + '章書き込み済み・残り未適用。'
    + 'もう一度「取り込み」を押すと済んだ章は自動で置換され途中から復旧します'
    + '（取り込み前バックアップDoc作成済み）。';
  const error = new Error(message);
  error.code = FAILURE_ERROR_CODE;
  error.partialImport = true;
  error.writtenCount = writtenCount;
  error.failedSectionKey = section?.['key'] || '';
  error.backup = backup || null;
  error.cause = cause;
  return error;
}

function collectDraftSectionCandidates(doc, phases = []) {
  const titleMap = buildSectionTitleMap(phases);
  const markerCandidates = extractMarkerDraftSectionCandidates(doc, titleMap);
  const markerKeys = new Set(markerCandidates.map((section) => section['key']));
  const legacyCandidates = extractLegacyDraftSectionCandidates(doc, titleMap)
    .filter((section) => !markerKeys.has(section['key']));

  const byKey = new Map();
  for (const candidate of markerCandidates.concat(legacyCandidates).sort((a, b) => a.startIndex - b.startIndex)) {
    const previous = byKey.get(candidate['key']);
    if (!previous || shouldReplaceCandidate(previous, candidate)) {
      byKey.set(candidate['key'], candidate);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.startIndex - b.startIndex);
}

function extractMarkerDraftSectionCandidates(doc, titleMap) {
  const markers = collectSectionMarkers(doc);
  const endIndex = computeEndIndex(doc);
  return markers.map((marker, index) => {
    const sectionKey = marker['key'];
    const next = markers[index + 1];
    const rawBody = getStructuralTextInRange(doc, marker.markerEndIndex, next ? next.startIndex : endIndex);
    return buildDraftSectionCandidate({
      key: sectionKey,
      fallbackTitle: titleMap.get(sectionKey) || '',
      rawBody,
      startIndex: marker.startIndex,
      source: 'marker',
    });
  });
}

function extractLegacyDraftSectionCandidates(doc, titleMap) {
  const sections = [];
  let current = null;

  function commitCurrent() {
    if (!current) return;
    sections.push(buildDraftSectionCandidate({
      key: current['key'],
      fallbackTitle: titleMap.get(current['key']) || current.title,
      rawBody: current.bodyChunks.join(''),
      startIndex: current.startIndex,
      source: 'legacy-heading',
      headingTitle: current.title,
    }));
    current = null;
  }

  for (const block of doc?.body?.content || []) {
    const text = getParagraphText(block);
    const heading = parseLegacyHeading(text.trim());
    if (heading && typeof block.startIndex === 'number') {
      commitCurrent();
      current = {
        key: heading['key'],
        title: heading.title,
        bodyChunks: [],
        startIndex: block.startIndex,
      };
      const remainder = getTextAfterFirstLine(text);
      if (remainder) current.bodyChunks.push(remainder);
      continue;
    }
    if (!current) continue;
    current.bodyChunks.push(getStructuralElementText(block));
  }

  commitCurrent();
  return sections;
}

function buildDraftSectionCandidate({
  key,
  fallbackTitle,
  rawBody,
  startIndex,
  source,
  headingTitle = '',
} = {}) {
  const sectionKey = normalizeSectionKey(key);
  const titleFromBody = extractSectionTitle(rawBody, sectionKey);
  const title = headingTitle || titleFromBody || fallbackTitle || '(無題)';
  const body = normalizeImportBody(rawBody, sectionKey);
  const statusMarker = findStatusMarkerForKey(rawBody, sectionKey);
  const failure = parseGeneratedError(rawBody, body);
  const status = classifyDraftSectionStatus({
    key: sectionKey,
    body,
    failure,
    statusMarker,
  });

  return {
    key: sectionKey,
    title,
    body: status === 'failed' ? '' : body,
    status,
    errorMessage: status === 'failed' ? (failure.message || statusMarker?.code || 'DRAFT import detected generated error section') : '',
    startIndex: Number.isFinite(startIndex) ? startIndex : 0,
    source,
  };
}

function classifyDraftSectionStatus({ key, body, failure, statusMarker }) {
  if (!key || key === '99' || key.startsWith('-')) return 'skipped';
  if (statusMarker?.status === 'failed') return 'failed';
  if (failure.isGeneratedErrorOnly) return 'failed';
  if (body) return 'done';
  return 'todo';
}

function shouldReplaceCandidate(previous, candidate) {
  const previousImportable = IMPORTABLE_STATUSES.has(previous.status);
  const candidateImportable = IMPORTABLE_STATUSES.has(candidate.status);
  if (candidateImportable && !previousImportable) return true;
  if (!candidateImportable && previousImportable) return false;
  return candidate.startIndex > previous.startIndex;
}

function toPublicSection(section) {
  return {
    key: section['key'],
    title: section.title,
    body: section.body,
    status: section.status,
    errorMessage: section.errorMessage || '',
    source: section.source,
  };
}

function buildSectionTitleMap(phases = []) {
  const map = new Map();
  for (const phase of phases || []) {
    const phaseKey = normalizeSectionKey(phase?.no);
    if (!phaseKey) continue;
    if (phase.title) map.set(phaseKey, String(phase.title).trim());
    const prompts = Array.isArray(phase?.prompts) ? phase.prompts : [];
    prompts.forEach((prompt, index) => {
      const subKey = phaseKey + '-' + (index + 1);
      if (prompt?.label) map.set(subKey, String(prompt.label).trim());
    });
  }
  return map;
}

function parseLegacyHeading(text) {
  const match = String(text || '').trim().match(/^(?:[#＃]+\s*)?§\s*(-?\d+(?:-\d+)?)\s*[.．]\s*([^\n]*)/);
  if (!match) return null;
  const sectionKey = normalizeSectionKey(match[1]);
  if (!sectionKey) return null;
  return {
    key: sectionKey,
    title: String(match[2] || '').trim(),
  };
}

function extractSectionTitle(rawBody, sectionKey) {
  const headingRe = new RegExp('^§\\s*' + escapeRegExp(sectionKey) + '\\s*[.．]\\s*(.+)$');
  for (const line of String(rawBody || '').split('\n')) {
    const match = line.trim().match(headingRe);
    if (match) return match[1].trim();
  }
  return '';
}

function normalizeImportBody(rawBody, sectionKey) {
  const headingRe = new RegExp('^(?:[#＃]+\\s*)?§\\s*' + escapeRegExp(sectionKey) + '\\s*[.．]\\s*.*$');
  return String(rawBody || '')
    .replace(/\[\[SK-SECTION:§-?\d+(?:-\d+)?\]\]/g, '')
    .replace(/\[\[SK-STATUS:§-?\d+(?:-\d+)?[^\]]*\]\]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (headingRe.test(trimmed)) return false;
      if (/^[（(]\s*未保存\s*[）)]$/.test(trimmed)) return false;
      if (/^`?\[最終更新/.test(trimmed)) return false;
      if (/^（生成AI:/.test(trimmed)) return false;
      if (/^[（(]生成エラー[）)]$/.test(trimmed)) return false;
      if (/^理由\s*[:：]/.test(trimmed)) return false;
      if (/^reason\s*[:：]/i.test(trimmed)) return false;
      if (/^この章は\s*primary CTA\s*から埋め直せます/.test(trimmed)) return false;
      if (/^⚠\s*生成失敗/.test(trimmed)) return false;
      if (isTemplateScaffoldLine(trimmed)) return false;
      if (isTemplateTableLine(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function parseGeneratedError(rawBody, normalizedBody) {
  const source = String(rawBody || '');
  const hasFailureSignal = /[（(]生成エラー[）)]|生成失敗|Finance Gate 不合格|primary CTA から埋め直せます/.test(source);
  if (!hasFailureSignal) return { isGeneratedErrorOnly: false, message: '' };

  const message = extractFailureMessage(source);
  return {
    isGeneratedErrorOnly: !String(normalizedBody || '').trim(),
    message,
  };
}

function extractFailureMessage(source) {
  const text = String(source || '');
  const reason = text.match(/(?:理由|reason)\s*[:：]\s*([^\n]+)/i);
  if (reason) return reason[1].trim().slice(0, 200);
  const generated = text.match(/生成失敗\s*[-—]\s*理由\s*[:：]\s*([^\n]+)/);
  if (generated) return generated[1].trim().slice(0, 200);
  const finance = text.match(/Finance Gate 不合格[^\n]*/);
  if (finance) return finance[0].trim().slice(0, 200);
  return 'DRAFT import detected generated error section';
}

function findStatusMarkerForKey(text, sectionKey) {
  const source = String(text || '');
  const matches = source.match(/\[\[SK-STATUS:§-?\d+(?:-\d+)?[^\]]*\]\]/g) || [];
  let found = null;
  for (const markerText of matches) {
    const parsed = parseStatusMarker(markerText);
    if (parsed?.['key'] === sectionKey) found = parsed;
  }
  return found;
}

function getStructuralTextInRange(doc, startIndex, endIndex) {
  const chunks = [];
  for (const block of doc?.body?.content || []) {
    if (typeof block?.startIndex !== 'number' || typeof block?.endIndex !== 'number') continue;
    if (block.endIndex <= startIndex || block.startIndex >= endIndex) continue;
    if (block.paragraph) {
      chunks.push(getParagraphTextInRange(block, startIndex, endIndex));
      continue;
    }
    chunks.push(getStructuralElementText(block));
  }
  return chunks.join('');
}

function getParagraphTextInRange(block, startIndex, endIndex) {
  const chunks = [];
  for (const elem of block?.paragraph?.elements || []) {
    if (typeof elem?.startIndex !== 'number' || typeof elem?.endIndex !== 'number') continue;
    if (elem.endIndex <= startIndex || elem.startIndex >= endIndex) continue;
    const text = elem?.textRun?.content || '';
    const sliceStart = Math.max(0, startIndex - elem.startIndex);
    const sliceEnd = Math.min(text.length, endIndex - elem.startIndex);
    chunks.push(text.slice(sliceStart, sliceEnd));
  }
  return chunks.join('');
}

function getParagraphText(block) {
  const elements = block?.paragraph?.elements || [];
  return elements.map((element) => element?.textRun?.content || '').join('');
}

function getTextAfterFirstLine(text) {
  const source = String(text || '');
  const newlineIndex = source.indexOf('\n');
  if (newlineIndex < 0) return '';
  return source.slice(newlineIndex + 1);
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

function parseMarkdownTableLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return [];
  if (/^\|[\s\-:|]+\|$/.test(text)) return [];
  return text
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
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

function assertImportDeps({ docsClient, driveClient, draftManager, masterDocManager, masterSectionWriter }) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }
  if (!driveClient || typeof driveClient.copyFile !== 'function') {
    throw new Error('driveClient.copyFile is required');
  }
  if (!draftManager || typeof draftManager.getStoredDraftInfo !== 'function') {
    throw new Error('draftManager.getStoredDraftInfo is required');
  }
  if (!masterDocManager || typeof masterDocManager.getStoredMasterDocInfo !== 'function') {
    throw new Error('masterDocManager.getStoredMasterDocInfo is required');
  }
  if (!masterSectionWriter || typeof masterSectionWriter.writeMasterSection !== 'function') {
    throw new Error('masterSectionWriter.writeMasterSection is required');
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
