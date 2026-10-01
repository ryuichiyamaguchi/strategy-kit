// STRATEGY-KIT — 広告表現の注意喚起（決定的なルール照合）と「数字の出どころ」一覧
//
// どちらも AI を使わずに本文を走査する。結果は「注意喚起」であって法的判断ではない。
// 画面・書き出しには必ずその旨を添える（AD_CHECK_DISCLAIMER）。

export const AD_CHECK_DISCLAIMER =
  'この結果は、よく問題になる言い回しを機械的に拾った注意喚起です。法的な判断ではありません。広告として出す前に、業界団体のガイドラインや専門家の確認を受けてください。';

// law: 根拠となる法令・規程の通称 / categories: どの業種で強く効くか（'all' は全業種）
export const AD_RULES = Object.freeze([
  // 景品表示法（優良誤認・有利誤認）— 全業種
  { id: 'superlative', pattern: /(No\.?\s?1|ナンバーワン|日本一|世界一|業界一|地域一番|最高級?|最上|最強|一番人気)/gi, law: '景品表示法（優良誤認）', categories: ['all'], why: '「No.1」「日本一」などは、調査の出典・期間・対象を併記できないと優良誤認とされやすい表現です。', fix: '客観的な調査があるなら「◯◯調べ（調査期間・対象）」を同じ場所に明記する。無ければ具体的な事実（創業年数・施術件数など）に言い換える。' },
  { id: 'first', pattern: /(業界初|日本初|世界初|唯一|オンリーワン)/g, law: '景品表示法（優良誤認）', categories: ['all'], why: '「初」「唯一」は事実の裏付けが無いと優良誤認になりやすい表現です。', fix: '裏付けの範囲（地域・時期・調査方法）を書くか、別の具体的な特徴に言い換える。' },
  { id: 'absolute', pattern: /(絶対|必ず|100\s?%|１００％|完全|確実に|間違いなく|誰でも)/g, law: '景品表示法（優良誤認）', categories: ['all'], why: '効果や結果を言い切る表現は、実際と違えば優良誤認になります。', fix: '「◯割のお客様が〜（自社調べ・期間・人数）」のように根拠付きで示すか、言い切りを外す。' },
  { id: 'limited', pattern: /(今だけ|本日限り|期間限定|残りわずか|先着\d*名?)/g, law: '景品表示法（有利誤認）', categories: ['all'], why: '実際には期限や数量の制限が無い場合、有利誤認になります。', fix: '実際の期限・数量を明記し、その条件を守る。' },
  { id: 'double-price', pattern: /(通常価格|定価|当店通常|半額|\d+\s?%\s?(OFF|オフ)|割引)/gi, law: '景品表示法（二重価格表示）', categories: ['all'], why: '比較する元の価格に販売実績が無いと、不当な二重価格表示になります。', fix: '比較対象の価格で実際に販売していた期間を確認し、必要なら期間を併記する。' },
  { id: 'stealth', pattern: /(口コミ.{0,10}(投稿|書いて).{0,10}(割引|特典|プレゼント)|レビュー.{0,10}(特典|プレゼント|割引)|インフルエンサー.{0,10}(依頼|起用))/g, law: '景品表示法（ステルスマーケティング規制）', categories: ['all'], why: '特典と引き換えの口コミや依頼した投稿は「広告」です。広告であることが分からない形だと違反になります。', fix: '投稿に「PR」「広告」など広告であることが分かる表示を入れてもらう運用を決める。' },
  // 薬機法（化粧品・健康食品・美容）
  { id: 'cure', pattern: /(治る|治す|治療|完治|改善する|回復する|効く|効果がある|予防)/g, law: '医薬品医療機器等法（薬機法）', categories: ['cosmetics', 'healthfood', 'treatment'], why: '医薬品ではない商品・サービスで病気の治療・予防をうたうことはできません。', fix: '体の状態の変化を断定せず、「リラックスできる時間を」など体験・雰囲気の表現に言い換える。' },
  { id: 'body-change', pattern: /(痩せる|やせる|脂肪(燃焼|を落とす)|デトックス|シミが消える|シワが消える|若返る|アンチエイジング|美白になる|育毛|発毛)/g, law: '医薬品医療機器等法（薬機法）', categories: ['cosmetics', 'healthfood', 'treatment'], why: '化粧品・健康食品で認められた効能の範囲を超える表現です。', fix: '認められた効能の範囲（例: 化粧品の56効能）で言い換える。' },
  { id: 'safety', pattern: /(副作用(が|は)?ない|安全性が高い|安心安全|無添加だから安全)/g, law: '医薬品医療機器等法（薬機法）／景品表示法', categories: ['cosmetics', 'healthfood', 'medical'], why: '安全性を保証する表現は禁止または強い根拠が必要です。', fix: '成分・製法などの事実だけを書く。' },
  // 医療広告ガイドライン（医療・歯科・クリニック）
  { id: 'testimonial', pattern: /(体験談|患者様の声|お客様の声|口コミ)/g, law: '医療広告ガイドライン', categories: ['medical'], why: '医療機関の広告では、治療の内容・効果に関する患者の体験談は掲載できません。', fix: '体験談を広告（Web サイト含む）に載せない。院内の雰囲気・設備など事実の紹介にする。' },
  { id: 'before-after', pattern: /(ビフォー.?アフター|before.?after|施術前後)/gi, law: '医療広告ガイドライン', categories: ['medical', 'cosmetics'], why: '術前術後の写真は、治療内容・費用・リスク・副作用の説明を併記しないと掲載できません。', fix: '掲載するなら、治療内容・標準的な費用・期間・主なリスクと副作用を同じ場所に詳しく書く。' },
  { id: 'medical-superior', pattern: /(名医|最先端|最新の治療|痛くない|無痛|安心の治療)/g, law: '医療広告ガイドライン（比較優良・誇大広告）', categories: ['medical'], why: '他院より優れていると受け取れる表現や誇大な表現は禁止されています。', fix: '提供している治療・設備を客観的な事実として書く。' },
  // あはき法・柔整法（整骨院・整体・マッサージ）
  { id: 'treatment-scope', pattern: /(保険(が)?使える|保険適用|肩こり|腰痛|頭痛|骨盤矯正|姿勢改善)/g, law: 'あはき法・柔道整復師法の広告制限', categories: ['treatment'], why: '施術所の広告は掲載できる事項が法律で限定されています（症状名・保険適用の書き方など）。', fix: '掲載できる事項（名称・施術日時・所在地等）を確認し、症状名や保険の扱いは所管の指導に合わせる。' },
  // 不動産
  { id: 'realestate', pattern: /(駅近|格安|掘り出し物|お買い得|最高の立地|完全(リフォーム|リノベ))/g, law: '不動産の表示に関する公正競争規約', categories: ['realestate'], why: '不動産広告では、根拠の無い強調表現や特定用語の使用が制限されています。', fix: '駅からの徒歩分数（80m=1分換算）など、規約が定める具体的な表示に置き換える。' },
  // 金融
  { id: 'finance', pattern: /(元本保証|必ず儲かる|確実に増える|リスクなし|ノーリスク|高利回り)/g, law: '金融商品取引法・保険業法', categories: ['finance'], why: '利益の断定やリスクの否定は禁止されています。', fix: 'リスクと手数料を同じ場所に、同じ大きさで説明する。' },
]);

