// STRATEGY-KIT — ヒアリング準備状況の共有判定（純ロジック）
// 役割:
//   - F2 案件整合チェック（要約・skip ack のメタが現在の業種/店舗と一致するか）
//   - 全自動停止ゲートの発火判定（getHearingReadiness）
//   - ゲートモーダルの選択肢マトリクス（getHearingGatePlan）
// 設計: hearing-redesign.md §3 F2 / §4-2 条件マトリクス
//
// このモジュールは DOM / chrome.* に依存しない純関数のみを置く。
// sidepanel.js は state.settings から値を渡し、tests は直接 import して評価する。

export const HEARING_META_KEY = 'sk_hearing_meta_v013';
export const HEARING_SKIP_ACK_KEY = 'sk_hearing_skip_ack_v013';

function norm(value) {
  return String(value == null ? '' : value).trim();
}

// 確定要約 / skip ack に併存させる案件メタを作る。
export function buildHearingMeta({ storeName, industryLabel, now } = {}) {
  return {
    storeName: norm(storeName),
    industryLabel: norm(industryLabel),
    updatedAt: typeof now === 'number' ? now : Date.now(),
  };
}

// メタの storeName + industryLabel が現在の設定と一致するか。
// メタが無い（後方互換の既存要約）場合は整合不明 = false。
// Y1: 両フィールドが非空であることを必要条件とする（空同士の一致は案件識別なし＝不整合扱い）。
export function isHearingMetaConsistent(meta, settings = {}) {
  if (!meta || typeof meta !== 'object') return false;
  const metaStore = norm(meta.storeName);
  const metaIndustry = norm(meta.industryLabel);
  const settingsStore = norm(settings.storeName);
  const settingsIndustry = norm(settings.industryLabel);
  // 両方のフィールドが非空かつ一致のみ consistent=true
  if (!metaStore || !metaIndustry || !settingsStore || !settingsIndustry) return false;
  return metaStore === settingsStore && metaIndustry === settingsIndustry;
}

// ゲート発火判定（ゲートと next-action 誘導の共有ソース）。
// 返り値:
//   mode, hasSummary, consistent, metaUnknown, skipAckValid, gateRequired, status, staleStoreName
// status: 'ready' | 'ack-skipped' | 'needs-hearing' | 'stale-summary' | 'meta-unknown' | 'mode-a-design'
//
// 判定順（R1 修正後）:
//   1. 整合する確定要約あり → ready（最優先。注入できる状態）
//   2. stale-summary（別案件メタ付き要約）→ ゲート必要（ack より優先。事故防止の核心）
//   3. meta-unknown（後方互換の既存要約）→ ゲート必要（一度だけ確認）
//   4. skip ack 済み（同案件・要約なし状態への同意）→ ack-skipped
//   5. 上記以外 → needs-hearing / mode-a-design
//
// Y2: モード A にも skip ack を適用（ack 済み同一案件では再表示しない）。
//   「A は常に発火」= 「ack なしなら常に発火」と解釈（受入基準3の一般則を優先）。
export function getHearingReadiness({ mode, summary, meta, skipAck, settings = {} } = {}) {
  const hasSummary = !!norm(summary);
  const consistent = hasSummary && isHearingMetaConsistent(meta, settings);
  const metaUnknown = hasSummary && !meta;
  const skipAckValid = isHearingMetaConsistent(skipAck, settings);

  // 1. 整合する確定要約あり → ゲート不要（既存動線維持）。
  if (consistent) {
    return {
      mode,
      hasSummary,
      consistent,
      metaUnknown,
      skipAckValid,
      gateRequired: false,
      status: 'ready',
      staleStoreName: '',
    };
  }

  // 2. R1: stale-summary（別案件メタ付き要約）→ ack より優先してゲート表示。
  //    ack は「要約なし状態への同意」にのみ有効。古い要約が残っている場合は
  //    ack が有っても「引き継ぐ/破棄」の確認を出す（誤コンテキスト事故防止）。
  if (hasSummary && meta && !consistent) {
    return {
      mode,
      hasSummary,
      consistent,
      metaUnknown,
      skipAckValid,
      gateRequired: true,
      status: 'stale-summary',
      staleStoreName: norm(meta.storeName),
    };
  }

  // 3. meta-unknown（後方互換の既存要約・メタ無し）→ 整合不明として一度だけ確認。
  if (metaUnknown) {
    return {
      mode,
      hasSummary,
      consistent,
      metaUnknown,
      skipAckValid,
      gateRequired: true,
      status: 'meta-unknown',
      staleStoreName: '',
    };
  }

  // 4. skip ack 済み（同一案件・要約なし状態への同意）→ ゲート不要。
  //    Y2: モード A にも適用（受入基準3の一般則）。
  if (skipAckValid) {
    return {
      mode,
      hasSummary,
      consistent,
      metaUnknown,
      skipAckValid,
      gateRequired: false,
      status: 'ack-skipped',
      staleStoreName: '',
    };
  }

  // 5. モードA（ack なし）: 質問設計のゲートを出す。
  if (mode === 'A') {
    return {
      mode,
      hasSummary,
      consistent,
      metaUnknown,
      skipAckValid,
      gateRequired: true,
      status: 'mode-a-design',
      staleStoreName: '',
    };
  }

  // 6. 要約なし → ヒアリング未完。
  return {
    mode,
    hasSummary,
    consistent,
    metaUnknown,
    skipAckValid,
    gateRequired: true,
    status: 'needs-hearing',
    staleStoreName: '',
  };
}

