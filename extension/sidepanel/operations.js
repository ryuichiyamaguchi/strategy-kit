// STRATEGY-KIT — 運用ボード (operations.html)
//
// 「作った後」を回す全画面。戦略書（マスタードキュメント）を正本にしたまま、
//   目的別レシピ / 施策トラッカー / 実績データ / 答え合わせ・2周目 / 月次レポート /
//   用途別の書き出し・根拠表 / 会社資料の先読み / 制約と広告表現チェック / チーム共有
// をここで扱う。保存先は chrome.storage.local の案件スコープ（sk-state.projects.<id>.ops）。
// 純ロジックは lib/ops-core.js・lib/ad-compliance.js、AI への指示文は lib/ops-prompts.js、
// Google 連携は phase0/ops-google.js に分けてある（このファイルは画面と配線だけ）。

import * as core from '../lib/ops-core.js';
import * as ad from '../lib/ad-compliance.js';
import * as prompts from '../lib/ops-prompts.js';
import * as google from '../phase0/ops-google.js';
import { DEFAULT_GEMINI_MODEL, generateContent } from '../phase0/gemini-client.js';

const SNAPSHOT_KEY = 'sk-state.ui.missionSnapshot';
const ACTIVE_PROJECT_KEY = 'sk-state.ui.activeProjectId';
const MODEL_OPTIONS = new Set([
  'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'deepseek-v4-flash',
]);

