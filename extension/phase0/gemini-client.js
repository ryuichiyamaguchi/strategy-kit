import { postGeminiProxy } from './apps-script-client.js';

export const GEMINI_API_KEY_KEY = 'sk_gemini_api_key_v012';
export const GEMINI_PROXY_KEY = 'sk_gemini_proxy_v012';
export const GEMINI_PROXY_TOKEN_KEY = 'sk_gemini_proxy_token_v012';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
export { DEFAULT_IMAGE_MODEL as DEFAULT_GEMINI_IMAGE_MODEL };
const IMAGE_MODEL_FALLBACKS = ['gemini-2.5-flash-image'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// AI プロバイダ選択（v0.12〜）。後方互換のため未設定時は常に 'gemini' とみなす。
export const PROVIDER_TYPE_KEY = 'sk_provider_type_v012';
export const DEEPSEEK_API_KEY_KEY = 'sk_deepseek_api_key_v012';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
export const DEEPSEEK_REASONER_MODEL = 'deepseek-reasoner';
const DEEPSEEK_BASE = 'https://api.deepseek.com/chat/completions';

function getChromeStorage(area) {
  return globalThis.chrome?.storage?.[area] || null;
}

export function buildGenerateContentRequest({
  prompt,
  temperature = 0.3,
  responseModalities,
  responseFormat,
} = {}) {
  const generationConfig = { temperature };
  if (Array.isArray(responseModalities) && responseModalities.length) {
    generationConfig.responseModalities = responseModalities;
  }
  if (responseFormat) {
    generationConfig.responseFormat = responseFormat;
  }

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(prompt || '') }],
      },
    ],
    generationConfig,
  };
}

export function extractGenerateContentParts(json) {
  return json?.candidates?.[0]?.content?.parts || [];
}

export function extractGenerateContentText(json) {
  const parts = extractGenerateContentParts(json);
  return parts.map((part) => part.text || '').join('');
}

export function extractGenerateContentImages(json) {
  return extractGenerateContentParts(json)
    .map((part) => {
      const inlineData = part?.inlineData || part?.inline_data;
      if (inlineData?.data) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
        const data = inlineData.data;
        return {
          mimeType,
          data,
          dataUrl: `data:${mimeType};base64,${data}`,
        };
      }
      const fileData = part?.fileData || part?.file_data;
      const uri = fileData?.fileUri || fileData?.file_uri;
      if (uri) {
        return {
          mimeType: fileData.mimeType || fileData.mime_type || 'image/png',
          uri,
          dataUrl: uri,
        };
      }
      return null;
    })
    .filter(Boolean);
}

export async function getGeminiApiKey({ storage = getChromeStorage('local') } = {}) {
  if (!storage?.get) return '';
  const stored = await storage.get([GEMINI_API_KEY_KEY]);
  return String(stored?.[GEMINI_API_KEY_KEY] || '').trim();
}

export async function getGeminiProxyConfig({
  storage = getChromeStorage('local'),
  syncStorage = getChromeStorage('sync'),
} = {}) {
  if (!syncStorage?.get || !storage?.get) {
    return { proxy: null, token: '' };
  }
  const [syncStored, localStored] = await Promise.all([
    syncStorage.get([GEMINI_PROXY_KEY]),
    storage.get([GEMINI_PROXY_TOKEN_KEY]),
  ]);
  const proxy = syncStored?.[GEMINI_PROXY_KEY] || null;
  const token = String(localStored?.[GEMINI_PROXY_TOKEN_KEY] || '').trim();
  if (!proxy?.webAppUrl || !token) {
    return { proxy: null, token: '' };
  }
  return { proxy, token };
}

// 選択中のプロバイダ種別を返す。デフォルトは 'gemini'（未設定・不明値も 'gemini'）。
// 保存先は sync を基本に、無ければ local をフォールバック確認する。
export async function getSelectedProvider({
  storage = getChromeStorage('local'),
  syncStorage = getChromeStorage('sync'),
} = {}) {
  let raw = '';
  if (syncStorage?.get) {
    // proxy key も同時に読むことで、後続の proxy 設定読み込みと同じ get 形状を保ち
    // 既存テスト/挙動（sync の get 呼び出し）に影響を与えない。
    const synced = await syncStorage.get([PROVIDER_TYPE_KEY, GEMINI_PROXY_KEY]);
    raw = String(synced?.[PROVIDER_TYPE_KEY] || '').trim();
  }
  if (!raw && storage?.get) {
    // local 側も既存の token 読み込みと同じ get 形状に揃える。
    const local = await storage.get([PROVIDER_TYPE_KEY, GEMINI_PROXY_TOKEN_KEY]);
    raw = String(local?.[PROVIDER_TYPE_KEY] || '').trim();
  }
  return raw === 'deepseek' ? 'deepseek' : 'gemini';
}