// 「自社事業」かつ、同一案件でユーザーが明示的にヒアリングを省略した場合だけ、
// §1 を質問設計ではなく既知情報の整理へ切り替える。
// mode=C だけを対象にすることで、ヒアリング実施前(A)・ヒアリング済(B)の契約は変えない。
export function shouldUseNoHearingPhaseOne({ mode, status } = {}) {
  return mode === 'C' && status === 'ack-skipped';
}

// ゲートモーダルの選択肢マトリクス（設計 §4-2）。
// choice.id: 'wallbounce' | 'paste' | 'summarize' | 'generate-questions' | 'keep-stale' | 'proceed'
// choice.ackOnProceed: true のとき選択で skip ack を記録して続行する。
export function getHearingGatePlan({ mode, status, staleStoreName } = {}) {
  const proceed = {
    id: 'proceed',
    label: 'このまま進む',
    desc: '構造化ヒアリング無しだと §1 以降の精度が下がります。同意のうえ全自動を開始します。',
    ackOnProceed: true,
    recommended: false,
  };

  // モードA: 質問30問の生成 or 同意（runFullAuto は使わない）。
  if (mode === 'A') {
    return {
      mode,
      status,
      title: 'モード A は質問設計まで',
      lede: 'モード A は聞くべきことを設計するモードです。ヒアリング実施後にモード B で要約を確定してから全自動を回してください。',
      choices: [
        {
          id: 'generate-questions',
          label: 'ヒアリング質問30問を生成だけする',
          desc: '質問設計プロンプトを1回だけ実行します。全自動ループには入りません。',
          recommended: true,
        },
        proceed,
      ],
    };
  }

  const wallbounce = {
    id: 'wallbounce',
    label: '壁打ちで埋める（推奨）',
    desc: 'AI と1問ずつヒアリングしてヒアリング要約を作るプロンプトをコピーします。',
    recommended: true,
  };
  const paste = {
    id: 'paste',
    label: '手持ち情報を貼り付けて要約する',
    desc: 'すでにある議事録・メモを貼り付けて要約・確定する画面へ移動します。',
    recommended: false,
  };
  const summarize = {
    id: 'summarize',
    label: '文字起こしを貼って要約・確定',
    desc: 'ヒアリングの録音文字起こしを貼り付けて要約し、確定する画面へ移動します。',
    recommended: true,
  };
  const keepStale = {
    id: 'keep-stale',
    label: status === 'meta-unknown'
      ? 'この要約のまま進む（整合を確認）'
      : `前の案件（${staleStoreName || '別案件'}）の要約を引き継ぐ`,
    desc: status === 'meta-unknown'
      ? '保存済みの要約をこの案件のものとして扱い、整合を確認します。'
      : '残っている要約を現在の案件のものとして扱い、整合を確認します。',
    recommended: false,
  };

  // 不整合 / 整合不明: 引き継ぐ or 破棄して新規（壁打ち/貼り付け）。
  if (status === 'stale-summary' || status === 'meta-unknown') {
    const lede = status === 'stale-summary'
      ? `前の案件（${staleStoreName || '別案件'}）のヒアリング要約が残っています。この案件の要約を作り直すか、引き継ぐかを選んでください。`
      : '保存済みのヒアリング要約が、どの案件のものか確認できません。引き継ぐか、作り直すかを選んでください。';
    return {
      mode,
      status,
      title: 'ヒアリング要約の確認',
      lede,
      choices: [
        mode === 'B' ? summarize : wallbounce,
        paste,
        keepStale,
        proceed,
      ],
    };
  }

  // 通常（要約なし）: モード別に壁打ち/要約 + 貼り付け + 同意。
  if (mode === 'B') {
    return {
      mode,
      status,
      title: 'ヒアリング要約を確定してください',
      lede: '全自動の品質は入口のヒアリングで決まります。要約を確定してから全自動を回すことを推奨します。',
      choices: [summarize, paste, proceed],
    };
  }

  // モード C（自社事業・デフォルト）
  const proceedWithoutHearing = {
    ...proceed,
    label: 'ヒアリングせず進む',
    desc: '質問項目は作らず、§0の調査結果と入力済み情報から現状整理・不足情報・検証計画を作ります。',
  };
  return {
    mode,
    status,
    title: '自社事業の進め方を選んでください',
    lede: '壁打ちで情報を整えるか、ヒアリングを省略して手元の情報と調査結果から進めるかを選べます。',
    choices: [wallbounce, paste, proceedWithoutHearing],
  };
}

