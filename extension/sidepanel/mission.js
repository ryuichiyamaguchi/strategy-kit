// STRATEGY-KIT — 半自動／全自動 共通の全画面コマンドセンター (mission.html)
//
// 表示は storage の snapshot/task を購読し、操作は missionCommand に集約する。
// 実行本体は既存の sidepanel/automation.js を唯一のソースとして再利用し、
// この画面からは開始・再開・中断・フェーズ・AI・Docs 操作を指示する。
//
// 購読キー:
//   - sk_task_monitor_v1           … live task (status / taskLabel / lastEvent / provider)
//   - sk-state.ui.missionSnapshot  … サイドパネルが publish する raw 入力 (phases / 進捗 / 案件名)

import { deriveMissionModel } from '../lib/mission-view-model.js';
import { mergeAutomationDraft } from '../lib/automation-draft.js';
import {
  MODEL_POLICY_VERSION,
  needsLegacyModelRemap,
  restoreSelectableModel,
} from '../lib/model-policy.js';

const TASK_KEY = 'sk_task_monitor_v1';
const SNAPSHOT_KEY = 'sk-state.ui.missionSnapshot';
const COMMAND_KEY = 'sk-state.ui.missionCommand';
const COMMAND_RESULT_KEY = 'sk-state.ui.missionCommandResult';
const AUTOMATION_EXECUTION_MODE_PATH = 'automation.executionMode';

let snapshot = null; // raw 入力 (phases / filledNos / partialNos / hasBusiness / projectName)
let task = null; // live task
let currentModel = null;
let controlFeedbackTimer = null;
let pendingProjectSwitch = null; // 切替要求中の projectId（反映されるまで保持）
let projectSwitchTimer = null;
let activeTaskStartedAt = null;
let automationDraftSaveTimer = null;
let automationDraftProjectId = null;
let automationDraftLoadPromise = null;
let automationDraftLoadingId = null;
let lastCommandTs = 0;

function $(id) {
  return document.getElementById(id);
}

