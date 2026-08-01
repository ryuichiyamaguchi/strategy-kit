// STRATEGY-KIT — リサーチサイクルの前段出力連携（純ロジック）
//
// prompts.json の ★research-...★ は、事業情報の穴埋めではなく「直前の
// AI回答をここへ入れる」という工程間の受け渡し。通常の★検査へ渡す前に、
// このモジュールで回答本文または分かりやすい未入力表示へ解決する。

export const RESEARCH_STEP_IDS = Object.freeze([
  'primary',
  'secondary',
  'factcheck',
  'integrate',
]);

const STEP_LABELS = Object.freeze({
  primary: '1次リサーチ',
  secondary: '2次リサーチ',
  factcheck: 'ファクトチェック',
  integrate: '統合',
});

const REQUIRED_OUTPUTS = Object.freeze({
  primary: [],
  secondary: ['primary'],
  factcheck: ['primary', 'secondary'],
  integrate: ['primary', 'secondary'],
});

function normalize(value) {
  return String(value == null ? '' : value).trim();
}

export function researchStepLabel(stepId) {
  return STEP_LABELS[normalize(stepId)] || normalize(stepId) || '前段';
}

export function requiredResearchOutputs(stepId) {
  return [...(REQUIRED_OUTPUTS[normalize(stepId)] || [])];
}

export function missingResearchOutputs(stepId, outputs = {}) {
  return requiredResearchOutputs(stepId).filter((id) => !normalize(outputs[id]));
}

export function researchCycleScopeKey({ projectId = '', caseId = '', researchNo = '' } = {}) {
  const project = normalize(projectId) || normalize(caseId) || 'default';
  const no = normalize(researchNo) || 'NN';
  return `${project}::${no}`;
}

export function normalizeResearchOutputs(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    RESEARCH_STEP_IDS.map((id) => [id, String(source[id] == null ? '' : source[id])]),
  );
}

export function extractResearchHandoffText(value) {
  const full = normalize(value);
  if (!full) return '';
  const lines = full.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^\s*#{1,6}\s+.*要点版/.test(line));
  if (headingIndex < 0) return full;
  const body = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^\s*#{1,6}\s+/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return normalize(body.join('\n')) || full;
}

function outputPattern(stepId) {
  // Webマーケ版: research-01-primary.md
  // SNS版:       research-sns-01-primary.md
  // NN は applyTemplate 前、数字は適用後のどちらにも対応する。
  return new RegExp(
    `★research(?:-sns)?-(?:NN|[A-Za-z0-9_-]+)-${stepId}\\.md[^★\\n]*★`,
    'gi',
  );
}

/**
 * 前段のAI回答を prompt 内の研究ファイル用★へ入れる。
 * required の不足判定は missingResearchOutputs() で先に止める。ここではUI上に
 * 生の★を残さず「何を貼ればよいか」を読めるようにしている。
 */
export function resolveResearchPrompt({
  text = '',
  stepId = '',
  outputs = {},
  wrapOutput = (label, body) => `【${label}】\n${body}`,
} = {}) {
  const normalizedOutputs = normalizeResearchOutputs(outputs);
  let result = String(text == null ? '' : text);

  for (const id of ['primary', 'secondary', 'factcheck']) {
    const value = normalize(normalizedOutputs[id]);
    let replacement;
    if (value) {
      const handoff = id === 'primary' || id === 'secondary'
        ? extractResearchHandoffText(value)
        : value;
      const suffix = handoff !== value ? '要点版' : 'AI回答';
      replacement = wrapOutput(`${researchStepLabel(id)}の${suffix}`, handoff);
    } else if (id === 'factcheck' && normalize(stepId) === 'integrate') {
      replacement = '（ファクトチェックは実施していないため省略）';
    } else {
      replacement = `【未入力：${researchStepLabel(id)}のAI回答を前のカードへ貼り付けてください】`;
    }
    result = result.replace(outputPattern(id), replacement);
  }

  // 1次プロンプト中の「後続フェーズの『★貼付★』」は説明用の記号であり、
  // 未入力値ではない。通常の★バリデータに誤検知させない。
  return result.replaceAll('★貼付★', '前段出力の貼り付け欄');
}
