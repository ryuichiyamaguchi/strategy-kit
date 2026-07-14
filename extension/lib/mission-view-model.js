// STRATEGY-KIT — mission view-model (pure, no DOM / no chrome)
//
// 「state → 表示文言/状態」の純関数群。全画面ページ mission.js が購読データ
// (sk-state.ui.missionSnapshot の raw 入力 + sk_task_monitor_v1 の live task) から
// 表示モデルを組み立てるために使う。
//
// NOTE(共通化 TODO): 同じロジックは sidepanel.js renderMissionControl 内にも
// インライン実装がある。段階3では既存の source-regex テスト
// (tests/phase0/strategy-tab-redesign.test.mjs) が sidepanel.js 内の
// detailTitle 文言・ラベルマップ・pause/stop 配列を固定しているため、
// sidepanel.js からの引き剥がしは行わず、本モジュールへ複製した。
// 将来テストを本モジュール直呼びへ書き換えたうえで sidepanel.js を
// 本モジュール参照へ寄せて重複を解消する。

export const MISSION_STATUS_LABELS = {
  running: '全自動 · 実行中',
  retrying: '全自動 · 再試行中',
  paused: '全自動 · 一時停止',
  blocked: '全自動 · 保留',
  completed: '全自動 · 完了',
  ready: '開始前',
};

const TASK_STALE_AFTER_MS = 10 * 60 * 1000;

export function missionStatusLabel(status) {
  return MISSION_STATUS_LABELS[status] || '開始前';
}

// sidepanel.js getLiveMissionTask と同一のフィルタ。stale / 非表示 / idle は無効化。
export function getLiveMissionTask(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.visible === false || snapshot.status === 'idle') return null;
  const updatedAt = Number(snapshot.updatedAt || 0);
  if (!updatedAt || now - updatedAt > TASK_STALE_AFTER_MS) return null;
  return snapshot;
}

export function deriveMissionRoute(phases, filledSet, partialSet, currentNo) {
  return phases.map((phase) => {
    const no = String(phase.no);
    const isDone = filledSet.has(no);
    const isCurrent = !isDone && (partialSet.has(no) || no === currentNo);
    return { no, title: phase.title || '', state: isDone ? 'done' : isCurrent ? 'current' : 'todo' };
  });
}

export function deriveMissionActivity(phases, filledSet, currentPhase, task) {
  const activity = [];
  const completed = phases.filter((phase) => filledSet.has(String(phase.no)));
  if (completed.length) {
    const phase = completed[completed.length - 1];
    activity.push({ done: true, title: `§${phase.no} ${phase.title}`, detail: 'Google Docsへ保存済み' });
  }
  if (task) {
    activity.push({
      done: task.status === 'completed',
      title: task.taskLabel || `§${currentPhase.no} ${currentPhase.title}`,
      detail: task.lastEvent || '全自動で処理中',
    });
  } else if (currentPhase) {
    activity.push({ done: false, title: `§${currentPhase.no} ${currentPhase.title}`, detail: '次に進めるフェーズ' });
  }
  return activity.slice(-3);
}

export function deriveMissionDetails(status, ctx) {
  const { completed, total, currentPhase, task } = ctx;
  const currentLabel = `§${currentPhase.no} ${currentPhase.title}`;
  let detailTitle = '次の一手';
  let details = [
    ['現在フェーズ', currentLabel],
    ['進め方', '自分で進める / 全自動を管理'],
  ];
  if (status === 'running') {
    detailTitle = '全自動の進行状況';
    details = [
      ['全体の流れ', `${completed} / ${total}フェーズ完了`],
      ['現在地点', (task && task.taskLabel) || currentLabel],
      ['直近', (task && task.lastEvent) || '処理中'],
    ];
  } else if (status === 'retrying') {
    detailTitle = '自動再試行の状況';
    details = [
      ['現在地点', (task && task.taskLabel) || currentLabel],
      ['状況', (task && task.lastEvent) || '再試行中'],
      ['保存済み', `${completed}フェーズ`],
    ];
  } else if (status === 'blocked' || status === 'paused') {
    detailTitle = '保存地点から再開できます';
    details = [
      ['止まった地点', (task && task.taskLabel) || currentLabel],
      ['直近', (task && task.lastEvent) || '処理を停止'],
      ['保存済み', `${completed}フェーズ`],
    ];
  } else if (status === 'completed') {
    detailTitle = '戦略書が完成しました';
    details = [
      ['完成物', 'STRATEGY-KIT 戦略書'],
      ['種別', 'Google Docs'],
      ['要確認', '数値と固有名詞を最終確認'],
    ];
  }
  return { detailTitle, details };
}

// sidepanel.js renderMissionControl の action 決定と同一。
export function deriveMissionAction(hasBusiness, status, task) {
  if (!hasBusiness) return 'setup';
  if (status === 'completed') return 'master';
  return task ? 'automation' : 'phase';
}

// raw 入力 (phases / filledNos / partialNos / task / hasBusiness / projectName) から
// 全画面ページが描画する表示モデルを組み立てる。renderMissionControl の算術を写す。
export function deriveMissionModel(input, now = Date.now()) {
  const phases = Array.isArray(input?.phases) ? input.phases : [];
  const filledSet = new Set((input?.filledNos || []).map(String));
  const partialSet = new Set((input?.partialNos || []).map(String));
  const task = getLiveMissionTask(input?.task, now);
  const hasBusiness = !!input?.hasBusiness;

  const total = phases.length;
  const completed = phases.filter((phase) => filledSet.has(String(phase.no))).length;
  const partial = phases.filter(
    (phase) => partialSet.has(String(phase.no)) && !filledSet.has(String(phase.no))
  ).length;
  const currentPhase =
    phases.find((phase) => partialSet.has(String(phase.no)) && !filledSet.has(String(phase.no))) ||
    phases.find((phase) => !filledSet.has(String(phase.no))) ||
    phases[phases.length - 1] ||
    { no: '0', title: '', frame: '' };
  const percent =
    total === 0 ? 0 : completed >= total ? 100 : Math.round(((completed + partial * 0.5) / total) * 100);
  const status = total > 0 && completed >= total ? 'completed' : (task && task.status) || 'ready';

  const { detailTitle, details } = deriveMissionDetails(status, { completed, total, currentPhase, task });
  const isRunning = status === 'running' || status === 'retrying';

  return {
    projectName: input?.projectName || '新規プロジェクト',
    percent,
    completed,
    total,
    partial,
    metaText: `${completed} / ${total}フェーズ完了${partial ? ` · 下書き ${partial}` : ''}`,
    currentPhase: { no: currentPhase.no, title: currentPhase.title || '' },
    phaseDescription: (task && task.taskLabel) || currentPhase.frame || `${currentPhase.title || ''}を進めます。`,
    status,
    statusKey: hasBusiness ? status : 'setup',
    statusLabel: missionStatusLabel(status),
    provider: (task && task.provider) || '待機中',
    route: deriveMissionRoute(phases, filledSet, partialSet, String(currentPhase.no)),
    detailTitle,
    details,
    activity: deriveMissionActivity(phases, filledSet, currentPhase, task),
    action: deriveMissionAction(hasBusiness, status, task),
    // 実行中のみ一時停止/停止が意味を持つ。全画面ページのボタン活性判定に使う。
    isRunning,
    // 保存地点があり再開余地がある状態（保留/一時停止）も含めて「進行中セッション」扱い。
    hasActiveSession: isRunning || status === 'paused' || status === 'blocked',
  };
}
