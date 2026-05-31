import { buildGoogleDocUrl, parseGoogleDocId } from './draft-manager.js';

const MASTER_KEY = 'sk_master_doc_v012';

export async function setMasterDocFromUrl(url, {
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
  const title = doc?.title || 'STRATEGY-KIT Master';
  const masterInfo = {
    documentId,
    docUrl: buildGoogleDocUrl(documentId),
    title,
    source: 'manual-url',
    format: 'v012-full-port',
    updatedAt: now().toISOString(),
  };
  await storageArea.set({ [MASTER_KEY]: masterInfo });
  return {
    ok: true,
    masterDocId: documentId,
    masterDocUrl: masterInfo.docUrl,
    title,
    masterInfo,
  };
}

export async function getStoredMasterDocInfo({
  docsClient,
  storageArea = chrome.storage.sync,
} = {}) {
  if (!docsClient || typeof docsClient.getDocument !== 'function') {
    throw new Error('docsClient.getDocument is required');
  }

  const stored = await storageArea.get([MASTER_KEY]);
  const masterInfo = stored?.[MASTER_KEY] || null;
  const documentId = masterInfo?.documentId;
  if (!documentId) return { ok: true, exists: false };

  try {
    const doc = await docsClient.getDocument(documentId, { fields: 'documentId,title' });
    return {
      ok: true,
      exists: true,
      documentId,
      docUrl: masterInfo.docUrl || buildGoogleDocUrl(documentId),
      title: doc?.title || masterInfo.title || 'STRATEGY-KIT Master',
      masterInfo: {
        ...masterInfo,
        title: doc?.title || masterInfo.title || 'STRATEGY-KIT Master',
      },
    };
  } catch (error) {
    return {
      ok: true,
      exists: false,
      error: error?.message || String(error),
    };
  }
}

export function buildMasterTemplateText({
  phases = [],
  industryLabel = '',
  storeName = '',
} = {}) {
  const lines = [
    'STRATEGY-KIT Master Document',
    '',
    `業種: ${String(industryLabel || '').trim() || '（未設定）'}`,
    `店舗・屋号: ${String(storeName || '').trim() || '（未設定）'}`,
    '',
  ];

  for (const phase of phases || []) {
    const no = Number(phase?.no);
    if (!Number.isFinite(no)) continue;
    lines.push(`[[SK-SECTION:§${no}]]`);
    lines.push(`§${no}. ${phase.title || ''}`.trim());
    lines.push('（未保存）');
    lines.push('');
  }

  lines.push('[[SK-SECTION:§99]]');
  lines.push('§99. 決定ログ');
  lines.push('（未保存）');
  lines.push('');

  return lines.join('\n');
}

export async function createMasterDocument({
  docsClient,
  storageArea = chrome.storage.sync,
  phases = [],
  industryLabel = '',
  storeName = '',
  now = () => new Date(),
  title = '',
} = {}) {
  if (!docsClient || typeof docsClient.createDocument !== 'function' || typeof docsClient.batchUpdate !== 'function') {
    throw new Error('docsClient.createDocument and docsClient.batchUpdate are required');
  }

  const safeTitle = String(title || '').trim() || buildMasterTitle({ storeName, now });
  const created = await docsClient.createDocument(safeTitle);
  const documentId = created.documentId;
  const text = buildMasterTemplateText({ phases, industryLabel, storeName });
  await docsClient.batchUpdate(documentId, [
    {
      insertText: {
        location: { index: 1 },
        text,
      },
    },
  ]);

  const masterInfo = {
    documentId,
    docUrl: buildGoogleDocUrl(documentId),
    title: safeTitle,
    source: 'generated-template',
    format: 'v012-full-port',
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  await storageArea.set({ [MASTER_KEY]: masterInfo });
  return {
    ok: true,
    masterDocId: documentId,
    masterDocUrl: masterInfo.docUrl,
    title: safeTitle,
    masterInfo,
  };
}

function buildMasterTitle({ storeName, now }) {
  const date = now().toISOString().slice(0, 10);
  const name = String(storeName || '').trim();
  return `STRATEGY-KIT Master${name ? ` - ${name}` : ''} - ${date}`;
}