function clearChildren(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function providerInitial(value) {
  const text = String(value || 'AI').trim();
  return text.slice(0, 1).toUpperCase() || 'AI';
}

function renderRoute(route) {
  const list = $('mission-route');
  if (!list) return;
  clearChildren(list);
  for (const item of route) {
    const li = document.createElement('li');
    li.className = item.state === 'done' ? 'is-done' : item.state === 'current' ? 'is-current' : '';
    li.setAttribute('aria-label', `§${item.no} ${item.state === 'done' ? '完了' : item.state === 'current' ? '現在' : '未着手'}`);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.phaseNo = String(item.no);
    button.textContent = `§${item.no}`;
    button.setAttribute('aria-label', `§${item.no}を操作`);
    li.append(dot, button);
    list.appendChild(li);
  }
}

function renderDetails(details) {
  const dl = $('mission-details');
  if (!dl) return;
  clearChildren(dl);
  for (const pair of details) {
    if (!pair) continue;
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = pair[0] || '';
    const dd = document.createElement('dd');
    dd.textContent = pair[1] || '—';
    row.append(dt, dd);
    dl.appendChild(row);
  }
}

function renderActivity(activity) {
  const list = $('mission-activity');
  const empty = $('mission-activity-empty');
  if (!list) return;
  clearChildren(list);
  if (!activity.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  for (const item of activity) {
    const li = document.createElement('li');
    if (item.done) li.className = 'is-done';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    li.append(title, detail);
    list.appendChild(li);
  }
}

function renderMissionMetrics(model) {
  const doneCount = model.route.filter((item) => item.state === 'done').length;
  const total = model.route.length || 10;
  const outputCount = new Set([
    ...(snapshot?.filledNos || []).map(String),
    ...(snapshot?.partialNos || []).map(String),
  ]).size;
  const current = model.route.find((item) => item.state === 'current');

  const percent = $('mission-metric-percent');
  if (percent) percent.textContent = `${model.percent}%`;
  const phase = $('mission-metric-phase');
  if (phase) phase.textContent = `${doneCount} / ${total}`;
  const output = $('mission-metric-output');
  if (output) output.textContent = String(outputCount);
  const health = $('mission-metric-health');
  if (health) health.textContent = model.isRunning ? '稼働中' : model.statusLabel;
  const routeStatus = $('mission-route-status');
  if (routeStatus) {
    routeStatus.textContent = current
      ? `現在地 §${current.no}`
      : doneCount >= total
        ? '全フェーズ完了'
        : '開始前';
  }

  if (model.isRunning && !activeTaskStartedAt) activeTaskStartedAt = Date.now();
  if (!model.isRunning) activeTaskStartedAt = null;
  renderElapsedTime();
}

function renderElapsedTime() {
  const target = $('mission-metric-time');
  if (!target) return;
  const elapsed = activeTaskStartedAt ? Math.max(0, Date.now() - activeTaskStartedAt) : 0;
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  target.textContent = `${hours}:${minutes}:${seconds}`;
}

function render() {
  const activeTask = task?.projectId && snapshot?.activeProjectId && task.projectId !== snapshot.activeProjectId
    ? null
    : task;
  const model = deriveMissionModel({
    phases: snapshot?.phases || [],
    filledNos: snapshot?.filledNos || [],
    partialNos: snapshot?.partialNos || [],
    task: activeTask,
    hasBusiness: snapshot?.hasBusiness,
    projectName: snapshot?.projectName,
    // 段階B: 現在地統一・状態別の次の一手・進め方未選択・案件切替のための追加入力。
    selectedNo: snapshot?.selectedNo,
    needsMode: snapshot?.needsMode,
    executionMode: snapshot?.executionMode,
    projects: snapshot?.projects,
    activeProjectId: snapshot?.activeProjectId,
  });
  currentModel = model;

  // 案件切替の反映を検知したら「反映まち」表示を解除する。
  if (pendingProjectSwitch && model.activeProjectId === pendingProjectSwitch) {
    clearProjectSwitchPending();
  }

  const topbar = $('mission-topbar');
  if (topbar) topbar.dataset.running = String(model.isRunning);
  const statusText = $('mission-status-text');
  if (statusText) statusText.textContent = model.isRunning ? `${model.executionMode === 'semi' ? '半自動' : '全自動'} 実行中` : model.statusLabel;
  const projectEl = $('mission-project-name');
  if (projectEl) projectEl.textContent = model.projectName;

  const percentEl = $('mission-percent-value');
  if (percentEl) percentEl.textContent = String(model.percent);
  const metaEl = $('mission-progress-meta');
  if (metaEl) metaEl.textContent = model.metaText;
  const progress = $('mission-progress');
  if (progress) progress.setAttribute('aria-valuenow', String(model.percent));
  const bar = $('mission-progress-bar');
  if (bar) bar.style.width = `${model.percent}%`;
  renderRoute(model.route);
  renderMissionMetrics(model);

  const phaseTitle = $('mission-phase-title');
  if (phaseTitle) phaseTitle.textContent = `§${model.currentPhase.no} ${model.currentPhase.title}`;
  const phaseStatus = $('mission-phase-status');
  if (phaseStatus) phaseStatus.textContent = model.statusLabel;
  const phaseDesc = $('mission-phase-desc');
  if (phaseDesc) phaseDesc.textContent = model.phaseDescription;

  const detailTitle = $('mission-detail-title');
  if (detailTitle) detailTitle.textContent = model.detailTitle;
  const providerMark = $('mission-provider-mark');
  if (providerMark) providerMark.textContent = providerInitial(model.provider);
  const providerName = $('mission-provider-name');
  if (providerName) providerName.textContent = model.provider;
  renderDetails(model.details);
  renderActivity(model.activity);
  renderNextMove(model);
  renderPhaseGuide(model);
  renderModeBanner(model);
  renderProjectSwitch(model);

  updateControls(model);
  loadAutomationDraftForProject(model.activeProjectId);
}

// 「次の一手」= 状態別の推奨アクション＋理由（サイドパネルから移管した詳細版）。
function renderNextMove(model) {
  const reco = $('mission-nextmove-recommendation');
  const reason = $('mission-nextmove-reason');
  if (reco) reco.textContent = model.nextMove?.recommendation || '—';
  if (reason) reason.textContent = model.nextMove?.reason || '';
}

// 現在の状態に合わせて、全画面で次に操作できる内容を案内する。
function renderPhaseGuide(model) {
  const guide = $('mission-phase-guide');
  if (!guide) return;
  const mode = model.isRunning ? model.executionMode : selectedExecutionMode();
  if (model.statusKey === 'setup') {
    guide.textContent = '初期設定を整えると、ここから半自動／全自動を選んで実行できます。';
  } else if (model.isRunning) {
    guide.textContent = mode === 'semi'
      ? '半自動で進行中です。回答の確認・貼り付けはサイドパネルで行います。'
      : '全自動で生成・保存中です。必要なら「中断して保存」で再開地点を残せます。';
  } else {
    guide.textContent = mode === 'semi'
      ? '半自動はサイドパネルでAIの回答を確認しながら進め、進捗はこの画面にも同期されます。'
      : '全自動はGeminiで各フェーズを順番に生成し、進捗をこの画面で確認できます。';
  }
}

// 未設定 / 進め方未選択（needs-mode）を正直に表示する。
function renderModeBanner(model) {
  const banner = $('mission-mode-banner');
  if (!banner) return;
  let text = '';
  if (model.statusKey === 'setup') {
    banner.dataset.tone = 'setup';
    text = '初期設定がまだです。「設定」から Google 連携・事業情報・§0 を整えましょう。';
  } else if (model.needsMode) {
    banner.dataset.tone = 'mode';
    text = '進め方が未選択です。この画面の「実行方法」で半自動／全自動を選べます。';
  }
  banner.textContent = text;
  banner.hidden = !text;
}

// 案件セレクタ: サイドパネルが publish した projects/activeProjectId を表示し、切替は
// missionCommand 経由でサイドパネルの既存切替経路へ委譲する（二重実装しない）。
function renderProjectSwitch(model) {
  const select = $('mission-project-switch');
  const wrap = select ? select.closest('.mission-project-switch-wrap') : null;
  const nameEl = $('mission-project-name');
  const projects = model.projects || [];
  if (nameEl) nameEl.textContent = model.projectName;
  if (!select || !wrap) return;

  // 1件でもセレクタを表示し、現在扱っている案件が明確に分かるようにする。
  const canSwitch = projects.length > 0;
  wrap.hidden = !canSwitch;
  if (nameEl) nameEl.hidden = canSwitch;
  if (!canSwitch) {
    clearChildren(select);
    return;
  }

  // 内容が変わったときだけ options を作り直す（選択中に潰さない）。
  const signature = projects.map((p) => `${p.id}:${p.label}`).join('|') + '#' + (model.activeProjectId || '');
  if (select.dataset.signature !== signature) {
    clearChildren(select);
    for (const project of projects) {
      const opt = document.createElement('option');
      opt.value = project.id;
      opt.textContent = project.label || '無題プロジェクト';
      if (project.id === model.activeProjectId) opt.selected = true;
      select.appendChild(opt);
    }
    select.dataset.signature = signature;
  }
}

function updateControls(model) {
  const run = $('mission-run');
  const pause = $('mission-pause');
  const stop = $('mission-stop');
  const restart = $('mission-restart-phase');
  const commandState = $('mission-command-state');
  const running = model.isRunning;
  const modeLabel = $('mission-mode-select')?.value === 'semi' ? '半自動' : '全自動';

  if (run) {
    run.disabled = running;
    run.textContent = model.statusKey === 'setup'
      ? '初期設定を開く'
      : model.status === 'paused' || model.status === 'blocked'
        ? '保存地点から再開'
        : model.status === 'completed'
          ? '完成したマスターを確認'
          : `${modeLabel}を開始`;
  }
  if (pause) pause.disabled = !running;
  if (stop) stop.disabled = false;
  if (restart) restart.disabled = running || model.statusKey === 'setup';
  if (commandState) {
    commandState.textContent = running
      ? 'RUNNING'
      : model.status === 'paused'
        ? 'PAUSED'
        : model.status === 'blocked'
          ? 'CHECK'
          : model.status === 'completed'
            ? 'DONE'
            : 'READY';
    commandState.dataset.state = model.status;
  }

  if (!controlFeedbackTimer) {
    const note = $('mission-control-note');
    if (note) {
      note.dataset.tone = '';
      const selectedMode = running ? model.executionMode : selectedExecutionMode();
      note.textContent = running
        ? selectedMode === 'semi'
          ? 'サイドパネルで回答を確認・貼り付けながら進行中です。中断すると現在地点から再開できます。'
          : 'Geminiで生成し、Google Docsへ保存中です。中断すると現在地点から再開できます。'
        : selectedMode === 'semi'
          ? '半自動は、AIの回答を確認・貼り付けしながら1ステップずつ保存します。'
          : '全自動は、Geminiで§0〜§9を順番に生成してGoogle Docsへ保存します。';
    }
  }
}

function automationDraftKey(projectId) {
  return projectId
    ? `sk-state.projects.${projectId}.automation.uiDraft`
    : 'sk-state.automation.uiDraft';
}

function automationExecutionModeKey(projectId) {
  return projectId
    ? `sk-state.projects.${projectId}.${AUTOMATION_EXECUTION_MODE_PATH}`
    : `sk-state.${AUTOMATION_EXECUTION_MODE_PATH}`;
}

function selectedExecutionMode() {
  return $('mission-mode-select')?.value === 'full' ? 'full' : 'semi';
}

function updateMissionModeUI() {
  const mode = selectedExecutionMode();
  for (const field of document.querySelectorAll('.mission-full-auto-only')) {
    field.hidden = mode !== 'full';
  }
  if (currentModel) updateControls(currentModel);
}

// 受講者がこの画面で自分で編集した欄。空にした欄を「未入力」ではなく
// 「意図的に消した」と区別するために記録する。
const touchedDraftFields = new Set();

const DRAFT_TEXT_FIELDS = [
  ['memo', 'mission-automation-memo'],
  ['context', 'mission-automation-context'],
];

function readAutomationDraftFromForm() {
  const clearedFields = DRAFT_TEXT_FIELDS
    .filter(([field, id]) => touchedDraftFields.has(field) && !($(id)?.value || ''))
    .map(([field]) => field);
  return {
    memo: $('mission-automation-memo')?.value || '',
    context: $('mission-automation-context')?.value || '',
    clearedFields,
    // この版数があるドラフトは「受講者が選んだ値」として扱い、以後読み替えない。
    modelPolicyVersion: MODEL_POLICY_VERSION,
    mode: selectedExecutionMode(),
    model: $('mission-model-select')?.value || 'gemini-3.6-flash',
    financeModel: $('mission-finance-model-select')?.value || 'gemini-3.6-flash',
    updatedAt: Date.now(),
  };
}

// 保存済みドラフトをフォームへ反映する。skipFocused を立てると、ユーザーが入力中の欄は
// 触らない（サイドパネル側の保存が飛んできてカーソルごと書き換わるのを防ぐ）。
function applyAutomationDraftToForm(draft, { executionMode, skipFocused = false, remapLegacyModels = false } = {}) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const memo = $('mission-automation-memo');
  const context = $('mission-automation-context');
  const model = $('mission-model-select');
  const finance = $('mission-finance-model-select');
  const mode = $('mission-mode-select');
  const editing = (node) => skipFocused && node && document.activeElement === node;
  // 外から値を入れ直した欄は、受講者の編集ではなくなるので「消した」印も落とす。
  if (memo && !editing(memo)) {
    memo.value = source.memo || '';
    touchedDraftFields.delete('memo');
  }
  if (context && !editing(context)) {
    context.value = source.context || '';
    touchedDraftFields.delete('context');
  }
  // v0.12.28 以前に自動保存された課金専用モデルだけを無料枠モデルへ読み替える。
  // そのまま復元すると既存受講者だけ §7 で止まり続けるが、逆に毎回読み替えると
  // 課金APIキーで Pro を選んだ人が使い続けられなくなる。版数の有無で区別する。
  const remap = { remapLegacy: remapLegacyModels };
  if (model && source.model && !editing(model)) {
    model.value = restoreSelectableModel(source.model, Array.from(model.options).map((o) => o.value), remap);
  }
  if (finance && source.financeModel && !editing(finance)) {
    finance.value = restoreSelectableModel(source.financeModel, Array.from(finance.options).map((o) => o.value), remap);
  }
  if (mode && executionMode && !editing(mode)) mode.value = executionMode;
  updateMissionModeUI();
}

// 読み込みが実際に終わるまで「読込済み」を立てない。先に立てると、案件を切り替えた
// 直後の実行が「もう新案件の値だ」と誤認し、フォームに残った旧案件のメモを送ってしまう。
function loadAutomationDraftForProject(projectId) {
  const normalizedId = projectId || '';
  if (automationDraftProjectId === normalizedId && document.body.dataset.automationDraftLoaded === 'true') {
    return Promise.resolve();
  }
  if (automationDraftLoadPromise && automationDraftLoadingId === normalizedId) {
    return automationDraftLoadPromise;
  }
  if (automationDraftSaveTimer) {
    clearTimeout(automationDraftSaveTimer);
    automationDraftSaveTimer = null;
  }
  automationDraftProjectId = normalizedId;
  automationDraftLoadingId = normalizedId;
  document.body.dataset.automationDraftLoaded = 'false';
  automationDraftLoadPromise = (async () => {
    if (!globalThis.chrome?.storage?.local) return;
    try {
      const key = automationDraftKey(normalizedId);
      const modeKey = automationExecutionModeKey(normalizedId);
      const values = await chrome.storage.local.get([key, modeKey]);
      // 読込中にさらに案件が変わっていたら、この結果は捨てる。
      if (automationDraftProjectId !== normalizedId) return;
      const draft = values?.[key] || {};
      const executionMode = values?.[modeKey] === 'full'
        ? 'full'
        : values?.[modeKey] === 'semi'
          ? 'semi'
          : draft.mode === 'full' ? 'full' : 'semi';
      const remapLegacyModels = needsLegacyModelRemap(draft);
      applyAutomationDraftToForm(draft, { executionMode, remapLegacyModels });
      document.body.dataset.automationDraftLoaded = 'true';
      // 読み替えたら版数を刻んで保存する。次回以降は受講者の選択をそのまま尊重する。
      if (remapLegacyModels) scheduleAutomationDraftSave();
    } catch (_) {
      /* 入力復元に失敗しても操作は継続できる（読込済みにはしない） */
    } finally {
      if (automationDraftLoadingId === normalizedId) {
        automationDraftLoadPromise = null;
        automationDraftLoadingId = null;
      }
    }
  })();
  return automationDraftLoadPromise;
}

// 案件を切り替えた直後は、フォームにまだ旧案件の値が残っていることがある
// （切替完了の表示は即座に解除されるが、ドラフト読込は待たれていない）。
// そのまま実行すると旧案件のメモが新案件へ送られて保存されるため、
// 読み込み直してから、受講者に内容を確認させる。
async function ensureDraftMatchesActiveProject() {
  const activeId = snapshot?.activeProjectId || '';
  if (automationDraftProjectId === activeId
      && document.body.dataset.automationDraftLoaded === 'true') {
    return true;
  }
  await loadAutomationDraftForProject(activeId);
  return false;
}

// 送信直前の保険。購読が届いていなくても、storage に値があれば空のまま送らない。
async function mergeWithStoredDraft(formDraft) {
  try {
    const key = automationDraftKey(automationDraftProjectId || snapshot?.activeProjectId || '');
    const stored = (await chrome.storage.local.get([key]))?.[key] || {};
    return mergeAutomationDraft(formDraft, stored);
  } catch (_) {
    return formDraft;
  }
}

function scheduleAutomationDraftSave() {
  if (!globalThis.chrome?.storage?.local) return;
  if (automationDraftSaveTimer) clearTimeout(automationDraftSaveTimer);
  automationDraftSaveTimer = setTimeout(async () => {
    automationDraftSaveTimer = null;
    const key = automationDraftKey(automationDraftProjectId || '');
    try {
      const current = await chrome.storage.local.get([key]);
      await chrome.storage.local.set({
        [key]: { ...(current?.[key] || {}), ...readAutomationDraftFromForm() },
      });
    } catch (_) {
      /* 保存失敗は実行時の command payload で再送できる */
    }
  }, 300);
}

async function persistMissionExecutionMode() {
  if (!globalThis.chrome?.storage?.local) return;
  const key = automationExecutionModeKey(automationDraftProjectId || snapshot?.activeProjectId || '');
  try {
    await chrome.storage.local.set({ [key]: selectedExecutionMode() });
  } catch (_) {
    showCommandFeedback('実行方法を保存できませんでした。もう一度選択してください。', 'warn');
  }
}

function showCommandFeedback(message, tone = '') {
  const note = $('mission-control-note');
  if (note) {
    note.dataset.tone = tone;
    note.textContent = message;
  }
}

async function openSupportingSidePanel() {
  if (!globalThis.chrome?.sidePanel?.open || !globalThis.chrome?.windows?.getAll) return false;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const target = windows.find((item) => item.focused) || windows[0];
    if (!target?.id) return false;
    await chrome.sidePanel.open({ windowId: target.id });
    return true;
  } catch (_) {
    return false;
  }
}

