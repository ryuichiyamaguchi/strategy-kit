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

export const FREE_TIER_FALLBACK_MODEL = 'gemini-3.6-flash';

// 保存済みドラフトに刻む版数。これが無いドラフトは v0.12.28 以前に自動保存された
// もので、当時の §7 既定（課金専用の gemini-3.1-pro-preview）が入っている可能性がある。
// 一度読み替えたら版数を刻み、以後は受講者の選択をそのまま尊重する。
// 課金APIキーを貼って Pro を選んだ人が、毎回無料枠モデルへ戻されないようにするため。
export const MODEL_POLICY_VERSION = 1;

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
export function restoreSelectableModel(savedModel, selectableModels, { remapLegacy = true } = {}) {
  const list = Array.isArray(selectableModels) ? selectableModels : [];
  if (!list.includes(savedModel)) return FREE_TIER_FALLBACK_MODEL;
  // 旧バージョンの自動保存値だけを読み替える。新版で受講者が自分で選んだ値は維持する。
  if (remapLegacy && PAID_ONLY_MODELS.includes(savedModel)) return FREE_TIER_FALLBACK_MODEL;
  return savedModel;
}
