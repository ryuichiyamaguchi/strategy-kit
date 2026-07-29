import { postGeminiProxy } from './apps-script-client.js';

export const GEMINI_API_KEY_KEY = 'sk_gemini_api_key_v012';
export const GEMINI_PROXY_KEY = 'sk_gemini_proxy_v012';
export const GEMINI_PROXY_TOKEN_KEY = 'sk_gemini_proxy_token_v012';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export { DEFAULT_IMAGE_MODEL as DEFAULT_GEMINI_IMAGE_MODEL };
const IMAGE_MODEL_FALLBACKS = ['gemini-3-pro-image'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// 429 レスポンスの details[].quotaMetric を取り出す。
//   ..._input_token_count → 無料枠では呼べないモデル（モデルを変えるしかない）
//   ..._requests          → 一時的なレート上限（待てば直る）
export function extractQuotaMetric(text) {
  const match = /"quotaMetric"\s*:\s*"([^"]+)"/.exec(String(text || ''));
  return match ? match[1] : '';
}

function quotaMetricSuffix(text) {
  const metric = extractQuotaMetric(text);
  return metric ? ` quotaMetric=${metric}` : '';
}

function getChromeStorage(area) {
  return globalThis.chrome?.storage?.[area] || null;
}

export function buildGenerateContentRequest({
  prompt,
  model = '',
  temperature = 0.3,
  responseModalities,
  responseFormat,
  tools,
} = {}) {
  const generationConfig = { temperature };
  if (Array.isArray(responseModalities) && responseModalities.length) {
    generationConfig.responseModalities = responseModalities;
  }
  if (responseFormat) {
    generationConfig.responseFormat = responseFormat;
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: String(prompt || '') }],
      },
    ],
  };
  if (Object.keys(generationConfig).length) {
    body.generationConfig = generationConfig;
  }
  // tools（例: [{ google_search: {} }]）は指定時のみ body に載せる。
  // 未指定・空配列・非配列は付与せず、現行リクエストとバイト一致を維持する（後方互換）。
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
  }
  return body;
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

async function generateDirect({
  prompt,
  model,
  temperature,
  responseModalities,
  responseFormat,
  tools,
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
      model,
      temperature,
      responseModalities,
      responseFormat,
      tools,
    })),
  });

  const text = await res.text();
  if (!res.ok) {
    // 429 の本文は「無料枠では使えないモデル」と「一時的なレート上限」で同じ文面になり、
    // 違いは details[].quotaMetric だけ。本文の後ろのほうに出るので、切り詰めで
    // 落ちないよう先頭に付け直す（付けないと両者を取り違えて案内が噛み合わない）。
    const err = new Error(
      `Gemini API HTTP ${res.status}:${quotaMetricSuffix(text)} ${text.slice(0, 240)}`,
    );
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
  tools,
  fetchImpl = fetch,
  proxy,
  token,
}) {
  const generationConfig = buildGenerateContentRequest({
    prompt,
    model,
    temperature,
    responseModalities,
    responseFormat,
  }).generationConfig || {};
  const payload = {
    action: 'generateContent',
    token,
    prompt,
    model,
    temperature,
    generationConfig,
  };
  // tools（google_search 等）は指定時のみ payload に載せる。
  // 既存デプロイ済み proxy は tools を無視（不明キーはスルー）するため後方互換。
  // 将来の proxy 更新で grounding を有効化できるよう前方互換のために送る。
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
  }
  const json = await postGeminiProxy(proxy.webAppUrl, payload, { fetchImpl });
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
  tools,
} = {}, {
  storage = getChromeStorage('local'),
  syncStorage = getChromeStorage('sync'),
  fetchImpl = fetch,
} = {}) {
  const { proxy, token } = await getGeminiProxyConfig({ storage, syncStorage });
  if (proxy && token) {
    try {
      return await generateViaProxy({
        prompt,
        model,
        temperature,
        responseModalities,
        responseFormat,
        tools,
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
        tools,
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
    tools,
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
