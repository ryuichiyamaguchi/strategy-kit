// STRATEGY-KIT — 運用ボードの Google 連携（Docs / Drive）
//
// 追加の OAuth 権限は使わない（drive.file のまま）。この権限で触れるのは
// 「この拡張で作ったファイル」だけなので、書き出し・共有・複製はすべて拡張が作ったファイルが対象。

import { fetchWithAuth } from './auth.js';
import { ApiError } from './errors.js';
import { batchUpdate, getDocument } from './docs-client.js';
import { computeEndIndex, findSectionRange, getSectionText } from './docs-sections.js';
import { copyFile, getFile } from './drive-client.js';
import { writeMasterSection } from './master-section-writer.js';
import { formatStateSheetRow, markdownToHtml, wrapHtmlDocument } from '../lib/ops-core.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const MASTER_KEY = 'sk_master_doc_v012';

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

export function buildDocUrl(id) {
  return `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
}

export function buildSheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

export async function getActiveMasterDoc({ syncStorage = chrome.storage.sync } = {}) {
  const stored = await syncStorage.get([MASTER_KEY]);
  const info = stored?.[MASTER_KEY] || null;
  if (!info?.documentId) return null;
  return { documentId: info.documentId, docUrl: info.docUrl || buildDocUrl(info.documentId), title: info.title || '' };
}

// 戦略書から章ごとの本文を読む。章が無い・空のときは空文字。
export async function readMasterSections(documentId, sectionNos = [], { docs = { getDocument } } = {}) {
  const doc = await docs.getDocument(documentId);
  const texts = {};
  for (const no of sectionNos) {
    const result = getSectionText(doc, Number(no), { allowLastSectionNo: 99 });
    const text = result.status === 'ok' ? result.text.trim() : '';
    texts[no] = /^（未保存）$/.test(text) ? '' : text;
  }
  return { doc, texts, title: doc?.title || '' };
}

// ---------------------------------------------------------------------------
// §98 案件ステートシートへの追記
// ---------------------------------------------------------------------------

const STATE_SHEET_TITLE = '§98. 案件ステートシート（数値と決定の正本）';
const STATE_SHEET_HEADER = '| 種別 | 内容（数値は逐語・単位付き） | 出典 | タグ | 更新日 |\n|---|---|---|---|---|';

// 生成済みの戦略書には §98 が無いことがある（§0〜§9＋§99 で作られるため）。
// 無ければ §99 の直前に §98 を作ってから行を足す。行の削除・書き換えはしない（追記のみ）。
export function buildStateSheetAppendRequests(doc, rows = []) {
  const lines = rows.map((r) => formatStateSheetRow(r)).join('\n');
  if (!lines) return [];
  const range = findSectionRange(doc, 98, { allowLastSectionNo: 99 });
  if (range.status === 'ok') {
    const existing = getSectionText(doc, 98, { allowLastSectionNo: 99 }).text || '';
    const needsHeader = !/\|\s*種別\s*\|/.test(existing);
    const text = `${needsHeader ? STATE_SHEET_HEADER + '\n' : ''}${lines}\n`;
    return [{ insertText: { location: { index: range.endIndex }, text } }];
  }
  if (range.status !== 'missing-current-marker') {
    throw new Error(`§98 の位置を特定できません（${range.status}）`);
  }
  const range99 = findSectionRange(doc, 99, { allowLastSectionNo: 99 });
  const marker99 = range99.markers?.find((m) => m.no === 99);
  const insertAt = marker99 ? marker99.startIndex : computeEndIndex(doc);
  const head = '[[SK-SECTION:§98]]\n';
  const text = `${head}${STATE_SHEET_TITLE}\n${STATE_SHEET_HEADER}\n${lines}\n\n`;
  const headingStart = insertAt + head.length;
  return [
    { insertText: { location: { index: insertAt }, text } },
    {
      updateParagraphStyle: {
        range: { startIndex: headingStart, endIndex: headingStart + STATE_SHEET_TITLE.length + 1 },
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType',
      },
    },
  ];
}

export async function appendStateSheetRows(documentId, rows = [], { docs = { getDocument, batchUpdate } } = {}) {
  if (!rows.length) return { ok: true, appended: 0 };
  const doc = await docs.getDocument(documentId);
  const requests = buildStateSheetAppendRequests(doc, rows);
  if (requests.length) await docs.batchUpdate(documentId, requests);
  return { ok: true, appended: rows.length };
}

// ---------------------------------------------------------------------------
// 書き出し（Google ドキュメント／スプレッドシートへの変換アップロード）
// ---------------------------------------------------------------------------

async function uploadConverted({ name, targetMime, mediaMime, content, parents = [] }) {
  const boundary = `sk-ops-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = { name, mimeType: targetMime, ...(parents.length ? { parents } : {}) };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mediaMime}; charset=UTF-8`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`;
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (res.status !== 200) throw new ApiError('files.create(convert)', res.status, await res.text());
  return await res.json();
}

