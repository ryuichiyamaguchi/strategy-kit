// STRATEGY-KIT — 運用ボードの純ロジック（DOM / chrome / ネットワーク非依存）
//
// 「作った後」を回すための部品をここに集める。
//   - 施策トラッカー（担当・期限・状態・実施記録 → §98 への1行）
//   - 実績データ（CSV・貼り付けの解析、期間の扱い）
//   - 目的別レシピ（必要な章だけ使う）
//   - 制約条件（プロンプトへ渡す文面）
//   - 書き出し用の Markdown → HTML 変換、カレンダー(.ics)、スプレッドシート(CSV)
//
// 画面（sidepanel/operations.js）と Google 連携（phase0/ops-google.js）はここを呼ぶだけにする。

export const OPS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 保存場所
// ---------------------------------------------------------------------------

// state-persistence.js の _scopedKey と同じ規則（案件があれば案件配下）。
export function opsStorageKey(projectId) {
  const id = String(projectId || '').trim();
  return id ? `sk-state.projects.${id}.ops` : 'sk-state.ops';
}

export function createEmptyOpsState() {
  return {
    schemaVersion: OPS_SCHEMA_VERSION,
    actions: [],
    metrics: [],
    constraints: createEmptyConstraints(),
    recipe: null,
    reports: [],
    exports: [],
    round2: null,
    prefill: null,
    share: { trackerSheet: null, sharedWith: [] },
    adCheck: null,
  };
}

export function normalizeOpsState(raw) {
  const base = createEmptyOpsState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    schemaVersion: OPS_SCHEMA_VERSION,
    actions: Array.isArray(raw.actions) ? raw.actions.map(normalizeAction).filter(Boolean) : [],
    metrics: Array.isArray(raw.metrics) ? raw.metrics.map(normalizeMetric).filter(Boolean) : [],
    constraints: { ...createEmptyConstraints(), ...(raw.constraints || {}) },
    reports: Array.isArray(raw.reports) ? raw.reports : [],
    exports: Array.isArray(raw.exports) ? raw.exports : [],
    share: {
      trackerSheet: raw.share?.trackerSheet || null,
      sharedWith: Array.isArray(raw.share?.sharedWith) ? raw.share.sharedWith : [],
    },
  };
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

export function toIsoDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = String(value).trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[年月/.]/g, '-')
    .replace(/日/g, '');
  // GA4 などの書き出しは 20260901 形式
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return toIsoDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (date.getFullYear() !== Number(m[1]) || date.getMonth() !== Number(m[2]) - 1) return '';
  return toIsoDate(date);
}

function parseIsoDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function daysBetween(fromIso, toIso) {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIso);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// 週は月曜はじまり（日本の職場の感覚に合わせる）。
export function weekRange(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0=Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setDate(d.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

export function monthRange(yearMonth) {
  const m = String(yearMonth || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const end = new Date(Number(m[1]), Number(m[2]), 0);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

export function previousYearMonth(yearMonth) {
  const m = String(yearMonth || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 施策トラッカー
// ---------------------------------------------------------------------------

export const ACTION_STATUSES = Object.freeze({
  todo: '未着手',
  doing: '実行中',
  done: '完了',
  dropped: '見送り',
});

export const ACTION_CATEGORIES = Object.freeze({
  quickwin: '短期（Quick Win）',
  midlong: '中長期',
  other: 'その他',
});

function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function normalizeTitleKey(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[「」『』【】()（）\[\]\s・,，、。.]/g, '');
}

export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const status = Object.prototype.hasOwnProperty.call(ACTION_STATUSES, raw.status) ? raw.status : 'todo';
  const category = Object.prototype.hasOwnProperty.call(ACTION_CATEGORIES, raw.category) ? raw.category : 'other';
  return {
    id: String(raw.id || newId('act')),
    title,
    category,
    owner: String(raw.owner || '').trim(),
    startDate: toIsoDate(raw.startDate),
    dueDate: toIsoDate(raw.dueDate),
    status,
    kpi: String(raw.kpi || '').trim(),
    note: String(raw.note || '').trim(),
    budget: String(raw.budget || '').trim(),
    sourceSection: String(raw.sourceSection || '').trim(),
    log: Array.isArray(raw.log) ? raw.log.filter((e) => e && e.date && e.status) : [],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
  };
}

// AI が §7 から抽出した施策を既存の一覧へ合流させる。
// 同名（表記ゆれ吸収）の施策は、受講者が入れた担当・期限・状態・記録を消さない。
export function mergeExtractedActions(existing = [], extracted = []) {
  const result = existing.map((a) => normalizeAction(a)).filter(Boolean);
  const byKey = new Map(result.map((a) => [normalizeTitleKey(a.title), a]));
  let added = 0;
  let updated = 0;
  for (const item of extracted) {
    const normalized = normalizeAction(item);
    if (!normalized) continue;
    const key = normalizeTitleKey(normalized.title);
    const current = byKey.get(key);
    if (current) {
      // AI 由来で埋まるのは「空欄」だけ。人が書いた値は上書きしない。
      let changed = false;
      for (const field of ['kpi', 'budget', 'sourceSection']) {
        if (!current[field] && normalized[field]) {
          current[field] = normalized[field];
          changed = true;
        }
      }
      if (!current.dueDate && normalized.dueDate) {
        current.dueDate = normalized.dueDate;
        changed = true;
      }
      if (current.category === 'other' && normalized.category !== 'other') {
        current.category = normalized.category;
        changed = true;
      }
      if (changed) updated += 1;
      continue;
    }
    result.push(normalized);
    byKey.set(key, normalized);
    added += 1;
  }
  return { actions: result, added, updated };
}

// 状態を変えたら記録を1件足す。§98 へ書く1行も返す（書くかどうかは呼び出し側）。
export function applyActionStatus(action, { status, note = '', date } = {}, now = new Date()) {
  const current = normalizeAction(action);
  if (!current) throw new Error('施策が見つかりません');
  if (!Object.prototype.hasOwnProperty.call(ACTION_STATUSES, status)) throw new Error('不明な状態です');
  const day = toIsoDate(date) || toIsoDate(now);
  const entry = { date: day, status, note: String(note || '').trim() };
  const next = {
    ...current,
    status,
    note: entry.note || current.note,
    startDate: current.startDate || (status === 'doing' || status === 'done' ? day : ''),
    log: [...current.log, entry],
    updatedAt: now.toISOString(),
  };
  return { action: next, stateSheetRow: buildImplementationRow(next, entry) };
}

export function buildImplementationRow(action, entry) {
  const label = ACTION_STATUSES[entry.status] || entry.status;
  const parts = [
    `${ACTION_CATEGORIES[action.category] || ''}「${action.title}」`,
    `実施状況: ${label}`,
  ];
  if (action.owner) parts.push(`担当: ${action.owner}`);
  if (entry.note) parts.push(`メモ: ${entry.note}`);
  return {
    kind: '実施記録',
    content: parts.join('／'),
    source: action.sourceSection || '運用ボード',
    tag: '[事実-一次]',
    date: entry.date,
  };
}

export function isOpenAction(action) {
  return action && (action.status === 'todo' || action.status === 'doing');
}

export function listOverdueActions(actions = [], now = new Date()) {
  const today = toIsoDate(now);
  return actions
    .filter((a) => isOpenAction(a) && a.dueDate && a.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// 今週やること = 期限が今週の未完了 ＋ 実行中のもの（期限切れは別枠）。
export function listThisWeekActions(actions = [], now = new Date()) {
  const { start, end } = weekRange(now);
  const today = toIsoDate(now);
  return actions
    .filter((a) => isOpenAction(a))
    .filter((a) => {
      if (a.dueDate && a.dueDate < today) return false; // 期限切れは別枠
      if (a.dueDate && a.dueDate >= start && a.dueDate <= end) return true;
      return a.status === 'doing';
    })
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

export function summarizeActions(actions = [], now = new Date()) {
  const counts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const a of actions) counts[a.status] = (counts[a.status] || 0) + 1;
  return {
    total: actions.length,
    ...counts,
    thisWeek: listThisWeekActions(actions, now).length,
    overdue: listOverdueActions(actions, now).length,
    noOwner: actions.filter((a) => isOpenAction(a) && !a.owner).length,
    noDue: actions.filter((a) => isOpenAction(a) && !a.dueDate).length,
  };
}

// §98 の表に追記する Markdown の1行。
export function formatStateSheetRow({ kind, content, source, tag, date }) {
  const cell = (v) => String(v || '').replace(/\|/g, '｜').replace(/\n/g, ' ').trim();
  return `| ${cell(kind)} | ${cell(content)} | ${cell(source)} | ${cell(tag)} | ${cell(date)} |`;
}

// ---------------------------------------------------------------------------
// スプレッドシート（CSV）とカレンダー（.ics）
// ---------------------------------------------------------------------------

export const TRACKER_SHEET_HEADERS = Object.freeze([
  'ID', '施策名', '区分', '担当', '着手日', '期限', '状態', 'KPI', '予算', 'メモ',
]);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildTrackerCsv(actions = []) {
  const rows = [TRACKER_SHEET_HEADERS.join(',')];
  for (const a of actions) {
    rows.push([
      a.id,
      a.title,
      ACTION_CATEGORIES[a.category] || '',
      a.owner,
      a.startDate,
      a.dueDate,
      ACTION_STATUSES[a.status] || '',
      a.kpi,
      a.budget,
      a.note,
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

const STATUS_BY_LABEL = Object.fromEntries(Object.entries(ACTION_STATUSES).map(([k, v]) => [v, k]));
const CATEGORY_BY_LABEL = Object.fromEntries(Object.entries(ACTION_CATEGORIES).map(([k, v]) => [v, k]));

// 共有スプレッドシートでチームが更新した内容を取り込む。
// ID で突き合わせ、担当・期限・状態・メモの変更だけを反映する（施策の追加・削除はしない）。
export function applyTrackerSheetCsv(actions = [], csvText, now = new Date()) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { actions, changed: [], unknownIds: [] };
  const header = rows[0].map((h) => String(h).trim());
  const col = (name) => header.indexOf(name);
  const idx = {
    id: col('ID'), owner: col('担当'), start: col('着手日'), due: col('期限'), status: col('状態'), note: col('メモ'),
  };
  if (idx.id < 0) throw new Error('シートに「ID」列がありません。運用ボードから作ったシートを使ってください。');
  const byId = new Map(actions.map((a) => [a.id, normalizeAction(a)]));
  const changed = [];
  const unknownIds = [];
  for (const row of rows.slice(1)) {
    const id = String(row[idx.id] || '').trim();
    if (!id) continue;
    const current = byId.get(id);
    if (!current) {
      unknownIds.push(id);
      continue;
    }
    const nextStatus = idx.status >= 0 ? STATUS_BY_LABEL[String(row[idx.status] || '').trim()] : undefined;
    const patch = {
      owner: idx.owner >= 0 ? String(row[idx.owner] || '').trim() : current.owner,
      startDate: idx.start >= 0 ? toIsoDate(row[idx.start]) : current.startDate,
      dueDate: idx.due >= 0 ? toIsoDate(row[idx.due]) : current.dueDate,
      note: idx.note >= 0 ? String(row[idx.note] || '').trim() : current.note,
    };
    let next = { ...current, ...patch };
    let stateSheetRow = null;
    if (nextStatus && nextStatus !== current.status) {
      const applied = applyActionStatus(next, { status: nextStatus, note: patch.note }, now);
      next = applied.action;
      stateSheetRow = applied.stateSheetRow;
    }
    const diff = ['owner', 'startDate', 'dueDate', 'note', 'status'].filter((k) => next[k] !== current[k]);
    if (diff.length) {
      next.updatedAt = now.toISOString();
      byId.set(id, next);
      changed.push({ id, title: next.title, fields: diff, stateSheetRow });
    }
  }
  return { actions: actions.map((a) => byId.get(a.id) || a), changed, unknownIds };
}

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(iso) {
  return String(iso).replace(/-/g, '');
}

function nextDayIso(iso) {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + 1);
  return toIsoDate(d);
}

// Google カレンダー等に読み込める .ics（終日の予定・期限日）。追加の Google 権限は使わない。
export function buildActionsIcs(actions = [], { calendarName = 'STRATEGY-KIT 施策', now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//STRATEGY-KIT//Operations Board//JA',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];
  for (const a of actions) {
    if (!isOpenAction(a) || !a.dueDate) continue;
    const desc = [
      `区分: ${ACTION_CATEGORIES[a.category] || ''}`,
      a.owner ? `担当: ${a.owner}` : '',
      a.kpi ? `KPI: ${a.kpi}` : '',
      a.note ? `メモ: ${a.note}` : '',
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(a.id)}@strategy-kit`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(a.dueDate)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDayIso(a.dueDate))}`,
      `SUMMARY:${icsEscape(`【期限】${a.title}`)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// CSV / 貼り付けデータの解析
// ---------------------------------------------------------------------------

export function detectDelimiter(text) {
  const sample = String(text || '').split(/\r?\n/).slice(0, 5).join('\n');
  const counts = {
    '\t': (sample.match(/\t/g) || []).length,
    ',': (sample.match(/,/g) || []).length,
    ';': (sample.match(/;/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

// RFC 4180 寄りの CSV 解析（引用符・改行入りセル・BOM 対応）。区切りは自動判定。
export function parseCsv(text, delimiter) {
  // GA4 の書き出しは先頭に「# ----」のコメント行が付くので落とす。
  const src = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (!src.trim()) return [];
  const delim = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// AI に渡すためのプレビュー（列名＋先頭行）。データが大きくても上限で切る。
export function buildTablePreview(rows, { maxRows = 60, maxChars = 12000 } = {}) {
  const lines = [];
  for (const r of rows.slice(0, maxRows)) lines.push(r.map((c) => String(c).trim()).join('\t'));
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（以下省略）';
  const omitted = Math.max(0, rows.length - maxRows);
  return { text, omittedRows: omitted, totalRows: rows.length };
}

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[,\s円人件回%％]/g, '')
    .replace(/^¥/, '');
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

export function normalizeMetric(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = String(raw.metric || '').trim();
  const value = parseNumber(raw.value);
  if (!metric || value === null) return null;
  return {
    id: String(raw.id || newId('met')),
    metric,
    value,
    unit: String(raw.unit || '').trim(),
    periodStart: toIsoDate(raw.periodStart),
    periodEnd: toIsoDate(raw.periodEnd),
    source: String(raw.source || '').trim(),
    note: String(raw.note || '').trim(),
    importedAt: raw.importedAt || new Date().toISOString(),
  };
}

export function metricPeriodLabel(m) {
  if (m.periodStart && m.periodEnd) return `${m.periodStart}〜${m.periodEnd}`;
  if (m.periodStart) return `${m.periodStart}〜（終了日不明）`;
  return '期間不明';
}

// 同じ指標・同じ期間の値は置き換え、それ以外は追加する（取り込み直しで二重計上しない）。
export function mergeMetrics(existing = [], incoming = []) {
  const result = existing.map(normalizeMetric).filter(Boolean);
  const keyOf = (m) => `${normalizeTitleKey(m.metric)}|${m.periodStart}|${m.periodEnd}`;
  const index = new Map(result.map((m, i) => [keyOf(m), i]));
  let added = 0;
  let replaced = 0;
  const skipped = [];
  for (const raw of incoming) {
    const m = normalizeMetric(raw);
    if (!m) {
      skipped.push(raw);
      continue;
    }
    const key = keyOf(m);
    if (index.has(key)) {
      result[index.get(key)] = { ...m, id: result[index.get(key)].id };
      replaced += 1;
    } else {
      index.set(key, result.length);
      result.push(m);
      added += 1;
    }
  }
  return { metrics: result, added, replaced, skipped };
}

// 期間の揃い方を決定的に点検する（AI に渡す前の安全装置）。
// 期間の長さが違う／間が空いている数字を「直接比較しない」ための注記を作る。
export function buildPeriodNotes(metrics = []) {
  const groups = new Map();
  for (const m of metrics) {
    const key = normalizeTitleKey(m.metric);
    if (!groups.has(key)) groups.set(key, { name: m.metric, items: [] });
    groups.get(key).items.push(m);
  }
  const notes = [];
  for (const { name, items } of groups.values()) {
    const sorted = [...items].sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''));
    const unknown = sorted.filter((m) => !m.periodStart || !m.periodEnd);
    if (unknown.length) notes.push(`「${name}」: 期間が不明な値が${unknown.length}件あります（比較に使わないこと）`);
    const known = sorted.filter((m) => m.periodStart && m.periodEnd);
    for (let i = 1; i < known.length; i += 1) {
      const prev = known[i - 1];
      const cur = known[i];
      const lenPrev = daysBetween(prev.periodStart, prev.periodEnd);
      const lenCur = daysBetween(cur.periodStart, cur.periodEnd);
      const gap = daysBetween(prev.periodEnd, cur.periodStart);
      if (lenPrev !== null && lenCur !== null && Math.abs(lenPrev - lenCur) > 3) {
        notes.push(`「${name}」: ${metricPeriodLabel(prev)} と ${metricPeriodLabel(cur)} は期間の長さが違います（直接比較しない）`);
      }
      if (gap !== null && gap > 1) {
        notes.push(`「${name}」: ${prev.periodEnd} から ${cur.periodStart} まで${gap - 1}日の空白があります（欠測期間として扱う）`);
      }
    }
  }
  return notes;
}

export function buildMetricRow(m) {
  return {
    kind: '実績',
    content: `${m.metric} = ${m.value.toLocaleString('ja-JP')}${m.unit ? ' ' + m.unit : ''}（期間 ${metricPeriodLabel(m)}${m.source ? '・取得元 ' + m.source : ''}）`,
    source: '実績データ取り込み',
    tag: m.periodStart && m.periodEnd ? '[事実-一次]' : '[要確認]',
    date: toIsoDate(m.importedAt) || toIsoDate(new Date()),
  };
}

export function metricsInRange(metrics = [], { start, end }) {
  return metrics.filter((m) => m.periodStart && m.periodEnd && m.periodStart >= start && m.periodEnd <= end);
}

export function metricsTableMarkdown(metrics = []) {
  if (!metrics.length) return '（実績データなし）';
  const head = '| 指標 | 値 | 単位 | 期間 | 取得元 |\n|---|---|---|---|---|';
  const body = metrics.map((m) => `| ${m.metric} | ${m.value} | ${m.unit} | ${metricPeriodLabel(m)} | ${m.source} |`).join('\n');
  return `${head}\n${body}`;
}

export function actionsTableMarkdown(actions = []) {
  if (!actions.length) return '（施策の記録なし）';
  const head = '| 施策 | 区分 | 担当 | 着手日 | 期限 | 状態 | 記録 |\n|---|---|---|---|---|---|---|';
  const body = actions.map((a) => {
    const log = a.log.map((e) => `${e.date} ${ACTION_STATUSES[e.status]}${e.note ? '（' + e.note + '）' : ''}`).join(' / ');
    return `| ${a.title} | ${ACTION_CATEGORIES[a.category]} | ${a.owner || '未定'} | ${a.startDate || '-'} | ${a.dueDate || '-'} | ${ACTION_STATUSES[a.status]} | ${log || '記録なし'} |`;
  }).join('\n');
  return `${head}\n${body}`;
}

// ---------------------------------------------------------------------------
// 制約条件
// ---------------------------------------------------------------------------

export const REGULATED_CATEGORIES = Object.freeze({
  none: '特になし',
  medical: '医療・歯科・クリニック（医療広告ガイドライン）',
  cosmetics: '化粧品・美容（薬機法）',
  healthfood: '健康食品・サプリ（薬機法・健康増進法）',
  treatment: '整骨院・整体・マッサージ（あはき法・柔整法の広告制限）',
  realestate: '不動産（不動産の表示に関する公正競争規約）',
  finance: '金融・保険（金融商品取引法・保険業法）',
  professional: '士業（各士業の広告規程）',
});

export function createEmptyConstraints() {
  return {
    monthlyBudgetYen: '',
    weeklyHours: '',
    people: '',
    channelsAvailable: '',
    channelsUnavailable: '',
    regulated: 'none',
    deadline: '',
    other: '',
  };
}

export function hasConstraints(c = {}) {
  return Boolean(
    String(c.monthlyBudgetYen || '').trim() || String(c.weeklyHours || '').trim() || String(c.people || '').trim()
    || String(c.channelsAvailable || '').trim() || String(c.channelsUnavailable || '').trim()
    || (c.regulated && c.regulated !== 'none') || String(c.deadline || '').trim() || String(c.other || '').trim(),
  );
}

// 全自動・半自動・コピーするプロンプトへ添える制約の文面。
export function constraintsToPromptText(c = {}) {
  if (!hasConstraints(c)) return '';
  const lines = ['【実行上の制約（施策・予算・KPIは必ずこの範囲に収める）】'];
  const budget = parseNumber(c.monthlyBudgetYen);
  if (budget !== null) lines.push(`- 使える販促予算: 月 ${budget.toLocaleString('ja-JP')} 円まで`);
  else if (String(c.monthlyBudgetYen || '').trim()) lines.push(`- 使える販促予算: ${String(c.monthlyBudgetYen).trim()}`);
  if (String(c.weeklyHours || '').trim()) lines.push(`- 施策に割ける時間: 週 ${String(c.weeklyHours).trim()} 時間まで`);
  if (String(c.people || '').trim()) lines.push(`- 動ける人: ${String(c.people).trim()}`);
  if (String(c.channelsAvailable || '').trim()) lines.push(`- 使えるチャネル・資産: ${String(c.channelsAvailable).trim()}`);
  if (String(c.channelsUnavailable || '').trim()) lines.push(`- 使えない／使わないチャネル: ${String(c.channelsUnavailable).trim()}`);
  if (String(c.deadline || '').trim()) lines.push(`- 期限・時期の制約: ${String(c.deadline).trim()}`);
  if (c.regulated && c.regulated !== 'none' && REGULATED_CATEGORIES[c.regulated]) {
    lines.push(`- 広告規制: ${REGULATED_CATEGORIES[c.regulated]} の対象。効能効果の断定・最上級表現・体験談の扱いに注意し、出せない表現を使わない`);
  }
  if (String(c.other || '').trim()) lines.push(`- その他: ${String(c.other).trim()}`);
  lines.push('- この範囲を超える案は採用せず、「却下（制約超過）」として理由を1行書く');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 目的別レシピ（必要な章だけ使う）
// ---------------------------------------------------------------------------

export const RECIPES = Object.freeze([
  {
    id: 'full',
    title: '戦略を最初から作る',
    description: '§0〜§9 をすべて通します。新しい案件・新規事業向け。',
    phases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    tools: [],
  },
  {
    id: 'cause',
    title: '集客が落ちた原因を探したい',
    description: '実績を取り込み、環境の変化（§2）と顧客の動き（§4 カスタマージャーニー）を見直して、答え合わせで原因の当たりをつけます。',
    phases: [2, 4],
    tools: ['metrics', 'round2'],
  },
  {
    id: 'launch',
    title: '新商品・新メニューを打ち出したい',
    description: '狙う顧客（§4）→ 打ち出し方（§5 USP・コピー）→ 施策（§6・§7）の順に作ります。',
    phases: [4, 5, 6, 7],
    tools: ['adcheck'],
  },
  {
    id: 'budget',
    title: '来期の販促計画と予算を作りたい',
    description: '施策の洗い出し（§6）→ 予算配分（§7）→ 目標（§8）を作り、予算申請書に書き出します。',
    phases: [6, 7, 8],
    tools: ['export:budget'],
  },
  {
    id: 'keep-or-stop',
    title: 'いまの施策を続けるか判断したい',
    description: '実績を取り込んで答え合わせし、§9 の採否判断ルールで「続ける／やめる／変える」を決めます。',
    phases: [9],
    tools: ['metrics', 'round2'],
  },
]);

export function findRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null;
}

// 全自動が受け取るフェーズの絞り込み。null＝全部（従来どおり）。
export function recipePhaseFilter(recipe) {
  if (!recipe || recipe.id === 'full' || !Array.isArray(recipe.phases)) return null;
  return recipe.phases.map((n) => Number(n)).filter((n) => Number.isFinite(n));
}

// ---------------------------------------------------------------------------
// 書き出し: Markdown → HTML（Google ドキュメントへ変換アップロードする用）
// ---------------------------------------------------------------------------

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // リンクは http(s) だけ（javascript: などは作らない）。本文は escapeHtml 済みなので属性を壊せない。
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return html;
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// AI の出力（見出し・箇条書き・表・太字）を、Google ドキュメントが変換で崩さない素朴な HTML にする。
export function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      closeList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(`<pre>${escapeHtml(buf.join('\n'))}</pre>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList();
      const header = splitTableRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push('<table border="1" style="border-collapse:collapse">');
      out.push(`<tr>${header.map((h) => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr>`);
      for (const r of body) out.push(`<tr>${r.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`);
      out.push('</table>');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*・]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        closeList();
        out.push(`<${type}>`);
        list = type;
      }
      out.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function wrapHtmlDocument(title, bodyHtml) {
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '</head><body>',
    bodyHtml,
    '</body></html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// AI 出力からの JSON 取り出し
// ---------------------------------------------------------------------------

export function extractJson(text) {
  const src = String(text || '');
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const firstArr = src.indexOf('[');
  const firstObj = src.indexOf('{');
  const starts = [firstArr, firstObj].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = src[start];
    const close = open === '[' ? ']' : '}';
    const end = src.lastIndexOf(close);
    if (end > start) candidates.push(src.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (_) {
      /* 次の候補へ */
    }
  }
  throw new Error('AI の回答から JSON を読み取れませんでした');
}

// ---------------------------------------------------------------------------
// 実績データの集計（AI が決めた「表の読み方」に従ってプログラムが計算する）
// ---------------------------------------------------------------------------

function periodKeyFor(iso, granularity) {
  if (granularity === 'month') return iso.slice(0, 7);
  if (granularity === 'week') return weekRange(parseIsoDate(iso)).start;
  return 'whole';
}

function periodBoundsFor(key, granularity, isoDates) {
  if (granularity === 'month') {
    const r = monthRange(key);
    // データが月の途中で始まる／終わるなら、実際にデータがある日までに縮める（欠測を期間に含めない）
    const sorted = [...isoDates].sort();
    return { start: sorted[0] > r.start ? sorted[0] : r.start, end: sorted[sorted.length - 1] < r.end ? sorted[sorted.length - 1] : r.end };
  }
  if (granularity === 'week') {
    const d = parseIsoDate(key);
    const end = new Date(d);
    end.setDate(d.getDate() + 6);
    const sorted = [...isoDates].sort();
    const endIso = toIsoDate(end);
    return { start: sorted[0] > key ? sorted[0] : key, end: sorted[sorted.length - 1] < endIso ? sorted[sorted.length - 1] : endIso };
  }
  const sorted = [...isoDates].sort();
  return { start: sorted[0], end: sorted[sorted.length - 1] };
}

// 「2026年8月」「2026-08」「2026/8」（日が無いもの）を YYYY-MM にする。日付付きは null。
export function parseYearMonthCell(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const m = text.match(/^(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*月?$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

function aggregateValues(values, how) {
  if (!values.length) return null;
  if (how === 'average') return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  if (how === 'last') return values[values.length - 1];
  if (how === 'max') return Math.max(...values);
  return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
}

// spec = { headerRow, dateColumn, granularity, periodStart, periodEnd, source, metrics:[{column, metric, unit, aggregate}] }
export function aggregateTableBySpec(rows = [], spec = {}, { now = new Date() } = {}) {
  const headerRow = Number.isInteger(spec.headerRow) && spec.headerRow >= 0 ? spec.headerRow : 0;
  const header = (rows[headerRow] || []).map((h) => String(h).trim());
  const dataRows = rows.slice(headerRow + 1);
  const warnings = [];
  const colIndex = (name) => header.findIndex((h) => h === String(name || '').trim());
  const metricsSpec = (Array.isArray(spec.metrics) ? spec.metrics : []).filter((m) => {
    if (colIndex(m.column) < 0) {
      warnings.push(`列「${m.column}」が表に見つからないため、取り込みませんでした`);
      return false;
    }
    return true;
  });
  const source = String(spec.source || '').trim();
  const importedAt = now.toISOString();
  const results = [];

  const dateIdx = spec.dateColumn ? colIndex(spec.dateColumn) : -1;
  if (spec.dateColumn && dateIdx < 0) warnings.push(`日付の列「${spec.dateColumn}」が見つかりません`);

  if (dateIdx >= 0) {
    const granularity = ['month', 'week', 'whole'].includes(spec.granularity) ? spec.granularity : 'month';
    const groups = new Map();
    let undated = 0;
    for (const r of dataRows) {
      const month = parseYearMonthCell(r[dateIdx]);
      if (month) {
        // 「2026年8月」「2026-08」のような月単位の行は、その月まるごとを期間にする。
        const range = monthRange(month);
        const key = granularity === 'whole' ? 'whole' : month;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ iso: range.start, row: r }, { iso: range.end, row: null });
        continue;
      }
      const iso = toIsoDate(r[dateIdx]);
      if (!iso) {
        undated += 1;
        continue;
      }
      const key = periodKeyFor(iso, granularity);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ iso, row: r });
    }
    if (undated) warnings.push(`日付が読めない行が ${undated} 行あったため除外しました（合計行など）`);
    for (const [key, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const isoDates = items.map((i) => i.iso);
      const bounds = periodBoundsFor(key, granularity, isoDates);
      for (const m of metricsSpec) {
        const idx = colIndex(m.column);
        const values = items.filter((i) => i.row).map((i) => parseNumber(i.row[idx])).filter((v) => v !== null);
        if (!values.length) continue;
        const value = aggregateValues(values, m.aggregate);
        results.push(normalizeMetric({
          metric: m.metric || m.column,
          value,
          unit: m.unit,
          periodStart: bounds.start,
          periodEnd: bounds.end,
          source,
          note: `${values.length}行を${m.aggregate === 'average' ? '平均' : m.aggregate === 'last' ? '最終値' : m.aggregate === 'max' ? '最大値' : '合計'}で集計`,
          importedAt,
        }));
      }
    }
  } else {
    // 日付列が無い表は「表全体で1つの期間」。期間が分からなければ期間不明のまま取り込み、比較に使わない。
    const periodStart = toIsoDate(spec.periodStart);
    const periodEnd = toIsoDate(spec.periodEnd);
    if (!periodStart || !periodEnd) warnings.push('表の期間が分からないため「期間不明」として取り込みます（答え合わせ・前月比較には使われません）。期間を手で補ってください');
    for (const m of metricsSpec) {
      const idx = colIndex(m.column);
      const values = dataRows.map((r) => parseNumber(r[idx])).filter((v) => v !== null);
      if (!values.length) continue;
      results.push(normalizeMetric({
        metric: m.metric || m.column,
        value: aggregateValues(values, m.aggregate),
        unit: m.unit,
        periodStart,
        periodEnd,
        source,
        note: `${values.length}行を${m.aggregate === 'average' ? '平均' : m.aggregate === 'last' ? '最終値' : '合計'}で集計`,
        importedAt,
      }));
    }
  }
  return { metrics: results.filter(Boolean), warnings };
}
