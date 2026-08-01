// STRATEGY-KIT — 全画面コマンドセンターのヒアリング壁打ち欄 (mission.html)
//
// 壁打ちは §0 を直書きシードし、§1 以降の businessContext になる最上流の工程。
// これまでは「モーダルでプロンプトを作る → コピー → 別タブの AI に貼る → 要約を
// サイドパネルに戻す」という往復だった。この画面の中で完結させる。
//
// やりとりの方法は2つ。既定は ai（この画面で直接呼ぶ）。
//   ai     … 拡張が Gemini を呼ぶ。往復ぶん無料枠を使うので、呼んだ回数を常に出す。
//   manual … プロンプトをコピーして外部 AI で進め、要約だけこの画面に戻す。無料枠を使わない。
//
// AI 呼び出しはこの画面が自分で行う（サイドパネルへは投げない）。壁打ちは十数回
// 往復するので、往復ごとにサイドパネルを起こす設計は破綻しやすい。プロンプトの
// コピーを全画面側で実行しているのと同じ判断。
// ただし要約の確定だけはサイドパネルへ委譲する。保存には 6000 字検証・案件メタ生成・
// lastPhase 更新・再描画が要り、ここに再実装すると保存ロジックが二重化するため。

import { generateContent } from '../phase0/gemini-client.js';
import { buildWallbounceHearingPrompt } from '../phase0/hearing-readiness.js';
import {
  SPARRING_MODE_AI,
  SPARRING_MODE_MANUAL,
  appendTurn,
  buildManualContinuationPrompt,
  buildSparringPrompt,
  buildSummaryPrompt,
  createSparringSession,
  describeSparringFailure,
  describeSparringUsage,
  hasSparringStarted,
  isQuotaError,
  isUnconfiguredError,
  normalizeSparringMode,
  normalizeSparringSession,
  recordRequest,
  shouldSuggestSummary,
  sparringStorageKey,
} from '../lib/sparring-session.js';

// サイドパネル persistHearingSummary と同じ上限（超えると保存が必ず失敗する）。
const HEARING_SUMMARY_HARD_LIMIT = 6000;
const CONFIRM_ACTION = 'confirmHearingSummary';

// 確定コマンドの返事が来ないまま固まらないようにする待ち時間。
// サイドパネルは 60 秒より古いコマンドを結果を出さずに捨てるので、それより短く切る。
const CONFIRM_TIMEOUT_MS = 15000;
// 壁打ちは往復が多い。混雑時に 1 送信で 10 秒以上黙って待たせないため、
// 既定（3回）より浅くする。1.5s + 3s の2回まで。
const SPARRING_MAX_RETRIES = 2;

let deps = null;
let session = null;
let sessionProjectId = null;
let collapsed = null; // null = 自動判定、true/false = 受講者が明示的に開閉した
let busy = false;
let pendingConfirm = false;
let confirmTimer = null;
let saveWarned = false;
let lastSaveOk = true;
let renderedTurnCount = -1;

function $(id) {
  return document.getElementById(id);
}