// 壁打ちプロンプト（設計 §6-3）。
// ★業種★ / ★店舗名★ / ★現状メモ★ は呼び出し側が実値（formInputs）で渡す。
// 終了時の出力契約は sidepanel.js buildHearingSummaryPrompt の8セクション・タグ規則と一致させる。
//
// 製品別文言の間接化（後方互換）:
//   questionAreas / summaryHeading を渡すと「質問領域」行と要約フォーマット見出しを差し替える。
//   呼び出し側（automation.js）が supplementary id "mode-c-wallbounce" から解決して渡す。
//   未指定時は現行の Webマーケ版リテラルにフォールバックする（既存動線維持）。
//   ※ 出力フォーマット（8セクション）自体は buildHearingSummaryPrompt と共有の要約契約なので不変。
// 8セクション要約の出力契約（【出力フォーマット】〜末尾の「Q1 から始めてください」まで）。
// buildWallbounceHearingPrompt（汎用版）と buildGuidedInterviewPrompt（項目差し込み版）の
// 双方が共有する単一ソース。重複定義しないことで両プロンプトの契約が必ず一致する。
const HEARING_SUMMARY_OUTPUT_CONTRACT = [
  '【出力フォーマット】',
  '## 1. 案件概要',
  '- 業種・店舗名・サービス:',
  '- 誰の発言/資料か:',
  '- ヒアリング日や前提:',
  '',
  '## 2. 事業・サービスの一次情報',
  '- 提供価値:',
  '- 商品/サービス構成:',
  '- 収益構造:',
  '- 現在の強み:',
  '',
  '## 3. 顧客・市場・競合',
  '- 主な顧客:',
  '- 顧客の悩み/購買動機:',
  '- 商圏/市場変化:',
  '- 競合名/比較軸:',
  '',
  '## 4. マーケティング・営業実績',
  '| 項目 | ヒアリング内容 | タグ |',
  '|---|---|---|',
  '| 流入経路 |  | [事実-一次/申告/要確認] |',
  '| 過去施策 |  |  |',
  '| 投下予算 |  |  |',
  '| CPA/獲得件数/継続率 |  |  |',
  '',
  '## 5. 数字・制約・意思決定',
  '| 項目 | 内容 | タグ |',
  '|---|---|---|',
  '| 売上/単価/粗利 |  |  |',
  '| 月予算上限 |  |  |',
  '| 意思決定者 |  |  |',
  '| 導入期限 |  |  |',
  '| 実行体制 |  |  |',
  '',
  '## 6. 課題・機会・リスク',
  '- 課題:',
  '- 機会:',
  '- リスク:',
  '- 先方の意向:',
  '',
  '## 7. 未確認・矛盾・追加ヒアリング',
  '- 要確認:',
  '- 矛盾:',
  '- 次回聞くべき質問:',
  '',
  '## 8. 後続フェーズ用 businessContext',
  '上記を500〜900字で凝縮。§1以降のAIが最初に読む前提情報として、重要な一次情報、数字、制約、先方の意向をまとめる。',
  '',
  '【タグルール】',
  '- [事実-一次]: ヒアリング内で明確に語られた事実',
  '- [申告]: 数字や実績が先方申告のみで、裏取り前のもの',
  '- [仮説]: 受講者や先方の見立て',
  '- [要確認]: 不明、矛盾、根拠不足',
  '【ユーザー確認済み】の情報と【仮説・要確認】の情報をセクション内で明確に区別すること。',
  '',
  '【禁止】',
  '- 生データにない情報の追加',
  '- 外部Web調査',
  '- きれいな言葉での水増し',
  '- 6000字超過',
  '',
  'それでは Q1 から始めてください。',
].join('\n');

