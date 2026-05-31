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

  const SK_STATE = {
    _activeProjectId: null,
    _initialized: false,

    /**
     * 起動時に1回呼ぶ。activeProjectId を同期キャッシュへロード。
     * @returns {Promise<void>}
     */
    init: function () {
      return new Promise(function (resolve) {
        chrome.storage.local.get(['sk-state.ui.activeProjectId'], function (result) {
          SK_STATE._activeProjectId = result['sk-state.ui.activeProjectId'] || null;
          SK_STATE._initialized = true;
          resolve();
        });
      });
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
      create: function (label, options) {
        const opts = options || {};
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'proj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        const now = new Date().toISOString();
        const setObj = {};
        setObj['sk-state.projects.' + id + '.meta.id'] = id;
        setObj['sk-state.projects.' + id + '.meta.label'] = label || '無題プロジェクト';
        setObj['sk-state.projects.' + id + '.meta.createdAt'] = now;
        setObj['sk-state.projects.' + id + '.meta.updatedAt'] = now;
        if (opts.industry) {
          setObj['sk-state.projects.' + id + '.placeholders.industry'] = opts.industry;
        }
        if (opts.businessName) {
          setObj['sk-state.projects.' + id + '.placeholders.businessName'] = opts.businessName;
        }
        setObj['sk-state.ui.activeProjectId'] = id;
        return new Promise(function (resolve) {
          chrome.storage.local.set(setObj, function () {
            SK_STATE._activeProjectId = id;
            resolve(id);
          });
        });
      },

      /**
       * 既存プロジェクトをアクティブ化
       * @param {string} projectId
       * @returns {Promise<void>}
       */
      activate: function (projectId) {
        return new Promise(function (resolve) {
          chrome.storage.local.set({ 'sk-state.ui.activeProjectId': projectId }, function () {
            SK_STATE._activeProjectId = projectId;
            resolve();
          });
        });
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
      delete: function (projectId) {
        return new Promise(function (resolve) {
          chrome.storage.local.get(null, function (all) {
            const keys = Object.keys(all).filter(function (k) {
              return k.startsWith('sk-state.projects.' + projectId + '.');
            });
            const finalize = function (newActive) {
              SK_STATE._activeProjectId = newActive;
              resolve({ newActiveId: newActive });
            };
            const switchActiveIfNeeded = function () {
              if (SK_STATE._activeProjectId !== projectId) {
                finalize(SK_STATE._activeProjectId);
                return;
              }
              SK_STATE.project.list().then(function (others) {
                if (others.length === 0) {
                  chrome.storage.local.remove(['sk-state.ui.activeProjectId'], function () {
                    finalize(null);
                  });
                } else {
                  const next = others[0].id;
                  chrome.storage.local.set({ 'sk-state.ui.activeProjectId': next }, function () {
                    finalize(next);
                  });
                }
              });
            };
            if (keys.length === 0) {
              switchActiveIfNeeded();
              return;
            }
            chrome.storage.local.remove(keys, switchActiveIfNeeded);
          });
        });
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