export async function getDeepSeekApiKey({ storage = getChromeStorage('local') } = {}) {
  if (!storage?.get) return '';
  const stored = await storage.get([DEEPSEEK_API_KEY_KEY]);
  return String(stored?.[DEEPSEEK_API_KEY_KEY] || '').trim();
}

// 渡された model を DeepSeek 用に正規化する。
// 既に 'deepseek-' で始まるならそのまま。gemini 系/未知の場合、
// 'pro'(区切り境界) または 'reasoner' を含むなら reasoner、それ以外は chat。
// ※ 'preview' は image モデル名(gemini-3.1-flash-image-preview)にも含まれるため
//    単独では reasoner 判定に使わない(誤判定回避)。
function normalizeDeepSeekModel(model) {
  const name = String(model || '').trim().toLowerCase();
  if (name.startsWith('deepseek-')) return model;
  if (/(^|-)pro(-|$)|reasoner/.test(name)) return DEEPSEEK_REASONER_MODEL;
  return DEFAULT_DEEPSEEK_MODEL;
}

async function generateDeepSeek({
  prompt,
  model,
  temperature = 0.3,
  apiKey,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(DEEPSEEK_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: String(prompt || '') }],
      temperature,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    const err = new Error('DeepSeek API HTTP ' + res.status + ': ' + body.slice(0, 240));
    err.status = res.status;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('DeepSeek 応答の解析に失敗しました: ' + body.slice(0, 120));
  }
  return {
    ok: true,
    text: String(json?.choices?.[0]?.message?.content || ''),
    parts: [],
    images: [],
    raw: json,
    mode: 'deepseek',
  };
}