async function sendMissionCommand(action, payload = {}) {
  if (!globalThis.chrome?.storage?.local) {
    showCommandFeedback('拡張機能として開いた画面で操作してください。', 'warn');
    return false;
  }
  // sidePanel.open はユーザー操作中に開始する必要があるため、storage 書き込みより先に呼ぶ。
  const panelOpening = openSupportingSidePanel();
  const ts = Date.now();
  lastCommandTs = ts;
  showCommandFeedback('操作を準備しています…');
  if (controlFeedbackTimer) clearTimeout(controlFeedbackTimer);
  try {
    // 表示中の案件を明示する。サイドパネルが別案件に切り替わっていたら拒否させる。
    // switchProject だけは payload.projectId が「切替先」を意味するので、そちらを優先する
    // （スプレッドの順序に頼らず、ここで明示的に決める）。
    const commandProjectId = action === 'switchProject'
      ? String(payload.projectId || '')
      : (snapshot?.activeProjectId || '');
    await chrome.storage.local.set({
      [COMMAND_KEY]: { action, ...payload, projectId: commandProjectId, ts },
    });
  } catch (_) {
    showCommandFeedback('操作を送れませんでした。拡張機能を再読み込みしてください。', 'warn');
    return false;
  }
  await panelOpening.catch(() => false);
  controlFeedbackTimer = setTimeout(() => {
    controlFeedbackTimer = null;
    showCommandFeedback('反応がありません。拡張機能を再読み込みしてもう一度お試しください。', 'warn');
  }, 7000);
  return true;
}