function clearChildren(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function storageLocal() {
  return globalThis.chrome?.storage?.local || null;
}

function activeProjectId() {
  return deps?.getSnapshot?.()?.activeProjectId || '';
}

// いま画面に読み込んでいる案件のキー。「表示中の案件」を書き込む瞬間に読み直すと、
// 応答を待っている間の案件切替で、別案件のキーへ書いてしまう。
function currentKey() {
  return sparringStorageKey(sessionProjectId || '');
}

function hearingState() {
  const hearing = deps?.getSnapshot?.()?.hearing;
  return hearing && typeof hearing === 'object' ? hearing : {};
}

function isConfirmed() {
  const hearing = hearingState();
  return !!hearing.hasSummary && !!hearing.consistent;
}

// 要約が確定済みなら、案件種別にかかわらず「確定済み」を優先して畳む。
function defaultCollapsed() {
  return isConfirmed();
}

function isCollapsed() {
  return collapsed === null ? defaultCollapsed() : collapsed;
}

// 保存は必ず「その操作を始めた案件」へ書く。AI の応答を待っている数秒の間に案件が
// 切り替わることがあり、そのとき書き込み先を読み直すと、返ってきた応答が切替先の
// 会話へ混ざる（クライアントAの数字がクライアントBの戦略書に載る）。
// 画面の session を差し替えるのも、まだその案件を表示しているときだけにする。
// これは loadSessionForProject が既に採っている「読込中に案件が変わっていたら捨てる」
// と同じ作法を、書き込み側にも入れたもの。
async function saveSession(next, projectId = sessionProjectId) {
  const normalized = normalizeSparringSession(next);
  const target = String(projectId || '');
  if (target === String(sessionProjectId || '')) session = normalized;
  const storage = storageLocal();
  if (!storage) return normalized;
  try {
    await storage.set({ [sparringStorageKey(target)]: normalized });
    saveWarned = false;
    lastSaveOk = true;
  } catch (error) {
    lastSaveOk = false;
    // 握り潰すと「画面では会話が進むのに、開き直すと途中から消えている」になる。
    // 会話は続けられるので止めはしないが、1度は必ず知らせる。
    console.warn('[STRATEGY-KIT][sparring] save failed:', error);
    if (!saveWarned && target === String(sessionProjectId || '')) {
      saveWarned = true;
      setStatus('会話を保存できませんでした。このまま続けられますが、画面を開き直すと直前までの会話が失われることがあります。', 'warn');
    }
  }
  return normalized;
}

async function loadSessionForProject(projectId) {
  const normalizedId = String(projectId || '');
  if (sessionProjectId === normalizedId && session) return;
  sessionProjectId = normalizedId;
  session = createSparringSession({ basePrompt: '' });
  // 案件が変わったら確定ペインの本文も捨てる。残すと、前の案件の要約を
  // そのまま「この要約で確定」できてしまう。
  resetSummaryPane();
  const storage = storageLocal();
  if (storage) {
    try {
      const key = sparringStorageKey(normalizedId);
      const stored = await storage.get([key]);
      // 読込中に案件が変わっていたら、この結果は捨てる。
      if (sessionProjectId !== normalizedId) return;
      if (stored?.[key]) session = normalizeSparringSession(stored[key]);
    } catch (_) {
      /* 読めなくても新規セッションとして始められる */
    }
  }
  resetSummaryPane();
  collapsed = null;
  render();
}

// 確定ペインの本文を、いま読み込んでいるセッションの内容へ戻す。
function resetSummaryPane() {
  const summaryArea = $('mission-sparring-summary');
  if (summaryArea) summaryArea.value = session?.summaryDraft || '';
  renderConfirmCounter();
}

function setStatus(message, tone = '', extraButton = null) {
  const status = $('mission-sparring-status');
  if (!status) return;
  clearChildren(status);
  status.dataset.tone = tone;
  if (message) status.appendChild(document.createTextNode(message));
  if (extraButton) status.appendChild(extraButton);
}

function switchToManualButton(label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mission-sparring-inline-action';
  button.textContent = label;
  button.addEventListener('click', () => {
    const select = $('mission-sparring-mode');
    if (select) select.value = SPARRING_MODE_MANUAL;
    applyMode(SPARRING_MODE_MANUAL);
  });
  return button;
}

function renderLog() {
  const list = $('mission-sparring-log');
  const empty = $('mission-sparring-empty');
  if (!list) return;
  clearChildren(list);
  const turns = session?.turns || [];
  if (empty) empty.hidden = turns.length > 0 || !hasSparringStarted(session);
  for (const turn of turns) {
    const li = document.createElement('li');
    li.className = turn.role === 'user' ? 'is-user' : 'is-ai';
    const who = document.createElement('strong');
    who.textContent = turn.role === 'user' ? 'あなた' : 'AI';
    const body = document.createElement('p');
    body.textContent = turn.text;
    li.append(who, body);
    list.appendChild(li);
  }
  list.hidden = !turns.length;
  // 最下部へ送るのは発言が増えたときだけ。毎回の再描画で飛ばすと、
  // 前のほうの発言を読み返している最中に勝手に戻されてしまう。
  if (turns.length && turns.length !== renderedTurnCount) list.scrollTop = list.scrollHeight;
  renderedTurnCount = turns.length;
}

function renderUsage() {
  const usage = describeSparringUsage(session);
  const badge = $('mission-sparring-usage');
  if (badge) badge.textContent = usage.label;
  const note = $('mission-sparring-mode-note');
  if (!note) return;
  if (session?.mode === SPARRING_MODE_MANUAL) {
    note.textContent = '外部AI（ChatGPT / Claude / Gemini）で進めます。この方法では無料枠を使いません。出てきた要約を下の欄に貼って確定してください。';
    return;
  }
  const lines = [
    'この方法は1往復につきAIを1回呼びます。12問なら約14回 ── 全自動を1本回すのと同じくらいの量です。無料枠は翌日リセットされます。',
  ];
  if (usage.detail) lines.push(usage.detail);
  if (shouldSuggestSummary(session)) {
    lines.push('そろそろヒアリング要約に進めますか。続けたい場合はこのまま質問を重ねても大丈夫です。');
  }
  note.textContent = lines.join(' ');
}

function renderConfirmCounter() {
  const textarea = $('mission-sparring-summary');
  const counter = $('mission-sparring-counter');
  const confirmBtn = $('mission-sparring-confirm-btn');
  if (!textarea || !counter) return;
  const trimmed = String(textarea.value || '').trim();
  const tooLong = trimmed.length > HEARING_SUMMARY_HARD_LIMIT;
  counter.textContent = tooLong
    ? `要約が長すぎます。${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字以内に短くしてください（現在 ${trimmed.length.toLocaleString()}字）`
    : `要約 ${trimmed.length.toLocaleString()}字（保存上限 ${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字）`;
  counter.dataset.tone = tooLong ? 'warn' : '';
  if (confirmBtn) confirmBtn.disabled = pendingConfirm || !trimmed || tooLong;
}

function render() {
  const card = $('mission-sparring');
  if (!card) return;
  const snapshot = deps?.getSnapshot?.() || {};
  // 壁打ちは案件種別を問わない。A はヒアリング設計、B は既存情報の不足確認、
  // C は自社事業の情報整理として使い分け、既存資料の取込とは併用できる。
  const mode = hearingState().mode || '';
  card.hidden = !snapshot.hasBusiness;
  if (card.hidden) return;

  const context = $('mission-sparring-context');
  if (context) {
    context.textContent = mode === 'B'
      ? 'ヒアリング済みの文字起こし・議事録は、上の「既存情報を貼り付ける」から取り込みます。この壁打ちは、資料を読んで不足していた数字や判断材料を追加で深掘りするときに使えます。'
      : mode === 'A'
        ? 'これから行うヒアリングの質問設計や、聞くべき項目の抜け漏れ確認に使えます。'
        : '自社事業に限らず、顧客案件・新規事業・支援先についても、分からない点をAIと1問ずつ整理できます。';
  }

  const body = $('mission-sparring-body');
  const toggle = $('mission-sparring-toggle');
  const folded = isCollapsed();
  if (body) body.hidden = folded;
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!folded));
    toggle.textContent = folded ? '▶ 壁打ちを開く' : '▼ 壁打ちを閉じる';
  }

  const confirmed = $('mission-sparring-confirmed');
  if (confirmed) {
    const hearing = hearingState();
    const updatedAt = Number(hearing.updatedAt || 0);
    const updatedLabel = updatedAt
      ? new Date(updatedAt).toLocaleString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    confirmed.hidden = !isConfirmed();
    confirmed.textContent = isConfirmed()
      ? `✓ この案件のヒアリング要約は確定済みです（${Number(hearing.summaryLength || 0).toLocaleString()}字${updatedLabel ? `・最終確定 ${updatedLabel}` : ''}）。以後に新しく作るフェーズでは事業コンテキストとして参照されます。保存済みの章は自動更新されないため、反映し直す章は「このフェーズからやり直す」で再生成してください。`
      : '';
  }

  const select = $('mission-sparring-mode');
  if (select && select.value !== session?.mode) select.value = session?.mode || SPARRING_MODE_AI;

  const manual = session?.mode === SPARRING_MODE_MANUAL;
  const hasPrompt = !!session?.basePrompt;
  const hasTurns = (session?.turns || []).length > 0;
  // 「始める」は会話がまだ1件も無いときに出す。プロンプトの有無で決めると、
  // モーダル③から引き継いだ直後（プロンプトはあるが会話ゼロ）に、質問が無いのに
  // 入力欄だけが出て、受講者は何か書いて送るしかなくなる。
  // そこを「始める」に保つことで、1回目の送信＝素の基本プロンプトになり、
  // コピー導線が渡していたものと1文字も変わらない状態で Q1 が返る。
  const start = $('mission-sparring-start');
  const startBtn = $('mission-sparring-start-btn');
  const needsStart = manual ? !hasPrompt : !hasTurns;
  if (start) start.hidden = !needsStart;
  if (startBtn) {
    startBtn.disabled = busy;
    startBtn.textContent = manual ? '壁打ちプロンプトを作る' : '壁打ちを始める';
  }

  // manual では入力欄と送信ボタンを出さない。外部 AI とのやりとりを1往復ずつ
  // この画面に写させると、いまの運用（外部タブで続けて最後だけ戻す）より手数が増える。
  const inputLabel = $('mission-sparring-input')?.closest('label');
  if (inputLabel) inputLabel.hidden = manual || !hasTurns;
  // 操作列そのものは manual でも出す（隠すと「会話を破棄」まで押せなくなる）。
  const actions = document.querySelector('.mission-sparring-actions');
  if (actions) actions.hidden = !hasPrompt && !hasTurns;
  const send = $('mission-sparring-send');
  if (send) {
    send.hidden = manual || !hasTurns;
    send.disabled = busy;
  }
  const summarize = $('mission-sparring-summarize');
  if (summarize) {
    summarize.hidden = manual;
    summarize.disabled = busy || !hasTurns;
  }
  const discard = $('mission-sparring-discard');
  if (discard) discard.disabled = busy || !(hasPrompt || hasTurns);

  // manual は「プロンプトができた時点」でコピー欄を出す。会話が始まるまで隠すと、
  // 引き継ぎ直後の受講者にコピーする先が無い。
  const manualPane = $('mission-sparring-manual');
  if (manualPane) manualPane.hidden = !manual || !hasPrompt;
  const outbox = $('mission-sparring-outbox');
  if (outbox && manual && hasPrompt) outbox.value = buildManualContinuationPrompt(session);

  const confirmPane = $('mission-sparring-confirm');
  if (confirmPane) confirmPane.hidden = !hasPrompt || (!manual && !session?.summaryDraft);
  const summaryArea = $('mission-sparring-summary');
  if (summaryArea && session?.summaryDraft && summaryArea.value !== session.summaryDraft
      && document.activeElement !== summaryArea) {
    summaryArea.value = session.summaryDraft;
  }

  renderLog();
  renderUsage();
  renderConfirmCounter();
}

