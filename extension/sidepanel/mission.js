// STRATEGY-KIT — 全自動 全画面 見守りページ (mission.html)
//
// 一方向構造: storage を購読 → 表示モデルを組み立て → DOM を描画する。ここから
// 進捗系 storage を書き換えることはしない。唯一の書き込みは一時停止/停止コマンド
// (sk-state.ui.missionCommand) で、サイドパネルがそれを購読して既存の
// キャンセルボタンへ委譲する。実行ロジック(automation.js)には一切触れない。
//
// 購読キー:
//   - sk_task_monitor_v1           … live task (status / taskLabel / lastEvent / provider)
//   - sk-state.ui.missionSnapshot  … サイドパネルが publish する raw 入力 (phases / 進捗 / 案件名)

import { deriveMissionModel } from '../lib/mission-view-model.js';

const TASK_KEY = 'sk_task_monitor_v1';
const SNAPSHOT_KEY = 'sk-state.ui.missionSnapshot';
const COMMAND_KEY = 'sk-state.ui.missionCommand';

let snapshot = null; // raw 入力 (phases / filledNos / partialNos / hasBusiness / projectName)
let task = null; // live task
let controlFeedbackTimer = null;
let pendingProjectSwitch = null; // 切替要求中の projectId（反映されるまで保持）
let projectSwitchTimer = null;

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
    const label = document.createElement('span');
    label.textContent = `§${item.no}`;
    li.append(dot, label);
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

function render() {
  const model = deriveMissionModel({
    phases: snapshot?.phases || [],
    filledNos: snapshot?.filledNos || [],
    partialNos: snapshot?.partialNos || [],
    task,
    hasBusiness: snapshot?.hasBusiness,
    projectName: snapshot?.projectName,
    // 段階B: 現在地統一・状態別の次の一手・進め方未選択・案件切替のための追加入力。
    selectedNo: snapshot?.selectedNo,
    needsMode: snapshot?.needsMode,
    projects: snapshot?.projects,
    activeProjectId: snapshot?.activeProjectId,
  });

  // 案件切替の反映を検知したら「反映まち」表示を解除する。
  if (pendingProjectSwitch && model.activeProjectId === pendingProjectSwitch) {
    clearProjectSwitchPending();
  }

  const topbar = $('mission-topbar');
  if (topbar) topbar.dataset.running = String(model.isRunning);
  const statusText = $('mission-status-text');
  if (statusText) statusText.textContent = model.isRunning ? '全自動 実行中' : model.statusLabel;
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
}

// 「次の一手」= 状態別の推奨アクション＋理由（サイドパネルから移管した詳細版）。
function renderNextMove(model) {
  const reco = $('mission-nextmove-recommendation');
  const reason = $('mission-nextmove-reason');
  if (reco) reco.textContent = model.nextMove?.recommendation || '—';
  if (reason) reason.textContent = model.nextMove?.reason || '';
}

// ホームは「見る場所」、作業はサイドパネル、という役割分担の導き。
function renderPhaseGuide(model) {
  const guide = $('mission-phase-guide');
  if (guide) guide.textContent = model.homeGuide || '';
}

// 未設定 / 進め方未選択（needs-mode）を正直に表示する。
function renderModeBanner(model) {
  const banner = $('mission-mode-banner');
  if (!banner) return;
  let text = '';
  if (model.statusKey === 'setup') {
    banner.dataset.tone = 'setup';
    text = '初期設定がまだです。サイドパネルの ☰ から Google 連携・事業情報・§0 を整えましょう。';
  } else if (model.needsMode) {
    banner.dataset.tone = 'mode';
    text = '進め方（自分で / 全自動）が未選択です。サイドパネルの ☰「全自動を管理」から選べます。';
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

  // 切替可能な案件が2件以上のときだけセレクタを出す（1件以下は名前表示のみ）。
  const canSwitch = projects.length > 1;
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
  const pause = $('mission-pause');
  const stop = $('mission-stop');
  // 一時停止/停止は実行中(running/retrying)のときのみ意味を持つ。
  const enabled = model.isRunning;
  if (pause) pause.disabled = !enabled;
  if (stop) stop.disabled = !enabled;
  // フィードバック中でなければ既定の注記へ戻す。
  if (!controlFeedbackTimer) {
    const note = $('mission-control-note');
    if (note) {
      note.dataset.tone = '';
      note.textContent = enabled
        ? '一時停止・停止はサイドパネル経由で実行されます。サイドパネルを閉じている場合は反応しません。'
        : '現在は実行中のセッションがありません。全自動を開始すると操作できます。';
    }
  }
}

// 一時停止/停止: サイドパネルへコマンドを渡すだけ。サイドパネルが購読して
// 既存のキャンセル(#sk-auto-cancel)へ委譲する。ここで automation を直接止めない。
function sendControlCommand() {
  try {
    chrome.storage.local.set({ [COMMAND_KEY]: { action: 'cancel', ts: Date.now() } });
  } catch (e) {
    /* noop */
  }
  const note = $('mission-control-note');
  if (note) {
    note.dataset.tone = '';
    note.textContent = 'サイドパネルへ停止を要求しました…';
  }
  if (controlFeedbackTimer) clearTimeout(controlFeedbackTimer);
  // 一定時間内に停止が反映されなければ、サイドパネル未起動の可能性を正直に表示。
  controlFeedbackTimer = setTimeout(() => {
    controlFeedbackTimer = null;
    const live = task && (task.status === 'running' || task.status === 'retrying');
    const noteEl = $('mission-control-note');
    if (noteEl && live) {
      noteEl.dataset.tone = 'warn';
      noteEl.textContent = '反応がありません。サイドパネルが開いているか確認してください。';
    } else {
      render();
    }
  }, 5000);
}

function bindControls() {
  $('mission-pause')?.addEventListener('click', sendControlCommand);
  $('mission-stop')?.addEventListener('click', sendControlCommand);
}

// 案件切替: サイドパネルへ switchProject コマンドを渡すだけ（storage 経由でサイドパネルの
// 既存切替経路 activate → reload を呼ぶ）。切替結果は再 publish される missionSnapshot で受け取る。
function requestProjectSwitch(projectId) {
  if (!projectId) return;
  pendingProjectSwitch = projectId;
  try {
    chrome.storage.local.set({ [COMMAND_KEY]: { action: 'switchProject', projectId, ts: Date.now() } });
  } catch (e) {
    /* noop */
  }
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
      n.textContent = 'サイドパネルを開いてから切り替えてください（切替はサイドパネル経由で反映されます）。';
      n.hidden = false;
    }
  }, 5000);
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
}

function applyChange(key, value) {
  if (key === SNAPSHOT_KEY) snapshot = value || null;
  else if (key === TASK_KEY) task = value || null;
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
    const values = await chrome.storage.local.get([SNAPSHOT_KEY, TASK_KEY]);
    snapshot = values?.[SNAPSHOT_KEY] || null;
    task = values?.[TASK_KEY] || null;
  } catch (e) {
    /* noop */
  }
  render();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[SNAPSHOT_KEY]) applyChange(SNAPSHOT_KEY, changes[SNAPSHOT_KEY].newValue);
    if (changes[TASK_KEY]) applyChange(TASK_KEY, changes[TASK_KEY].newValue);
  });
}

init();
