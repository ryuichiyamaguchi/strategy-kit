// phase0/phase0-smoke-test.js
import { getAuthToken } from './auth.js';
import { createDocument, batchUpdate, getDocument } from './docs-client.js';
import { listFiles } from './drive-client.js';
import { buildGoogleDocUrl } from './draft-manager.js';
import {
  buildMasterSectionBlock,
  buildMasterSectionWriteRequests,
  writeMasterSection,
} from './master-section-writer.js';
import { buildSectionState } from './section-state.js';

const RUN_LABEL = `phase 0.1 smoke test (${new Date().toISOString()})`;
const MASTER_KEY = 'sk_master_doc_v012';
const MASTER_SECTION_WRITER_SMOKE_SECTIONS = [
  { key: '0', title: 'Smoke done section' },
  { key: '1-1', title: 'Smoke failed subsection' },
];

export async function phase0SmokeTest() {
  const results = {
    G1_extensionId: null,
    G2_authToken: null,
    G3_create: null,
    G4_batchUpdate: null,
    G5_get: null,
    G6_listFiles: null,
    errors: [],
  };

  try {
    results.G1_extensionId = chrome.runtime.id;
    console.log('[G1] extension id:', results.G1_extensionId);

    const token = await getAuthToken({ interactive: true });
    results.G2_authToken = `${token.slice(0, 16)}...(redacted)`;
    console.log('[G2] OAuth ok, token prefix:', results.G2_authToken);

    const created = await createDocument(RUN_LABEL);
    results.G3_create = { documentId: created.documentId, revisionId: created.revisionId };
    console.log('[G3] documents.create ok:', created.documentId);

    const updateRes = await batchUpdate(created.documentId, [
      { insertText: { location: { index: 1 }, text: 'phase 0.1 smoke test marker [[SK-SECTION:§0]]\n' } },
    ]);
    results.G4_batchUpdate = { replies: updateRes.replies };
    console.log('[G4] batchUpdate ok');

    const doc = await getDocument(created.documentId);
    const hasBody = !!(doc.body && Array.isArray(doc.body.content) && doc.body.content.length > 0);
    const bodyText = hasBody ? JSON.stringify(doc.body) : '';
    const markerFound = bodyText.includes('[[SK-SECTION:§0]]');
    results.G5_get = { hasBody, revisionId: doc.revisionId, markerFound, raw: doc };
    console.log('[G5] documents.get ok, hasBody:', hasBody, ', markerFound:', markerFound);

    const listed = await listFiles({
      query: `mimeType='application/vnd.google-apps.document' and name contains 'phase 0.1 smoke test'`,
    });
    const found = listed.files.some((f) => f.id === created.documentId);
    results.G6_listFiles = { totalFiles: listed.files.length, foundCreatedDoc: found };
    console.log('[G6] files.list ok, foundCreatedDoc:', found);

    return results;
  } catch (e) {
    results.errors.push({ name: e.constructor.name, code: e.code, status: e.status, message: e.message, bodyText: e.bodyText });
    console.error('[phase0SmokeTest] failed:', e);
    return results;
  }
}

export async function masterSectionWriterSmokeTest({
  docsClient = { createDocument, batchUpdate, getDocument },
  storageArea = globalThis.chrome?.storage?.sync,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!docsClient || typeof docsClient.createDocument !== 'function' || typeof docsClient.batchUpdate !== 'function' || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.createDocument, docsClient.batchUpdate, and docsClient.getDocument are required');
  }
  if (!storageArea || typeof storageArea.get !== 'function' || typeof storageArea.set !== 'function') {
    throw new Error('chrome.storage.sync is required');
  }

  const runAt = now().toISOString();
  const title = `STRATEGY-KIT master-section-writer smoke ${runAt}`;
  const result = {
    ok: false,
    created: null,
    writeDone: null,
    writeFailed: null,
    sectionState: null,
    nextSectionOk: false,
    duplicateStop: null,
    headingCheck: {},
    storageRestored: false,
    errors: [],
  };
  const originalMaster = await readStoredMaster(storageArea);

  try {
    const created = await docsClient.createDocument(title);
    const documentId = created.documentId;
    const docUrl = buildGoogleDocUrl(documentId);
    result.created = { documentId, docUrl, title };
    logger.log('[M1] disposable master created:', docUrl);

    await docsClient.batchUpdate(documentId, [
      {
        insertText: {
          location: { index: 1 },
          text: buildMasterSectionWriterSmokeTemplate(),
        },
      },
    ]);
    logger.log('[M2] smoke master markers inserted');

    await storageArea.set({
      [MASTER_KEY]: {
        documentId,
        docUrl,
        title,
        source: 'master-section-writer-smoke',
        createdAt: runAt,
        updatedAt: runAt,
      },
    });

    const writerClient = {
      getDocument: docsClient.getDocument.bind(docsClient),
      batchUpdate: docsClient.batchUpdate.bind(docsClient),
    };
    result.writeDone = await writeMasterSection({
      docsClient: writerClient,
      storageArea,
      sectionKey: '0',
      title: 'Smoke done section',
      body: 'Smoke body written through master-section-writer.',
      status: 'done',
      aiUsed: 'smoke',
      now,
    });
    logger.log('[M3] writeMasterSection done section ok');

    result.writeFailed = await writeMasterSection({
      docsClient: writerClient,
      storageArea,
      sectionKey: '1-1',
      title: 'Smoke failed subsection',
      status: 'failed',
      aiUsed: 'smoke',
      errorCode: 'SMOKE_FAIL',
      errorMessage: 'smoke failure marker',
      now,
    });
    logger.log('[M4] writeMasterSection failed section ok');

    const readbackDoc = await docsClient.getDocument(documentId);
    result.sectionState = buildSectionState(readbackDoc, MASTER_SECTION_WRITER_SMOKE_SECTIONS);
    const next = result.sectionState.nextSection;
    result.nextSectionOk = next?.['key'] === '1-1' && next?.status === 'failed';
    logger.log('[M5] section-state nextSection:', next);

    result.duplicateStop = verifyDuplicateStop(readbackDoc, '1-1');
    logger.log('[M6] duplicate marker stop:', result.duplicateStop);

    result.headingCheck = buildHeadingCheck(readbackDoc);
    logger.log('[M7] heading styles:', result.headingCheck);

    result.ok = result.nextSectionOk
      && result.duplicateStop.ok
      && Object.values(result.headingCheck).every((item) => item.ok);
    logger.log('[M8] masterSectionWriterSmokeTest result:', result.ok ? 'PASS' : 'FAIL', docUrl);
  } catch (e) {
    result.errors.push(formatSmokeError(e));
    logger.error('[masterSectionWriterSmokeTest] failed:', e);
  } finally {
    await restoreStoredMaster(storageArea, originalMaster);
    result.storageRestored = true;
  }

  return result;
}

