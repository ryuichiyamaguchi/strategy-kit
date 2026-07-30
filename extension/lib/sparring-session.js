// STRATEGY-KIT — 壁打ちセッション（純ロジック）
//
// 全画面コマンドセンターの壁打ち欄が使う、DOM も chrome API も触らない部分。
//   - 会話履歴の保持・トリム
//   - Gemini へ送る「平坦化プロンプト」の合成
//   - 無料枠の消費量（リクエスト回数・送信文字数）の集計
//
// なぜ平坦化するか:
//   phase0/gemini-client.js の buildGenerateContentRequest は contents に user パート
//   1件を固定で作る。セキュア学習モードの proxy（Apps Script）も受け取るのは prompt
//   文字列1本だけ。contents を配列化すると Apps Script の再デプロイが必要になり、
//   既に proxy を配った受講者を壊す。履歴を1本の文字列へ畳めば direct / proxy の
//   どちらでも同じコードが動き、Apps Script は無改修で済む。
//   （API は元々ステートレスで毎回全履歴を送るので、送信量は multi-turn 化しても
//     変わらない。失うのは role の区別だけで、それは見出しで代替できる。）

export const SPARRING_MODE_AI = 'ai';
export const SPARRING_MODE_MANUAL = 'manual';
export const DEFAULT_SPARRING_MODE = SPARRING_MODE_AI;

// 会話が長引いても止めない（設計判断: 上限で打ち切らず、促すだけ）。
// ただし storage を無制限に太らせないため、保持する発言数と1発言の長さには蓋をする。
export const MAX_TURNS = 80;
export const MAX_TURN_CHARS = 4000;
// この往復数を超えたら「そろそろ要約に進めますか」と促す（続けたい人は続けられる）。
export const SUMMARY_SUGGEST_AFTER = 20;

export const TRANSCRIPT_HEADING = '# これまでのやりとり';
export const INSTRUCTION_HEADING = '# いまやること';
export const AI_SPEAKER = 'AI';
export const USER_SPEAKER = '私';

const NEXT_QUESTION_INSTRUCTION = [
  '上のルールに従って続けてください。私の直前の回答を1行で確認してから、次の質問を1つだけ出してください。',
  '挨拶や前置き、ここまでのまとめは不要です。まだ要約は出さないでください。',
].join('\n');

const SUMMARY_INSTRUCTION = [
  'ヒアリングはここで終わりです。もう質問は出さないでください。',
  'ここまでの私の回答だけを根拠に、上の【出力フォーマット】の8セクションでヒアリング要約を出力してください。',
  '回答から読み取れないことは推測で埋めず「要確認」に分けてください。',
].join('\n');

const MANUAL_CONTINUATION_INSTRUCTION = [
  '上のルールと、ここまでのやりとりを引き継いで、ヒアリングの続きをしてください。',
  '私の直前の回答を1行で確認してから、次の質問を1つだけ出してください。',
  '私が「要約して」と言ったら、上の【出力フォーマット】の8セクションでヒアリング要約を出力してください。',
].join('\n');

// 案件ごとの保存キー。mission.js の automationDraftKey と同じ作法にそろえる
// （project-workspace.js の退避キー一覧に足す必要がなく、案件切替の仕組みに触らない）。
export function sparringStorageKey(projectId) {
  const id = String(projectId || '').trim();
  return id
    ? `sk-state.projects.${id}.hearing.sparring`
    : 'sk-state.hearing.sparring';
}

export function normalizeSparringMode(value) {
  return value === SPARRING_MODE_MANUAL ? SPARRING_MODE_MANUAL : SPARRING_MODE_AI;
}

function trimTurnText(value) {
  const text = String(value == null ? '' : value).trim();
  return text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) : text;
}

function normalizeTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = trimTurnText(raw.text);
  if (!text) return null;
  return {
    role: raw.role === 'user' ? 'user' : 'ai',
    text,
    ts: Number(raw.ts) || 0,
  };
}

export function createSparringSession({
  mode = DEFAULT_SPARRING_MODE,
  basePrompt = '',
  items = [],
  now = Date.now,
} = {}) {
  const at = typeof now === 'function' ? now() : Number(now) || 0;
  return {
    mode: normalizeSparringMode(mode),
    status: 'idle',
    basePrompt: String(basePrompt || ''),
    items: Array.isArray(items) ? items.map((item) => String(item)) : [],
    turns: [],
    requestCount: 0,
    sentChars: 0,
    summaryDraft: '',
    startedAt: at,
    updatedAt: at,
  };
}

