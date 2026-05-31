/**
 * Gemini.gs (Library 版) — Gemini API 呼出ヘルパ
 *
 * v0.11 のライブラリ版では、apiKey をライブラリ自身の ScriptProperties から
 * 取得すると受講者ごとに異なる API キーを扱えないため、apiKey を引数として
 * 受け取る `_geminiCall_(prompt, model, temperature, apiKey)` を提供する。
 *
 * 受講者がシート上で `=GEMINI(...)` を使いたい場合は、shim 側で以下のように
 * カスタム関数ラッパを定義する想定:
 *
 *   function GEMINI(prompt, model, temperature) {
 *     const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
 *     return StrategyKitLib.geminiCustom(prompt, model, temperature, apiKey);
 *   }
 *
 * 利用可能なモデル（2026-04時点）:
 *   - gemini-2.5-flash       : 高速・標準（Free 250 RPD）
 *   - gemini-2.5-flash-lite  : 軽量・高速（Free 1000 RPD）
 *   - gemini-2.5-pro         : 高品質・思考型（Free 上限低め）
 */

const SK_GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const SK_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini API 呼出（apiKey 引数化版）。ライブラリ内部から呼ばれる。
 * @param {string} prompt 送信するプロンプト
 * @param {string=} model モデル名
 * @param {number=} temperature 0.0〜1.0
 * @param {string} apiKey 受講者の GEMINI_API_KEY
 * @return {string} Gemini のテキスト応答（エラー時は '[ERROR] ...'）
 */
function _geminiCall_(prompt, model, temperature, apiKey) {
  if (!prompt || String(prompt).trim() === '') return '';
  if (!apiKey) {
    return '[ERROR] GEMINI_API_KEY が未指定です（受講者の Apps Script スクリプトプロパティに追加してください）';
  }

  const m = model || SK_GEMINI_DEFAULT_MODEL;
  const t = typeof temperature === 'number' ? temperature : 0.4;

  const url = SK_GEMINI_ENDPOINT + '/' + m + ':generateContent?key=' + encodeURIComponent(apiKey);
  const payload = {
    contents: [{ parts: [{ text: String(prompt) }] }],
    generationConfig: { temperature: t },
  };
  const opts = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let res;
  try {
    res = UrlFetchApp.fetch(url, opts);
  } catch (e) {
    return '[ERROR] fetch failed: ' + e.message;
  }

  const status = res.getResponseCode();
  if (status < 200 || status >= 300) {
    return '[ERROR] HTTP ' + status + ': ' + res.getContentText().slice(0, 240);
  }

  try {
    const json = JSON.parse(res.getContentText());
    const out = json && json.candidates && json.candidates[0] &&
                json.candidates[0].content && json.candidates[0].content.parts &&
                json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    return out || '[ERROR] empty response';
  } catch (e) {
    return '[ERROR] parse: ' + e.message;
  }
}

/**
 * 受講者の shim 側 GEMINI カスタム関数から委譲される公開 API。
 * @param {string} prompt
 * @param {string=} model
 * @param {number=} temperature
 * @param {string} apiKey 受講者の GEMINI_API_KEY
 * @return {string}
 */
function geminiCustom(prompt, model, temperature, apiKey) {
  return _geminiCall_(prompt, model, temperature, apiKey);
}

/**
 * 表全体に対する一括Gemini処理（横展開用）。受講者の shim 側で
 * GEMINI_BATCH カスタム関数として委譲して使う想定。
 * @param {string|string[][]} range
 * @param {string=} prefix
 * @param {string=} model
 * @param {string} apiKey
 * @return {string[][]}
 */
function geminiBatchCustom(range, prefix, model, apiKey) {
  if (!range) return [['']];
  const cells = Array.isArray(range) ? range : [[range]];
  const out = [];
  for (const row of cells) {
    const r = [];
    for (const cell of row) {
      if (!cell || String(cell).trim() === '') {
        r.push('');
        continue;
      }
      r.push(_geminiCall_((prefix || '') + String(cell), model, undefined, apiKey));
    }
    out.push(r);
  }
  return out;
}