function bindControls() {
  $('mission-run-form')?.addEventListener('submit', (event) => event.preventDefault());
  $('mission-run')?.addEventListener('click', async () => {
    if (currentModel?.statusKey === 'setup') {
      chrome.runtime.openOptionsPage?.();
      showCommandFeedback('初期設定を開きました。');
      return;
    }
    if (currentModel?.status === 'completed') {
      sendMissionCommand('openMaster');
      return;
    }
    if (!(await ensureDraftMatchesActiveProject())) {
      showCommandFeedback(
        'このプロジェクトの入力内容を読み込みました。内容を確認してから、もう一度実行してください。',
        'warn',
      );
      return;
    }
    const draft = await mergeWithStoredDraft(readAutomationDraftFromForm());
    sendMissionCommand('startAutomation', { draft });
  });
  $('mission-pause')?.addEventListener('click', () => sendMissionCommand('pauseAutomation'));
  $('mission-stop')?.addEventListener('click', () => sendMissionCommand('openAutomation'));
  $('mission-copy-prompt')?.addEventListener('click', () => sendMissionCommand('copyPrompt'));
  $('mission-open-ai')?.addEventListener('click', () => sendMissionCommand('openAi'));
  $('mission-open-master')?.addEventListener('click', () => sendMissionCommand('openMaster'));
  $('mission-open-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage?.();
    showCommandFeedback('設定画面を開きました。');
  });
  $('mission-open-phase')?.addEventListener('click', () => {
    const phaseNo = currentModel?.currentPhase?.no;
    if (phaseNo !== undefined) sendMissionCommand('openPhase', { phaseNo: String(phaseNo) });
  });
  $('mission-restart-phase')?.addEventListener('click', async () => {
    const phaseNo = currentModel?.currentPhase?.no;
    if (phaseNo === undefined) return;
    if (!(await ensureDraftMatchesActiveProject())) {
      showCommandFeedback(
        'このプロジェクトの入力内容を読み込みました。内容を確認してから、もう一度実行してください。',
        'warn',
      );
      return;
    }
    const mode = $('mission-mode-select')?.value === 'semi' ? '半自動' : '全自動';
    const ok = globalThis.confirm(
      `§${phaseNo} 以降を${mode}でやり直します。\n§${phaseNo}より前の内容は残し、以降の章は上書きされます。`,
    );
    if (!ok) return;
    sendMissionCommand('restartFromPhase', {
      phaseNo: String(phaseNo),
      draft: await mergeWithStoredDraft(readAutomationDraftFromForm()),
    });
  });
  $('mission-route')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-phase-no]');
    if (button) sendMissionCommand('openPhase', { phaseNo: button.dataset.phaseNo });
  });
  for (const id of ['mission-automation-memo', 'mission-automation-context', 'mission-mode-select', 'mission-model-select', 'mission-finance-model-select']) {
    $(id)?.addEventListener('input', scheduleAutomationDraftSave);
    $(id)?.addEventListener('change', scheduleAutomationDraftSave);
  }
  // 受講者が自分で触った欄を覚える。空にしたのが「未入力」ではなく
  // 「意図的に消した」ことを、実行時に伝えられるようにする。
  for (const [field, id] of DRAFT_TEXT_FIELDS) {
    $(id)?.addEventListener('input', () => touchedDraftFields.add(field));
  }
  $('mission-mode-select')?.addEventListener('change', () => {
    updateMissionModeUI();
    persistMissionExecutionMode();
  });
  $('mission-back-panel')?.addEventListener('click', async () => {
    await openSupportingSidePanel();
    globalThis.close();
  });
}