function buildMasterSectionWriterSmokeTemplate() {
  return [
    'STRATEGY-KIT disposable smoke master. You can delete this document after the test.',
    '',
    '[[SK-SECTION:§0]]',
    '(empty before smoke)',
    '',
    '[[SK-SECTION:§1-1]]',
    '(empty before smoke)',
    '',
  ].join('\n');
}

async function readStoredMaster(storageArea) {
  const stored = await storageArea.get([MASTER_KEY]);
  return stored?.[MASTER_KEY] || null;
}

async function restoreStoredMaster(storageArea, originalMaster) {
  if (originalMaster) {
    await storageArea.set({ [MASTER_KEY]: originalMaster });
    return;
  }
  if (typeof storageArea.remove === 'function') {
    await storageArea.remove([MASTER_KEY]);
    return;
  }
  await storageArea.set({ [MASTER_KEY]: null });
}

function verifyDuplicateStop(doc, sectionKey) {
  try {
    const duplicateDoc = appendDuplicateSectionMarker(doc, sectionKey);
    const sectionBlock = buildMasterSectionBlock({
      sectionKey,
      title: 'Duplicate stop smoke',
      body: 'This must not be written.',
      status: 'done',
      updatedAt: 'smoke',
    });
    buildMasterSectionWriteRequests(duplicateDoc, { sectionKey, sectionBlock });
    return { ok: false, message: 'duplicate marker was not rejected' };
  } catch (e) {
    return {
      ok: /marker が複数/.test(e.message),
      message: e.message,
    };
  }
}

function appendDuplicateSectionMarker(doc, sectionKey) {
  const clone = JSON.parse(JSON.stringify(doc || {}));
  if (!clone.body) clone.body = {};
  if (!Array.isArray(clone.body.content)) clone.body.content = [];
  const content = clone.body.content;
  const last = content[content.length - 1] || { endIndex: 1 };
  const startIndex = Math.max(1, last.endIndex || 1);
  const text = `\n[[SK-SECTION:§${sectionKey}]]\nduplicate marker for smoke\n`;
  content.push({
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex: startIndex + text.length,
          textRun: { content: text },
        },
      ],
    },
  });
  return clone;
}

function buildHeadingCheck(doc) {
  return {
    '0': buildHeadingStyleCheck(doc, '0', 'HEADING_2'),
    '1-1': buildHeadingStyleCheck(doc, '1-1', 'HEADING_2'),
  };
}

function buildHeadingStyleCheck(doc, sectionKey, expected) {
  const actual = findHeadingStyle(doc, sectionKey);
  return {
    expected,
    actual,
    ok: actual === expected,
  };
}

function findHeadingStyle(doc, sectionKey) {
  const prefix = `§${sectionKey}.`;
  for (const block of doc?.body?.content || []) {
    const paragraph = block?.paragraph;
    const text = (paragraph?.elements || [])
      .map((element) => element?.textRun?.content || '')
      .join('')
      .trimStart();
    if (text.startsWith(prefix)) {
      return paragraph?.paragraphStyle?.namedStyleType || '';
    }
  }
  return '';
}

function formatSmokeError(e) {
  return {
    name: e?.constructor?.name || 'Error',
    code: e?.code,
    status: e?.status,
    message: e?.message || String(e),
    bodyText: e?.bodyText,
  };
}

globalThis.phase0SmokeTest = phase0SmokeTest;
globalThis.masterSectionWriterSmokeTest = masterSectionWriterSmokeTest;