// 戦略書と同じフォルダに置く（見つからなければマイドライブ直下）。
export async function resolveOutputParents(masterDocumentId) {
  if (!masterDocumentId) return [];
  try {
    const file = await getFile(masterDocumentId, { fields: 'id,parents' });
    return Array.isArray(file?.parents) ? file.parents.slice(0, 1) : [];
  } catch (_) {
    return [];
  }
}

export async function createDocFromMarkdown({ title, markdown, parents = [] }) {
  const html = wrapHtmlDocument(title, markdownToHtml(markdown));
  const file = await uploadConverted({ name: title, targetMime: GOOGLE_DOC_MIME, mediaMime: 'text/html', content: html, parents });
  return { id: file.id, url: file.webViewLink || buildDocUrl(file.id), name: file.name };
}

export async function createSheetFromCsv({ title, csv, parents = [] }) {
  const file = await uploadConverted({ name: title, targetMime: GOOGLE_SHEET_MIME, mediaMime: 'text/csv', content: csv, parents });
  return { id: file.id, url: file.webViewLink || buildSheetUrl(file.id), name: file.name };
}

// 既存のシートの中身を CSV で置き換える（運用ボード → シートへの同期）。
export async function replaceSheetWithCsv(fileId, csv) {
  const url = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,webViewLink`;
  const res = await fetchWithAuth(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/csv; charset=UTF-8' },
    body: csv,
  });
  if (res.status !== 200) throw new ApiError('files.update(csv)', res.status, await res.text());
  return await res.json();
}

// シート → CSV（チームがシートで更新した状態を取り込む）。先頭のシートだけが対象。
export async function exportSheetCsv(fileId) {
  const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fcsv`;
  const res = await fetchWithAuth(url, { method: 'GET' });
  if (res.status !== 200) throw new ApiError('files.export(csv)', res.status, await res.text());
  return await res.text();
}

// ---------------------------------------------------------------------------
// 共有（拡張で作ったファイルだけが対象）
// ---------------------------------------------------------------------------

export const SHARE_ROLES = Object.freeze({
  writer: '編集できる',
  commenter: 'コメントできる',
  reader: '閲覧のみ',
});

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

export async function shareFileWithEmail(fileId, { email, role = 'writer', message = '' } = {}) {
  if (!isValidEmail(email)) throw new Error('メールアドレスの形式が正しくありません: ' + email);
  if (!Object.prototype.hasOwnProperty.call(SHARE_ROLES, role)) throw new Error('共有の種類が不明です');
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions`);
  url.searchParams.set('sendNotificationEmail', 'true');
  if (message) url.searchParams.set('emailMessage', message);
  url.searchParams.set('fields', 'id,emailAddress,role');
  const res = await fetchWithAuth(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ type: 'user', role, emailAddress: String(email).trim() }),
  });
  if (res.status !== 200) throw new ApiError('permissions.create', res.status, await res.text());
  return await res.json();
}

export async function listFilePermissions(fileId) {
  const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,emailAddress,role,type,displayName)`;
  const res = await fetchWithAuth(url, { method: 'GET' });
  if (res.status !== 200) throw new ApiError('permissions.list', res.status, await res.text());
  const json = await res.json();
  return Array.isArray(json.permissions) ? json.permissions : [];
}

// ---------------------------------------------------------------------------
// 2周目: 戦略書を複製して、複製側だけを書き換える（1周目は残す）
// ---------------------------------------------------------------------------

export async function copyMasterForRound2(masterDocumentId, { name } = {}) {
  const parents = await resolveOutputParents(masterDocumentId);
  const copied = await copyFile(masterDocumentId, { name, parents });
  return { id: copied.id, url: buildDocUrl(copied.id), name: copied.name };
}

export async function writeSectionToDocument(documentId, { sectionNo, title, body, aiUsed = '' }) {
  // writeMasterSection は保存済みの戦略書を書き先にする作りなので、書き先だけ差し替える。
  const storageArea = {
    async get() {
      return { [MASTER_KEY]: { documentId, docUrl: buildDocUrl(documentId) } };
    },
    async set() {},
  };
  return writeMasterSection({
    docsClient: { getDocument, batchUpdate },
    storageArea,
    sectionNo: String(sectionNo),
    title,
    body,
    status: 'done',
    aiUsed,
  });
}
