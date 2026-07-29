// STRATEGY-KIT — project workspace bridge
//
// 既存モジュールは chrome.storage.sync の固定キーを単一ワークスペースとして参照する。
// プロジェクト切替時にその固定キー群を案件別スナップショットへ退避・復元することで、
// 既存の Docs / automation 実装を二重化せず、案件ごとの事業情報と文書参照を分離する。

export const PROJECT_WORKSPACE_SYNC_KEYS = Object.freeze([
  'industry',
  'industryLabel',
  'storeName',
  'caseId',
  'caseName',
  'lastPhase',
  'lastTab',
  'lastSegment',
  'researchTopic',
  'researchNo',
  'researchPhaseLink',
  'showSafetyNotice',
  'setupCollapsed',
  'missionHeaderCollapsed',
  'sk_engagement_mode',
  'sk_hearing_summary_v012',
  'sk_hearing_notes_v012',
  'sk_hearing_meta_v013',
  'sk_hearing_skip_ack_v013',
  'sk_master_doc_v012',
  'sk_draft_doc_v012',
  'sk_chapter_doc_v012',
  'sk_master_backup_v012',
  'sk_research_folder_v012',
]);

export const DEFAULT_PROJECT_WORKSPACE = Object.freeze({
  industry: 'generic',
  industryLabel: '',
  storeName: '',
  caseId: '',
  caseName: '',
  lastPhase: 'phase-0',
  lastTab: 'phases',
  lastSegment: 'work',
  researchTopic: '',
  researchNo: '',
  researchPhaseLink: '',
  showSafetyNotice: true,
  setupCollapsed: false,
  missionHeaderCollapsed: false,
  sk_engagement_mode: '',
});

// 書き込み先の Google ドキュメントを指すキー。案件をまたいで共有されると、
// 別案件の戦略書へ追記してしまう（取り返しがつかない）。
export const PROJECT_WORKSPACE_DOCUMENT_KEYS = Object.freeze([
  'sk_master_doc_v012',
  'sk_draft_doc_v012',
  'sk_chapter_doc_v012',
  'sk_master_backup_v012',
]);

export const PROJECT_WORKSPACE_LOCAL_KEYS = Object.freeze([
  'sk_hearing_rawtext_v012_local',
  'sk_hearing_summary_v013_local',
]);

// 切替が sync 書き換えの途中で中断された場合に、次回起動で復旧するためのジャーナル。
export const WORKSPACE_SWITCH_JOURNAL_KEY = 'sk-state.ui.workspaceSwitchInFlight';
// 旧版（案件別スナップショットが無い時代）からの移行を一度だけ走らせるための印。
export const WORKSPACE_MIGRATED_KEY = 'sk-state.ui.workspaceMigratedAt';
// 案件切替の排他ロック。画面ごとの変数では、Chrome を2つのウィンドウで開いて
// それぞれのサイドパネルから切り替えたときに並走してしまうため storage に置く。
export const PROJECT_SWITCH_LOCK_KEY = 'sk-state.ui.projectSwitchLock';
// ロックの有効期限。切替の途中でサイドパネルが閉じられても、次回以降が
// 永久に締め出されないようにする。
export const PROJECT_SWITCH_LOCK_STALE_MS = 60 * 1000;

// このページが握っているロックの合言葉。自分のロック中は自分の退避を許し、
// 他ウィンドウのロック中は退避を止める、の判別に使う。
let heldLockToken = null;