export function buildWallbounceHearingPrompt({ industry, storeName, memo, context, questionAreas, summaryHeading } = {}) {
  const ind = norm(industry) || '（未設定）';
  const store = norm(storeName) || '（未設定）';
  const memoText = norm(memo) || '（特になし）';
  const ctxText = norm(context);
  const areas = norm(questionAreas)
    || '①事業の基本 ②顧客 ③現状の数値（売上・客数・単価・リピート）④集客チャネル ⑤強み・弱み ⑥目標 ⑦予算・工数の制約';
  const heading = norm(summaryHeading)
    || 'STRATEGY-KIT のヒアリング要約フォーマット（8セクション）でまとめること。私の回答だけを根拠にし、外部知識で補完しないでください。';
  const known = [
    '# 既に分かっていること（再質問禁止）',
    `- 業種: ${ind} / 屋号: ${store}`,
    `- メモ: ${memoText}`,
  ];
  if (ctxText) {
    known.push(`- 追加コンテキスト: ${ctxText}`);
  }
  return [
    'あなたは中小事業者向けのマーケティングコンサルタントです。これから私（事業者本人）にヒアリングをして、最後に「ヒアリング要約」を作ってください。',
    '',
    ...known,
    '',
    '# ヒアリングのルール',
    '- この最初のメッセージへの返答では、挨拶1行と Q1 だけを出すこと',
    '- 以降も1回の発言につき「前回回答の確認1行＋次の質問1つ」だけ。通し番号と進捗（例: Q3/12）を付ける',
    '- 最初の5問は ○× か 3択で答えられる質問。その後は数値や単語で答えられる質問に進み、自由に話してもらう質問は最後の2〜3問だけ',
    '- 私が「わからない」と答えた数値は、一般的な相場の範囲を示して「近いですか？(はい/いいえ)」で確認してよい。ただし出典のない具体的な数値を断定せず、確認が取れなかった数値には必ず [仮説] を付けること',
    '- 1トピックの深掘りは最大2回まで',
    `- 質問領域: ${areas}`,
    '- 全部で12問前後。私が「要約して」と言ったら途中でも要約に進む',
    '',
    '# 終了時の出力（ヒアリング要約）',
    heading,
    '不明点・矛盾・追加確認が必要な点は、推測で埋めず「要確認」に分けてください。',
    '数字、固有名詞、予算、期限、意思決定者、過去施策の実測値は優先して残してください。',
    '',
    HEARING_SUMMARY_OUTPUT_CONTRACT,
  ].join('\n');
}