async function generateDirect({
  prompt,
  model,
  temperature,
  responseModalities,
  responseFormat,
  apiKey,
  fetchImpl,
}) {
  const res = await fetchImpl(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(buildGenerateContentRequest({
      prompt,
      temperature,
      responseModalities,
      responseFormat,
    })),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini API HTTP ${res.status}: ${text.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }

  const json = JSON.parse(text);
  return {
    ok: true,
    text: extractGenerateContentText(json),
    parts: extractGenerateContentParts(json),
    images: extractGenerateContentImages(json),
    raw: json,
    mode: 'direct',
  };
}

async function generateViaProxy({
  prompt,
  model,
  temperature = 0.3,
  responseModalities,
  responseFormat,
  fetchImpl = fetch,
  proxy,
  token,
}) {
  const generationConfig = buildGenerateContentRequest({
    prompt,
    temperature,
    responseModalities,
    responseFormat,
  }).generationConfig;
  const json = await postGeminiProxy(proxy.webAppUrl, {
    action: 'generateContent',
    token,
    prompt,
    model,
    temperature,
    generationConfig,
  }, { fetchImpl });
  const raw = json.raw || json;
  return {
    ok: true,
    text: String(json.text || extractGenerateContentText(raw)),
    parts: extractGenerateContentParts(raw),
    images: extractGenerateContentImages(raw),
    raw,
    mode: 'proxy',
    proxy,
  };
}

const RETRIABLE_GEMINI_STATUS = /Gemini API HTTP (?:429|500|502|503|504)\b/;

// 503(高需要)・429(レート)・5xx・ネットワーク系は一時的なので自動リトライ対象。
// 404(モデル不在)などの恒久エラーは対象外＝即失敗させて無駄に待たない。
function isRetriableGeminiError(error) {
  // ステータスコードが取れる場合は本文に依存せず確定判定(404 等を誤ってリトライしない)。
  const status = error && error.status;
  if (typeof status === 'number') {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }
  // status の無い proxy/ネットワーク系エラーは文言で判定。
  const msg = String((error && error.message) || '');
  if (RETRIABLE_GEMINI_STATUS.test(msg)) return true;
  return /unavailable|high demand|overloaded|timeout|network|fetch failed|failed to fetch|networkerror|ECONNRESET/i.test(msg);
}

function defaultGeminiSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGenerateContentOnce({
  prompt,
  model = DEFAULT_GEMINI_MODEL,
  temperature = 0.3,
  responseModalities,
  responseFormat,
} = {}, {
  storage = getChromeStorage('local'),
  syncStorage = getChromeStorage('sync'),
  fetchImpl = fetch,
} = {}) {
  // プロバイダが 'deepseek' かつ DeepSeek キーありなら DeepSeek を使う。
  // それ以外（'gemini'・未設定・キー無し）は従来の proxy→Gemini 経路を一切変更せず実行。
  const provider = await getSelectedProvider({ storage, syncStorage });
  if (provider === 'deepseek') {
    const deepSeekKey = await getDeepSeekApiKey({ storage });
    if (deepSeekKey) {
      return await generateDeepSeek({
        prompt,
        model: normalizeDeepSeekModel(model),
        temperature,
        apiKey: deepSeekKey,
        fetchImpl,
      });
    }
  }

  const { proxy, token } = await getGeminiProxyConfig({ storage, syncStorage });
  if (proxy && token) {
    try {
      return await generateViaProxy({
        prompt,
        model,
        temperature,
        responseModalities,
        responseFormat,
        fetchImpl,
        proxy,
        token,
      });
    } catch (proxyError) {
      const apiKey = await getGeminiApiKey({ storage });
      if (!apiKey) {
        throw proxyError;
      }
      return await generateDirect({
        prompt,
        model,
        temperature,
        responseModalities,
        responseFormat,
        apiKey,
        fetchImpl,
      });
    }
  }

  const apiKey = await getGeminiApiKey({ storage });
  if (!apiKey) {
    throw new Error('Gemini API key または Gemini proxy が未設定です。Optionsで設定するか、手動AI挿入を使ってください。');
  }

  return await generateDirect({
    prompt,
    model,
    temperature,
    responseModalities,
    responseFormat,
    apiKey,
    fetchImpl,
  });
}

// 503/429/5xx/ネットワーク系の一時エラーは指数バックオフ(1.5s→3s→6s)で自動リトライ。
// 成功時は即返るので従来挙動と同一。maxRetries/baseDelayMs/sleepImpl は注入可能(テスト用)。
export async function generateContent(params = {}, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1500,
    sleepImpl = defaultGeminiSleep,
  } = options;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runGenerateContentOnce(params, options);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetriableGeminiError(error)) throw error;
      await sleepImpl(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

export async function generateSummary({
  prompt,
  model = DEFAULT_GEMINI_MODEL,
  temperature = 0.2,
} = {}, options = {}) {
  return generateContent({ prompt, model, temperature }, options);
}

// 画像生成。各候補モデルを generateContent 経由で呼ぶため、503/429/5xx/ネットワーク等の
// 一時エラーは generateContent 内の指数バックオフ(isRetriableGeminiError)で自動リトライされる。
// リトライを尽くしても一時エラーなら、それは「混雑が続いている」状態なので即 throw して
// 上位(diagram.js)の手動 fallback に委ねる(別モデルに移っても混雑解消の保証がないため暴走させない)。
// 404(モデル不在)のみ isModelNotFoundError で次の候補モデルへフォールバックする。
// → リトライ(一時エラー)とモデルフォールバック(恒久エラー=404)は判定が排他で二重暴走しない。
// maxRetries/baseDelayMs/sleepImpl は options 経由で generateContent にそのまま伝わる(テスト注入可能)。
export async function generateImage({
  prompt,
  model = DEFAULT_IMAGE_MODEL,
  temperature = 0.2,
  responseModalities = ['TEXT', 'IMAGE'],
  responseFormat,
} = {}, options = {}) {
  const models = [model].concat(IMAGE_MODEL_FALLBACKS.filter((candidate) => candidate !== model));
  let lastError = null;
  for (const candidateModel of models) {
    try {
      return await generateContent({
        prompt,
        model: candidateModel,
        temperature,
        responseModalities,
        responseFormat,
      }, options);
    } catch (error) {
      lastError = error;
      // 404 以外(リトライ後も残る一時エラー含む)はモデルを変えても解決しないので即失敗。
      if (!isModelNotFoundError(error)) throw error;
    }
  }
  throw lastError;
}

function isModelNotFoundError(error) {
  const message = String(error?.message || error || '');
  return /model not found|not found.*model|404/i.test(message);
}
