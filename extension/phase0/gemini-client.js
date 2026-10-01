import { postGeminiProxy } from './apps-script-client.js';

export const GEMINI_API_KEY_KEY = 'sk_gemini_api_key_v012';
export const GEMINI_PROXY_KEY = 'sk_gemini_proxy_v012';
export const GEMINI_PROXY_TOKEN_KEY = 'sk_gemini_proxy_token_v012';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export { DEFAULT_IMAGE_MODEL as DEFAULT_GEMINI_IMAGE_MODEL };
const IMAGE_MODEL_FALLBACKS = ['gemini-3-pro-image'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// DeepSeek（OpenAI 互換 API）。モデル名が 'deepseek-' で始まるときだけこちらへ流す。
// プロバイダ切替のスイッチを別に持たせないのは、選ぶ場所が2つあると
// 「モデルは DeepSeek なのにプロバイダは Gemini」という不一致が起きるため。
export const DEEPSEEK_API_KEY_KEY = 'sk_deepseek_api_key_v012';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_BASE = 'https://api.deepseek.com/chat/completions';
// ウェブ検索は Responses API 側でのみ提供される（サーバー実行の built-in ツール）。
// chat/completions には検索が無いため、検索が要る呼び出しだけこちらへ流す。
const DEEPSEEK_RESPONSES_BASE = 'https://api.deepseek.com/responses';

export function isDeepSeekModel(model) {
  return /^deepseek-/i.test(String(model == null ? '' : model).trim());
}

// 呼び出し側は Gemini 語彙（[{ google_search: {} }]）でツールを渡してくる。
// DeepSeek 側の語彙差はここで吸収し、呼び出し側を書き換えないで済むようにする。
export function wantsWebSearch(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    if (tool.google_search || tool.googleSearch || tool.web_search) return true;
    return /^web_search/.test(String(tool.type || ''));
  });
}

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

export async function getDeepSeekApiKey({ storage = getChromeStorage('local') } = {}) {
  if (!storage?.get) return '';
  const stored = await storage.get([DEEPSEEK_API_KEY_KEY]);
  return String(stored?.[DEEPSEEK_API_KEY_KEY] || '').trim();
}

// DeepSeek 生成（OpenAI 互換の chat/completions）。
// Gemini 専用の引数（responseModalities / tools）はここでは使えないため受け取らない。
// 画像生成とウェブ検索付き生成は呼び出し側が Gemini を選ぶ（下の runGenerateContentOnce 参照）。
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
      messages: [{ role: 'user', content: String(prompt == null ? '' : prompt) }],
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

// Responses API の出力から本文テキストを取り出す。
// SDK 便宜フィールド output_text があればそれを、無ければ output[].content[].text を連結する。
export function extractDeepSeekResponseText(json) {
  const direct = json?.output_text;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const output = Array.isArray(json?.output) ? json.output : [];
  const chunks = [];
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

// 実際にウェブ検索が走ったかを、応答から正直に判定する。
// 判定材料は2つ: (a) output に web_search 系のツール実行アイテムがある
//              (b) 本文の annotations に url_citation（引用元URL）がある
// どちらも取れないときは false を返し、UI は「Web検索なしで策定」と正直に表示する。
export function extractDeepSeekSearchTrace(json) {
  const output = Array.isArray(json?.output) ? json.output : [];
  const queries = [];
  const urls = [];
  let used = false;

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (/web_search/.test(type) || /web_search/.test(String(item.name || ''))) {
      used = true;
      const query = item.query
        || item.action?.query
        || item.arguments?.query;
      if (typeof query === 'string' && query.trim()) queries.push(query.trim());
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const note of annotations) {
        const url = note?.url || note?.url_citation?.url;
        if (typeof url === 'string' && url) {
          used = true;
          if (!urls.includes(url)) urls.push(url);
        }
      }
    }
  }
  return { used, queries, urls };
}

// DeepSeek + ウェブ検索（Responses API・サーバー側で検索が実行される）。
async function generateDeepSeekWithSearch({
  prompt,
  model,
  temperature = 0.3,
  apiKey,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(DEEPSEEK_RESPONSES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: String(prompt == null ? '' : prompt),
      temperature,
      tools: [{ type: 'web_search', name: 'web_search' }],
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    const err = new Error('DeepSeek Responses API HTTP ' + res.status + ': ' + body.slice(0, 240));
    err.status = res.status;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('DeepSeek 応答の解析に失敗しました: ' + body.slice(0, 120));
  }

  const trace = extractDeepSeekSearchTrace(json);
  return {
    ok: true,
    text: extractDeepSeekResponseText(json),
    parts: [],
    images: [],
    raw: json,
    mode: 'deepseek',
    grounded: trace.used,
    searchQueries: trace.queries,
    searchUrls: trace.urls,
  };
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
  // モデル名が deepseek-* のときだけ DeepSeek へ。それ以外は従来の proxy→Gemini 経路を変えない。
  // 画像生成（responseModalities に IMAGE）は DeepSeek に機能が無いので Gemini のまま流す
  // （generateImage は Gemini の画像モデルを渡してくるため、通常ここには来ない）。
  const wantsImage = Array.isArray(responseModalities)
    && responseModalities.some((m) => String(m).toUpperCase() === 'IMAGE');
  if (isDeepSeekModel(model) && !wantsImage) {
    const deepSeekKey = await getDeepSeekApiKey({ storage });
    if (!deepSeekKey) {
      throw new Error('DeepSeek API キーが未設定です。拡張の設定画面で DeepSeek のキーを入力するか、モデルを Gemini に戻してください。');
    }
    // 検索が要る呼び出しは Responses API（サーバー実行の web_search 付き）へ。
    // 検索が不要な通常生成は chat/completions のまま（全 DeepSeek モデルで使えるため）。
    if (wantsWebSearch(tools)) {
      return await generateDeepSeekWithSearch({
        prompt,
        model,
        temperature,
        apiKey: deepSeekKey,
        fetchImpl,
      });
    }
    return await generateDeepSeek({
      prompt,
      model,
      temperature,
      apiKey: deepSeekKey,
      fetchImpl,
    });
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
