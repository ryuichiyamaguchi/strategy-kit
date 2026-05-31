// auth.js (Phase 0.1, ES module)
import { AuthError } from './errors.js';

export async function getAuthToken({ interactive = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const lastError = chrome.runtime.lastError;
        const msg = lastError?.message || 'No token returned';
        if (msg.includes('OAuth2 not granted or revoked')) {
          return reject(new AuthError('F-1', msg, lastError));
        }
        if (msg.includes('user did not approve') || msg.includes('canceled')) {
          return reject(new AuthError('F-2', msg, lastError));
        }
        return reject(new AuthError('F-3', msg, lastError));
      }
      resolve(token);
    });
  });
}

export async function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

export async function fetchWithAuth(url, init = {}) {
  let token = await getAuthToken({ interactive: true });
  const headers = {
    ...(init.headers || {}),
    'Authorization': `Bearer ${token}`,
  };
  let res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    await removeCachedToken(token);
    token = await getAuthToken({ interactive: true });
    res = await fetch(url, {
      ...init,
      headers: { ...headers, 'Authorization': `Bearer ${token}` },
    });
  }
  return res;
}