// 業種名から規制カテゴリを推定する（受講者が選んだ規制カテゴリがあればそちらを優先）。
export function inferRegulatedCategory(industryLabel = '') {
  const text = String(industryLabel || '');
  if (/(歯科|クリニック|医院|病院|美容外科|皮膚科|医療)/.test(text)) return 'medical';
  if (/(整骨|接骨|整体|鍼灸|マッサージ|カイロ)/.test(text)) return 'treatment';
  if (/(サプリ|健康食品|栄養)/.test(text)) return 'healthfood';
  if (/(化粧品|コスメ|エステ|美容|ネイル|脱毛)/.test(text)) return 'cosmetics';
  if (/(不動産|住宅販売|賃貸)/.test(text)) return 'realestate';
  if (/(保険|証券|投資|金融)/.test(text)) return 'finance';
  if (/(税理士|弁護士|司法書士|行政書士|社労士|社会保険労務士|士業)/.test(text)) return 'professional';
  return 'none';
}

function snippetAround(text, index, length, radius = 24) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

// sections: [{ label: '§5', text }]。category は REGULATED_CATEGORIES のキー。
export function scanAdExpressions(sections = [], { category = 'none' } = {}) {
  const findings = [];
  for (const section of sections) {
    const text = String(section?.text || '');
    if (!text) continue;
    for (const rule of AD_RULES) {
      const applies = rule.categories.includes('all') || rule.categories.includes(category);
      if (!applies) continue;
      rule.pattern.lastIndex = 0;
      const seen = new Set();
      let m;
      while ((m = rule.pattern.exec(text)) !== null) {
        const phrase = m[0];
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        findings.push({
          ruleId: rule.id,
          section: section.label || '',
          phrase,
          context: snippetAround(text, m.index, phrase.length),
          law: rule.law,
          why: rule.why,
          fix: rule.fix,
          severity: rule.categories.includes('all') ? 'caution' : 'high',
        });
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 数字の出どころ一覧（根拠表）
// ---------------------------------------------------------------------------

const TAG_RE = /\[(事実-一次|事実-複数|事実|仮説|要確認|却下)\]/;
const NUMBER_RE = /(?:約|およそ)?[0-9０-９][0-9０-９,，.．]*(?:\s?[-〜~–]\s?[0-9０-９][0-9０-９,，.．]*)?\s?(?:万|億|千)?\s?(?:円|人|件|回|%|％|倍|ヶ月|か月|カ月|日|時間|店|社|名|歳|分|個|本|台|km|㎡|坪)/;
const URL_RE = /https?:\/\/[^\s)）」』>]+/g;
const SECTION_REF_RE = /§\s?\d+(?:-\d+)?/g;

export const EVIDENCE_TAG_LABELS = Object.freeze({
  '事実-一次': '一次情報で確認済み',
  '事実-複数': '複数の情報源で確認済み',
  事実: '事実（出典つき）',
  仮説: '仮説（裏付け待ち）',
  要確認: '要確認',
  却下: '却下',
  なし: 'タグなし（確かさ未記入）',
});

// 1行に「数字」があるものを拾い、同じ行のタグ・URL・§参照を出どころとして並べる。
export function scanEvidence(sections = []) {
  const rows = [];
  for (const section of sections) {
    const lines = String(section?.text || '').split(/\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || !NUMBER_RE.test(line)) continue;
      if (/^\[\[SK-/.test(line) || /^\[最終更新/.test(line)) continue;
      const tagMatch = line.match(TAG_RE);
      const urls = line.match(URL_RE) || [];
      const refs = (line.match(SECTION_REF_RE) || []).filter((r) => r.replace(/\s/g, '') !== String(section.label || '').replace(/\s/g, ''));
      const tag = tagMatch ? tagMatch[1] : 'なし';
      rows.push({
        section: section.label || '',
        statement: line.length > 160 ? line.slice(0, 160) + '…' : line,
        tag,
        tagLabel: EVIDENCE_TAG_LABELS[tag] || tag,
        sources: [...new Set([...urls, ...refs])],
      });
    }
  }
  return rows;
}

export function summarizeEvidence(rows = []) {
  const counts = {};
  for (const r of rows) counts[r.tag] = (counts[r.tag] || 0) + 1;
  const weak = rows.filter((r) => r.tag === 'なし' || r.tag === '仮説' || r.tag === '要確認').length;
  const noSource = rows.filter((r) => !r.sources.length).length;
  return { total: rows.length, counts, weak, noSource };
}

export function evidenceToMarkdown(rows = [], { title = '数字の出どころ一覧' } = {}) {
  const s = summarizeEvidence(rows);
  const lines = [
    `# ${title}`,
    '',
    `数字を含む記述 ${s.total} 件のうち、裏付け待ち・確かさ未記入が ${s.weak} 件、出典の記載が無いものが ${s.noSource} 件です。上司や取引先に説明する前に、この2つを優先して確認してください。`,
    '',
    '| 章 | 記述 | 確かさ | 出どころ |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    const src = r.sources.length ? r.sources.join(' ') : '（記載なし）';
    lines.push(`| ${r.section} | ${r.statement.replace(/\|/g, '｜')} | ${r.tagLabel} | ${src.replace(/\|/g, '｜')} |`);
  }
  return lines.join('\n');
}

export function adFindingsToMarkdown(findings = [], { title = '広告表現チェック' } = {}) {
  const lines = [`# ${title}`, '', `> ${AD_CHECK_DISCLAIMER}`, ''];
  if (!findings.length) {
    lines.push('よく問題になる言い回しは見つかりませんでした（見つからないことは、問題が無いことの保証ではありません）。');
    return lines.join('\n');
  }
  lines.push('| 章 | 表現 | 前後の文 | 関係する決まり | 理由 | 直し方の例 |', '|---|---|---|---|---|---|');
  for (const f of findings) {
    const cells = [f.section, f.phrase, f.context, f.law, f.why, f.fix].map((c) => String(c).replace(/\|/g, '｜'));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}