// §0 事前調査 + ヒアリング項目策定プロンプト（設計 v3）。
// Gemini を google_search ツール付きで単発呼び出しして、この案件固有の
// ヒアリング項目（12前後・カテゴリ/優先度付き）を策定させる。
// 入力: 業種 / 店舗名 / メモ / 追加コンテキスト（+ 任意で §0 プレリサーチ本文）。
// 出力は parseInterviewItems で番号付き項目を抽出する前提（番号付き列挙を強く指示）。
export function buildInterviewItemsPrompt({ industry, storeName, memo, context, preResearch, searchEnabled = true } = {}) {
  const ind = norm(industry) || '（未設定）';
  const store = norm(storeName) || '（未設定）';
  const memoText = norm(memo) || '（特になし）';
  const ctxText = norm(context);
  const research = norm(preResearch);
  const lines = [
    'あなたは中小事業者向けのマーケティングコンサルタントです。これから事業者にヒアリングを行うための「ヒアリング項目リスト」を、この案件に合わせて策定してください。',
    '',
    '# 対象事業',
    `- 業種: ${ind}`,
    `- 店舗・屋号: ${store}`,
    `- 現状メモ: ${memoText}`,
  ];
  if (ctxText) {
    lines.push(`- 追加コンテキスト: ${ctxText}`);
  }
  if (research) {
    lines.push('', '# §0 事前調査・既存資料（参考。重複する項目は避ける）', research);
  }
  // searchEnabled=true かつ context/メモに URL があれば url_context での読み取り指示を出す。
  // google_search は検索でありURL閲覧ではないため、URL の中身は url_context で読む必要がある。
  const hasUrl = searchEnabled && extractUrls(`${ctxText}\n${memoText}`).length > 0;

  lines.push(
    '',
    '# やること',
    // 検索ツールを渡さない再試行時は検索指示を残さない（ツール無しで検索を指示すると
    // モデルがツール呼び出しを試みて本文なし応答になることがあるため。実機 2026-06-06）。
    searchEnabled
      ? '1. まず google_search（Web 検索）で、この業種・地域の市場の実勢（顧客層・競合・価格帯・季節性・集客手段など）を軽く事前調査する。検索クエリには業種だけでなく、店舗・屋号や上記の追加コンテキスト（地域・立地・業態の特性）を含めて、この案件に固有の実勢を調べること。'
      : '1. あなたの知識の範囲で、この業種の市場の実勢（顧客層・競合・価格帯・季節性・集客手段など）を整理する。Web 検索やツールは使わず、テキストの回答だけを返すこと。',
  );
  if (hasUrl) {
    lines.push(
      '1b. 追加コンテキストやメモに記載された URL は、url_context ツールでページの内容を読み取り、この事業の実態（提供内容・価格帯・ターゲット・トーン）を把握して、必ずヒアリング項目へ反映すること。',
    );
  }
  lines.push(
    '2. その理解をふまえ、この事業のマーケティング戦略立案に必要な「ヒアリング項目」を策定する。',
    '',
    '# 出力ルール',
    '- 項目は12項目前後（10〜14）。多すぎても少なすぎてもいけない。',
    '- 各項目は1行で、「何を・なぜ聞くか」が分かる形にする（例: 「平日と土日の客数比（弱点時間帯の特定のため）」）。',
    '- 各項目の冒頭にカテゴリと優先度を付ける（例: 「[数字/高] 月商と客単価（収益規模の把握）」）。優先度は 高/中/低。',
    '- 必ず番号付き（1. 2. 3. …）で列挙する。前後の説明文は最小限にする。',
    '- この業種で特に効きそうな論点（季節性・商圏・リピート構造など案件固有の勘所）を必ず1つ以上含める。',
  );
  if (ctxText) {
    lines.push('- 追加コンテキストの内容を必ず項目に反映し、その立地・地域・業態に固有の論点を盛り込む。');
  }
  lines.push(
    '',
    '# 禁止',
    '- 出典のない数値の断定（相場や市場規模を「○○円」と言い切らない。傾向として述べるのは可）。',
    '- 12項目を大きく超える列挙。',
    '',
    'それでは、この案件のヒアリング項目を番号付きで列挙してください。',
  );
  return lines.join('\n');
}

