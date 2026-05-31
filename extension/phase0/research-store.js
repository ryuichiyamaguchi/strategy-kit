import {
  buildDriveFolderUrl,
  createFolder,
  createMultipartFile,
  listFiles,
} from './drive-client.js';

const RESEARCH_FOLDER_KEY = 'sk_research_folder_v012';
const RESEARCH_FOLDER_NAME = 'STRATEGY-KIT research';

export function normalizeResearchNo(no) {
  const raw = String(no || 'NN').trim() || 'NN';
  if (/^\d+$/.test(raw)) return raw.padStart(2, '0');
  return raw;
}

export function buildResearchFileName({ no, type }) {
  return `research-${normalizeResearchNo(no)}-${String(type || 'note').trim() || 'note'}.md`;
}

export function buildResearchMarkdown({ no, type, title, content, createdAt = new Date().toISOString() }) {
  const normalizedNo = normalizeResearchNo(no);
  const safeType = String(type || 'note').trim() || 'note';
  const safeTitle = String(title || '').trim() || `${normalizedNo} ${safeType}`;
  return [
    '---',
    `no: "${escapeYamlString(normalizedNo)}"`,
    `type: "${escapeYamlString(safeType)}"`,
    `title: "${escapeYamlString(safeTitle)}"`,
    `createdAt: "${escapeYamlString(createdAt)}"`,
    '---',
    '',
    `# research-${normalizedNo}-${safeType}`,
    '',
    String(content || '').trim(),
    '',
  ].join('\n');
}

export async function ensureResearchFolder({
  storage = chrome.storage.sync,
  drive = { createFolder },
} = {}) {
  const stored = await storage.get([RESEARCH_FOLDER_KEY]);
  const existing = stored?.[RESEARCH_FOLDER_KEY];
  if (existing?.folderId) return existing;

  const folder = await drive.createFolder({
    name: RESEARCH_FOLDER_NAME,
    appProperties: { skType: 'research-folder', skVersion: 'v012' },
  });
  const folderInfo = {
    folderId: folder.id,
    folderUrl: folder.webViewLink || buildDriveFolderUrl(folder.id),
    createdAt: new Date().toISOString(),
  };
  await storage.set({ [RESEARCH_FOLDER_KEY]: folderInfo });
  return folderInfo;
}

export async function saveResearchMarkdown(input, {
  storage = chrome.storage.sync,
  drive = { createFolder, createMultipartFile },
} = {}) {
  const no = normalizeResearchNo(input?.no);
  const type = String(input?.type || 'note').trim() || 'note';
  const fileName = buildResearchFileName({ no, type });
  const content = buildResearchMarkdown({ ...input, no, type });
  const folder = await ensureResearchFolder({ storage, drive });
  const file = await drive.createMultipartFile({
    name: fileName,
    mimeType: 'text/markdown',
    content,
    parents: [folder.folderId],
    appProperties: { skType: 'research', skVersion: 'v012', no, type },
  });

  return {
    ok: true,
    fileId: file.id,
    fileName: file.name || fileName,
    fileUrl: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
    folderId: folder.folderId,
    folderUrl: folder.folderUrl,
  };
}

export async function listResearchFiles({
  storage = chrome.storage.sync,
  drive = { listFiles },
} = {}) {
  const folder = await ensureResearchFolder({ storage, drive });
  const result = await drive.listFiles({
    query: `'${folder.folderId}' in parents and trashed=false and appProperties has { key='skType' and value='research' }`,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,createdTime)',
    pageSize: 100,
  });

  return {
    ok: true,
    folderId: folder.folderId,
    folderUrl: folder.folderUrl,
    files: (result.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      url: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
      updated: file.modifiedTime || file.createdTime || '',
    })),
  };
}

function escapeYamlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
