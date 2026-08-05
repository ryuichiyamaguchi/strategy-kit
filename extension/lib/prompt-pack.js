// STRATEGY-KIT — プロンプトパック書き出し（純ロジック）
//
// 目的: 拡張機能を使わずに AI エージェント／チャットで §0〜§9 を回すための
// 「現行プロンプト一式＋2周目ラッパー」を 1 ファイルの Markdown として書き出す。
//
// 背景（職業訓練校 2026-08-05 実走フィードバック 提案B）:
//   - Gemini API キーの発行で詰まる受講者
//   - 旧版の拡張を入れたまま更新しない受講者
//   - 普段から Claude Code 等のエージェントで作業する受講者
//   これらの受け皿が拡張の外に必要だった。書き出しがあればバージョンずれも吸収できる。
//
// 設計方針:
//   - prompts.json を正本とし、この module は「並べ替えと読み替え注記」だけを行う
//     （プロンプト本文をここに複製しない。複製すると本体と乖離するため）
//   - 拡張 UI 前提の文言（★貼付★ / {{…}} / Finance Gate / AI タブ操作）は、
//     本文を書き換えず、冒頭の読み替え表と各章の注記で吸収する
//   - DOM も chrome API も参照しない（node の単体テストで検証できるようにする）

const PLACEHOLDER_LEGEND = [
  ['`★…★`', '人が送信前に手で埋める（業種・店舗名など）', '実行者が埋める。分からなければ埋める前に依頼者へ質問する'],
  ['`★貼付★`', '前の章の要点版を人が貼り付ける', 'エージェント自身がマスタードキュメントの該当章（要点版）を読んで参照する'],
  ['`{{businessContext}}`', '拡張が事業情報を自動で差し込む', '案件の前提（業種・店舗名・確定した壁打ち要約）を実行者が差し込む'],
  ['`{{施策名}}` などの `{{…}}`', '拡張が直前の出力から差し込む', '直前の章で決めた名称をそのまま入れる'],
];

const TOOL_COUPLING_NOTES = [
  '**Finance Gate / Summary Gate**: 拡張機能に内蔵された自動チェックの名称です。エージェント実行では動きません。ただし表の形式（行ラベル固定・横持ち・空欄禁止）は指示どおり守ってください。あとで拡張やレビューへ通すときにそのまま使えます。',
  '**「送信しない」「Perplexity で」などの操作指示**: 拡張が AI タブを操作する前提の記述です。エージェント実行では「その AI が得意な作業」の指定として読み替え、手元のエージェントで代替してかまいません（ウェブ検索が必要な章は検索できる環境で実行する）。',
  '**§-1（案件メタ情報）**: 拡張では設定画面の入力から自動生成されます。エージェント実行では、最初に §-1 を手で作ってから §0 へ進んでください（業種タイプ／業種／店舗名／担当者／実施期間／既存資産の有無／版数／最終更新日）。',
];

const ROUND2_IDS = ['round2-normalize', 'round2-reconcile', 'round2-revise'];

function asText(value) {
  return String(value == null ? '' : value);
}