// 抽出を成功扱いにする最低項目数。設計の「12項目前後」に対し、
// 異常に少ない（ノイズ・生成崩れ）リストはフォールバックへ回す（上限ガードは設けない）。
const MIN_INTERVIEW_ITEMS = 5;

// 生成結果から番号付きヒアリング項目を寛容に抽出する。
// 半角/全角数字、. ) 、 区切り、前後の空白・空行に対応。
// 抽出件数が MIN_INTERVIEW_ITEMS 未満なら null（呼び出し側はフォールバックする）。
export function parseInterviewItems(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return null;
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 行頭の番号（半角/全角）＋区切り（. ) 、 ．）を許容して本文を取り出す。
    const m = trimmed.match(/^[(（]?([0-9０-９]{1,2})[)）.．、]\s*(.+)$/);
    if (!m) continue;
    const body = m[2].trim();
    if (body) items.push(body);
  }
  return items.length >= MIN_INTERVIEW_ITEMS ? items : null;
}

// 項目策定の生成結果が「Web 事前調査（grounding）付き」だったかを正直に判定する（fix2）。
// 既存デプロイ済みの Apps Script proxy は tools（google_search）を無視するため、
// proxy 経由は grounding 無効＝false。direct 経路かつ groundingMetadata がレスポンスに
// 存在するときのみ true（grounded 成功時に Gemini が返すメタ）。
export function wasPreResearchGrounded(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.mode === 'proxy') return false;
  const candidates = result.raw && result.raw.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return false;
  return candidates.some((c) => c && (c.groundingMetadata || c.grounding_metadata));
}

// 項目確認画面の見出し文言（grounded 有無で正直に出し分ける）。
export function interviewItemsHeading(grounded) {
  return grounded
    ? 'この案件のヒアリング項目（Webで事前調査して策定）'
    : 'この案件のヒアリング項目（Web検索なしで策定）';
}

// v3.3: 抽出する URL の最大数（url_context ツールに渡しすぎない・UI 表示も簡潔に保つ）。
const MAX_EXTRACTED_URLS = 5;

// テキストから http(s) URL を抽出する（重複除去・最大 MAX_EXTRACTED_URLS 件）。
// 文末によく付く句読点・閉じ括弧は URL に含めない。
export function extractUrls(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return [];
  const matches = raw.match(/https?:\/\/[^\s<>"'）)」』、。,]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    // 末尾の句読点・閉じ括弧の取りこぼしを除去（正規表現の除外で大半は防げるが保険）。
    const url = m.replace(/[）)」』、。,.]+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_EXTRACTED_URLS) break;
  }
  return out;
}

function firstCandidate(result) {
  const candidates = result && result.raw && result.raw.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return candidates[0] || null;
}

// grounding（google_search）が実際に投げた検索クエリ配列を取り出す（camel/snake 両対応）。
// 無ければ []。
export function extractSearchQueries(result) {
  const cand = firstCandidate(result);
  if (!cand) return [];
  const meta = cand.groundingMetadata || cand.grounding_metadata;
  if (!meta) return [];
  const queries = meta.webSearchQueries || meta.web_search_queries;
  if (!Array.isArray(queries)) return [];
  return queries.map((q) => String(q == null ? '' : q)).filter((q) => q);
}