const ctx = {
  projectId: '',
  opsKey: '',
  ops: core.createEmptyOpsState(),
  productConfig: null,
  phases: [],
  supplementary: [],
  master: null,
  business: { industryLabel: '', storeName: '' },
  projectName: '',
  filledNos: new Set(),
  sectionCache: null,
  pendingMetrics: null,
  adFindings: [],
};

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // markdownToHtml の出力（エスケープ済み）だけに使う
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'attrs') for (const [a, b] of Object.entries(v)) node.setAttribute(a, b);
    else node[k] = v;
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer = null;
function toast(message, tone = 'info', ms = 4500) {
  const box = $('ops-toast');
  if (!box) return;
  box.textContent = message;
  box.dataset.tone = tone;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

// ボタンを押している間は二度押しできないようにし、ラベルで進み具合を伝える。
async function withBusy(button, label, task) {
  const original = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    return await task((progressLabel) => {
      if (button && progressLabel) button.textContent = progressLabel;
    });
  } catch (error) {
    console.error('[STRATEGY-KIT ops]', error);
    toast(humanizeError(error), 'error', 9000);
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

export function humanizeError(error) {
  const msg = String(error?.message || error || '');
  if (/API key または Gemini proxy が未設定|DeepSeek API キーが未設定/.test(msg)) {
    return 'AI の設定がまだです。拡張の設定画面（Gemini 設定）で API キーを設定してください。';
  }
  if (/input_token_count|PERMISSION_DENIED|NOT_FOUND|is not found for API version|HTTP 40[34]\b/i.test(msg)) {
    return '選んだ AI モデルは、この API キーでは使えません。上の「使うAI」を Gemini 3.8 Flash に変えてください。';
  }
  if (/429|rate|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'AI の利用回数の上限に達しました。1分ほど待ってから、もう一度押してください。';
  }
  if (/503|unavailable|overloaded/i.test(msg)) {
    return 'AI が混み合っています。少し時間をおいてから、もう一度押してください。';
  }
  if (/F-1|F-2|F-3|OAuth|token/i.test(msg)) {
    return 'Google 連携が切れています。拡張の設定画面で「連携 / 再連携」を押してから、もう一度お試しください。';
  }
  if (/files\.|documents\.|permissions\./.test(msg) && /40[34]/.test(msg)) {
    return 'Google ドキュメント／ドライブへの書き込みが拒否されました。このツールで作った戦略書かどうか、Google 連携が有効かを確認してください。';
  }
  return msg.slice(0, 200) || '処理に失敗しました。';
}

function today() {
  return core.toIsoDate(new Date());
}

function downloadText(fileName, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function linkTo(url, label) {
  return el('a', { class: 'ops-link', href: url, target: '_blank', rel: 'noopener', text: label });
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

async function loadOps() {
  const stored = await chrome.storage.local.get([ctx.opsKey]);
  ctx.ops = core.normalizeOpsState(stored?.[ctx.opsKey]);
}

let saveChain = Promise.resolve();
function saveOps() {
  const snapshot = JSON.parse(JSON.stringify(ctx.ops));
  saveChain = saveChain.catch(() => {}).then(() => chrome.storage.local.set({ [ctx.opsKey]: snapshot }));
  return saveChain;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function selectedModel() {
  const value = $('ops-model-select')?.value;
  return MODEL_OPTIONS.has(value) ? value : DEFAULT_GEMINI_MODEL;
}

async function callAi(promptText, { tools } = {}) {
  const model = selectedModel();
  try {
    const result = await generateContent({ prompt: promptText, model, ...(tools ? { tools } : {}) });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('AI から空の回答が返りました。もう一度お試しください。');
    return text;
  } catch (error) {
    // 検索・URL 読み取りの道具が使えない環境（無料枠・プロキシ）では道具なしで1回だけやり直す。
    if (tools) return callAi(promptText);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 戦略書
// ---------------------------------------------------------------------------

function requireMaster() {
  if (!ctx.master) {
    throw new Error('戦略書（マスタードキュメント）がまだありません。サイドパネルで戦略書を作成してから使ってください。');
  }
  return ctx.master;
}

async function readSections(nos) {
  const master = requireMaster();
  const need = nos.filter((n) => !ctx.sectionCache || !(n in ctx.sectionCache.texts));
  if (need.length) {
    const read = await google.readMasterSections(master.documentId, need);
    ctx.sectionCache = {
      texts: { ...(ctx.sectionCache?.texts || {}), ...read.texts },
      title: read.title,
    };
  }
  const out = {};
  for (const n of nos) out[n] = ctx.sectionCache.texts[n] || '';
  return out;
}

async function outputParents() {
  return ctx.master ? google.resolveOutputParents(ctx.master.documentId) : [];
}

function docTitle(label) {
  const name = ctx.business.storeName || ctx.projectName || '案件';
  return `${name} ${label} ${today()}`;
}

async function saveMarkdownDoc(label, markdown, kind) {
  const doc = await google.createDocFromMarkdown({ title: docTitle(label), markdown, parents: await outputParents() });
  ctx.ops.exports = [{ kind, label, url: doc.url, id: doc.id, at: new Date().toISOString() }, ...ctx.ops.exports].slice(0, 50);
  await saveOps();
  renderHistories();
  return doc;
}

async function appendStateRows(rows) {
  if (!rows.length || !ctx.master) return 0;
  await google.appendStateSheetRows(ctx.master.documentId, rows);
  ctx.sectionCache = null; // §98 が変わったので読み直す
  return rows.length;
}

function constraintsText() {
  return core.constraintsToPromptText(ctx.ops.constraints);
}

// ---------------------------------------------------------------------------
// タブ
// ---------------------------------------------------------------------------

function showTab(name) {
  const tabs = document.querySelectorAll('.ops-tab');
  let found = false;
  for (const tab of tabs) {
    const on = tab.dataset.tab === name;
    if (on) found = true;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (!found) return showTab('recipes');
  for (const panel of document.querySelectorAll('.ops-panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  return undefined;
}

// ---------------------------------------------------------------------------
// 目的から選ぶ（レシピ）
// ---------------------------------------------------------------------------

const TOOL_LABELS = {
  metrics: ['metrics', '実績データを取り込む'],
  round2: ['round2', '答え合わせをする'],
  adcheck: ['guard', '広告表現をチェックする'],
  'export:budget': ['exports', '予算申請書に書き出す'],
};

function renderRecipes() {
  const list = $('ops-recipe-list');
  clear(list);
  const currentId = ctx.ops.recipe?.id || 'full';
  for (const recipe of core.RECIPES) {
    const chips = el('div', { class: 'ops-phase-chips' });
    for (const no of recipe.phases) {
      const phase = ctx.phases.find((p) => Number(p.no) === no);
      chips.appendChild(el('span', {
        class: `ops-phase-chip${ctx.filledNos.has(String(no)) ? ' is-filled' : ''}`,
        text: `§${no}${phase ? ' ' + shortTitle(phase.title) : ''}`,
        title: ctx.filledNos.has(String(no)) ? '戦略書に記入済み' : '未作成',
      }));
    }
    const selected = recipe.id === currentId;
    const card = el('article', { class: `ops-recipe${selected ? ' is-selected' : ''}` },
      el('h2', { text: recipe.title }),
      el('p', { text: recipe.description }),
      chips,
      el('button', {
        class: selected ? 'ops-btn ops-btn-ghost' : 'ops-btn',
        type: 'button',
        text: selected ? '選択中' : 'これにする',
        disabled: selected,
        on: { click: () => selectRecipe(recipe.id) },
      }),
    );
    list.appendChild(card);
  }
  const current = core.findRecipe(currentId);
  const box = $('ops-recipe-current');
  clear(box);
  box.hidden = false;
  box.appendChild(el('h2', { text: `いまの進め方: ${current.title}` }));
  box.appendChild(el('p', {
    text: current.id === 'full'
      ? '全自動・半自動は §0〜§9 をすべて進めます。'
      : `全自動・半自動は ${current.phases.map((n) => '§' + n).join('・')} だけを進めます（ほかの章は、戦略書に書かれていれば前提として使います）。始めるときは司令塔の「開始」を押してください。`,
  }));
  const actions = el('div', { class: 'ops-form-actions' });
  actions.appendChild(el('button', { class: 'ops-btn', type: 'button', text: '司令塔で開始する', on: { click: openMission } }));
  for (const tool of current.tools) {
    const [tab, label] = TOOL_LABELS[tool] || [];
    if (tab) actions.appendChild(el('button', { class: 'ops-btn ops-btn-ghost', type: 'button', text: label, on: { click: () => showTab(tab) } }));
  }
  box.appendChild(actions);
}

function shortTitle(title) {
  return String(title || '').replace(/（.*$/, '').slice(0, 14);
}

async function selectRecipe(id) {
  ctx.ops.recipe = id === 'full' ? null : { id, at: new Date().toISOString() };
  await saveOps();
  renderRecipes();
  toast(id === 'full' ? '§0〜§9 をすべて進める設定に戻しました' : `「${core.findRecipe(id).title}」に切り替えました`);
}

// ---------------------------------------------------------------------------
// 施策トラッカー
// ---------------------------------------------------------------------------

function renderTracker() {
  const now = new Date();
  const actions = ctx.ops.actions;
  const summary = core.summarizeActions(actions, now);
  const chips = $('ops-tracker-summary');
  clear(chips);
  const chip = (label, value, tone) => chips.appendChild(el('span', { class: `ops-chip${tone ? ' is-' + tone : ''}`, text: `${label} ${value}` }));
  chip('今週', summary.thisWeek);
  chip('期限切れ', summary.overdue, summary.overdue ? 'warn' : '');
  chip('実行中', summary.doing);
  chip('未着手', summary.todo);
  chip('完了', summary.done);
  if (summary.noOwner) chip('担当未定', summary.noOwner, 'warn');
  if (summary.noDue) chip('期限未定', summary.noDue, 'warn');

  const badge = $('ops-tab-badge');
  if (badge) {
    const n = summary.thisWeek + summary.overdue;
    badge.hidden = !n;
    badge.textContent = String(n);
  }

  renderActionList($('ops-overdue-list'), core.listOverdueActions(actions, now), '期限切れの施策はありません。');
  renderActionList($('ops-week-list'), core.listThisWeekActions(actions, now), '今週が期限の施策はありません。');
  const all = [...actions].sort((a, b) => {
    const order = { doing: 0, todo: 1, done: 2, dropped: 3 };
    return (order[a.status] - order[b.status]) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });
  renderActionList($('ops-all-list'), all, '施策がまだありません。「§7 から施策を取り込む」か「施策を手で追加」から始めてください。', { full: true });
}

function renderActionList(container, actions, emptyText, { full = false } = {}) {
  clear(container);
  if (!actions.length) {
    container.appendChild(el('p', { class: 'ops-empty', text: emptyText }));
    return;
  }
  for (const action of actions) container.appendChild(buildActionRow(action, { full }));
}

function buildActionRow(action, { full }) {
  const row = el('div', { class: `ops-action is-${action.status}` });
  const head = el('div', { class: 'ops-action-head' },
    el('strong', { text: action.title }),
    el('span', { class: 'ops-action-cat', text: core.ACTION_CATEGORIES[action.category] }),
  );
  if (action.sourceSection) head.appendChild(el('span', { class: 'ops-action-src', text: action.sourceSection }));
  row.appendChild(head);

  const fields = el('div', { class: 'ops-action-fields' });
  const owner = el('input', { value: action.owner, placeholder: '担当', attrs: { 'aria-label': `${action.title} の担当` } });
  owner.addEventListener('change', () => updateAction(action.id, { owner: owner.value.trim() }));
  const due = el('input', { type: 'date', value: action.dueDate, attrs: { 'aria-label': `${action.title} の期限` } });
  due.addEventListener('change', () => updateAction(action.id, { dueDate: due.value }));
  const status = el('select', { attrs: { 'aria-label': `${action.title} の状態` } });
  for (const [value, label] of Object.entries(core.ACTION_STATUSES)) {
    status.appendChild(el('option', { value, text: label, selected: value === action.status }));
  }
  const note = el('input', { value: action.note, placeholder: '実施メモ（何をどれだけやったか）', class: 'ops-action-note', attrs: { 'aria-label': `${action.title} のメモ` } });
  status.addEventListener('change', () => changeActionStatus(action.id, status.value, note.value.trim()));
  note.addEventListener('change', () => updateAction(action.id, { note: note.value.trim() }));
  fields.append(
    el('label', {}, '担当', owner),
    el('label', {}, '期限', due),
    el('label', {}, '状態', status),
    el('label', { class: 'ops-grow' }, 'メモ', note),
  );
  row.appendChild(fields);

  if (full) {
    const meta = el('div', { class: 'ops-action-meta' });
    if (action.kpi) meta.appendChild(el('span', { text: `KPI: ${action.kpi}` }));
    if (action.budget) meta.appendChild(el('span', { text: `予算: ${action.budget}` }));
    if (action.log.length) {
      const last = action.log[action.log.length - 1];
      meta.appendChild(el('span', { text: `最終記録: ${last.date} ${core.ACTION_STATUSES[last.status]}` }));
    }
    meta.appendChild(el('button', {
      class: 'ops-link-btn',
      type: 'button',
      text: '削除',
      on: { click: () => deleteAction(action.id) },
    }));
    row.appendChild(meta);
  }
  return row;
}

async function updateAction(id, patch) {
  ctx.ops.actions = ctx.ops.actions.map((a) => (a.id === id ? core.normalizeAction({ ...a, ...patch, updatedAt: new Date().toISOString() }) : a));
  await saveOps();
  renderTracker();
}

async function changeActionStatus(id, status, note) {
  const current = ctx.ops.actions.find((a) => a.id === id);
  if (!current) return;
  const { action, stateSheetRow } = core.applyActionStatus(current, { status, note }, new Date());
  ctx.ops.actions = ctx.ops.actions.map((a) => (a.id === id ? action : a));
  await saveOps();
  renderTracker();
  if ($('ops-write-state-sheet')?.checked && ctx.master) {
    try {
      await appendStateRows([stateSheetRow]);
      toast(`「${action.title}」を${core.ACTION_STATUSES[status]}にし、戦略書 §98 に記録しました`);
    } catch (error) {
      toast('状態は保存しましたが、戦略書への記録に失敗しました: ' + humanizeError(error), 'error', 8000);
    }
  } else {
    toast(`「${action.title}」を${core.ACTION_STATUSES[status]}にしました`);
  }
}

async function deleteAction(id) {
  const action = ctx.ops.actions.find((a) => a.id === id);
  if (!action || !window.confirm(`「${action.title}」を一覧から削除しますか？（戦略書の記録は消えません）`)) return;
  ctx.ops.actions = ctx.ops.actions.filter((a) => a.id !== id);
  await saveOps();
  renderTracker();
}

async function extractActions(button) {
  await withBusy(button, '§7 を読んでいます…', async (progress) => {
    const sections = await readSections([7, 9]);
    if (!sections[7]) throw new Error('戦略書の §7（施策設計）がまだ空です。先に §7 まで進めてください。');
    progress('AI が施策を取り出しています…');
    const text = await callAi(prompts.buildExtractActionsPrompt({
      section7: sections[7], section9: sections[9], today: today(), constraintsText: constraintsText(),
    }));
    const list = core.extractJson(text);
    if (!Array.isArray(list)) throw new Error('施策の一覧を読み取れませんでした。もう一度お試しください。');
    const merged = core.mergeExtractedActions(ctx.ops.actions, list);
    ctx.ops.actions = merged.actions;
    await saveOps();
    renderTracker();
    toast(`施策を ${merged.added} 件追加、${merged.updated} 件に空欄を補いました。担当と期限を確認してください。`, 'info', 7000);
  });
}

function bindTracker() {
  $('ops-actions-extract').addEventListener('click', (e) => extractActions(e.currentTarget));
  const form = $('ops-action-form');
  $('ops-actions-add').addEventListener('click', () => {
    form.hidden = false;
    form.elements.title.focus();
  });
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    form.reset();
    form.hidden = true;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const merged = core.mergeExtractedActions(ctx.ops.actions, [{ ...data, sourceSection: '手入力' }]);
    if (!merged.added) {
      toast('同じ名前の施策がすでにあります', 'warn');
      return;
    }
    ctx.ops.actions = merged.actions;
    await saveOps();
    form.reset();
    form.hidden = true;
    renderTracker();
    toast('施策を追加しました');
  });
  $('ops-actions-ics').addEventListener('click', () => {
    const open = ctx.ops.actions.filter((a) => core.isOpenAction(a) && a.dueDate);
    if (!open.length) {
      toast('期限の入った未完了の施策がありません', 'warn');
      return;
    }
    const ics = core.buildActionsIcs(ctx.ops.actions, { calendarName: `${ctx.business.storeName || '案件'} 施策の期限` });
    downloadText(`strategy-kit-actions-${today()}.ics`, ics, 'text/calendar');
    toast(`${open.length} 件の期限をカレンダー用ファイルに保存しました。Google カレンダーの「設定 → インポート」で読み込めます。`, 'info', 8000);
  });
}

// ---------------------------------------------------------------------------
// 実績データ
// ---------------------------------------------------------------------------

async function readMetricsInput() {
  const file = $('ops-metrics-file').files?.[0];
  if (file) return { text: await file.text(), fileName: file.name };
  const pasted = $('ops-metrics-paste').value;
  if (pasted.trim()) return { text: pasted, fileName: '' };
  throw new Error('CSV ファイルを選ぶか、表を貼り付けてください。');
}

async function readMetricsTable(button) {
  await withBusy(button, '表を読んでいます…', async (progress) => {
    const { text, fileName } = await readMetricsInput();
    const rows = core.parseCsv(text);
    if (rows.length < 2) throw new Error('表として読み取れる行が足りません（見出し行＋データ行が必要です）。');
    const preview = core.buildTablePreview(rows);
    let kpiText = '';
    if (ctx.master) {
      try {
        kpiText = (await readSections([8]))[8];
      } catch (_) {
        kpiText = '';
      }
    }
    progress('AI が列の意味を読み取っています…');
    const answer = await callAi(prompts.buildMetricsMappingPrompt({ tablePreview: preview.text, fileName, kpiText, today: today() }));
    const spec = core.extractJson(answer);
    const result = core.aggregateTableBySpec(rows, spec);
    ctx.pendingMetrics = { ...result, spec, fileName };
    renderMetricsPreview();
  });
}

function renderMetricsPreview() {
  const box = $('ops-metrics-preview');
  clear(box);
  const pending = ctx.pendingMetrics;
  if (!pending) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.appendChild(el('h3', { text: `読み取り結果（取得元: ${pending.spec.source || '不明'}${pending.fileName ? '／' + pending.fileName : ''}）` }));
  if (Array.isArray(pending.spec.notes) && pending.spec.notes.length) {
    box.appendChild(el('ul', { class: 'ops-notes' }, ...pending.spec.notes.map((n) => el('li', { text: String(n) }))));
  }
  if (pending.warnings.length) {
    box.appendChild(el('ul', { class: 'ops-warnings' }, ...pending.warnings.map((w) => el('li', { text: w }))));
  }
  if (!pending.metrics.length) {
    box.appendChild(el('p', { class: 'ops-empty', text: '取り込める数値が見つかりませんでした。列名や貼り付けた範囲を確認してください。' }));
    return;
  }
  box.appendChild(buildMetricsTable(pending.metrics, { deletable: false }));
  const writeRow = el('label', { class: 'ops-check' }, el('input', { type: 'checkbox', checked: true, id: 'ops-metrics-write' }), ' 戦略書 §98 にも記録する');
  const actions = el('div', { class: 'ops-form-actions' },
    el('button', { class: 'ops-btn', type: 'button', text: `この ${pending.metrics.length} 件を保存する`, on: { click: (e) => commitPendingMetrics(e.currentTarget) } }),
    el('button', { class: 'ops-btn ops-btn-ghost', type: 'button', text: '取り消す', on: { click: () => { ctx.pendingMetrics = null; renderMetricsPreview(); } } }),
    writeRow,
  );
  box.appendChild(actions);
}

async function commitPendingMetrics(button) {
  const pending = ctx.pendingMetrics;
  if (!pending) return;
  await withBusy(button, '保存しています…', async () => {
    const merged = core.mergeMetrics(ctx.ops.metrics, pending.metrics);
    ctx.ops.metrics = merged.metrics;
    await saveOps();
    let written = 0;
    if ($('ops-metrics-write')?.checked && ctx.master) {
      written = await appendStateRows(pending.metrics.map(core.buildMetricRow));
    }
    ctx.pendingMetrics = null;
    $('ops-metrics-file').value = '';
    $('ops-metrics-paste').value = '';
    renderMetricsPreview();
    renderMetrics();
    toast(`実績を ${merged.added} 件追加・${merged.replaced} 件更新しました${written ? '（§98 にも記録）' : ''}`);
  });
}

function buildMetricsTable(metrics, { deletable }) {
  const table = el('table', { class: 'ops-table' });
  table.appendChild(el('thead', {}, el('tr', {}, ...['指標', '値', '単位', '期間', '取得元', '集計', ''].map((h) => el('th', { text: h })))));
  const body = el('tbody');
  for (const m of metrics) {
    const tr = el('tr', {},
      el('td', { text: m.metric }),
      el('td', { class: 'ops-num', text: m.value.toLocaleString('ja-JP') }),
      el('td', { text: m.unit }),
      el('td', { text: core.metricPeriodLabel(m), class: m.periodStart && m.periodEnd ? '' : 'ops-warn-text' }),
      el('td', { text: m.source }),
      el('td', { text: m.note }),
    );
    const last = el('td');
    if (deletable) {
      last.appendChild(el('button', { class: 'ops-link-btn', type: 'button', text: '削除', on: { click: () => deleteMetric(m.id) } }));
    }
    tr.appendChild(last);
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

function renderMetrics() {
  const sorted = [...ctx.ops.metrics].sort((a, b) => a.metric.localeCompare(b.metric, 'ja') || (a.periodStart || '').localeCompare(b.periodStart || ''));
  const box = $('ops-metrics-table');
  clear(box);
  if (!sorted.length) box.appendChild(el('p', { class: 'ops-empty', text: 'まだ実績がありません。' }));
  else box.appendChild(buildMetricsTable(sorted, { deletable: true }));
  const notes = core.buildPeriodNotes(ctx.ops.metrics);
  const notesBox = $('ops-period-notes');
  clear(notesBox);
  if (notes.length) {
    notesBox.appendChild(el('div', { class: 'ops-card ops-card-warn' },
      el('h3', { text: '期間の注意（答え合わせ・月次レポートで直接比べない組み合わせ）' }),
      el('ul', {}, ...notes.map((n) => el('li', { text: n }))),
    ));
  }
}

async function deleteMetric(id) {
  ctx.ops.metrics = ctx.ops.metrics.filter((m) => m.id !== id);
  await saveOps();
  renderMetrics();
}

function bindMetrics() {
  $('ops-metrics-read').addEventListener('click', (e) => readMetricsTable(e.currentTarget));
  const form = $('ops-metric-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.periodStart > data.periodEnd) {
      toast('期間の始まりが終わりより後になっています', 'warn');
      return;
    }
    const merged = core.mergeMetrics(ctx.ops.metrics, [{ ...data, importedAt: new Date().toISOString() }]);
    if (!merged.added && !merged.replaced) {
      toast('値を数字で入れてください', 'warn');
      return;
    }
    ctx.ops.metrics = merged.metrics;
    await saveOps();
    if (ctx.master && $('ops-write-state-sheet')?.checked) {
      const m = core.normalizeMetric(data);
      if (m) await appendStateRows([core.buildMetricRow(m)]).catch(() => 0);
    }
    form.reset();
    renderMetrics();
    toast('実績を追加しました');
  });
}

// ---------------------------------------------------------------------------
// 答え合わせ・2周目
// ---------------------------------------------------------------------------

function supplementaryBody(id) {
  return ctx.supplementary.find((s) => s.id === id)?.body || '';
}

function renderMarkdownInto(box, markdown, links = []) {
  clear(box);
  box.hidden = false;
  if (links.length) box.appendChild(el('div', { class: 'ops-form-actions' }, ...links));
  box.appendChild(el('div', { class: 'ops-md', html: core.markdownToHtml(markdown) }));
}

async function runReconcile(button) {
  await withBusy(button, '戦略書を読んでいます…', async (progress) => {
    const sections = await readSections([7, 8, 9]);
    if (!sections[8] && !sections[7]) throw new Error('戦略書の §7・§8 がまだ空です。答え合わせには目標値（§8）と施策（§7）が必要です。');
    if (!ctx.ops.metrics.length && !ctx.ops.actions.length) {
      if (!window.confirm('実績データも施策の記録もまだありません。このまま答え合わせをすると、ほぼすべて「判定不能」になります。続けますか？')) return;
    }
    progress('AI が答え合わせをしています…');
    const markdown = await callAi(prompts.buildReconcilePrompt({
      reconcileBody: supplementaryBody('round2-reconcile'),
      sections,
      metricsTable: core.metricsTableMarkdown(ctx.ops.metrics),
      periodNotes: core.buildPeriodNotes(ctx.ops.metrics),
      actionsTable: core.actionsTableMarkdown(ctx.ops.actions),
      today: today(),
    }));
    progress('ドキュメントに保存しています…');
    const doc = await saveMarkdownDoc('答え合わせ', markdown, 'reconcile');
    ctx.ops.round2 = { ...(ctx.ops.round2 || {}), reconcile: { markdown, url: doc.url, at: new Date().toISOString() } };
    await saveOps();
    renderRound2();
    toast('答え合わせを保存しました');
  });
}

async function runRound2(button) {
  const reconcile = ctx.ops.round2?.reconcile?.markdown;
  if (!reconcile) {
    toast('先に「1. 答え合わせ」を実行してください', 'warn');
    return;
  }
  const recipe = core.findRecipe(ctx.ops.recipe?.id || 'full');
  const filter = $('ops-round2-recipe-only').checked ? core.recipePhaseFilter(recipe) : null;
  const targets = ctx.phases.filter((p) => !filter || filter.includes(Number(p.no)));
  if (!window.confirm(`元の戦略書を複製し、複製側の ${targets.length} 章を書き直します（AI を ${targets.length} 回呼びます）。元の戦略書は変わりません。始めますか？`)) return;
  const progressBox = $('ops-round2-progress');
  clear(progressBox);
  progressBox.hidden = false;
  const line = (text, tone = '') => progressBox.appendChild(el('div', { class: `ops-progress-line${tone ? ' is-' + tone : ''}`, text }));
  await withBusy(button, '2周目の戦略書を作っています…', async (progress) => {
    const master = requireMaster();
    const originals = await readSections(targets.map((p) => Number(p.no)));
    const name = `${ctx.sectionCache?.title || '戦略書'}（2周目 ${today()}）`;
    const copy = await google.copyMasterForRound2(master.documentId, { name });
    line(`複製を作りました: ${name}`);
    const failed = [];
    for (let i = 0; i < targets.length; i += 1) {
      const phase = targets[i];
      progress(`§${phase.no} を書き直しています…（${i + 1}/${targets.length}）`);
      try {
        const body = await callAi(prompts.buildReviseSectionPrompt({
          reviseBody: supplementaryBody('round2-revise'),
          phase,
          industry: ctx.business.industryLabel,
          storeName: ctx.business.storeName,
          firstRoundText: originals[Number(phase.no)],
          reconcileResult: reconcile,
          metricsTable: core.metricsTableMarkdown(ctx.ops.metrics),
          constraintsText: constraintsText(),
        }));
        await google.writeSectionToDocument(copy.id, { sectionNo: phase.no, title: phase.title, body, aiUsed: selectedModel() + ' round2' });
        line(`§${phase.no} ${shortTitle(phase.title)} を書き直しました`, 'done');
      } catch (error) {
        failed.push(phase.no);
        line(`§${phase.no} は書き直せませんでした: ${humanizeError(error)}`, 'error');
      }
    }
    ctx.ops.round2 = { ...(ctx.ops.round2 || {}), copy: { id: copy.id, url: copy.url, at: new Date().toISOString(), failed } };
    await saveOps();
    progressBox.appendChild(el('div', { class: 'ops-form-actions' }, linkTo(copy.url, '2周目の戦略書を開く')));
    toast(failed.length ? `2周目の戦略書を作りました（§${failed.join('・§')} は失敗。もう一度押すと新しい複製で作り直します）` : '2周目の戦略書を作りました', failed.length ? 'warn' : 'info', 9000);
  });
}

async function runPlan(button) {
  const reconcile = ctx.ops.round2?.reconcile?.markdown;
  if (!reconcile) {
    toast('先に「1. 答え合わせ」を実行してください', 'warn');
    return;
  }
  await withBusy(button, '90日プランを作っています…', async (progress) => {
    const sections = await readSections([8]);
    const markdown = await callAi(prompts.buildNinetyDayPlanPrompt({
      reconcileResult: reconcile,
      section8: sections[8],
      actionsTable: core.actionsTableMarkdown(ctx.ops.actions),
      constraintsText: constraintsText(),
      today: today(),
    }));
    progress('ドキュメントに保存しています…');
    const doc = await saveMarkdownDoc('次の90日プラン', markdown, 'plan');
    ctx.ops.round2 = { ...(ctx.ops.round2 || {}), plan: { markdown, url: doc.url, at: new Date().toISOString() } };
    await saveOps();
    renderRound2();
    toast('次の90日プランを作りました。「プランの施策をトラッカーに取り込む」で実行管理に移せます。', 'info', 7000);
  });
}

async function importPlanActions(button) {
  const plan = ctx.ops.round2?.plan?.markdown;
  if (!plan) return;
  await withBusy(button, '施策を取り出しています…', async () => {
    const text = await callAi(prompts.buildExtractActionsPrompt({ section7: plan, section9: '', today: today(), constraintsText: constraintsText() }));
    const list = core.extractJson(text);
    const merged = core.mergeExtractedActions(ctx.ops.actions, (Array.isArray(list) ? list : []).map((a) => ({ ...a, sourceSection: '90日プラン' })));
    ctx.ops.actions = merged.actions;
    await saveOps();
    renderTracker();
    toast(`90日プランの施策を ${merged.added} 件トラッカーに追加しました`);
  });
}

function renderRound2() {
  const r = ctx.ops.round2 || {};
  if (r.reconcile) {
    renderMarkdownInto($('ops-reconcile-result'), r.reconcile.markdown, [linkTo(r.reconcile.url, '答え合わせのドキュメントを開く')]);
  }
  if (r.plan) {
    const importBtn = el('button', { class: 'ops-btn ops-btn-ghost', type: 'button', text: 'プランの施策をトラッカーに取り込む（AI）' });
    importBtn.addEventListener('click', () => importPlanActions(importBtn));
    renderMarkdownInto($('ops-plan-result'), r.plan.markdown, [linkTo(r.plan.url, '90日プランのドキュメントを開く'), importBtn]);
  }
  if (r.copy && $('ops-round2-progress').hidden) {
    const box = $('ops-round2-progress');
    clear(box);
    box.hidden = false;
    box.appendChild(el('div', { class: 'ops-form-actions' }, linkTo(r.copy.url, `前回作った2周目の戦略書を開く（${core.toIsoDate(new Date(r.copy.at))}）`)));
  }
}

// ---------------------------------------------------------------------------
// 月次レポート
// ---------------------------------------------------------------------------

function defaultReportMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function updateReportCheck() {
  const month = $('ops-report-month').value;
  const range = core.monthRange(month);
  const box = $('ops-report-check');
  if (!range) {
    box.textContent = '';
    return;
  }
  const these = core.metricsInRange(ctx.ops.metrics, range);
  const prevRange = core.monthRange(core.previousYearMonth(month));
  const prev = prevRange ? core.metricsInRange(ctx.ops.metrics, prevRange) : [];
  box.textContent = these.length
    ? `この月の実績 ${these.length} 件・前月 ${prev.length} 件を使います。`
    : 'この月の実績がまだありません。「実績データ」で取り込むと、目標との比較が入ります（無いまま作ると「未取得」になります）。';
}

async function runReport(button) {
  const month = $('ops-report-month').value;
  const range = core.monthRange(month);
  if (!range) {
    toast('対象の月を選んでください', 'warn');
    return;
  }
  await withBusy(button, '月次レポートを作っています…', async (progress) => {
    const sections = await readSections([8]);
    const these = core.metricsInRange(ctx.ops.metrics, range);
    const prevMonth = core.previousYearMonth(month);
    const prev = core.metricsInRange(ctx.ops.metrics, core.monthRange(prevMonth));
    const monthActions = ctx.ops.actions.filter((a) => a.log.some((e) => e.date >= range.start && e.date <= range.end) || core.isOpenAction(a));
    const markdown = await callAi(prompts.buildMonthlyReportPrompt({
      yearMonth: month,
      storeName: ctx.business.storeName || ctx.projectName,
      section8: sections[8],
      metricsThisMonth: core.metricsTableMarkdown(these),
      metricsPrevMonth: core.metricsTableMarkdown(prev),
      periodNotes: core.buildPeriodNotes([...these, ...prev]),
      actionsTable: core.actionsTableMarkdown(monthActions),
      audience: $('ops-report-audience').value,
    }));
    progress('ドキュメントに保存しています…');
    const doc = await google.createDocFromMarkdown({ title: docTitle(`月次報告 ${month}`), markdown, parents: await outputParents() });
    ctx.ops.reports = [{ month, url: doc.url, id: doc.id, at: new Date().toISOString() }, ...ctx.ops.reports].slice(0, 36);
    await saveOps();
    renderHistories();
    toast(`${month} の月次レポートを作りました`);
    window.open(doc.url, '_blank', 'noopener');
  });
}

// ---------------------------------------------------------------------------
// 書類の書き出し・根拠表
// ---------------------------------------------------------------------------

function renderExportGrid() {
  const grid = $('ops-export-grid');
  clear(grid);
  for (const [kind, spec] of Object.entries(prompts.EXPORT_KINDS)) {
    const btn = el('button', { class: 'ops-btn', type: 'button', text: '作る（AI）' });
    btn.addEventListener('click', () => runExport(kind, btn));
    grid.appendChild(el('article', { class: 'ops-card ops-export' },
      el('h2', { text: spec.title }),
      el('p', { class: 'ops-hint', text: `使う章: ${spec.sections.map((n) => '§' + n).join('・')}` }),
      btn,
    ));
  }
}

async function runExport(kind, button) {
  const spec = prompts.EXPORT_KINDS[kind];
  await withBusy(button, '作っています…', async (progress) => {
    const sections = await readSections(spec.sections);
    const filled = spec.sections.filter((n) => sections[n]);
    if (!filled.length) throw new Error(`戦略書の ${spec.sections.map((n) => '§' + n).join('・')} がまだ空です。`);
    const markdown = await callAi(prompts.buildExportPrompt(kind, {
      sections,
      storeName: ctx.business.storeName || ctx.projectName,
      industry: ctx.business.industryLabel,
      actionsTable: core.actionsTableMarkdown(ctx.ops.actions),
      constraintsText: constraintsText(),
    }));
    progress('ドキュメントに保存しています…');
    const doc = await saveMarkdownDoc(spec.title, markdown, kind);
    toast(`「${spec.title}」を作りました`);
    window.open(doc.url, '_blank', 'noopener');
  });
}

async function runEvidence(button) {
  await withBusy(button, '戦略書を読んでいます…', async () => {
    const nos = [...ctx.phases.map((p) => Number(p.no)), 98];
    const sections = await readSections(nos);
    const rows = ad.scanEvidence(nos.map((n) => ({ label: `§${n}`, text: sections[n] })));
    if (!rows.length) throw new Error('数字を含む記述が見つかりませんでした。');
    const summary = ad.summarizeEvidence(rows);
    $('ops-evidence-summary').textContent = `数字を含む記述 ${summary.total} 件／裏付け待ち・確かさ未記入 ${summary.weak} 件／出典の記載なし ${summary.noSource} 件`;
    const doc = await saveMarkdownDoc('数字の出どころ一覧', ad.evidenceToMarkdown(rows), 'evidence');
    window.open(doc.url, '_blank', 'noopener');
    toast('数字の出どころ一覧を作りました');
  });
}

function renderHistories() {
  const exportBox = $('ops-export-history');
  clear(exportBox);
  if (!ctx.ops.exports.length) exportBox.appendChild(el('p', { class: 'ops-empty', text: 'まだありません。' }));
  for (const item of ctx.ops.exports) {
    exportBox.appendChild(el('div', { class: 'ops-history-row' },
      el('span', { text: core.toIsoDate(new Date(item.at)) }),
      linkTo(item.url, item.label),
    ));
  }
  const reportBox = $('ops-report-history');
  clear(reportBox);
  if (!ctx.ops.reports.length) reportBox.appendChild(el('p', { class: 'ops-empty', text: 'まだありません。' }));
  for (const item of ctx.ops.reports) {
    reportBox.appendChild(el('div', { class: 'ops-history-row' },
      el('span', { text: item.month }),
      linkTo(item.url, `${item.month} の月次報告`),
    ));
  }
}

// ---------------------------------------------------------------------------
// 会社資料の先読み
// ---------------------------------------------------------------------------

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

async function collectPrefillMaterials() {
  const parts = [];
  const pasted = $('ops-prefill-text').value.trim();
  if (pasted) parts.push(`【貼り付けた資料】\n${pasted}`);
  const files = [...($('ops-prefill-files').files || [])];
  for (const file of files) {
    if (file.size > 2 * 1024 * 1024) {
      toast(`「${file.name}」は大きすぎるため読み飛ばしました（2MB まで）`, 'warn');
      continue;
    }
    const raw = await file.text();
    const text = /\.html?$/i.test(file.name) ? htmlToText(raw) : raw;
    parts.push(`【ファイル: ${file.name}】\n${text.slice(0, 20000)}`);
  }
  const urls = $('ops-prefill-urls').value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 5);
  return { materials: parts.join('\n\n'), urls };
}

async function runPrefill(button) {
  await withBusy(button, '資料を読んでいます…', async (progress) => {
    const { materials, urls } = await collectPrefillMaterials();
    if (!materials && !urls.length) throw new Error('資料の本文を貼るか、ファイル・URL を入れてください。');
    progress('AI が事前記入シートを作っています…');
    const markdown = await callAi(
      prompts.buildHearingPrefillPrompt({
        industry: ctx.business.industryLabel,
        storeName: ctx.business.storeName,
        materials: materials || '（本文なし。URL のみ）',
        urls,
        b2b: $('ops-prefill-b2b').checked,
      }),
      urls.length ? { tools: [{ url_context: {} }] } : {},
    );
    progress('全自動へ渡す要点をまとめています…');
    const contextText = await callAi(prompts.buildPrefillContextPrompt(markdown));
    progress('ドキュメントに保存しています…');
    const doc = await saveMarkdownDoc('ヒアリング事前記入シート', markdown, 'prefill');
    ctx.ops.prefill = { markdown, contextText, url: doc.url, useInAutomation: true, at: new Date().toISOString() };
    await saveOps();
    renderPrefill();
    toast('事前記入シートを作りました。資料から分かった要点は、全自動・半自動の前提として使われます。', 'info', 8000);
  });
}

function renderPrefill() {
  const box = $('ops-prefill-result');
  const p = ctx.ops.prefill;
  if (!p) {
    box.hidden = true;
    return;
  }
  clear(box);
  box.hidden = false;
  const toggle = el('input', { type: 'checkbox', checked: Boolean(p.useInAutomation) });
  toggle.addEventListener('change', async () => {
    ctx.ops.prefill.useInAutomation = toggle.checked;
    await saveOps();
    toast(toggle.checked ? '全自動・半自動の前提として使います' : '全自動・半自動には渡しません');
  });
  box.append(
    el('div', { class: 'ops-form-actions' },
      linkTo(p.url, '事前記入シートを開く'),
      el('label', { class: 'ops-check' }, toggle, ' 資料から分かった要点を全自動・半自動の前提として使う'),
    ),
    el('details', { class: 'ops-details', open: true },
      el('summary', { text: '全自動・半自動へ渡す要点' }),
      el('pre', { text: p.contextText }),
    ),
    el('div', { class: 'ops-md', html: core.markdownToHtml(p.markdown) }),
  );
}

async function bindPrefillFilesNote() {
  $('ops-prefill-files').addEventListener('change', () => {
    const files = [...($('ops-prefill-files').files || [])];
    $('ops-prefill-files-note').textContent = files.length ? `${files.length} 件のファイル: ${files.map((f) => f.name).join('、')}` : '';
  });
}

// ---------------------------------------------------------------------------
// 制約と広告表現チェック
// ---------------------------------------------------------------------------

function effectiveRegulatedCategory() {
  const chosen = ctx.ops.constraints.regulated;
  if (chosen && chosen !== 'none') return chosen;
  return ad.inferRegulatedCategory(ctx.business.industryLabel);
}

function renderConstraints() {
  const form = $('ops-constraints-form');
  const select = $('ops-regulated-select');
  if (!select.options.length) {
    for (const [value, label] of Object.entries(core.REGULATED_CATEGORIES)) select.appendChild(el('option', { value, text: label }));
  }
  for (const [k, v] of Object.entries(ctx.ops.constraints)) {
    if (form.elements[k]) form.elements[k].value = v ?? '';
  }
  const inferred = ad.inferRegulatedCategory(ctx.business.industryLabel);
  $('ops-constraints-status').textContent = inferred !== 'none' && ctx.ops.constraints.regulated === 'none'
    ? `業種から「${core.REGULATED_CATEGORIES[inferred]}」の可能性があります。該当すれば選んで保存してください。`
    : '';
  $('ops-constraints-preview').textContent = constraintsText() || '（まだ制約は入っていません）';
}

function bindConstraints() {
  $('ops-constraints-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    ctx.ops.constraints = { ...core.createEmptyConstraints(), ...data };
    await saveOps();
    renderConstraints();
    toast('制約を保存しました。次に全自動・半自動・コピーするプロンプトから反映されます。');
  });
  $('ops-adcheck-disclaimer').textContent = ad.AD_CHECK_DISCLAIMER;
  $('ops-adcheck-run').addEventListener('click', (e) => runAdCheck(e.currentTarget));
  $('ops-adcheck-rewrite').addEventListener('click', (e) => runAdRewrite(e.currentTarget));
  $('ops-adcheck-save').addEventListener('click', (e) => withBusy(e.currentTarget, '保存しています…', async () => {
    const doc = await saveMarkdownDoc('広告表現チェック', ad.adFindingsToMarkdown(ctx.adFindings), 'adcheck');
    window.open(doc.url, '_blank', 'noopener');
  }));
}

async function runAdCheck(button) {
  await withBusy(button, 'チェックしています…', async () => {
    const targets = [];
    if (ctx.master) {
      const sections = await readSections([5, 6, 7]);
      for (const n of [5, 6, 7]) if (sections[n]) targets.push({ label: `§${n}`, text: sections[n] });
    }
    const pasted = $('ops-adcheck-text').value.trim();
    if (pasted) targets.push({ label: '貼付文', text: pasted });
    if (!targets.length) throw new Error('チェックする文面がありません。戦略書の §5〜§7 を作るか、広告文を貼り付けてください。');
    const category = effectiveRegulatedCategory();
    ctx.adFindings = ad.scanAdExpressions(targets, { category });
    ctx.ops.adCheck = { at: new Date().toISOString(), count: ctx.adFindings.length, category };
    await saveOps();
    renderAdFindings();
  });
}

function renderAdFindings() {
  const box = $('ops-adcheck-result');
  clear(box);
  const findings = ctx.adFindings;
  $('ops-adcheck-save').disabled = false;
  $('ops-adcheck-rewrite').disabled = !findings.length;
  const category = effectiveRegulatedCategory();
  box.appendChild(el('p', { class: 'ops-hint', text: `照合した規制カテゴリ: ${core.REGULATED_CATEGORIES[category] || '特になし'}（全業種共通の景品表示法・ステマ規制も含む）` }));
  if (!findings.length) {
    box.appendChild(el('p', { text: 'よく問題になる言い回しは見つかりませんでした（問題が無いことの保証ではありません）。' }));
    return;
  }
  const table = el('table', { class: 'ops-table' });
  table.appendChild(el('thead', {}, el('tr', {}, ...['章', '表現', '前後の文', '関係する決まり', '理由と直し方'].map((h) => el('th', { text: h })))));
  const body = el('tbody');
  for (const f of findings) {
    body.appendChild(el('tr', { class: f.severity === 'high' ? 'is-high' : '' },
      el('td', { text: f.section }),
      el('td', {}, el('strong', { text: f.phrase })),
      el('td', { text: f.context }),
      el('td', { text: f.law }),
      el('td', { text: `${f.why} → ${f.fix}` }),
    ));
  }
  table.appendChild(body);
  box.appendChild(table);
}

async function runAdRewrite(button) {
  if (!ctx.adFindings.length) return;
  await withBusy(button, '言い換え案を作っています…', async () => {
    const category = effectiveRegulatedCategory();
    const markdown = await callAi(prompts.buildAdRewritePrompt({
      findingsMarkdown: ad.adFindingsToMarkdown(ctx.adFindings),
      industry: ctx.business.industryLabel,
      regulatedLabel: category !== 'none' ? core.REGULATED_CATEGORIES[category] : '',
    }));
    const box = $('ops-adcheck-result');
    box.appendChild(el('h3', { text: '言い換え案（AI）' }));
    box.appendChild(el('div', { class: 'ops-md', html: core.markdownToHtml(markdown) }));
    box.appendChild(el('p', { class: 'ops-disclaimer', text: ad.AD_CHECK_DISCLAIMER }));
  });
}

// ---------------------------------------------------------------------------
// チーム共有
// ---------------------------------------------------------------------------

function renderTeam() {
  const sheet = ctx.ops.share.trackerSheet;
  const link = $('ops-sheet-link');
  link.hidden = !sheet;
  if (sheet) link.href = sheet.url;
  $('ops-sheet-create').textContent = sheet ? 'スプレッドシートを最新の一覧で上書きする' : 'トラッカーをスプレッドシートに書き出す';
  $('ops-sheet-pull').disabled = !sheet;
  $('ops-sheet-status').textContent = sheet
    ? `最終同期: ${sheet.syncedAt ? new Date(sheet.syncedAt).toLocaleString('ja-JP') : '—'}。メンバーにはシートの「担当」「着手日」「期限」「状態」「メモ」列を更新してもらい、「シートの更新を取り込む」で反映します。`
    : 'まだ作っていません。';
}

async function pushSheet(button) {
  if (!ctx.ops.actions.length) {
    toast('施策がまだありません。先に「今週やること」で施策を登録してください。', 'warn');
    return;
  }
  const sheet = ctx.ops.share.trackerSheet;
  if (sheet && !window.confirm('シートの内容をこの画面の一覧で上書きします。メンバーがシートで更新した内容は、先に「シートの更新を取り込む」で反映してください。上書きしますか？')) return;
  await withBusy(button, 'スプレッドシートに書き出しています…', async () => {
    const csv = core.buildTrackerCsv(ctx.ops.actions);
    if (sheet) {
      await google.replaceSheetWithCsv(sheet.id, csv);
      ctx.ops.share.trackerSheet = { ...sheet, syncedAt: new Date().toISOString() };
    } else {
      const created = await google.createSheetFromCsv({ title: docTitle('施策トラッカー'), csv, parents: await outputParents() });
      ctx.ops.share.trackerSheet = { id: created.id, url: created.url, syncedAt: new Date().toISOString() };
    }
    await saveOps();
    renderTeam();
    toast('スプレッドシートを更新しました');
  });
}

async function pullSheet(button) {
  const sheet = ctx.ops.share.trackerSheet;
  if (!sheet) return;
  await withBusy(button, 'シートを読んでいます…', async () => {
    const csv = await google.exportSheetCsv(sheet.id);
    const result = core.applyTrackerSheetCsv(ctx.ops.actions, csv, new Date());
    ctx.ops.actions = result.actions;
    ctx.ops.share.trackerSheet = { ...sheet, syncedAt: new Date().toISOString() };
    await saveOps();
    const rows = result.changed.map((c) => c.stateSheetRow).filter(Boolean);
    let written = 0;
    if (rows.length && $('ops-write-state-sheet')?.checked && ctx.master) written = await appendStateRows(rows).catch(() => 0);
    renderTracker();
    renderTeam();
    const extra = result.unknownIds.length ? `（シートにだけある ${result.unknownIds.length} 行は取り込んでいません。施策の追加はこの画面で行ってください）` : '';
    toast(result.changed.length ? `${result.changed.length} 件の変更を取り込みました${written ? `（§98 に ${written} 件記録）` : ''}${extra}` : `変更はありませんでした${extra}`, 'info', 8000);
  });
}

function parseEmails(text) {
  return [...new Set(String(text || '').split(/[\s,，、;]+/).map((s) => s.trim()).filter(Boolean))];
}

async function submitShare(form, button) {
  const data = Object.fromEntries(new FormData(form).entries());
  const emails = parseEmails(data.emails);
  const invalid = emails.filter((e) => !google.isValidEmail(e));
  if (!emails.length || invalid.length) {
    toast(invalid.length ? `メールアドレスの形式を確認してください: ${invalid.join(', ')}` : 'メールアドレスを入れてください', 'warn');
    return;
  }
  const files = [];
  if ((data.target === 'both' || data.target === 'master') && ctx.master) files.push({ id: ctx.master.documentId, label: '戦略書' });
  if ((data.target === 'both' || data.target === 'sheet') && ctx.ops.share.trackerSheet) files.push({ id: ctx.ops.share.trackerSheet.id, label: 'チーム用トラッカー' });
  if (!files.length) {
    toast('共有できるファイルがありません（戦略書の作成、またはトラッカーの書き出しを先に）', 'warn');
    return;
  }
  await withBusy(button, '招待しています…', async () => {
    const results = [];
    for (const email of emails) {
      for (const file of files) {
        try {
          await google.shareFileWithEmail(file.id, { email, role: data.role, message: data.message });
          results.push(`${email} → ${file.label}: 招待しました`);
          ctx.ops.share.sharedWith = [
            { email, role: data.role, file: file.label, at: new Date().toISOString() },
            ...ctx.ops.share.sharedWith.filter((s) => !(s.email === email && s.file === file.label)),
          ];
        } catch (error) {
          results.push(`${email} → ${file.label}: 失敗（${humanizeError(error)}）`);
        }
      }
    }
    await saveOps();
    $('ops-share-status').textContent = results.join(' ／ ');
    form.elements.emails.value = '';
    await refreshShareList();
  });
}

async function refreshShareList() {
  const box = $('ops-share-list');
  clear(box);
  const targets = [];
  if (ctx.master) targets.push({ id: ctx.master.documentId, label: '戦略書' });
  if (ctx.ops.share.trackerSheet) targets.push({ id: ctx.ops.share.trackerSheet.id, label: 'チーム用トラッカー' });
  if (!targets.length) {
    box.appendChild(el('p', { class: 'ops-empty', text: '共有できるファイルがまだありません。' }));
    return;
  }
  for (const t of targets) {
    try {
      const perms = await google.listFilePermissions(t.id);
      const people = perms.filter((p) => p.type === 'user');
      box.appendChild(el('h3', { text: t.label }));
      box.appendChild(el('ul', {}, ...people.map((p) => el('li', { text: `${p.displayName || ''} ${p.emailAddress || ''}（${google.SHARE_ROLES[p.role] || (p.role === 'owner' ? 'オーナー' : p.role)}）` }))));
    } catch (error) {
      box.appendChild(el('p', { class: 'ops-warn-text', text: `${t.label}: 一覧を取得できませんでした（${humanizeError(error)}）` }));
    }
  }
}

function bindTeam() {
  $('ops-sheet-create').addEventListener('click', (e) => pushSheet(e.currentTarget));
  $('ops-sheet-pull').addEventListener('click', (e) => pullSheet(e.currentTarget));
  $('ops-share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitShare(e.currentTarget, e.currentTarget.querySelector('button[type="submit"]'));
  });
  $('ops-share-refresh').addEventListener('click', (e) => withBusy(e.currentTarget, '読み込み中…', refreshShareList));
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function openMission() {
  const url = chrome.runtime.getURL('sidepanel/mission.html');
  const existing = await chrome.tabs.query({ url });
  if (existing?.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

async function loadJson(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  if (!res.ok) throw new Error(`${path} を読み込めませんでした`);
  return res.json();
}

async function loadContext() {
  let product = null;
  try {
    product = await loadJson('product.json');
  } catch (_) {
    product = null;
  }
  // product.json が読めないときは Webマーケ版の既定（運用ボード有効）。
  ctx.productConfig = product || { promptsPath: 'data/prompts.json', features: { operations: true }, branding: { footerLabel: 'STRATEGY-KIT' } };
  const brand = ctx.productConfig.branding?.footerLabel || 'STRATEGY-KIT';
  $('ops-brand-name').textContent = `${brand} 運用ボード`;
  document.title = `${brand} 運用ボード`;
  const promptsData = await loadJson(ctx.productConfig.promptsPath || 'data/prompts.json');
  ctx.phases = Array.isArray(promptsData.phases) ? promptsData.phases : [];
  ctx.supplementary = Array.isArray(promptsData.supplementary) ? promptsData.supplementary : [];

  const local = await chrome.storage.local.get([ACTIVE_PROJECT_KEY, SNAPSHOT_KEY]);
  ctx.projectId = local[ACTIVE_PROJECT_KEY] || '';
  ctx.opsKey = core.opsStorageKey(ctx.projectId);
  const snapshot = local[SNAPSHOT_KEY] || {};
  ctx.filledNos = new Set((snapshot.filledNos || []).map(String));
  const sync = await chrome.storage.sync.get(['industryLabel', 'storeName']);
  ctx.business = {
    industryLabel: String(sync.industryLabel || snapshot.business?.industryLabel || '').trim(),
    storeName: String(sync.storeName || snapshot.business?.storeName || '').trim(),
  };
  let label = '';
  if (ctx.projectId) {
    const metaKey = `sk-state.projects.${ctx.projectId}.meta.label`;
    label = (await chrome.storage.local.get([metaKey]))[metaKey] || '';
  }
  ctx.projectName = label || snapshot.projectName || ctx.business.storeName || '（案件未設定）';
  ctx.master = await google.getActiveMasterDoc();
  // 案件ができる前に運用ボードで入れた内容（案件スコープ外）は、案件ができたらその案件へ引き継ぐ。
  if (ctx.projectId) {
    const unscopedKey = core.opsStorageKey('');
    const both = await chrome.storage.local.get([ctx.opsKey, unscopedKey]);
    if (!both[ctx.opsKey] && both[unscopedKey]) {
      await chrome.storage.local.set({ [ctx.opsKey]: both[unscopedKey] });
      await chrome.storage.local.remove([unscopedKey]);
    }
  }
  await loadOps();

  // 使う AI: 運用ボードで選んだもの → 全自動で選んでいるもの → 既定（3.8 Flash）
  let model = ctx.ops.model;
  if (!MODEL_OPTIONS.has(model) && ctx.projectId) {
    const draftKey = `sk-state.projects.${ctx.projectId}.automation.uiDraft`;
    const draft = (await chrome.storage.local.get([draftKey]))[draftKey];
    if (draft && Number(draft.modelPolicyVersion) >= 2) model = draft.model;
  }
  $('ops-model-select').value = MODEL_OPTIONS.has(model) ? model : DEFAULT_GEMINI_MODEL;
}

function renderHeader() {
  $('ops-project-name').textContent = ctx.projectName;
  const link = $('ops-master-link');
  if (ctx.master) {
    link.hidden = false;
    link.href = ctx.master.docUrl;
  } else {
    link.hidden = true;
  }
  $('ops-no-master').hidden = Boolean(ctx.master);
}

function renderAll() {
  renderHeader();
  renderRecipes();
  renderTracker();
  renderMetrics();
  renderMetricsPreview();
  renderRound2();
  renderExportGrid();
  renderHistories();
  renderPrefill();
  renderConstraints();
  renderTeam();
  if (!$('ops-report-month').value) $('ops-report-month').value = defaultReportMonth();
  updateReportCheck();
}

function bindAll() {
  for (const tab of document.querySelectorAll('.ops-tab')) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  $('ops-open-mission').addEventListener('click', openMission);
  $('ops-model-select').addEventListener('change', async () => {
    ctx.ops.model = selectedModel();
    await saveOps();
  });
  bindTracker();
  bindMetrics();
  $('ops-reconcile-run').addEventListener('click', (e) => runReconcile(e.currentTarget));
  $('ops-round2-run').addEventListener('click', (e) => runRound2(e.currentTarget));
  $('ops-plan-run').addEventListener('click', (e) => runPlan(e.currentTarget));
  $('ops-report-run').addEventListener('click', (e) => runReport(e.currentTarget));
  $('ops-report-month').addEventListener('change', updateReportCheck);
  $('ops-evidence-run').addEventListener('click', (e) => runEvidence(e.currentTarget));
  $('ops-prefill-run').addEventListener('click', (e) => runPrefill(e.currentTarget));
  bindPrefillFilesNote();
  bindConstraints();
  bindTeam();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ACTIVE_PROJECT_KEY]) {
      // 案件が切り替わったら、その案件の運用ボードを読み直す。
      location.reload();
      return;
    }
    if (area === 'sync' && changes.sk_master_doc_v012) {
      google.getActiveMasterDoc().then((m) => {
        ctx.master = m;
        ctx.sectionCache = null;
        renderHeader();
      });
    }
    if (area === 'local' && changes[SNAPSHOT_KEY]) {
      ctx.filledNos = new Set((changes[SNAPSHOT_KEY].newValue?.filledNos || []).map(String));
      renderRecipes();
    }
  });
}

async function init() {
  try {
    await loadContext();
  } catch (error) {
    console.error('[STRATEGY-KIT ops] init failed', error);
    toast('運用ボードの読み込みに失敗しました: ' + humanizeError(error), 'error', 12000);
  }
  if (!ctx.productConfig?.features?.operations) {
    $('ops-disabled').hidden = false;
    document.querySelector('.ops-layout').hidden = true;
    return;
  }
  bindAll();
  renderAll();
  showTab(location.hash.slice(1) || 'recipes');
}

init();
