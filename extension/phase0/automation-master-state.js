import { buildSectionState } from './section-state.js';
import { isFinanceGatePhase } from './finance-gate.js';

export function buildMasterSectionDefs(phases = []) {
  const defs = [];
  for (const phase of phases || []) {
    const phaseNo = Number.parseInt(String(phase?.no), 10);
    if (!Number.isFinite(phaseNo) || phaseNo === 99) continue;
    const prompts = Array.isArray(phase?.prompts) ? phase.prompts : [];

    if (shouldSplitPhaseForMasterState(phase)) {
      prompts.forEach((prompt, index) => {
        defs.push({
          key: `${phaseNo}-${index + 1}`,
          no: phaseNo,
          title: String(prompt?.label || phase?.title || '').trim(),
        });
      });
      continue;
    }

    defs.push({
      key: String(phaseNo),
      no: phaseNo,
      title: String(phase?.title || '').trim(),
    });
  }
  return defs;
}

export function buildMasterAutomationState(doc, phases = []) {
  const sectionDefs = buildMasterSectionDefs(phases);
  const sectionState = buildSectionState(doc, sectionDefs);
  const progress = buildProgressFromSections(sectionState.sections);
  const failedSections = buildFailedSections(sectionState.sections);
  const resumeContext = buildResumeContext(sectionState.nextSection);

  return {
    sectionDefs,
    sectionState,
    progress,
    failedSections,
    resumeContext,
  };
}

// マスター側の節の数え方は、全自動モードの分割実行（automation.js の
// shouldSplitPhaseForFinanceGate）と必ず一致させる。ここがズレると、生成側は §7-1…§7-5 を
// 書くのにマスター側は §7 を1つ期待する、という食い違いになり、進捗率・再開位置・失敗検出が壊れる。
// 対象プロンプトIDの一覧は finance-gate.js を単一の真実源にする（IDを各所へ直書きしない）。
function shouldSplitPhaseForMasterState(phase) {
  return isFinanceGatePhase(phase);
}

function buildProgressFromSections(sections = []) {
  const filledSections = [];
  const subFilledSections = {};
  let maxFilledSection = -1;

  for (const section of sections) {
    if (section?.status !== 'done') continue;
    const key = String(section?.['key'] || '');
    const parsed = parseSectionKey(key);
    if (!Number.isFinite(parsed.phaseNo)) continue;
    maxFilledSection = Math.max(maxFilledSection, parsed.phaseNo);
    if (parsed.subNo) {
      const parentKey = String(parsed.phaseNo);
      if (!subFilledSections[parentKey]) subFilledSections[parentKey] = [];
      subFilledSections[parentKey].push(parsed.subNo);
      continue;
    }
    filledSections.push(parsed.phaseNo);
  }

  for (const key of Object.keys(subFilledSections)) {
    subFilledSections[key].sort((a, b) => a - b);
  }

  return {
    filledSections: uniqueSortedNumbers(filledSections),
    subFilledSections,
    maxFilledSection,
  };
}

function buildFailedSections(sections = []) {
  return sections
    .filter((section) => section?.status === 'failed')
    .map((section) => ({
      no: String(section?.['key'] || ''),
      title: String(section?.title || '').trim() || `§${section?.['key'] || ''}`,
      reason: String(section?.code || '').trim() || '生成エラー',
    }));
}

function buildResumeContext(nextSection) {
  if (!nextSection) return null;
  const parsed = parseSectionKey(nextSection['key']);
  if (!Number.isFinite(parsed.phaseNo)) return null;
  return {
    source: 'master',
    rawIndex: parsed.rawIndex,
    startIndex: parsed.phaseNo,
    startSubNo: parsed.subNo,
    accumulated: null,
  };
}

function parseSectionKey(value) {
  const rawIndex = String(value || '').trim();
  const match = rawIndex.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return { rawIndex, phaseNo: NaN, subNo: null };
  return {
    rawIndex,
    phaseNo: Number.parseInt(match[1], 10),
    subNo: match[2] ? Number.parseInt(match[2], 10) : null,
  };
}

function uniqueSortedNumbers(values) {
  return Array.from(new Set(values))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}
