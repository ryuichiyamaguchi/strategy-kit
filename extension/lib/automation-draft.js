// STRATEGY-KIT — 自動化ドラフトのマージ規則
//
// 全画面コマンドセンターとサイドパネルは同じ automation.uiDraft を共有する。
// 全画面の入力欄が空のまま実行されると、サイドパネルに入力済みの現状メモが
// 空文字で上書きされ、事業メモ抜きで全10フェーズが生成されてしまう。
// 画面が空のときは保存済みの値を採用する、という規則をここに固定する。

/**
 * 画面の入力値と storage の保存値を突き合わせる。
 * 画面に入力があればそれを優先し、空なら保存済みの値を拾う。両方空なら空のまま。
 *
 * ただし受講者が自分で全部消した欄（formDraft.clearedFields に載る）は、
 * 「意図的な空」として空のまま通す。これが無いと、全画面でメモを消しても
 * 保存済みの古いメモが復活し、消したはずの内容で生成されてしまう。
 *
 * @param {object} formDraft 画面から読んだドラフト
 * @param {object} storedDraft storage に保存されているドラフト
 * @returns {object} 送信に使うドラフト
 */
export function mergeAutomationDraft(formDraft, storedDraft) {
  const form = formDraft && typeof formDraft === 'object' ? formDraft : {};
  const stored = storedDraft && typeof storedDraft === 'object' ? storedDraft : {};
  const cleared = new Set(Array.isArray(form.clearedFields) ? form.clearedFields : []);
  const pick = (field) => (cleared.has(field) ? '' : (form[field] || stored[field] || ''));
  return {
    ...form,
    memo: pick('memo'),
    context: pick('context'),
  };
}
