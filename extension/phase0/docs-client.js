// docs-client.js
import { fetchWithAuth } from './auth.js';
import { ApiError } from './errors.js';

const DOCS_BASE = 'https://docs.googleapis.com/v1';

export async function createDocument(title) {
  const res = await fetchWithAuth(`${DOCS_BASE}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ title }),
  });
  if (res.status !== 200) {
    throw new ApiError('documents.create', res.status, await res.text());
  }
  const json = await res.json();
  return { documentId: json.documentId, revisionId: json.revisionId, raw: json };
}

export async function batchUpdate(documentId, requests) {
  const url = `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`;
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ requests }),
  });
  if (res.status !== 200) {
    throw new ApiError('documents.batchUpdate', res.status, await res.text());
  }
  const json = await res.json();
  return { replies: json.replies, raw: json };
}

export async function getDocument(documentId, { fields } = {}) {
  const url = new URL(`${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`);
  if (fields) url.searchParams.set('fields', fields);
  const res = await fetchWithAuth(url.toString(), { method: 'GET' });
  if (res.status !== 200) {
    throw new ApiError('documents.get', res.status, await res.text());
  }
  return await res.json();
}
