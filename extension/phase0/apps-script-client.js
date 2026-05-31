import { fetchWithAuth } from './auth.js';
import { ApiError } from './errors.js';

const SCRIPT_PROJECTS_BASE = 'https://script.googleapis.com/v1/projects';
const DEFAULT_PROXY_TITLE = 'Strategy Kit Gemini Proxy';
const DEFAULT_PROXY_DESCRIPTION = 'STRATEGY-KIT Gemini proxy web app';
const DEFAULT_PROXY_MODEL = 'gemini-3.5-flash';
const APPS_SCRIPT_USER_SETTINGS_URL = 'https://script.google.com/home/usersettings';

function contentHeaders() {
  return { 'Content-Type': 'application/json; charset=UTF-8' };
}

async function readJsonResponse(res, apiName) {
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const serviceError = buildAppsScriptServiceError(apiName, res.status, text);
    if (serviceError) throw serviceError;
    throw new ApiError(apiName, res.status, text);
  }
  return text ? JSON.parse(text) : {};
}

function buildAppsScriptServiceError(apiName, status, bodyText) {
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return null;
  }

  const error = parsed?.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  const joinedMessages = [
    error.message,
    ...details.map((detail) => detail?.message),
  ].filter(Boolean).join(' ');

  if (
    /User has not enabled the Apps Script API/i.test(joinedMessages) ||
    joinedMessages.includes(APPS_SCRIPT_USER_SETTINGS_URL) ||
    joinedMessages.includes('Apps Script API が有効になっていません')
  ) {
    const message = [
      'ユーザー設定で Apps Script API が無効です。',
      `${APPS_SCRIPT_USER_SETTINGS_URL} を開き、「Google Apps Script API」をオンにしてください。`,
      '設定後、反映まで数分待ってから再実行してください。',
    ].join(' ');
    const friendlyError = new Error(message);
    friendlyError.code = 'SCRIPT_API_USER_DISABLED';
    friendlyError.apiName = apiName;
    friendlyError.status = status;
    friendlyError.activationUrl = APPS_SCRIPT_USER_SETTINGS_URL;
    friendlyError.parsed = parsed;
    return friendlyError;
  }

  const serviceDisabled = details.find((detail) => (
    detail?.reason === 'SERVICE_DISABLED' &&
    (
      detail?.metadata?.service === 'script.googleapis.com' ||
      detail?.metadata?.serviceTitle === 'Apps Script API'
    )
  ));
  if (!serviceDisabled) return null;

  const activationUrl = serviceDisabled.metadata?.activationUrl || '';
  const projectId = String(serviceDisabled.metadata?.consumer || '')
    .replace(/^projects\//, '');
  const message = [
    `Apps Script API が無効です${projectId ? `（Google Cloud project: ${projectId}）` : ''}。`,
    'セキュア学習モードで Gemini proxy を作成するには、この project で Apps Script API を有効化してください。',
    activationUrl ? `有効化URL: ${activationUrl}` : '',
    '有効化後、反映まで数分待ってから再実行してください。',
  ].filter(Boolean).join(' ');

  const friendlyError = new Error(message);
  friendlyError.code = 'SCRIPT_API_DISABLED';
  friendlyError.apiName = apiName;
  friendlyError.status = status;
  friendlyError.activationUrl = activationUrl;
  friendlyError.parsed = parsed;
  return friendlyError;
}

export function buildProxyToken({
  cryptoImpl = globalThis.crypto,
  prefix = 'skp',
} = {}) {
  const bytes = new Uint8Array(24);
  if (cryptoImpl?.getRandomValues) {
    cryptoImpl.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const encoded = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${encoded}`;
}

export function buildBoundGeminiProxyFiles({ proxyToken = '__STRATEGY_KIT_PROXY_TOKEN__' } = {}) {
  const manifest = {
    timeZone: 'Asia/Tokyo',
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    oauthScopes: [
      'https://www.googleapis.com/auth/script.external_request',
    ],
    webapp: {
      access: 'ANYONE_ANONYMOUS',
      executeAs: 'USER_DEPLOYING',
    },
  };

  return [
    {
      name: 'Code',
      type: 'SERVER_JS',
      source: buildProxyCode({ proxyToken }),
    },
    {
      name: 'appsscript',
      type: 'JSON',
      source: JSON.stringify(manifest, null, 2),
    },
  ];
}

function buildProxyCode({ proxyToken }) {
  return `const GEMINI_API_KEY_PROP = 'GEMINI_API_KEY';
const GEMINI_API_KEY_PLACEHOLDER = 'PASTE_GEMINI_API_KEY_HERE';
const SK_PROXY_TOKEN_PROP = 'SK_PROXY_TOKEN';
const INITIAL_PROXY_TOKEN = ${JSON.stringify(proxyToken)};
const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_PROXY_MODEL)};

