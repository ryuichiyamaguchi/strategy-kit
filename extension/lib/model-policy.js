// STRATEGY-KIT — 使えるモデルの方針
//
// 受講者は無料枠の API キーを使う前提。課金APIキーが必要なモデルを既定にすると、
// §7 ユニットエコノミクスで 429（クォータ超過）になり全自動がそこで止まる。
//
// 注意: sidepanel/modules/automation.js は classic script で import できないため、
// 同じ一覧を SK_PAID_ONLY_MODELS として持っている。両者が一致することを
// tests/phase0/model-availability.test.mjs が検査する。

export const PAID_ONLY_MODELS = Object.freeze([
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
]);

export const FREE_TIER_FALLBACK_MODEL = 'gemini-3.8-flash';

// 以前の既定モデル。v0.13.0 で既定を gemini-3.8-flash へ上げた（作者指示 2026-10-02）。
// 旧版が自動保存した既定値（3.6 Flash）は、版数2未満のドラフトに限って1回だけ 3.8 Flash へ読み替える。
// 版数2以降に受講者が自分で 3.6 Flash を選んだ場合はそのまま尊重する。
export const PREVIOUS_DEFAULT_MODELS = Object.freeze([
  'gemini-3.6-flash',
]);

// 保存済みドラフトに刻む版数。これが無いドラフトは v0.12.28 以前に自動保存された
// もので、当時の §7 既定（課金専用の gemini-3.1-pro-preview）が入っている可能性がある。
// 一度読み替えたら版数を刻み、以後は受講者の選択をそのまま尊重する。
// 課金APIキーを貼って Pro を選んだ人が、毎回無料枠モデルへ戻されないようにするため。
// 1: v0.12.29 課金専用モデルの読み替え / 2: v0.13.0 既定を 3.8 Flash へ
export const MODEL_POLICY_VERSION = 2;

/**
 * このドラフトが「旧バージョンの自動保存値」かどうか。
 * @param {object} draft 保存されていたドラフト
 * @returns {boolean} true なら課金専用モデルを読み替える
 */
export function needsLegacyModelRemap(draft) {
  const version = Number(draft && draft.modelPolicyVersion) || 0;
  return version < MODEL_POLICY_VERSION;
}

/**
 * 保存済みのモデル名を、いま選べる値へ読み替える。
 * @param {string} savedModel 保存されていたモデル名
 * @param {string[]} selectableModels 現在の選択肢
 * @param {{remapLegacy?: boolean}} [options] remapLegacy=false なら課金専用でも維持する
 * @returns {string} 実際に使うモデル名
 */
export function restoreSelectableModel(savedModel, selectableModels, { remapLegacy = true, savedPolicyVersion = 0 } = {}) {
  const list = Array.isArray(selectableModels) ? selectableModels : [];
  if (!list.includes(savedModel)) return FREE_TIER_FALLBACK_MODEL;
  if (!remapLegacy) return savedModel;
  // 旧バージョンの自動保存値だけを読み替える。新版で受講者が自分で選んだ値は維持する。
  const version = Number(savedPolicyVersion) || 0;
  // 版数1未満: v0.12.28 以前の §7 既定（課金専用 Pro）
  if (version < 1 && PAID_ONLY_MODELS.includes(savedModel)) return FREE_TIER_FALLBACK_MODEL;
  // 版数2未満: v0.12.40 以前の既定（3.6 Flash）
  if (version < 2 && PREVIOUS_DEFAULT_MODELS.includes(savedModel)) return FREE_TIER_FALLBACK_MODEL;
  return savedModel;
}