// storage から読んだ値を必ず扱える形にそろえる（壊れた値で画面が落ちないように）。
export function normalizeSparringSession(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const turns = (Array.isArray(source.turns) ? source.turns : [])
    .map(normalizeTurn)
    .filter(Boolean)
    .slice(-MAX_TURNS);
  return {
    mode: normalizeSparringMode(source.mode),
    status: typeof source.status === 'string' ? source.status : 'idle',
    basePrompt: String(source.basePrompt || ''),
    items: Array.isArray(source.items) ? source.items.map((item) => String(item)) : [],
    turns,
    requestCount: Math.max(0, Number(source.requestCount) || 0),
    sentChars: Math.max(0, Number(source.sentChars) || 0),
    summaryDraft: String(source.summaryDraft || ''),
    startedAt: Number(source.startedAt) || 0,
    updatedAt: Number(source.updatedAt) || 0,
  };
}

// モーダル③（項目策定→項目確認）から全画面へ引き継ぐときのレコードを作る。
// 進行中の会話は消さない。壁打ち中は「確定済み要約が無い」状態なので、全自動の
// 実行を押すたびにヒアリングゲートを通る。毎回作り直すと十数往復した会話が無警告で
// 消えるため、既存の会話があるときは項目と基本プロンプトだけ差し替える。
// やりとりの方法（mode）は案件ごとの設定なので、既存の値を必ず引き継ぐ。
export function mergeHandoffSession(existing, { basePrompt = '', items = [], now = Date.now } = {}) {
  const at = typeof now === 'function' ? now() : Number(now) || 0;
  const base = existing ? normalizeSparringSession(existing) : null;
  const nextItems = Array.isArray(items) ? items.map((item) => String(item)) : [];
  if (!base || !base.turns.length) {
    return {
      ...createSparringSession({ mode: base?.mode, basePrompt, items: nextItems, now }),
      // 会話が無くても、消費実績は案件の実測値なので引き継ぐ。
      requestCount: base?.requestCount || 0,
      sentChars: base?.sentChars || 0,
    };
  }
  return {
    ...base,
    basePrompt: String(basePrompt || ''),
    items: nextItems,
    status: 'running',
    updatedAt: at,
  };
}

export function hasSparringStarted(session) {
  const s = normalizeSparringSession(session);
  return !!s.basePrompt || s.turns.length > 0;
}

export function appendTurn(session, { role, text, now = Date.now } = {}) {
  const base = normalizeSparringSession(session);
  const turn = normalizeTurn({ role, text, ts: typeof now === 'function' ? now() : now });
  if (!turn) return base;
  const turns = base.turns.concat([turn]).slice(-MAX_TURNS);
  return { ...base, turns, updatedAt: turn.ts || base.updatedAt };
}

// AI を呼んだ実績を記録する（推定ではなく実測。表示もこの値をそのまま出す）。
// count は実際に飛んだ HTTP リクエスト数。generateContent の指数バックオフは
// 1回の送信を複数リクエストに増やし、proxy 設定者は proxy + direct で2発になり得る。
// 成功だけを1回として数えると、無料枠が尽きかけている局面に限って表示が実態から外れる。
export function recordRequest(session, { sentChars = 0, count = 1, now = Date.now } = {}) {
  const base = normalizeSparringSession(session);
  const requests = Math.max(1, Math.floor(Number(count) || 1));
  return {
    ...base,
    requestCount: base.requestCount + requests,
    sentChars: base.sentChars + Math.max(0, Number(sentChars) || 0),
    updatedAt: typeof now === 'function' ? now() : Number(now) || base.updatedAt,
  };
}

function transcriptLines(turns) {
  return turns.map((turn) => `${turn.role === 'user' ? USER_SPEAKER : AI_SPEAKER}: ${turn.text}`);
}

// 平坦化の共通形。
//   <基本プロンプト>
//
//   # これまでのやりとり
//   AI: …
//   私: …
//
//   # いまやること
//   <指示>
// 会話がまだ無いときは基本プロンプトだけを返す。1回目の送信内容が、いまコピー導線で
// 渡しているプロンプトと1文字も変わらないようにするため（既存の壁打ち品質を保つ）。
function flatten(session, instruction, extraTurns = []) {
  const base = normalizeSparringSession(session);
  const turns = base.turns.concat(extraTurns.map(normalizeTurn).filter(Boolean));
  const prompt = base.basePrompt.trim();
  if (!turns.length) return prompt;
  return [
    prompt,
    '',
    TRANSCRIPT_HEADING,
    ...transcriptLines(turns),
    '',
    INSTRUCTION_HEADING,
    instruction,
  ].join('\n');
}