// 案件切替: サイドパネルへ switchProject コマンドを渡すだけ（storage 経由でサイドパネルの
// 既存切替経路 activate → reload を呼ぶ）。切替結果は再 publish される missionSnapshot で受け取る。
function requestProjectSwitch(projectId) {
  if (!projectId) return;
  pendingProjectSwitch = projectId;
  sendMissionCommand('switchProject', { projectId });
  const note = $('mission-project-switch-note');
  if (note) {
    note.dataset.tone = '';
    note.textContent = 'プロジェクトを切り替えています…';
    note.hidden = false;
  }
  if (projectSwitchTimer) clearTimeout(projectSwitchTimer);
  // 一定時間内に反映されなければ、サイドパネル未起動の可能性を正直に伝える。
  projectSwitchTimer = setTimeout(() => {
    projectSwitchTimer = null;
    if (!pendingProjectSwitch) return;
    const n = $('mission-project-switch-note');
    if (n) {
      n.dataset.tone = 'warn';
      n.textContent = '切り替えを確認できません。拡張機能を再読み込みしてお試しください。';
      n.hidden = false;
    }
  }, 7000);
}

function clearProjectSwitchPending() {
  pendingProjectSwitch = null;
  if (projectSwitchTimer) {
    clearTimeout(projectSwitchTimer);
    projectSwitchTimer = null;
  }
  const note = $('mission-project-switch-note');
  if (note) {
    note.dataset.tone = '';
    note.textContent = '';
    note.hidden = true;
  }
}