function fence(body) {
  // 本文に ``` が含まれていても壊れないよう、必要に応じてフェンスを伸ばす。
  const text = asText(body);
  let ticks = 3;
  const runs = text.match(/`{3,}/g) || [];
  for (const run of runs) ticks = Math.max(ticks, run.length + 1);
  const bar = '`'.repeat(ticks);
  return bar + 'text\n' + text + '\n' + bar;
}

function heading(phase) {
  const no = phase.no === undefined || phase.no === null ? '' : '§' + phase.no + ' ';
  return no + asText(phase.title);
}

function phaseMeta(phase) {
  const rows = [];
  if (phase.frame) rows.push('- 使うフレーム: ' + asText(phase.frame));
  if (phase.inputs) rows.push('- 入力: ' + asText(phase.inputs));
  if (phase.outputs) rows.push('- 出力: ' + asText(phase.outputs));
  if (phase.estimatedMinutes) rows.push('- 目安: 約' + phase.estimatedMinutes + '分');
  return rows;
}

function promptSection(prompt, index) {
  const lines = [];
  const label = asText(prompt.label || prompt.title || ('プロンプト' + (index + 1)));
  lines.push('#### ' + label);
  const meta = [];
  if (prompt.for) meta.push('推奨AI: ' + asText(prompt.for));
  if (Array.isArray(prompt.alternativeFor) && prompt.alternativeFor.length) {
    meta.push('代替: ' + prompt.alternativeFor.map(asText).join(' / '));
  }
  if (prompt.purpose) meta.push('用途: ' + asText(prompt.purpose));
  if (meta.length) lines.push('> ' + meta.join('／'));
  lines.push('');
  lines.push(fence(prompt.body));
  lines.push('');
  return lines;
}

/**
 * プロンプトパック本文（Markdown）を組み立てる。
 *
 * @param {object} opts
 * @param {object} opts.prompts        prompts.json をパースしたオブジェクト
 * @param {string} [opts.productName]  製品表示名（例 "STRATEGY-KIT"）
 * @param {string} [opts.appVersion]   拡張のバージョン（manifest.version）
 * @param {string} [opts.generatedOn]  書き出し日（YYYY-MM-DD。省略時は日付行を出さない）
 * @returns {string} Markdown
 */
export function buildPromptPack({ prompts, productName, appVersion, generatedOn } = {}) {
  const data = prompts || {};
  const phases = Array.isArray(data.phases) ? data.phases : [];
  const supplementary = Array.isArray(data.supplementary) ? data.supplementary : [];
  const name = asText(productName || 'STRATEGY-KIT');
  const out = [];

  out.push('# ' + name + ' プロンプトパック（エージェント実行用）');
  out.push('');
  const head = [];
  if (appVersion) head.push('拡張バージョン: ' + asText(appVersion));
  if (data.version) head.push('プロンプト版数: ' + asText(data.version));
  if (data.updated) head.push('プロンプト更新日: ' + asText(data.updated));
  if (generatedOn) head.push('書き出し日: ' + asText(generatedOn));
  if (head.length) {
    out.push(head.map((h) => '- ' + h).join('\n'));
    out.push('');
  }
  out.push('このファイルは、' + name + ' 拡張機能に入っているプロンプト一式を、そのまま AI エージェント（Claude Code / ChatGPT / Gemini など）へ渡せる形に書き出したものです。拡張機能が無くても、この 1 ファイルだけで §0〜§9 の戦略づくりと、実測データを使った 2 周目を回せます。');
  out.push('');

  out.push('## 使い方（3ステップ）');
  out.push('');
  out.push('1. このファイル全体を AI に渡し、「この手順に従って進めてください」と伝える');
  out.push('2. 案件の前提（業種・店舗名・業種タイプ）を伝える。既にマスタードキュメントがある場合はそれも渡す');
  out.push('3. §0 から順に実行する。**1 つの章＝1 つの新しいチャット**で実行し、章をまたぐ受け渡しは「§N 要点版」と「§98 案件ステートシート」だけに絞る（長い履歴を持ち越すほど精度が落ちるため）');
  out.push('');
  out.push('既にマスタードキュメントがあり、実測データで見直したい場合は、下の「2周目」から始めてください。');
  out.push('');

  out.push('## 記法の読み替え（拡張機能 → エージェント）');
  out.push('');
  out.push('| 記法 | 拡張機能での意味 | エージェント実行での扱い |');
  out.push('|---|---|---|');
  for (const [mark, inExt, inAgent] of PLACEHOLDER_LEGEND) {
    out.push('| ' + mark + ' | ' + inExt + ' | ' + inAgent + ' |');
  }
  out.push('');
  out.push('### 拡張機能に結びついた記述の扱い');
  out.push('');
  for (const note of TOOL_COUPLING_NOTES) out.push('- ' + note);
  out.push('');

  if (Array.isArray(data.principles) && data.principles.length) {
    out.push('## 全体の原則（すべての章に適用）');
    out.push('');
    for (const p of data.principles) out.push('- ' + asText(p));
    out.push('');
  }

  out.push('## マスタードキュメントの章立て');
  out.push('');
  out.push('§-1 案件メタ情報／§0 プレリサーチ／§1 ヒアリング／§2 調査分析／§3 統合（SWOT）／§4 戦略策定／§5 価値設計／§6 施策ブレスト／§7 施策設計詳細／§8 KPIツリー／§9 PDCA設計／§98 案件ステートシート（数値と決定の正本）／§99 決定ログ');
  out.push('');
  out.push('出力はこの章立てのマスタードキュメント 1 本に集約します。各章の末尾には「§N 要点版（500字以内）」と「ステートシート差分（§98 へ追記）」を必ず付けてください。');
  out.push('');

  out.push('---');
  out.push('');
  out.push('## 1周目: 章ごとのプロンプト（§0〜§9）');
  out.push('');
  for (const phase of phases) {
    out.push('### ' + heading(phase));
    out.push('');
    const meta = phaseMeta(phase);
    if (meta.length) {
      out.push(meta.join('\n'));
      out.push('');
    }
    const list = Array.isArray(phase.prompts) ? phase.prompts : [];
    list.forEach((prompt, i) => {
      for (const line of promptSection(prompt, i)) out.push(line);
    });
  }

  out.push('---');
  out.push('');
  out.push('## 2周目: 実測データで答え合わせして改訂する');
  out.push('');
  out.push('既にマスタードキュメント（1周目）があり、実施後の数字が手元にある場合の進め方です。**①取り込み → ②答え合わせ → ③改訂走行** の順に実行し、最後に「改訂版マスタードキュメント」「答え合わせ表」「次の90日プラン」の3点を出します。');
  out.push('');
  out.push('③改訂走行のラッパーは、上の「1周目: 章ごとのプロンプト」の各章プロンプトの**前に貼り付けて**使います（章プロンプトそのものは書き換えません）。');
  out.push('');
  const byId = new Map(supplementary.map((item) => [asText(item.id), item]));
  for (const id of ROUND2_IDS) {
    const item = byId.get(id);
    if (!item) continue;
    out.push('### ' + asText(item.title || id));
    out.push('');
    if (item.purpose) {
      out.push('> ' + asText(item.purpose));
      out.push('');
    }
    out.push(fence(item.body));
    out.push('');
  }

  const rest = supplementary.filter((item) => !ROUND2_IDS.includes(asText(item.id)));
  if (rest.length) {
    out.push('---');
    out.push('');
    out.push('## 補助プロンプト');
    out.push('');
    for (const item of rest) {
      out.push('### ' + asText(item.title || item.id));
      out.push('');
      if (item.purpose) {
        out.push('> ' + asText(item.purpose));
        out.push('');
      }
      out.push(fence(item.body));
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('生成元: ' + name + (appVersion ? ' v' + asText(appVersion) : '') + '（prompts ' + asText(data.version || '-') + '）。プロンプト本文は拡張機能の内容と同一です。');
  out.push('');
  return out.join('\n');
}

/**
 * 書き出しファイル名。バージョンと日付で世代を区別できるようにする。
 */
export function buildPromptPackFileName({ productSlug, appVersion, generatedOn } = {}) {
  const slug = asText(productSlug || 'strategy-kit').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const parts = [slug, 'promptpack'];
  if (appVersion) parts.push('v' + asText(appVersion));
  if (generatedOn) parts.push(asText(generatedOn));
  return parts.join('-') + '.md';
}