function selectedModel() {
  return $('mission-model-select')?.value || 'gemini-3.6-flash';
}

// 実際に飛んだ HTTP リクエストを数えるための fetch。generateContent の
// 指数バックオフは 1 回の送信を複数リクエストに増やし、proxy 設定者は
// proxy + direct で 2 発になり得る。成功回数だけ数えると、無料枠が尽きかけて
// いるときに限って消費の表示が実態から外れる（いちばん効いてほしい局面で狂う）。
function countingFetch(counter) {
  return (...args) => {
    counter.requests += 1;
    return fetch(...args);
  };
}

// 戻り値は { result, requests }。requests は成否によらず実測値。
async function callGemini(prompt, { busyMessage = '' } = {}) {
  const counter = { requests: 0 };
  let waited = 0;
  try {
    const result = await generateContent({
      prompt,
      model: selectedModel(),
      temperature: 0.5,
    }, {
      storage: chrome.storage.local,
      syncStorage: chrome.storage.sync,
      fetchImpl: countingFetch(counter),
      maxRetries: SPARRING_MAX_RETRIES,
      ...(Number(deps?.retryBaseDelayMs) > 0 ? { baseDelayMs: Number(deps.retryBaseDelayMs) } : {}),
      // 待っている間を無言にしない。混雑時は数秒止まるので、何が起きているか出す。
      sleepImpl: (ms) => new Promise((resolve) => {
        waited += 1;
        setStatus(`AI が混み合っています。少し待って再試行しています（${waited}/${SPARRING_MAX_RETRIES}）…`, '');
        setTimeout(resolve, ms);
      }),
    });
    if (waited && busyMessage) setStatus(busyMessage, '');
    return { result, requests: counter.requests };
  } catch (error) {
    error.sparringRequests = counter.requests;
    throw error;
  }
}

