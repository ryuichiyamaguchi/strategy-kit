// STRATEGY-KIT — 状態永続化モジュール (v0.12: マルチプロジェクト対応)
// 役割:
//   chrome.storage.local を使い、サイドパネルを閉じても状態を保持する。
//   SK_STATE を window に公開し、各モジュールから呼び出す。
//
// キー命名規則:
//   sk-state.ui.*                                  プロジェクト非依存のUI状態
//   sk-state.projects.{projectId}.meta.*           プロジェクトのメタ情報
//   sk-state.projects.{projectId}.placeholders.*   プロジェクト別のプレースホルダ
//   sk-state.projects.{projectId}.automation.*     プロジェクト別の半自動化進行
//
// 後方互換:
//   activeProjectId が null（v0.11.x 由来データのみ存在）の場合、save/load は
//   旧仕様の sk-state.{key} フラット形式で動作する。background.js のマイグレーションで
//   既存フラットデータをデフォルトプロジェクト配下に移行する。

(function () {
  'use strict';

  // デバウンス用タイマー管理
  const _debounceTimers = {};
  let _workspaceModulePromise = null;

  function loadWorkspaceModule() {
    if (!_workspaceModulePromise) {
      _workspaceModulePromise = import(chrome.runtime.getURL('phase0/project-workspace.js'));
    }
    return _workspaceModulePromise;
  }

  // 案件の切替／新規作成が走っている間は true。並走すると、片方の sync 内容を
  // もう片方の案件スナップショットへ退避したり、ジャーナルを互いに消し合って
  // 次回起動でも復旧できなくなるため、同時実行を禁止する。
  // 同一画面はこのフラグ、別ウィンドウのサイドパネルとは storage 上のロックで排他する。
  let _projectSwitchInFlight = false;

  // 切替・新規作成を、画面内フラグ + storage ロック + 失敗時ロールバックで包む。
  // 途中で失敗したまま放置すると、以降の退避がすべて拒否され（退避できない状態）、
  // 受講者の編集が次回起動の復旧で消える。その場で整合を戻してから投げ直す。
  async function runExclusiveProjectChange(run) {
    if (_projectSwitchInFlight) {
      throw new Error('案件の切り替え中です。完了してからもう一度お試しください。');
    }
    const workspace = await loadWorkspaceModule();
    const token = await workspace.acquireProjectSwitchLock({ localStorage: chrome.storage.local });
    if (!token) {
      throw new Error('別のウィンドウで案件を切り替え中です。完了してからもう一度お試しください。');
    }
    _projectSwitchInFlight = true;
    try {
      return await run();
    } catch (error) {
      try {
        await workspace.recoverInterruptedWorkspaceSwitch({
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
        SK_STATE._activeProjectId = await SK_STATE.project.getActiveId();
      } catch (rollbackError) {
        console.warn('[STRATEGY-KIT] project change rollback failed:', rollbackError);
      }
      throw error;
    } finally {
      _projectSwitchInFlight = false;
      await workspace.releaseProjectSwitchLock({ token, localStorage: chrome.storage.local });
    }
  }

  const SK_STATE = {
    _activeProjectId: null,
    _initialized: false,
    isProjectSwitchInFlight: function () {
      return _projectSwitchInFlight;
    },

    /**
     * 起動時に1回呼ぶ。activeProjectId を同期キャッシュへロード。
     * @returns {Promise<void>}
     */
    init: async function () {
      const workspace = await loadWorkspaceModule();
      // 1) 旧版で作られた案件へ、現在の sync / local を一度だけ複製する。
      await workspace.migrateLegacyProjectWorkspaces({
        localStorage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      // 2) 中断された切替が残っていれば、スナップショットから整合を戻す。
      await workspace.recoverInterruptedWorkspaceSwitch({
        localStorage: chrome.storage.local,
        syncStorage: chrome.storage.sync,
      });
      const result = await chrome.storage.local.get(['sk-state.ui.activeProjectId']);
      SK_STATE._activeProjectId = result['sk-state.ui.activeProjectId'] || null;
      if (SK_STATE._activeProjectId) {
        await workspace.ensureProjectWorkspace({
          projectId: SK_STATE._activeProjectId,
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
      }
      SK_STATE._initialized = true;
    },

    /**
     * キーをアクティブプロジェクトのスコープへマップする。
     *   - 'ui.*'        / 'projects.*' は無加工で 'sk-state.' プレフィックスのみ付与
     *   - その他のキーは activeProjectId 配下へ
     *   - activeProjectId が無い場合は旧仕様フラットキー（互換）
     */
    _scopedKey: function (key) {
      if (key.startsWith('ui.') || key.startsWith('projects.')) {
        return 'sk-state.' + key;
      }
      if (!SK_STATE._activeProjectId) {
        return 'sk-state.' + key;
      }
      return 'sk-state.projects.' + SK_STATE._activeProjectId + '.' + key;
    },

    /**
     * 1件保存
     * @param {string} key  - ドット区切りキー (e.g. 'placeholders.industry')
     * @param {*} value
     */
    save: function (key, value) {
      const storageKey = SK_STATE._scopedKey(key);
      const obj = {};
      obj[storageKey] = value;
      chrome.storage.local.set(obj);
    },

    /**
     * 1件読込（Promise）
     * @param {string} key
     * @param {*} defaultValue
     * @returns {Promise<*>}
     */
    load: function (key, defaultValue) {
      const storageKey = SK_STATE._scopedKey(key);
      return new Promise(function (resolve) {
        chrome.storage.local.get([storageKey], function (result) {
          const val = result[storageKey];
          resolve(val !== undefined ? val : defaultValue);
        });
      });
    },

    /**
     * 複数キーをまとめて保存
     * @param {Object} obj  - { 'placeholders.industry': 'クライミングジム', ... }
     */
    saveAll: function (obj) {
      const mapped = {};
      for (const key of Object.keys(obj)) {
        mapped[SK_STATE._scopedKey(key)] = obj[key];
      }
      chrome.storage.local.set(mapped);
    },

    /**
     * 全 sk-state.* キーを読込してコールバックに渡す（旧仕様互換）。
     * アクティブプロジェクト配下のキーは projectId プレフィックスを剥がした形で返す。
     * @param {function(Object): void} callback - { 'placeholders.industry': '...', ... }
     */
    loadAll: function (callback) {
      chrome.storage.local.get(null, function (all) {
        const filtered = {};
        const projectPrefix = SK_STATE._activeProjectId
          ? 'sk-state.projects.' + SK_STATE._activeProjectId + '.'
          : null;
        for (const k of Object.keys(all)) {
          if (!k.startsWith('sk-state.')) continue;

          if (projectPrefix && k.startsWith(projectPrefix)) {
            filtered[k.slice(projectPrefix.length)] = all[k];
            continue;
          }
          if (k.startsWith('sk-state.ui.')) {
            filtered[k.slice('sk-state.'.length)] = all[k];
            continue;
          }
          if (k.startsWith('sk-state.projects.')) continue;

          // 旧仕様フラットキー（互換）
          filtered[k.slice('sk-state.'.length)] = all[k];
        }
        callback(filtered);
      });
    },

    /**
     * 全状態を消去（全プロジェクト + UI 状態を含む）。
     * @returns {Promise<void>}
     */
    reset: function () {
      Object.keys(_debounceTimers).forEach(function (k) {
        clearTimeout(_debounceTimers[k]);
        delete _debounceTimers[k];
      });
      return new Promise(function (resolve) {
        chrome.storage.local.get(null, function (all) {
          const keys = Object.keys(all).filter(function (k) {
            return k.startsWith('sk-state.');
          });
          if (keys.length === 0) {
            SK_STATE._activeProjectId = null;
            resolve();
            return;
          }
          chrome.storage.local.remove(keys, function () {
            SK_STATE._activeProjectId = null;
            resolve();
          });
        });
      });
    },

    /**
     * ストレージ変更を監視
     * @param {string} key  - e.g. 'placeholders.industry'
     * @param {function(newValue, oldValue): void} callback
     */
    on: function (key, callback) {
      const storageKey = SK_STATE._scopedKey(key);
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes[storageKey]) {
          callback(changes[storageKey].newValue, changes[storageKey].oldValue);
        }
      });
    },

    /**
     * デバウンス付き保存（連続入力で保存頻度を抑制）
     * @param {string} key
     * @param {*} value
     * @param {number} ms  - デフォルト 500ms
     */
    debounceSave: function (key, value, ms) {
      const delay = ms !== undefined ? ms : 500;
      if (_debounceTimers[key]) {
        clearTimeout(_debounceTimers[key]);
      }
      _debounceTimers[key] = setTimeout(function () {
        SK_STATE.save(key, value);
        delete _debounceTimers[key];
      }, delay);
    },

    /**
     * プロジェクト管理 API
     */
    project: {
      /**
       * 現在アクティブな projectId を取得
       * @returns {Promise<string|null>}
       */
      getActiveId: function () {
        return new Promise(function (resolve) {
          chrome.storage.local.get(['sk-state.ui.activeProjectId'], function (result) {
            resolve(result['sk-state.ui.activeProjectId'] || null);
          });
        });
      },

      /**
       * 新規プロジェクト作成（自動的にアクティブ化）
       * @param {string} label
       * @param {{industry?: string, businessName?: string}} [options]
       * @returns {Promise<string>} 新しい projectId
       */
      create: async function (label, options) {
        return runExclusiveProjectChange(() => SK_STATE.project._createUnsafe(label, options));
      },

      _createUnsafe: async function (label, options) {
        const opts = options || {};
        const currentId = SK_STATE._activeProjectId || await SK_STATE.project.getActiveId();
        const workspace = await loadWorkspaceModule();
        if (currentId) {
          await workspace.captureProjectWorkspace({
            projectId: currentId,
            localStorage: chrome.storage.local,
            syncStorage: chrome.storage.sync,
          });
        }
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'proj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        const now = new Date().toISOString();
        const setObj = {};
        setObj['sk-state.projects.' + id + '.meta.id'] = id;
        setObj['sk-state.projects.' + id + '.meta.label'] = label || '無題プロジェクト';
        setObj['sk-state.projects.' + id + '.meta.createdAt'] = now;
        setObj['sk-state.projects.' + id + '.meta.updatedAt'] = now;
        const initialWorkspace = currentId
          ? {
              ...workspace.DEFAULT_PROJECT_WORKSPACE,
              industry: opts.industryId || 'generic',
              industryLabel: opts.industry || '',
              storeName: opts.businessName || '',
            }
          : {
              ...workspace.DEFAULT_PROJECT_WORKSPACE,
              ...(await workspace.readCurrentWorkspace({ syncStorage: chrome.storage.sync })),
            };
        setObj[workspace.projectWorkspaceStorageKey(id)] = initialWorkspace;
        const initialLocalWorkspace = currentId
          ? {}
          : await chrome.storage.local.get(workspace.PROJECT_WORKSPACE_LOCAL_KEYS);
        setObj[workspace.projectLocalWorkspaceStorageKey(id)] = initialLocalWorkspace;
        await chrome.storage.local.set(setObj);
        // ここから sync を新案件へ入れ替える。切替と同じく、中断されたら次回起動で
        // 復旧できるようジャーナルを置く（無いと不整合が再起動しても自己修復しない）。
        await workspace.writeWorkspaceSwitchJournal({
          fromProjectId: currentId || '',
          toProjectId: id,
          localStorage: chrome.storage.local,
        });
        await workspace.restoreProjectWorkspace({
          projectId: id,
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
        await chrome.storage.local.remove(['sk_task_monitor_v1']);
        await chrome.storage.local.set({ 'sk-state.ui.activeProjectId': id });
        SK_STATE._activeProjectId = id;
        await workspace.clearWorkspaceSwitchJournal({ localStorage: chrome.storage.local });
        return id;
      },

      /**
       * 既存プロジェクトをアクティブ化
       * @param {string} projectId
       * @returns {Promise<void>}
       */
      activate: async function (projectId) {
        return runExclusiveProjectChange(() => SK_STATE.project._activateUnsafe(projectId));
      },

      _activateUnsafe: async function (projectId) {
        const targetId = String(projectId || '').trim();
        if (!targetId) throw new Error('projectId is required');
        const currentId = SK_STATE._activeProjectId || await SK_STATE.project.getActiveId();
        if (currentId === targetId) return;
        const workspace = await loadWorkspaceModule();
        await workspace.switchProjectWorkspace({
          fromProjectId: currentId,
          toProjectId: targetId,
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
        await chrome.storage.local.remove(['sk_task_monitor_v1']);
        await chrome.storage.local.set({ 'sk-state.ui.activeProjectId': targetId });
        SK_STATE._activeProjectId = targetId;
        // ここまで到達したら切替は完結している。中断復旧用のジャーナルを消す。
        await workspace.clearWorkspaceSwitchJournal({ localStorage: chrome.storage.local });
      },

      /**
       * プロジェクト一覧を取得（createdAt 昇順）
       * @returns {Promise<Array<{id, label, createdAt, updatedAt}>>}
       */
      list: function () {
        return new Promise(function (resolve) {
          chrome.storage.local.get(null, function (all) {
            const projects = {};
            for (const k of Object.keys(all)) {
              const m = k.match(/^sk-state\.projects\.([^.]+)\.meta\.(.+)$/);
              if (m) {
                const id = m[1];
                const metaKey = m[2];
                if (!projects[id]) projects[id] = { id: id };
                projects[id][metaKey] = all[k];
              }
            }
            for (const id of Object.keys(projects)) {
              const workspace = all['sk-state.projects.' + id + '.workspace.sync'] || {};
              projects[id].industryLabel = workspace.industryLabel || '';
              projects[id].storeName = workspace.storeName || '';
              projects[id].masterDocumentId = workspace.sk_master_doc_v012?.documentId || '';
            }
            const list = Object.values(projects).sort(function (a, b) {
              return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
            });
            resolve(list);
          });
        });
      },

      /**
       * プロジェクトを削除。削除対象がアクティブだった場合、最も古い別案件をアクティブ化。
       * 案件がなくなった場合は activeProjectId を null に。
       * @param {string} projectId
       * @returns {Promise<{newActiveId: string|null}>}
       */
      delete: async function (projectId) {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(function (k) {
          return k.startsWith('sk-state.projects.' + projectId + '.');
        });
        await chrome.storage.local.remove(keys);
        if (SK_STATE._activeProjectId !== projectId) {
          return { newActiveId: SK_STATE._activeProjectId };
        }
        const others = await SK_STATE.project.list();
        if (!others.length) {
          // 最後の案件を消したら sync も初期状態へ戻す。残しておくと、次に作る案件が
          // 削除済み案件のマスタードキュメント・ヒアリング要約を引き継いでしまう。
          const workspaceModule = await loadWorkspaceModule();
          await workspaceModule.resetWorkspaceToDefault({
            localStorage: chrome.storage.local,
            syncStorage: chrome.storage.sync,
          });
          await chrome.storage.local.remove(['sk-state.ui.activeProjectId']);
          SK_STATE._activeProjectId = null;
          return { newActiveId: null };
        }
        const next = others[0].id;
        const workspace = await loadWorkspaceModule();
        await workspace.restoreProjectWorkspace({
          projectId: next,
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
        await chrome.storage.local.set({ 'sk-state.ui.activeProjectId': next });
        SK_STATE._activeProjectId = next;
        return { newActiveId: next };
      },

      /**
       * 現在の sync ワークスペースをアクティブ案件へ退避。
       * options など別画面で更新した値も、切替前に案件へ固定できる。
       */
      /**
       * 保存領域へ書き込んでよい状態かを返す。
       *   ''          … 通常。書き込んでよい
       *   'switching' … 自分の画面で切替中。書き込みは見送るが、退避は切替側が行うので問題ない
       *   'unsettled' … 切替が途中で終わっている／別ウィンドウが切替中。書き込むと別案件を汚す
       * @returns {Promise<string>}
       */
      workspaceBusyReason: async function () {
        if (_projectSwitchInFlight) return 'switching';
        const workspace = await loadWorkspaceModule();
        const pending = await workspace.isWorkspaceSwitchPending({ localStorage: chrome.storage.local });
        return pending ? 'unsettled' : '';
      },

      saveWorkspace: async function () {
        const projectId = SK_STATE._activeProjectId || await SK_STATE.project.getActiveId();
        if (!projectId) return { ok: true, skipped: true, workspace: null };
        const workspace = await loadWorkspaceModule();
        const captured = await workspace.captureProjectWorkspace({
          projectId: projectId,
          localStorage: chrome.storage.local,
          syncStorage: chrome.storage.sync,
        });
        // null = 保存領域が誰のものか確定していないため退避を拒否した、という意味。
        // 黙って捨てると受講者の編集が次回起動の復旧で消えるので、呼び出し側へ伝える。
        return { ok: captured !== null, skipped: false, workspace: captured };
      },

      /**
       * ラベル変更
       * @param {string} projectId
       * @param {string} newLabel
       * @returns {Promise<void>}
       */
      rename: function (projectId, newLabel) {
        const now = new Date().toISOString();
        const setObj = {};
        setObj['sk-state.projects.' + projectId + '.meta.label'] = newLabel;
        setObj['sk-state.projects.' + projectId + '.meta.updatedAt'] = now;
        return new Promise(function (resolve) {
          chrome.storage.local.set(setObj, resolve);
        });
      },

      /**
       * プロジェクトを丸ごとエクスポート（バックアップ用 JSON 文字列を返す）
       * @param {string} projectId
       * @returns {Promise<{projectId, exportedAt, data}>}
       */
      export: function (projectId) {
        return new Promise(function (resolve) {
          chrome.storage.local.get(null, function (all) {
            const prefix = 'sk-state.projects.' + projectId + '.';
            const data = {};
            for (const k of Object.keys(all)) {
              if (k.startsWith(prefix)) {
                data[k.slice(prefix.length)] = all[k];
              }
            }
            resolve({
              projectId: projectId,
              exportedAt: new Date().toISOString(),
              data: data,
            });
          });
        });
      },

      /**
       * エクスポートデータからプロジェクトを復元（新規 projectId を採番）。
       * @param {{data: Object, label?: string}} payload
       * @returns {Promise<string>} 新しい projectId
       */
      import: function (payload) {
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'proj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        const now = new Date().toISOString();
        const setObj = {};
        for (const k of Object.keys(payload.data || {})) {
          setObj['sk-state.projects.' + id + '.' + k] = payload.data[k];
        }
        setObj['sk-state.projects.' + id + '.meta.id'] = id;
        setObj['sk-state.projects.' + id + '.meta.label'] =
          payload.label
          || (payload.data && payload.data['meta.label'])
          || '復元プロジェクト';
        setObj['sk-state.projects.' + id + '.meta.createdAt'] = now;
        setObj['sk-state.projects.' + id + '.meta.updatedAt'] = now;
        return new Promise(function (resolve) {
          chrome.storage.local.set(setObj, function () {
            resolve(id);
          });
        });
      },
    },
  };

  window.SK_STATE = SK_STATE;
})();