function bindProjectSwitch() {
  $('mission-project-switch')?.addEventListener('change', function () {
    const id = this.value;
    if (id) requestProjectSwitch(id);
  });
  const form = $('mission-project-new-form');
  const input = $('mission-project-new-input');
  $('mission-project-new')?.addEventListener('click', () => {
    if (!form) return;
    form.hidden = false;
    input?.focus();
  });
  $('mission-project-new-cancel')?.addEventListener('click', () => {
    if (form) form.hidden = true;
    if (input) input.value = '';
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const label = String(input?.value || '').trim();
    if (!label) {
      input?.focus();
      return;
    }
    if (form) form.hidden = true;
    sendMissionCommand('createProject', { label });
  });
}

function applyChange(key, value) {
  if (key === SNAPSHOT_KEY) snapshot = value || null;
  else if (key === TASK_KEY) task = value || null;
  else if (key === COMMAND_RESULT_KEY) {
    if (!value || value.commandTs !== lastCommandTs) return;
    if (controlFeedbackTimer) {
      clearTimeout(controlFeedbackTimer);
      controlFeedbackTimer = null;
    }
    // プロンプトのコピーは、フォーカスを持っているこの画面で実行する。
    // 成否をそのまま表示するので、コピーできていないのに成功と伝えることがない。
    if (value.action === 'copyPrompt' && value.ok && value.promptText) {
      navigator.clipboard.writeText(value.promptText).then(
        () => showCommandFeedback(
          `§${value.phaseNo} のプロンプトをコピーしました。AIの入力欄に貼り付けてください。`,
          'success',
        ),
        () => showCommandFeedback(
          'コピーできませんでした。この画面をクリックしてから、もう一度お試しください。',
          'warn',
        ),
      );
      return;
    }
    showCommandFeedback(
      value.message || (value.ok ? '操作を受け付けました。' : '操作を完了できませんでした。'),
      value.ok ? 'success' : 'warn',
    );
    return;
  }
  else return;
  // 停止反映を検知したらフィードバックを解除。
  if (key === TASK_KEY && controlFeedbackTimer && task && task.status !== 'running' && task.status !== 'retrying') {
    clearTimeout(controlFeedbackTimer);
    controlFeedbackTimer = null;
  }
  render();
}