function setBusy(value, message) {
  busy = value;
  if (message) setStatus(message, '');
  render();
}

function handleFailure(error) {
  const message = describeSparringFailure(error);
  const needsEscape = isQuotaError(error) || isUnconfiguredError(error);
  setStatus(
    message,
    'warn',
    needsEscape ? switchToManualButton('外部AIで続ける') : null,
  );
}

// 会話がまだ無い状態の基本プロンプト。項目策定を経ていない入口なので、
// 既存のフォールバックと同じ汎用テンプレ（buildWallbounceHearingPrompt）を使う。
function buildGenericBasePrompt() {
  const snapshot = deps?.getSnapshot?.() || {};
  const business = snapshot.business && typeof snapshot.business === 'object' ? snapshot.business : {};
  const form = deps?.getFormInputs?.() || {};
  return buildWallbounceHearingPrompt({
    industry: business.industryLabel,
    storeName: business.storeName,
    memo: form.memo,
    context: form.context,
  });
}

// 失敗した呼び出しも消費として記録する（無料枠は日次リクエスト数で切れるため）。
// 会話は変えず、実際に飛んだ回数と送信量だけを、その操作を始めた案件へ書き戻す。
async function recordFailedRequests(base, projectId, prompt, error) {
  const requests = Number(error?.sparringRequests) || 0;
  if (!requests) return;
  await saveSession(
    recordRequest(base, { sentChars: prompt.length * requests, count: requests }),
    projectId,
  );
}