function doGet() {
  initializeProperties_();
  return json_({ ok: true, service: 'strategy-kit-gemini-proxy', configured: hasApiKey_() });
}

function authorizeOnce() {
  initializeProperties_();
  PropertiesService.getScriptProperties().setProperty('AUTHORIZED_AT', new Date().toISOString());
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis', { muteHttpExceptions: true });
}

function initializeProperties() {
  initializeProperties_();
}

function initializeProperties_() {
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperties();
  if (!Object.prototype.hasOwnProperty.call(current, GEMINI_API_KEY_PROP)) {
    props.setProperty(GEMINI_API_KEY_PROP, GEMINI_API_KEY_PLACEHOLDER);
  }
  if (!Object.prototype.hasOwnProperty.call(current, SK_PROXY_TOKEN_PROP)) {
    props.setProperty(SK_PROXY_TOKEN_PROP, INITIAL_PROXY_TOKEN);
  }
}

function doPost(e) {
  try {
    var payload = parsePayload_(e);
    var action = String(payload.action || '');
    if (action === 'status') return handleStatus_(payload);
    if (action === 'setupKey') return handleSetupKey_(payload);
    if (action === 'generateContent') return handleGenerateContent_(payload);
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message || error) });
  }
}

function handleStatus_(payload) {
  initializeProperties_();
  requireToken_(payload);
  return json_({ ok: true, configured: hasApiKey_() });
}

function handleSetupKey_(payload) {
  initializeProperties_();
  requireToken_(payload);
  var apiKey = String(payload.apiKey || '').trim();
  if (!apiKey) return json_({ ok: false, error: 'Gemini API key is required.' });
  var props = PropertiesService.getScriptProperties();
  props.setProperty(GEMINI_API_KEY_PROP, apiKey);
  props.setProperty(SK_PROXY_TOKEN_PROP, String(payload.token || ''));
  return json_({ ok: true, configured: true });
}

function handleGenerateContent_(payload) {
  initializeProperties_();
  requireToken_(payload);
  var apiKey = readGeminiApiKey_();
  if (!apiKey) return json_({ ok: false, error: 'Gemini API key is not configured.' });

  var model = String(payload.model || DEFAULT_MODEL);
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  var payloadGenerationConfig = payload.generationConfig && typeof payload.generationConfig === 'object'
    ? payload.generationConfig
    : {};
  var requestGenerationConfig = {
    temperature: Number(payload.temperature == null ? 0.3 : payload.temperature)
  };
  if (Array.isArray(payloadGenerationConfig.responseModalities) && payloadGenerationConfig.responseModalities.length) {
    requestGenerationConfig.responseModalities = payloadGenerationConfig.responseModalities;
  }
  if (payloadGenerationConfig.responseFormat && typeof payloadGenerationConfig.responseFormat === 'object') {
    requestGenerationConfig.responseFormat = payloadGenerationConfig.responseFormat;
  }
  var requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(payload.prompt || '') }]
      }
    ],
    generationConfig: requestGenerationConfig
  };
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: { 'x-goog-api-key': apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify(requestBody)
  });
  var status = response.getResponseCode();
  var text = response.getContentText();
  if (status < 200 || status >= 300) {
    return json_({ ok: false, status: status, error: text.slice(0, 500) });
  }
  var raw = JSON.parse(text);
  return json_({ ok: true, text: extractText_(raw), raw: raw });
}

function parsePayload_(e) {
  var text = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  return JSON.parse(text);
}

function requireToken_(payload) {
  var token = String(payload.token || '');
  var expected = PropertiesService.getScriptProperties().getProperty(SK_PROXY_TOKEN_PROP) || INITIAL_PROXY_TOKEN;
  if (!token || token !== expected) throw new Error('Invalid proxy token.');
}

function readGeminiApiKey_() {
  var value = String(PropertiesService.getScriptProperties().getProperty(GEMINI_API_KEY_PROP) || '').trim();
  if (!value || value === GEMINI_API_KEY_PLACEHOLDER) return '';
  return value;
}

function hasApiKey_() {
  return !!readGeminiApiKey_();
}