// url_context が読み取った URL と取得成否を {url, ok}[] で取り出す（camel/snake 両対応）。
// ok は urlRetrievalStatus が *SUCCESS のとき true。無ければ []。
export function extractUrlContextStatuses(result) {
  const cand = firstCandidate(result);
  if (!cand) return [];
  const meta = cand.urlContextMetadata || cand.url_context_metadata;
  if (!meta) return [];
  const list = meta.urlMetadata || meta.url_metadata;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const url = String((entry && (entry.retrievedUrl || entry.retrieved_url)) || '');
    const status = String((entry && (entry.urlRetrievalStatus || entry.url_retrieval_status)) || '');
    return { url, ok: /SUCCESS/i.test(status) };
  }).filter((e) => e.url);
}

// v3.5: ヒアリング要約 本体の保存先（chrome.storage.local）。
// 真因: chrome.storage.sync は QUOTA_BYTES_PER_ITEM=8192。日本語要約（最大18KB / 現実3000〜4500字≒9〜14KB）は
// sync.set が必ず reject していた（モードB/C 共通の潜在バグ）。本体を local（10MB級）へ移し、
// メタ（小さい）だけ sync に残す。生データ sk_hearing_rawtext_v012_local と同じ流儀。
export const HEARING_SUMMARY_LOCAL_KEY = 'sk_hearing_summary_v013_local';
// 後方互換マイグレーション元: 旧 sync 本体キー（移行成功後に sync から削除する）。
export const HEARING_SUMMARY_LEGACY_SYNC_KEY = 'sk_hearing_summary_v012';

// 要約確定時の保存プランを返す（純関数）。本体は local、メタ+lastPhase は sync。
// 呼び出し側は plan.local を chrome.storage.local.set、plan.sync を chrome.storage.sync.set に渡す。
// 本体は sync 側に絶対入れない（8KB/item クォータ事故の再発防止）。
export function buildHearingPersistPlan({ value, meta } = {}) {
  const body = String(value == null ? '' : value);
  return {
    local: { [HEARING_SUMMARY_LOCAL_KEY]: body },
    sync: { [HEARING_META_KEY]: meta, lastPhase: 'phase-1' },
  };
}

// 起動時ロードの本体ハイドレーション方針を返す（純関数）。
// local に値があれば local を正とする。local 空で旧 sync 値があれば移行する（migrate=true）。
// 移行する場合のみ removeLegacy=true（旧 sync キーを削除して sync 全体クォータ100KBを解放）。
export function planHearingSummaryMigration({ localValue, legacySyncValue } = {}) {
  const local = String(localValue == null ? '' : localValue).trim();
  const legacy = String(legacySyncValue == null ? '' : legacySyncValue).trim();
  if (local) {
    return { value: local, migrate: false, removeLegacy: false };
  }
  if (legacy) {
    return { value: legacy, migrate: true, removeLegacy: true };
  }
  return { value: '', migrate: false, removeLegacy: false };
}

// v3.6+: 全自動 fresh run の §0 シード判定（純ロジック）。
//   実機: 整合する確定要約があるのに全自動が §0（プレリサーチ）から AI 生成され二度手間。
//   仕様: mode === 'B'（クライアントワーク）かつ readiness.status === 'ready' のときだけ §0 シード：
//     - §0 が未充足なら確定要約を §0 章としてマスターへ直書きシード（seedPhase0=true）
//     - §0 が既に done なら書き込みスキップ（seedPhase0=false・上書きしない）
//     - いずれも生成ループは §1 から（startIndex=1）。§0 相当はヒアリング/項目策定で済んでいる。
//   mode !== 'B'（モードC=自社事業・モードA・省略）は ready でも §0 シードしない。
//     - モードC: §0（市場調査=phase-0-prelimit）を AI に実行させ壁打ち要約を §0 に反映する。
//     - モードA: §0 をヒアリング設計差し替えで実行する（既存仕様不変）。
//   ready でない（needs-hearing / ack-skipped / stale-summary / meta-unknown 等）は
//   従来どおり §0 から生成（seedPhase0=false・startIndex=0）。
//   呼び出し側はこの判定の対象を「全自動 fresh run」に限定する（resume/retry は触らない）。
export function planFullAutoFreshRunStart({ status, phase0Filled, mode } = {}) {
  if (mode === 'B' && status === 'ready') {
    return { seedPhase0: !phase0Filled, startIndex: 1 };
  }
  return { seedPhase0: false, startIndex: 0 };
}