async function startSparring() {
  if (busy) return;
  // 操作を始めた案件を固定する。以降の保存はすべてこの案件へ書く。
  const projectId = sessionProjectId;
  // 引き継ぎ済みのプロンプト・項目・消費実績は捨てない（作り直すのは破棄ボタンの役目）。
  const base = normalizeSparringSession(session);
  const next = {
    ...base,
    basePrompt: base.basePrompt || buildGenericBasePrompt(),
    status: 'running',
  };
  const saved = await saveSession(next, projectId);
  if (saved.mode === SPARRING_MODE_MANUAL) {
    setStatus('プロンプトを作りました。コピーして外部AIに貼り付けてください。', 'success');
    render();
    return;
  }
  setBusy(true, 'AIに最初の質問を作ってもらっています…');
  const prompt = buildSparringPrompt(saved, {});
  try {
    const { result, requests } = await callGemini(prompt, { busyMessage: 'AIに最初の質問を作ってもらっています…' });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('empty response text');
    let updated = recordRequest(saved, { sentChars: prompt.length * Math.max(1, requests), count: requests });
    updated = appendTurn(updated, { role: 'ai', text });
    await saveSession(updated, projectId);
    setStatus('最初の質問が届きました。下の欄に答えて送信してください。', 'success');
  } catch (error) {
    console.warn('[STRATEGY-KIT][sparring] start failed:', error);
    await recordFailedRequests(saved, projectId, prompt, error);
    handleFailure(error);
  } finally {
    setBusy(false);
  }
}

// manual は「無料枠を使いません」と約束しているモード。ボタンを隠すだけでなく、
// 関数側でも呼ばせない（表示の取りこぼしがそのまま枠の消費にならないように）。
function isManualMode() {
  return session?.mode === SPARRING_MODE_MANUAL;
}

async function sendAnswer() {
  if (busy || isManualMode()) return;
  const input = $('mission-sparring-input');
  const answer = String(input?.value || '').trim();
  if (!answer) {
    setStatus('回答を入力してから送信してください。', 'warn');
    return;
  }
  // 送信を始めた案件と、その時点の会話を固定する。応答を待つ数秒の間に案件が
  // 切り替わっても、返ってきた応答は元の案件へ書き、切替先には触れない。
  const projectId = sessionProjectId;
  const base = normalizeSparringSession(session);
  setBusy(true, 'AIが次の質問を考えています…');
  const prompt = buildSparringPrompt(base, { userText: answer });
  try {
    const { result, requests } = await callGemini(prompt, { busyMessage: 'AIが次の質問を考えています…' });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('empty response text');
    let updated = appendTurn(base, { role: 'user', text: answer });
    updated = recordRequest(updated, { sentChars: prompt.length * Math.max(1, requests), count: requests });
    updated = appendTurn(updated, { role: 'ai', text });
    await saveSession(updated, projectId);
    // 入力欄をクリアしてよいのは、まだ同じ案件を表示しているときだけ。
    if (input && projectId === sessionProjectId) input.value = '';
    // 保存に失敗した知らせは消さない（消すと「画面では進むが開き直すと消えている」に戻る）。
    if (projectId === sessionProjectId && lastSaveOk) setStatus('', '');
  } catch (error) {
    console.warn('[STRATEGY-KIT][sparring] send failed:', error);
    // 送信に失敗した回答は履歴へ残さない（入力欄に残したまま再送できるようにする）。
    await recordFailedRequests(base, projectId, prompt, error);
    if (projectId === sessionProjectId) handleFailure(error);
  } finally {
    setBusy(false);
  }
}