function newLockToken() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `lock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function acquireProjectSwitchLock({
  localStorage = chrome.storage.local,
  now = Date.now,
} = {}) {
  const stored = await localStorage.get([PROJECT_SWITCH_LOCK_KEY]);
  const current = stored?.[PROJECT_SWITCH_LOCK_KEY];
  const at = now();
  if (current?.token && at - Number(current.startedAt || 0) < PROJECT_SWITCH_LOCK_STALE_MS) {
    return null;
  }
  const token = newLockToken();
  await localStorage.set({ [PROJECT_SWITCH_LOCK_KEY]: { token, startedAt: at } });
  heldLockToken = token;
  return token;
}

export async function releaseProjectSwitchLock({
  token,
  localStorage = chrome.storage.local,
} = {}) {
  const stored = await localStorage.get([PROJECT_SWITCH_LOCK_KEY]);
  const current = stored?.[PROJECT_SWITCH_LOCK_KEY];
  // 期限切れで他ページに奪われたロックは消さない。
  if (current?.token && token && current.token !== token) return false;
  await localStorage.remove([PROJECT_SWITCH_LOCK_KEY]);
  if (heldLockToken === token) heldLockToken = null;
  return true;
}

export function projectWorkspaceStorageKey(projectId) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('projectId is required');
  return `sk-state.projects.${id}.workspace.sync`;
}

export function projectLocalWorkspaceStorageKey(projectId) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('projectId is required');
  return `sk-state.projects.${id}.workspace.local`;
}

export async function readProjectWorkspace({
  projectId,
  localStorage = chrome.storage.local,
} = {}) {
  const key = projectWorkspaceStorageKey(projectId);
  const stored = await localStorage.get([key]);
  const workspace = stored?.[key];
  return workspace && typeof workspace === 'object' ? { ...workspace } : null;
}

export async function readCurrentWorkspace({
  syncStorage = chrome.storage.sync,
} = {}) {
  const stored = await syncStorage.get(PROJECT_WORKSPACE_SYNC_KEYS);
  const workspace = {};
  for (const key of PROJECT_WORKSPACE_SYNC_KEYS) {
    if (stored?.[key] !== undefined) workspace[key] = stored[key];
  }
  return workspace;
}

// いま chrome.storage.sync にある値が、本当に引数の案件のものかを確かめる。
// 切替の最中は「sync は切替先・activeProjectId は切替元」という食い違いが構造的に発生する。
// その隙に capture が走ると、切替先の内容を切替元のスナップショットとして焼き付けてしまい、
// 切替元の事業情報・マスタードキュメント参照が復旧不能に壊れる。
async function syncBelongsToProject(projectId, localStorage) {
  const guard = await localStorage.get([
    'sk-state.ui.activeProjectId',
    WORKSPACE_SWITCH_JOURNAL_KEY,
    PROJECT_SWITCH_LOCK_KEY,
  ]);
  // ジャーナルがある = sync が誰のものか確定していない。この間の capture は常に危険。
  if (guard?.[WORKSPACE_SWITCH_JOURNAL_KEY]) return false;
  // 別ウィンドウが切替中なら、sync はそちらが書き換えている最中。
  // 自分が握っているロックのときだけは、切替処理自身の退避なので許す。
  const lock = guard?.[PROJECT_SWITCH_LOCK_KEY];
  if (lock?.token && lock.token !== heldLockToken) return false;
  const activeProjectId = guard?.['sk-state.ui.activeProjectId'] || '';
  if (!activeProjectId) return true;
  return activeProjectId === String(projectId || '').trim();
}

export async function captureProjectWorkspace({
  projectId,
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  if (!(await syncBelongsToProject(projectId, localStorage))) return null;
  const workspace = await readCurrentWorkspace({ syncStorage });
  const localValues = await localStorage.get(PROJECT_WORKSPACE_LOCAL_KEYS);
  const localWorkspace = {};
  for (const key of PROJECT_WORKSPACE_LOCAL_KEYS) {
    if (localValues?.[key] !== undefined) localWorkspace[key] = localValues[key];
  }
  await localStorage.set({
    [projectWorkspaceStorageKey(projectId)]: workspace,
    [projectLocalWorkspaceStorageKey(projectId)]: localWorkspace,
  });
  return workspace;
}

export async function ensureProjectWorkspace({
  projectId,
  initialWorkspace = null,
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const existing = await readProjectWorkspace({ projectId, localStorage });
  if (existing) return existing;
  const workspace = initialWorkspace && typeof initialWorkspace === 'object'
    ? { ...DEFAULT_PROJECT_WORKSPACE, ...initialWorkspace }
    : { ...DEFAULT_PROJECT_WORKSPACE, ...(await readCurrentWorkspace({ syncStorage })) };
  // local 側のスナップショットも同時に用意する。未定義のままだと restoreProjectWorkspace が
  // ヒアリング原文などの local キーを消しっぱなしにする。
  const localKey = projectLocalWorkspaceStorageKey(projectId);
  const localStored = await localStorage.get([localKey]);
  await localStorage.set({
    [projectWorkspaceStorageKey(projectId)]: workspace,
    [localKey]: localStored?.[localKey] || {},
  });
  return workspace;
}

export async function restoreProjectWorkspace({
  projectId,
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const stored = await readProjectWorkspace({ projectId, localStorage });
  const localKey = projectLocalWorkspaceStorageKey(projectId);
  const localStored = await localStorage.get([localKey]);
  const localWorkspace = localStored?.[localKey] || {};
  const workspace = { ...DEFAULT_PROJECT_WORKSPACE, ...(stored || {}) };
  // remove を先に走らせると、set が失敗したときに sync が空のまま残る。その状態で次の
  // 切替を行うと、空の sync が切替元スナップショットへ退避されてデータが失われる。
  // 先に set して値を確定させ、そのあとで「新しい workspace に無いキー」だけを消す。
  await syncStorage.set(workspace);
  const staleSyncKeys = PROJECT_WORKSPACE_SYNC_KEYS.filter((key) => workspace[key] === undefined);
  if (staleSyncKeys.length) await syncStorage.remove(staleSyncKeys);

  if (Object.keys(localWorkspace).length) await localStorage.set(localWorkspace);
  const staleLocalKeys = PROJECT_WORKSPACE_LOCAL_KEYS.filter((key) => localWorkspace[key] === undefined);
  if (staleLocalKeys.length) await localStorage.remove(staleLocalKeys);
  return workspace;
}

// 旧版（v0.12.28 以前）で作られた案件は workspace スナップショットを持たず、全案件が
// chrome.storage.sync の同じ値を共有していた。そのまま切替を行うと、スナップショットの無い
// 案件が空の既定値で上書きされ、事業情報・マスタードキュメント参照・ヒアリングが消える。
// 更新後の初回起動時に一度だけ、現在の sync / local をすべての案件へ複製する。
export async function migrateLegacyProjectWorkspaces({
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const all = await localStorage.get(null);
  if (all?.[WORKSPACE_MIGRATED_KEY]) return { migrated: [], skipped: true };

  const projectIds = Object.keys(all || {})
    .map((key) => /^sk-state\.projects\.([^.]+)\.meta\.id$/.exec(key))
    .filter(Boolean)
    .map((match) => match[1]);

  const currentSync = await readCurrentWorkspace({ syncStorage });
  // sync だけでなく local のヒアリングスナップショットも複製する。
  const currentLocalValues = await localStorage.get(PROJECT_WORKSPACE_LOCAL_KEYS);
  const currentLocal = {};
  for (const key of PROJECT_WORKSPACE_LOCAL_KEYS) {
    if (currentLocalValues?.[key] !== undefined) currentLocal[key] = currentLocalValues[key];
  }

  // いま sync が指している Google ドキュメントは、アクティブ案件のものと見なす。
  // 全案件へそのまま複製すると、案件Bで全自動を回したときに案件Aの戦略書へ
  // §0〜§9 が追記される（書き込み先が同じ Doc になる）。他の案件からは文書参照を
  // 落とし、「マスター未作成」の状態から始めてもらう。
  const activeProjectId = all?.['sk-state.ui.activeProjectId'] || '';
  const writes = {};
  const migrated = [];
  const documentsCleared = [];
  for (const projectId of projectIds) {
    // 新版で作られた案件は正しい値を持っているので触らない。
    if (all[projectWorkspaceStorageKey(projectId)]) continue;
    const workspace = { ...DEFAULT_PROJECT_WORKSPACE, ...currentSync };
    if (projectId !== activeProjectId) {
      for (const key of PROJECT_WORKSPACE_DOCUMENT_KEYS) delete workspace[key];
      documentsCleared.push(projectId);
    }
    writes[projectWorkspaceStorageKey(projectId)] = workspace;
    writes[projectLocalWorkspaceStorageKey(projectId)] = { ...currentLocal };
    migrated.push(projectId);
  }
  writes[WORKSPACE_MIGRATED_KEY] = new Date().toISOString();
  await localStorage.set(writes);
  return { migrated, documentsCleared, skipped: false };
}

export async function writeWorkspaceSwitchJournal({
  fromProjectId = '',
  toProjectId,
  localStorage = chrome.storage.local,
} = {}) {
  await localStorage.set({
    [WORKSPACE_SWITCH_JOURNAL_KEY]: {
      fromProjectId: String(fromProjectId || ''),
      toProjectId: String(toProjectId || ''),
      startedAt: Date.now(),
    },
  });
}

// 保存領域が「誰のものか確定していない」状態かどうか。ジャーナルが残っているか、
// 別ウィンドウがロックを握っているときに true。この間の sync 書き込みは、
// 別案件の領域を自分の値で汚す危険がある。
export async function isWorkspaceSwitchPending({
  localStorage = chrome.storage.local,
} = {}) {
  const stored = await localStorage.get([WORKSPACE_SWITCH_JOURNAL_KEY, PROJECT_SWITCH_LOCK_KEY]);
  if (stored?.[WORKSPACE_SWITCH_JOURNAL_KEY]) return true;
  const lock = stored?.[PROJECT_SWITCH_LOCK_KEY];
  return !!(lock?.token && lock.token !== heldLockToken);
}

export async function clearWorkspaceSwitchJournal({
  localStorage = chrome.storage.local,
} = {}) {
  await localStorage.remove([WORKSPACE_SWITCH_JOURNAL_KEY]);
}

// 切替が sync 書き換えの途中で終わっていた場合の復旧。退避（capture）は破壊的操作より前に
// 完了しているためスナップショットは常に正しく、restoreProjectWorkspace は冪等なので
// 同じ案件へ復元し直すだけで整合が戻る。
export async function recoverInterruptedWorkspaceSwitch({
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const stored = await localStorage.get([WORKSPACE_SWITCH_JOURNAL_KEY, 'sk-state.ui.activeProjectId']);
  const journal = stored?.[WORKSPACE_SWITCH_JOURNAL_KEY];
  if (!journal || !journal.toProjectId) return { recovered: false };
  const activeId = stored['sk-state.ui.activeProjectId']
    || journal.fromProjectId
    || journal.toProjectId;
  await restoreProjectWorkspace({ projectId: activeId, localStorage, syncStorage });
  // activeProjectId も必ず確定させる。初回の案件作成が中断された場合、ここで
  // 確定させないと「案件は作られたがアクティブでない」状態になり、次回起動が
  // もう一つ案件を自動作成して重複が残る。
  await localStorage.set({ 'sk-state.ui.activeProjectId': activeId });
  await localStorage.remove([WORKSPACE_SWITCH_JOURNAL_KEY]);
  return { recovered: true, projectId: activeId };
}

// 案件が1件も無い状態へ戻す。最後の案件を削除したあとに sync を残すと、次に作る案件が
// 削除済み案件のマスタードキュメント・ヒアリング要約を引き継いでしまう。
export async function resetWorkspaceToDefault({
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  await syncStorage.set({ ...DEFAULT_PROJECT_WORKSPACE });
  const staleSyncKeys = PROJECT_WORKSPACE_SYNC_KEYS
    .filter((key) => DEFAULT_PROJECT_WORKSPACE[key] === undefined);
  if (staleSyncKeys.length) await syncStorage.remove(staleSyncKeys);
  await localStorage.remove(PROJECT_WORKSPACE_LOCAL_KEYS);
  return { ...DEFAULT_PROJECT_WORKSPACE };
}

export async function switchProjectWorkspace({
  fromProjectId,
  toProjectId,
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const fromId = String(fromProjectId || '').trim();
  const toId = String(toProjectId || '').trim();
  if (!toId) throw new Error('toProjectId is required');
  // ここまでは破壊的操作なし（退避とスナップショット作成のみ）。
  if (fromId && fromId !== toId) {
    await captureProjectWorkspace({ projectId: fromId, localStorage, syncStorage });
  }
  await ensureProjectWorkspace({
    projectId: toId,
    initialWorkspace: fromId ? DEFAULT_PROJECT_WORKSPACE : null,
    localStorage,
    syncStorage,
  });
  // ここから sync を書き換える。中断されたら次回起動の recover が拾えるよう記録する。
  await writeWorkspaceSwitchJournal({ fromProjectId: fromId, toProjectId: toId, localStorage });
  return restoreProjectWorkspace({ projectId: toId, localStorage, syncStorage });
}

export async function patchActiveProjectWorkspace({
  patch,
  localStorage = chrome.storage.local,
  syncStorage = chrome.storage.sync,
} = {}) {
  const activeStored = await localStorage.get(['sk-state.ui.activeProjectId']);
  const projectId = activeStored?.['sk-state.ui.activeProjectId'] || '';
  if (!projectId) return { projectId: '', workspace: null };
  const existing = await ensureProjectWorkspace({ projectId, localStorage, syncStorage });
  const allowedPatch = {};
  for (const key of PROJECT_WORKSPACE_SYNC_KEYS) {
    if (patch?.[key] !== undefined) allowedPatch[key] = patch[key];
  }
  const workspace = { ...existing, ...allowedPatch };
  await localStorage.set({
    [projectWorkspaceStorageKey(projectId)]: workspace,
  });
  return { projectId, workspace };
}