// 項目差し込み済みの壁打ちプロンプト（設計 v3）。
// 汎用版 buildWallbounceHearingPrompt の固定「質問領域」行を、案件固有の
// 「# この案件のヒアリング項目（この順に埋める）」セクションに置き換える。
// 1問ずつ・最初は Q1 のみ・○×/3択から徐々に・[仮説]タグ・8セクション要約契約・
// 6000字以内 は汎用版と同一（出力契約は HEARING_SUMMARY_OUTPUT_CONTRACT を共有）。
export function buildGuidedInterviewPrompt({ industry, storeName, memo, context, summaryHeading } = {}, items) {
  const ind = norm(industry) || '（未設定）';
  const store = norm(storeName) || '（未設定）';
  const memoText = norm(memo) || '（特になし）';
  const ctxText = norm(context);
  const heading = norm(summaryHeading)
    || 'STRATEGY-KIT のヒアリング要約フォーマット（8セクション）でまとめること。私の回答だけを根拠にし、外部知識で補完しないでください。';
  const list = Array.isArray(items) ? items.filter((it) => norm(it)) : [];
  const itemLines = list.length
    ? list.map((it, i) => `${i + 1}. ${norm(it)}`)
    : ['（事前策定された項目はありません。一般的なマーケ戦略立案に必要な順で進めてください）'];
  const known = [
    '# 既に分かっていること（再質問禁止）',
    `- 業種: ${ind} / 屋号: ${store}`,
    `- メモ: ${memoText}`,
  ];
  if (ctxText) {
    known.push(`- 追加コンテキスト: ${ctxText}`);
  }
  return [
    'あなたは中小事業者向けのマーケティングコンサルタントです。これから私（事業者本人）にヒアリングをして、最後に「ヒアリング要約」を作ってください。',
    '',
    ...known,
    '',
    '# この案件のヒアリング項目（この順に埋める）',
    '※ 事前調査をもとに策定済みの項目です。原則この順に1問ずつ確認していってください。',
    ...itemLines,
    '',
    '# ヒアリングのルール',
    '- この最初のメッセージへの返答では、挨拶1行と Q1 だけを出すこと',
    '- 以降も1回の発言につき「前回回答の確認1行＋次の質問1つ」だけ。通し番号と進捗（例: Q3/12）を付ける',
    '- 最初の5問は ○× か 3択で答えられる質問。その後は数値や単語で答えられる質問に進み、自由に話してもらう質問は最後の2〜3問だけ',
    '- 私が「わからない」と答えた数値は、一般的な相場の範囲を示して「近いですか？(はい/いいえ)」で確認してよい。ただし出典のない具体的な数値を断定せず、確認が取れなかった数値には必ず [仮説] を付けること',
    '- 1トピックの深掘りは最大2回まで',
    '- 上の項目を上から順に埋める。私が「要約して」と言ったら途中でも要約に進む',
    '',
    '# 終了時の出力（ヒアリング要約）',
    heading,
    '不明点・矛盾・追加確認が必要な点は、推測で埋めず「要確認」に分けてください。',
    '数字、固有名詞、予算、期限、意思決定者、過去施策の実測値は優先して残してください。',
    '',
    HEARING_SUMMARY_OUTPUT_CONTRACT,
  ].join('\n');
}