async function requestSummary() {
  if (busy || isManualMode()) return;
  const input = $('mission-sparring-input');
  const answer = String(input?.value || '').trim();
  setBusy(true, 'ここまでの回答からヒアリング要約を作っています…');
  const projectId = sessionProjectId;
  const base = normalizeSparringSession(session);
  const prompt = buildSummaryPrompt(base, { userText: answer });
  try {
    const { result, requests } = await callGemini(prompt, { busyMessage: 'ここまでの回答からヒアリング要約を作っています…' });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('empty response text');
    let updated = answer ? appendTurn(base, { role: 'user', text: answer }) : base;
    updated = recordRequest(updated, { sentChars: prompt.length * Math.max(1, requests), count: requests });
    updated = { ...updated, summaryDraft: text, status: 'summarizing' };
    await saveSession(updated, projectId);
    if (projectId !== sessionProjectId) return;
    if (input) input.value = '';
    const summaryArea = $('mission-sparring-summary');
    if (summaryArea) summaryArea.value = text;
    setStatus('要約ができました。内容を確認して「確定して今後のプロンプトに反映」を押してください。', 'success');
  } catch (error) {
    console.warn('[STRATEGY-KIT][sparring] summary failed:', error);
    await recordFailedRequests(base, projectId, prompt, error);
    if (projectId === sessionProjectId) handleFailure(error);
  } finally {
    setBusy(false);
  }
}

function clearConfirmTimer() {
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

async function confirmSummary() {
  const summaryArea = $('mission-sparring-summary');
  const text = String(summaryArea?.value || '').trim();
  if (!text) {
    setStatus('確定する要約を入力してください。', 'warn');
    return;
  }
  if (text.length > HEARING_SUMMARY_HARD_LIMIT) {
    setStatus(`要約が長すぎます。${HEARING_SUMMARY_HARD_LIMIT.toLocaleString()}字以内に短くしてください。`, 'warn');
    return;
  }
  // 確定先は「いま表示中の案件」ではなく「この要約を作ったセッションの案件」。
  // 案件を切り替えた直後に押しても、前の案件の要約が新しい案件へ保存されない。
  const projectId = sessionProjectId;
  const base = normalizeSparringSession(session);
  pendingConfirm = true;
  clearConfirmTimer();
  renderConfirmCounter();
  setStatus('ヒアリング要約を保存しています…', '');
  // 保存より先にコマンドを送る。sendMissionCommand は chrome.sidePanel.open() を
  // 呼ぶが、これは受講者の操作中に始める必要があり、storage 書き込みの往復を
  // 挟むと失敗しやすくなる。
  const sending = deps?.sendMissionCommand?.(CONFIRM_ACTION, { text, projectId });
  // 返事が来ないまま押せなくなるのを防ぐ。サイドパネルは 60 秒より古いコマンドを
  // 結果を出さずに捨てるので、放置すると回復手段が再読込しかなくなる。
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    if (!pendingConfirm) return;
    pendingConfirm = false;
    setStatus('要約を保存できませんでした。サイドパネルを開いてから、もう一度「確定して今後のプロンプトに反映」を押してください。', 'warn');
    renderConfirmCounter();
  }, Number(deps?.confirmTimeoutMs) || CONFIRM_TIMEOUT_MS);
  await saveSession({ ...base, summaryDraft: text }, projectId);
  const sent = await sending;
  if (sent === false) {
    clearConfirmTimer();
    pendingConfirm = false;
    setStatus('操作を送れませんでした。拡張機能を再読み込みしてから、もう一度お試しください。', 'warn');
    renderConfirmCounter();
  }
}

