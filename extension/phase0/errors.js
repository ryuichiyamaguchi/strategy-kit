// phase0/errors.js (Phase 0.1)
// auth.js と docs-client.js / drive-client.js から共通参照されるエラー class 定義

export class AuthError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.code = code;           // "F-1" | "F-2" | "F-3"
    this.cause = cause;
  }
}

export class ApiError extends Error {
  constructor(apiName, status, bodyText) {
    super(`${apiName} failed: HTTP ${status} ${bodyText}`);
    this.apiName = apiName;     // "documents.create" | "documents.batchUpdate" | "documents.get" | "files.list"
    this.status = status;
    this.bodyText = bodyText;
    this.parsed = tryParseJson(bodyText);
  }
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
