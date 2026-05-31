/**
 * Gemini.gs — Sheets/Docs から Gemini API を呼ぶカスタム関数
 *
 * 前提:
 *   - Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に
 *     GEMINI_API_KEY を保存しておく（無料枠で取得可: https://ai.google.dev/）
 *   - 通信先: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * 使い方:
 *   セルに =GEMINI("3階建てモデルとは？") と入力
 *   第2引数でモデル指定: =GEMINI("...", "gemini-2.5-flash")
 *   第3引数で温度指定:   =GEMINI("...", , 0.2)
 *
 * 利用可能なモデル（2026-04時点）:
 *   - gemini-2.5-flash       : 高速・標準（Free 250 RPD）
 *   - gemini-2.5-flash-lite  : 軽量・高速（Free 1000 RPD）
 *   - gemini-2.5-pro         : 高品質・思考型（Free 上限低め）
 *
 * 制約:
 *   - レート制限はGoogle側に依存（Free tier: Flash 250 RPD / Flash-Lite 1000 RPD）
 *   - カスタム関数はキャッシュされる（同じ引数の再評価は走らない）
 *   - 機微情報を投げないこと
 */

const SK_GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const SK_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Geminiにプロンプトを投げて応答テキストを返す。
 * @param {string} prompt 送信するプロンプト
 * @param {string=} model モデル名（省略時 gemini-flash-latest）
 * @param {number=} temperature 0.0〜1.0（省略時 0.4）
 * @return {string} Gemini のテキスト応答
 * @customfunction
 */
function GEMINI(prompt, model, temperature) {
  if (!prompt || String(prompt).trim() === '') return '';
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return '[ERROR] GEMINI_API_KEY がスクリプトプロパティに未設定です。プロジェクトの設定→スクリプトプロパティに追加してください。';
  }

  const m = model || SK_GEMINI_DEFAULT_MODEL;
  const t = typeof temperature === 'number' ? temperature : 0.4;

  const url = `${SK_GEMINI_ENDPOINT}/${m}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
    const out = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    return out || '[ERROR] empty response';
  } catch (e) {
    return '[ERROR] parse: ' + e.message;
  }
}

/**
 * 表全体に対する一括Gemini処理（横展開用）。
 * Sheets で範囲渡し: =GEMINI_BATCH(A2:A10, "次の事業ヒアリングメモを3行で要約: ")
 * 各セルにプレフィックス＋セル値を投げて結果を縦に並べる。
 * @param {string|string[][]} range セルまたは範囲
 * @param {string=} prefix 各プロンプトの先頭に付ける指示文
 * @param {string=} model モデル名
 * @return {string[][]}
 * @customfunction
 */
function GEMINI_BATCH(range, prefix, model) {
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
      r.push(GEMINI((prefix || '') + String(cell), model));
    }
    out.push(r);
  }
  return out;
}