async function discardSession() {
  if (busy) return;
  const ok = globalThis.confirm('この案件の壁打ちの会話を破棄します。確定済みのヒアリング要約は消えません。');
  if (!ok) return;
  const projectId = sessionProjectId;
  const storage = storageLocal();
  if (storage) {
    try {
      await storage.remove([sparringStorageKey(projectId)]);
    } catch (_) {
      /* 消せなくても新しいセッションで上書きされる */
    }
  }
  if (projectId !== sessionProjectId) return;
  session = createSparringSession({ mode: session?.mode });
  resetSummaryPane();
  setStatus('会話を破棄しました。もう一度「壁打ちを始める」から作り直せます。', '');
  render();
}

async function applyMode(value) {
  const mode = normalizeSparringMode(value);
  const projectId = sessionProjectId;
  const saved = await saveSession({ ...normalizeSparringSession(session), mode }, projectId);
  if (projectId !== sessionProjectId) return;
  if (mode === SPARRING_MODE_MANUAL && hasSparringStarted(saved)) {
    setStatus('ここまでの会話を含んだプロンプトを作りました。コピーして外部AIに貼り付ければ、続きから進められます。', 'success');
  } else {
    setStatus('', '');
  }
  render();
}

// サイドパネルからの結果を受ける。消費したら true を返し、mission.js の
// 汎用フィードバック表示には流さない（壁打ち欄の中で結果を見せるため）。
export function handleSparringCommandResult(value) {
  if (!value || value.action !== CONFIRM_ACTION) return false;
  clearConfirmTimer();
  pendingConfirm = false;
  if (value.ok) {
    setStatus(value.message || 'ヒアリング要約を確定しました。以後に新しく作るフェーズでは事業コンテキストとして参照します。保存済みの章は自動更新されません。', 'success');
  } else {
    setStatus(value.message || '要約を保存できませんでした。サイドパネルで状態を確認してください。', 'warn');
  }
  renderConfirmCounter();
  return true;
}

function bind() {
  $('mission-sparring-toggle')?.addEventListener('click', () => {
    collapsed = !isCollapsed();
    render();
  });
  $('mission-sparring-mode')?.addEventListener('change', function () {
    applyMode(this.value);
  });
  $('mission-sparring-start-btn')?.addEventListener('click', () => startSparring());
  $('mission-sparring-send')?.addEventListener('click', () => sendAnswer());
  $('mission-sparring-summarize')?.addEventListener('click', () => requestSummary());
  $('mission-sparring-discard')?.addEventListener('click', () => discardSession());
  $('mission-sparring-confirm-btn')?.addEventListener('click', () => confirmSummary());
  $('mission-sparring-summary')?.addEventListener('input', () => renderConfirmCounter());
  $('mission-sparring-open-import')?.addEventListener('click', async () => {
    const sent = await deps?.sendMissionCommand?.('openHearingImport', {
      projectId: sessionProjectId || activeProjectId(),
    });
    setStatus(
      sent
        ? 'サイドパネルに「ヒアリング済み情報」の貼り付け欄を開きました。'
        : '貼り付け欄を開けませんでした。サイドパネルで「今回の入口」→「ヒアリング済み」を選んでください。',
      sent ? 'success' : 'warn',
    );
  });
  $('mission-sparring-copy')?.addEventListener('click', async () => {
    const outbox = $('mission-sparring-outbox');
    try {
      await navigator.clipboard.writeText(String(outbox?.value || ''));
      setStatus('プロンプトをコピーしました。外部AIに貼り付けて壁打ちを続けてください。', 'success');
    } catch (_) {
      setStatus('コピーできませんでした。上の本文を選んで手動でコピーしてください。', 'warn');
    }
  });
}

export function initSparring(dependencies) {
  deps = dependencies || {};
  session = createSparringSession({ basePrompt: '' });
  bind();
  render();
  loadSessionForProject(activeProjectId());
  if (!globalThis.chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const key = currentKey();
    if (!changes[key]) return;
    // サイドパネル（モーダル③の引き継ぎ）が書いた内容を取り込む。
    // 自分の保存で戻ってきた分も含むが、正規化後の値なので描画は安定する。
    session = normalizeSparringSession(changes[key].newValue);
    if (changes[key].newValue && collapsed === null) collapsed = false;
    render();
  });
}

// snapshot が更新されたら呼ぶ（案件切替の追従と表示条件の再判定）。
export function refreshSparring() {
  const projectId = activeProjectId();
  if (sessionProjectId !== String(projectId || '')) {
    loadSessionForProject(projectId);
    return;
  }
  render();
}
