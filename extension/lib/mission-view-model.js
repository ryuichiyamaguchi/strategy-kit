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
    ['進め方', '半自動 / 全自動を選ぶ'],
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

// 全画面ホームの「次の一手」= 状態別の推奨アクションとその理由。
// サイドパネルの現在フェーズカード next-move（isFilled/isPartial 分岐）を全画面へ移管し、
// 見る側（ホーム）から「次に何をどこですればよいか」を1段詳しく提示する。
export function deriveNextMove(status, ctx) {
  const { hasBusiness, needsMode, workingPhase, isFilled, isPartial, completed, executionMode } = ctx;
  const label = `§${workingPhase.no} ${workingPhase.title}`.trim();
  if (!hasBusiness) {
    return {
      recommendation: '初期設定を完了する',
      reason: 'Google 連携・事業情報・§0 の3つが揃うと、プロンプト操作を始められます。設定はサイドパネルの ☰ から。',
    };
  }
  if (status === 'running') {
    return {
      recommendation: '全自動の完了を待つ',
      reason: 'AI タブが裏で処理を進めています。止めたいときは下の「一時停止 / 停止」から。',
    };
  }
  if (status === 'retrying') {
    return {
      recommendation: '自動再試行を見守る',
      reason: 'エラーを検知して自動でやり直しています。保存済みのフェーズは失われません。',
    };
  }
  if (status === 'blocked' || status === 'paused') {
    return {
      recommendation: '保存地点から再開する',
      reason: `${completed}フェーズまで保存済みです。サイドパネルの全自動から続きを再開できます。`,
    };
  }
  if (status === 'completed') {
    return {
      recommendation: '戦略書を最終確認する',
      reason: '数値と固有名詞を見直し、戦略書・成果物として書き出せます。',
    };
  }
  if (needsMode) {
    return {
      recommendation: '進め方を選ぶ（自分で / 全自動）',
      reason: 'サイドパネルの ☰「実行モードを管理」から進め方を決めると、次のフェーズに進めます。',
    };
  }
  if (executionMode === 'full') {
    return {
      recommendation: `${label} から全自動を開始する`,
      reason: '入力内容とモデルを確認すると、Geminiが各フェーズを順番に生成してGoogle Docsへ保存します。',
    };
  }
  if (executionMode === 'semi') {
    return {
      recommendation: `${label} から半自動を開始する`,
      reason: 'サイドパネルでAIの回答を確認・貼り付けしながら、1ステップずつGoogle Docsへ保存します。',
    };
  }
  const recommendation = isFilled
    ? `${label} を見直す、または次のフェーズへ進む`
    : isPartial
      ? `${label} の下書きを仕上げる`
      : `${label} のプロンプトをコピーする`;
  const reason = isFilled
    ? '記入済みのフェーズです。内容を確認し、薄バーの ▸ で次のフェーズへ進めます。'
    : isPartial
      ? '下書きがあります。サイドパネルでプロンプトをコピーし、AI の回答で仕上げます。'
      : 'サイドパネルの現在フェーズカードでプロンプトをコピーし、AI に貼り付けて回答を作ります。';
  return { recommendation, reason };
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
  const isRunning = status === 'running' || status === 'retrying';
  const executionMode = task
    ? task.mode === 'semi' ? 'semi' : 'full'
    : input?.executionMode === 'full' ? 'full' : 'semi';
  const statusLabel = executionMode === 'semi'
    ? missionStatusLabel(status).replace('全自動', '半自動')
    : missionStatusLabel(status);

  // 現在地（§N）統一: 実行中はタスクのフェーズ（=first-incomplete currentPhase）、手動時は
  // サイドパネルの選択フェーズ(lastPhase)基準= selectedNo に一致させる。これで薄バー中央の §N と
  // ホームの「現在フェーズ」が常に同じ番号を指す（段階A 申し送り b の統一要件）。進捗ヒーローの
  // % と航路は従来どおり filled/partial の客観進捗（renderMissionControl と同一算術）を使う。
  let workingPhase = currentPhase;
  if (!isRunning && input?.selectedNo != null && input.selectedNo !== '') {
    const selNo = String(input.selectedNo);
    const found = phases.find((phase) => String(phase.no) === selNo);
    if (found) workingPhase = found;
  }
  const workNo = String(workingPhase.no);
  const workingIsFilled = filledSet.has(workNo);
  const workingIsPartial = !workingIsFilled && partialSet.has(workNo);
  const needsMode = !!input?.needsMode && hasBusiness && !isRunning && status !== 'completed';

  let { detailTitle, details } = deriveMissionDetails(status, { completed, total, currentPhase: workingPhase, task });
  let nextMove = deriveNextMove(status, {
    hasBusiness,
    needsMode,
    workingPhase,
    isFilled: workingIsFilled,
    isPartial: workingIsPartial,
    completed,
    total,
    executionMode,
  });
  if (status === 'ready') {
    details = [
      ['現在フェーズ', `§${workingPhase.no} ${workingPhase.title}`],
      ['実行方法', executionMode === 'full' ? '全自動モード' : '半自動モード'],
    ];
  }
  if (executionMode === 'semi') {
    detailTitle = detailTitle.replaceAll('全自動', '半自動');
    details = details.map(([label, value]) => [
      String(label).replaceAll('全自動', '半自動'),
      String(value).replaceAll('全自動', '半自動'),
    ]);
    nextMove = {
      recommendation: nextMove.recommendation.replaceAll('全自動', '半自動'),
      reason: nextMove.reason.replaceAll('全自動', '半自動'),
    };
  }

  return {
    projectName: input?.projectName || '新規プロジェクト',
    // ホーム上部の案件セレクタ用（サイドパネルが DOM #project-select から publish）。
    projects: Array.isArray(input?.projects) ? input.projects : [],
    activeProjectId: input?.activeProjectId || '',
    percent,
    completed,
    total,
    partial,
    metaText: `${completed} / ${total}フェーズ完了${partial ? ` · 下書き ${partial}` : ''}`,
    currentPhase: { no: workingPhase.no, title: workingPhase.title || '' },
    phaseDescription: (task && task.taskLabel) || workingPhase.frame || `${workingPhase.title || ''}を進めます。`,
    status,
    statusKey: hasBusiness ? status : 'setup',
    statusLabel,
    executionMode,
    provider: (task && task.provider) || '待機中',
    route: deriveMissionRoute(phases, filledSet, partialSet, workNo),
    detailTitle,
    details,
    nextMove,
    // ホームは「見る場所」、実作業はサイドパネル、という役割分担の導き文言。
    homeGuide: isRunning
      ? `ここは司令塔です。${executionMode === 'semi' ? '半自動' : '全自動'}の進行を見守り、必要なときは下の操作で止められます。`
      : 'ここは司令塔（見る場所）です。プロンプトのコピーなど実際の作業はサイドパネルで行います。',
    needsMode,
    activity: deriveMissionActivity(phases, filledSet, workingPhase, task),
    action: deriveMissionAction(hasBusiness, status, task),
    // 実行中のみ一時停止/停止が意味を持つ。全画面ページのボタン活性判定に使う。
    isRunning,
    // 保存地点があり再開余地がある状態（保留/一時停止）も含めて「進行中セッション」扱い。
    hasActiveSession: isRunning || status === 'paused' || status === 'blocked',
  };
}