async function init() {
  bindControls();
  bindProjectSwitch();
  if (!globalThis.chrome?.storage?.local) {
    render();
    return;
  }
  try {
    const values = await chrome.storage.local.get([SNAPSHOT_KEY, TASK_KEY, COMMAND_RESULT_KEY]);
    snapshot = values?.[SNAPSHOT_KEY] || null;
    task = values?.[TASK_KEY] || null;
  } catch (e) {
    /* noop */
  }
  render();
  setInterval(renderElapsedTime, 1000);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[SNAPSHOT_KEY]) applyChange(SNAPSHOT_KEY, changes[SNAPSHOT_KEY].newValue);
    if (changes[TASK_KEY]) applyChange(TASK_KEY, changes[TASK_KEY].newValue);
    if (changes[COMMAND_RESULT_KEY]) applyChange(COMMAND_RESULT_KEY, changes[COMMAND_RESULT_KEY].newValue);
    // サイドパネルで入力された現状メモ・追加コンテキストを全画面へ反映する。
    // 購読しないと、全画面が空欄のまま実行してサイドパネルの入力を空で上書きする。
    const draftKey = automationDraftKey(snapshot?.activeProjectId || automationDraftProjectId || '');
    if (changes[draftKey]) {
      applyAutomationDraftToForm(changes[draftKey].newValue || {}, { skipFocused: true });
    }
    const modeKey = automationExecutionModeKey(snapshot?.activeProjectId || automationDraftProjectId || '');
    if (changes[modeKey]) {
      const mode = $('mission-mode-select');
      if (mode) mode.value = changes[modeKey].newValue === 'full' ? 'full' : 'semi';
      updateMissionModeUI();
      renderPhaseGuide(currentModel || { statusKey: 'ready', isRunning: false, executionMode: selectedExecutionMode() });
    }
  });
}

init();
