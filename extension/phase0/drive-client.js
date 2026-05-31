// drive-client.js
import { fetchWithAuth } from './auth.js';
import { ApiError } from './errors.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export async function listFiles({ query, fields = 'files(id,name,mimeType,createdTime)', pageSize = 50 }) {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', fields);
  url.searchParams.set('pageSize', String(pageSize));
  const res = await fetchWithAuth(url.toString(), { method: 'GET' });
  if (res.status !== 200) {
    throw new ApiError('files.list', res.status, await res.text());
  }
  const json = await res.json();
  return { files: json.files || [], raw: json };
}

export async function getFile(fileId, { fields = 'id,name,mimeType,webViewLink' } = {}) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', fields);
  const res = await fetchWithAuth(url.toString(), { method: 'GET' });
  if (res.status !== 200) {
    throw new ApiError('files.get', res.status, await res.text());
  }
  return await res.json();
}

export async function copyFile(fileId, {
  name,
  parents,
  fields = 'id,name,mimeType,webViewLink,createdTime,modifiedTime',
} = {}) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/copy`);
  url.searchParams.set('fields', fields);
  const body = {
    ...(name ? { name } : {}),
    ...(parents && parents.length ? { parents } : {}),
  };
  const res = await fetchWithAuth(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new ApiError('files.copy', res.status, await res.text());
  }
  return await res.json();
}

export async function createFolder({ name, appProperties } = {}) {
  const res = await fetchWithAuth(`${DRIVE_BASE}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(appProperties ? { appProperties } : {}),
    }),
  });
  if (res.status !== 200) {
    throw new ApiError('files.createFolder', res.status, await res.text());
  }
  return await res.json();
}

export async function createMultipartFile({ name, mimeType, content, parents = [], appProperties } = {}) {
  const boundary = `strategy-kit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = {
    name,
    mimeType,
    ...(parents.length ? { parents } : {}),
    ...(appProperties ? { appProperties } : {}),
  };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}; charset=UTF-8`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', 'id,name,mimeType,webViewLink,createdTime,modifiedTime');
  const res = await fetchWithAuth(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (res.status !== 200) {
    throw new ApiError('files.createMultipart', res.status, await res.text());
  }
  return await res.json();
}

export function buildDriveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export function buildDriveFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}