// 次の質問を1つもらうためのプロンプト。userText を渡すと、その回答を履歴の末尾に
// 足した状態で組み立てる（session 側へ append する前に本文を確定できる）。
export function buildSparringPrompt(session, { userText = '' } = {}) {
  const answer = trimTurnText(userText);
  const extra = answer ? [{ role: 'user', text: answer }] : [];
  return flatten(session, NEXT_QUESTION_INSTRUCTION, extra);
}

// 要約ターン。基本プロンプト末尾の【出力フォーマット】をそのまま指す
// （8セクションの契約は hearing-readiness.js の単一ソースに従う）。
export function buildSummaryPrompt(session, { userText = '' } = {}) {
  const answer = trimTurnText(userText);
  const extra = answer ? [{ role: 'user', text: answer }] : [];
  const base = normalizeSparringSession(session);
  if (!base.turns.length && !extra.length) {
    // 会話が無い状態の要約はプロンプトだけでは成立しないので、指示を明示して付ける。
    return [base.basePrompt.trim(), '', INSTRUCTION_HEADING, SUMMARY_INSTRUCTION].join('\n');
  }
  return flatten(session, SUMMARY_INSTRUCTION, extra);
}

// 無料枠が尽きた／手動へ切り替えたときに、外部 AI で続きを再開するためのプロンプト。
// ここまでの会話を含めるので、途中まで進んだ壁打ちを捨てずに済む。
export function buildManualContinuationPrompt(session) {
  const base = normalizeSparringSession(session);
  if (!base.turns.length) return base.basePrompt.trim();
  return flatten(base, MANUAL_CONTINUATION_INSTRUCTION);
}

// 無料枠の見える化。無料枠は日ごとのリクエスト数（RPD）で切れるので、
// 主表示はトークン数ではなく「AI を何回呼んだか」にする。
export function describeSparringUsage(session) {
  const base = normalizeSparringSession(session);
  const exchanges = base.turns.filter((turn) => turn.role === 'user').length;
  const label = base.requestCount
    ? `${exchanges}往復 / AI呼び出し ${base.requestCount}回`
    : 'まだAIを呼んでいません';
  const detail = base.sentChars
    ? `送信した文字数 約${Math.round(base.sentChars / 1000).toLocaleString()}千字`
    : '';
  return {
    exchanges,
    requestCount: base.requestCount,
    sentChars: base.sentChars,
    label,
    detail,
  };
}

export function shouldSuggestSummary(session) {
  return describeSparringUsage(session).exchanges >= SUMMARY_SUGGEST_AFTER;
}

// 未設定かどうかは事前判定せず、実行時のエラー本文で判定する
// （事前判定の二重実装は「実生成は通るのに判定だけ落ちる」乖離バグを生む。automation.js 同様）。
export function isUnconfiguredError(error) {
  return /未設定/.test(String((error && error.message) || error || ''));
}

export function isQuotaError(error) {
  const message = String((error && error.message) || error || '');
  const status = error && typeof error.status === 'number' ? error.status : null;
  if (status === 429) return true;
  return /HTTP 429|quota|rate limit|free_tier/i.test(message);
}

// 失敗理由を、受講者が次の一手を選べる日本語にする（diagram.js の describeImageFailureReason と同じ作法）。
export function describeSparringFailure(error) {
  if (isUnconfiguredError(error)) {
    return 'AI 連携（Gemini API key または proxy）が未設定です。設定するか、やりとりの方法を「プロンプトをコピーして外部AIで」に切り替えてください。';
  }
  if (isQuotaError(error)) {
    return '無料枠の上限に達しました。数時間おいて再開するか、やりとりの方法を「プロンプトをコピーして外部AIで」に切り替えてください。ここまでの会話は残っています。';
  }
  const message = String((error && error.message) || error || '');
  if (/HTTP (?:500|502|503|504)|high demand|overloaded|unavailable/i.test(message)) {
    return 'Gemini 側が混雑しています。少し時間をおいて送り直すか、やりとりの方法を「プロンプトをコピーして外部AIで」に切り替えてください。';
  }
  return message
    ? `AI から返答を受け取れませんでした（${message}）。やりとりの方法を「プロンプトをコピーして外部AIで」に切り替えると、この続きを外部AIで進められます。`
    : 'AI から返答を受け取れませんでした。やりとりの方法を「プロンプトをコピーして外部AIで」に切り替えると、この続きを外部AIで進められます。';
}