function extractText_(json) {
  var parts = (((json || {}).candidates || [])[0] || {}).content;
  parts = parts && parts.parts ? parts.parts : [];
  return parts.map(function(part) { return part.text || ''; }).join('');
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
`;
}

export function extractWebAppUrl(deployment) {
  const entry = (deployment?.entryPoints || []).find((item) => item?.webApp?.url);
  return entry?.webApp?.url || '';
}

export async function createBoundGeminiProxy({
  masterDocId,
  title = DEFAULT_PROXY_TITLE,
  proxyToken = buildProxyToken(),
  now = () => new Date().toISOString(),
} = {}, {
  fetchWithAuthImpl = fetchWithAuth,
} = {}) {
  if (!masterDocId) throw new Error('masterDocId is required to create a bound proxy script.');

  const project = await readJsonResponse(await fetchWithAuthImpl(SCRIPT_PROJECTS_BASE, {
    method: 'POST',
    headers: contentHeaders(),
    body: JSON.stringify({ title, parentId: masterDocId }),
  }), 'script.projects.create');

  const scriptId = project.scriptId;
  if (!scriptId) throw new Error('Apps Script project was created without scriptId.');

  await readJsonResponse(await fetchWithAuthImpl(`${SCRIPT_PROJECTS_BASE}/${encodeURIComponent(scriptId)}/content`, {
    method: 'PUT',
    headers: contentHeaders(),
    body: JSON.stringify({ files: buildBoundGeminiProxyFiles({ proxyToken }) }),
  }), 'script.projects.updateContent');

  const version = await readJsonResponse(await fetchWithAuthImpl(`${SCRIPT_PROJECTS_BASE}/${encodeURIComponent(scriptId)}/versions`, {
    method: 'POST',
    headers: contentHeaders(),
    body: JSON.stringify({ description: 'Initial STRATEGY-KIT Gemini proxy version' }),
  }), 'script.projects.versions.create');

  const deployment = await readJsonResponse(await fetchWithAuthImpl(`${SCRIPT_PROJECTS_BASE}/${encodeURIComponent(scriptId)}/deployments`, {
    method: 'POST',
    headers: contentHeaders(),
    body: JSON.stringify({
      versionNumber: version.versionNumber,
      manifestFileName: 'appsscript',
      description: DEFAULT_PROXY_DESCRIPTION,
    }),
  }), 'script.projects.deployments.create');

  return {
    scriptId,
    deploymentId: deployment.deploymentId || '',
    webAppUrl: extractWebAppUrl(deployment),
    masterDocId,
    title,
    createdAt: now(),
    scriptUrl: `https://script.google.com/d/${encodeURIComponent(scriptId)}/edit`,
    raw: { project, version, deployment },
  };
}

export async function postGeminiProxy(webAppUrl, payload, {
  fetchImpl = fetch,
} = {}) {
  if (!webAppUrl) throw new Error('Gemini proxy URL is missing.');
  const res = await fetchImpl(webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini proxy HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    throw buildGeminiProxyNonJsonError(text);
  }
  if (json?.ok === false) {
    throw new Error(json.error || 'Gemini proxy returned an error.');
  }
  return json;
}

function extractHtmlTitle(text) {
  const match = String(text || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildGeminiProxyNonJsonError(text) {
  const body = String(text || '');
  const title = extractHtmlTitle(body);
  const isHtml = /<(?:!doctype|html|head|body|title)\b/i.test(body);
  if (!isHtml) {
    return new Error('Gemini proxy returned non-JSON. Open the Apps Script project and confirm deployment or first-run authorization.');
  }

  const needsAuthorization = /Authorization|required|承認|OAuth|Sign in|ログイン/i.test(body);
  const message = [
    `Apps Script proxy returned HTML instead of JSON${title ? ` (${title})` : ''}.`,
    needsAuthorization
      ? 'Apps Script の初回承認が未完了の可能性があります。Apps Script を開き、関数 authorizeOnce を1回実行して承認してから、proxy 実行確認を再実行してください。'
      : 'Web app のデプロイまたは URL が正しくない可能性があります。Apps Script のデプロイが有効で、/exec の Web app URL を使っているか確認してください。',
  ].join(' ');
  const error = new Error(message);
  error.code = 'GEMINI_PROXY_NON_JSON';
  error.responseTitle = title;
  return error;
}

export async function setupGeminiProxyKey({
  webAppUrl,
  proxyToken,
  apiKey,
} = {}, {
  fetchImpl = fetch,
} = {}) {
  return await postGeminiProxy(webAppUrl, {
    action: 'setupKey',
    token: proxyToken,
    apiKey,
  }, { fetchImpl });
}

export async function checkGeminiProxyStatus({
  webAppUrl,
  proxyToken,
} = {}, {
  fetchImpl = fetch,
} = {}) {
  return await postGeminiProxy(webAppUrl, {
    action: 'status',
    token: proxyToken,
  }, { fetchImpl });
}
