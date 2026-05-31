export function parseAutomationIndex(idxLike) {
  if (idxLike === null || idxLike === undefined) return { phaseNo: 0, subNo: null, rawIndex: '0' };
  const rawIndex = String(idxLike).trim() || '0';
  const subMatch = rawIndex.match(/^(\d+)-(\d+)$/);
  if (subMatch) {
    return {
      phaseNo: Number.parseInt(subMatch[1], 10),
      subNo: Number.parseInt(subMatch[2], 10),
      rawIndex,
    };
  }
  const phaseNo = Number.parseInt(rawIndex, 10);
  return {
    phaseNo: Number.isFinite(phaseNo) ? phaseNo : 0,
    subNo: null,
    rawIndex,
  };
}

export function formatSectionLabel(idxLike) {
  const parsed = parseAutomationIndex(idxLike);
  return parsed.subNo ? `§${parsed.phaseNo}-${parsed.subNo}` : `§${parsed.phaseNo}`;
}

function normalizePhaseNo(value) {
  const no = Number.parseInt(String(value), 10);
  return Number.isFinite(no) ? no : null;
}

function countPhasePrompts(phase) {
  return Array.isArray(phase?.prompts) && phase.prompts.length ? phase.prompts.length : 0;
}

export function computeNextDraftResumeIndex({ progress, phases = [] } = {}) {
  const filledSet = new Set((progress?.filledSections || []).map(String));
  const subFilled = progress?.subFilledSections || {};

  for (const phase of phases) {
    const phaseNo = normalizePhaseNo(phase?.no);
    if (phaseNo === null || phaseNo === 99) continue;
    const totalSubs = countPhasePrompts(phase);
    const filledSubs = Array.isArray(subFilled[String(phaseNo)]) ? subFilled[String(phaseNo)] : [];

    if (totalSubs >= 2) {
      if (filledSubs.length >= totalSubs) continue;
      if (filledSubs.length === 0 && filledSet.has(String(phaseNo))) continue;
      const filledSubSet = new Set(filledSubs.map((value) => Number.parseInt(String(value), 10)));
      let nextSub = 1;
      while (nextSub <= totalSubs && filledSubSet.has(nextSub)) nextSub += 1;
      return { rawIndex: `${phaseNo}-${nextSub}`, label: `§${phaseNo}-${nextSub}`, complete: false };
    }

    if (filledSet.has(String(phaseNo))) continue;
    return { rawIndex: String(phaseNo), label: `§${phaseNo}`, complete: false };
  }

  return { rawIndex: '', label: '全章完了済み', complete: true };
}

function buildAutomationUnits(phases = []) {
  const units = [];
  const byPhase = new Map();
  const byKey = new Map();

  for (const phase of phases) {
    const phaseNo = normalizePhaseNo(phase?.no);
    if (phaseNo === null || phaseNo === 99) continue;
    const totalSubs = countPhasePrompts(phase);
    const phaseUnits = [];

    if (totalSubs >= 2) {
      for (let subNo = 1; subNo <= totalSubs; subNo += 1) {
        phaseUnits.push({ rawIndex: `${phaseNo}-${subNo}`, phaseNo, subNo });
      }
    } else {
      phaseUnits.push({ rawIndex: String(phaseNo), phaseNo, subNo: null });
    }

    byPhase.set(String(phaseNo), phaseUnits);
    for (const unit of phaseUnits) {
      byKey.set(unit.rawIndex, unit);
      units.push(unit);
    }
  }

  return { units, byPhase, byKey };
}

function findUnitPosition(units, rawIndex) {
  return units.findIndex((unit) => unit.rawIndex === rawIndex);
}

function collectCompletedUnitPositions({ progress, units, byPhase }) {
  const positions = [];
  const filledSet = new Set((progress?.filledSections || []).map(String));
  const subFilled = progress?.subFilledSections || {};

  for (const [phaseKey, phaseUnits] of byPhase.entries()) {
    const filledSubs = Array.isArray(subFilled[phaseKey]) ? subFilled[phaseKey] : [];
    if (filledSubs.length > 0) {
      const filledSubSet = new Set(filledSubs.map((value) => Number.parseInt(String(value), 10)));
      for (const unit of phaseUnits) {
        if (unit.subNo && filledSubSet.has(unit.subNo)) {
          positions.push(findUnitPosition(units, unit.rawIndex));
        }
      }
      continue;
    }

    if (!filledSet.has(phaseKey)) continue;
    for (const unit of phaseUnits) {
      positions.push(findUnitPosition(units, unit.rawIndex));
    }
  }

  return positions.filter((position) => position >= 0);
}

function collectFailedUnitPositions({ failedSections, units, byPhase, byKey }) {
  const positions = [];
  for (const failure of failedSections || []) {
    const parsed = parseAutomationIndex(failure?.no);
    const key = parsed.rawIndex;
    if (parsed.subNo && byKey.has(key)) {
      positions.push(findUnitPosition(units, key));
      continue;
    }

    const phaseUnits = byPhase.get(String(parsed.phaseNo));
    if (phaseUnits && phaseUnits.length) {
      const lastUnit = phaseUnits[phaseUnits.length - 1];
      positions.push(findUnitPosition(units, lastUnit.rawIndex));
    }
  }
  return positions.filter((position) => position >= 0);
}

export function computeNextDraftForwardIndex({ progress, phases = [], failedSections = [] } = {}) {
  const { units, byPhase, byKey } = buildAutomationUnits(phases);
  if (!units.length) return { rawIndex: '', label: '全章完了済み', complete: true };

  const completedPositions = collectCompletedUnitPositions({ progress, units, byPhase });
  const failedPositions = collectFailedUnitPositions({ failedSections, units, byPhase, byKey });
  const highestPosition = Math.max(-1, ...completedPositions, ...failedPositions);
  const next = units[highestPosition + 1];
  if (next) return { rawIndex: next.rawIndex, label: formatSectionLabel(next.rawIndex), complete: false };

  return { rawIndex: '', label: '全章完了済み', complete: true };
}

export function findFailedSectionsFromDraftText(text) {
  const source = String(text || '');
  if (!source.trim()) return [];

  const sections = source
    .split(/(?=^§\s*\d+(?:-\d+)?\.\s*)/gm)
    .map((part) => part.trim())
    .filter(Boolean);
  const failed = [];
  const seen = new Set();

  for (const section of sections) {
    if (!/[（(]生成エラー[）)]/.test(section)) continue;
    const heading = section.match(/^§\s*(\d+(?:-\d+)?)\.\s*([^\n]*)/);
    if (!heading) continue;
    const no = heading[1].trim();
    if (seen.has(no)) continue;
    seen.add(no);
    const reasonMatch = section.match(/(?:理由|reason)\s*[:：]\s*([^\n]+)/i);
    failed.push({
      no,
      title: heading[2].trim() || `§${no}`,
      reason: reasonMatch ? reasonMatch[1].trim().slice(0, 120) : '生成エラー',
    });
  }

  return failed;
}

function normalizeResumeContext(resumeContext) {
  if (!resumeContext || resumeContext.source === 'none') {
    return { source: 'none', startIndex: 0, startSubNo: null, rawIndex: '0', accumulated: null };
  }
  const parsed = parseAutomationIndex(resumeContext.rawIndex ?? resumeContext.startIndex);
  return {
    ...resumeContext,
    startIndex: Number.isFinite(resumeContext.startIndex) ? resumeContext.startIndex : parsed.phaseNo,
    startSubNo: resumeContext.startSubNo || parsed.subNo || null,
    rawIndex: resumeContext.rawIndex || parsed.rawIndex,
  };
}

function summarizeFailedSections(failedSections) {
  if (!failedSections.length) return '';
  const first = formatSectionLabel(failedSections[0].no);
  if (failedSections.length === 1) return first;
  return `${first} ほか${failedSections.length - 1}章`;
}

function isProgressSectionFilled(progress, idxLike) {
  if (!progress) return false;
  const parsed = parseAutomationIndex(idxLike);
  if (!Number.isFinite(parsed.phaseNo)) return false;
  if (parsed.subNo) {
    const subs = Array.isArray(progress.subFilledSections?.[String(parsed.phaseNo)])
      ? progress.subFilledSections[String(parsed.phaseNo)]
      : [];
    return subs.some((value) => Number.parseInt(String(value), 10) === parsed.subNo);
  }
  return (progress.filledSections || []).map(String).includes(String(parsed.phaseNo));
}

function buildForwardResumeContext({ progress, phases, ctx, failedSections = [] }) {
  const forward = progress ? computeNextDraftForwardIndex({ progress, phases, failedSections }) : null;
  if (!forward || forward.complete) return null;
  const forwardParsed = parseAutomationIndex(forward.rawIndex);
  if (!forwardParsed.rawIndex || forwardParsed.rawIndex === ctx.rawIndex) return null;
  return {
    source: 'draft-forward',
    rawIndex: forwardParsed.rawIndex,
    startIndex: forwardParsed.phaseNo,
    startSubNo: forwardParsed.subNo,
    accumulated: ctx.accumulated || null,
  };
}

function isDraftComplete(progress, phases) {
  if (!progress) return false;
  return computeNextDraftResumeIndex({ progress, phases }).complete;
}

export function buildAutomationPrimaryAction({
  phases = [],
  resumeContext = null,
  failedSections = [],
  progress = null,
} = {}) {
  const rawFailures = Array.isArray(failedSections) ? failedSections : [];
  const failures = progress
    ? rawFailures.filter((failure) => !isProgressSectionFilled(progress, failure.no))
    : rawFailures;
  const ctx = normalizeResumeContext(resumeContext);
  const hasResume = ctx.source !== 'none';
  const failedLabel = summarizeFailedSections(failures);

  if (failures.length) {
    const first = failures[0];
    const parsed = parseAutomationIndex(first.no);
    const forward = progress ? computeNextDraftForwardIndex({ progress, phases, failedSections: failures }) : null;
    const forwardParsed = forward && !forward.complete ? parseAutomationIndex(forward.rawIndex) : null;
    const ctxParsed = hasResume ? parseAutomationIndex(ctx.rawIndex) : null;
    const secondaryParsed = forwardParsed || ctxParsed;
    const secondaryRawIndex = secondaryParsed ? secondaryParsed.rawIndex : '';
    const firstRawIndex = parseAutomationIndex(first.no).rawIndex;
    const canContinueForward = !!secondaryParsed && secondaryRawIndex && secondaryRawIndex !== firstRawIndex;
    const secondaryResumeContext = canContinueForward
      ? {
          source: forwardParsed ? 'draft-forward' : ctx.source,
          rawIndex: secondaryRawIndex,
          startIndex: secondaryParsed.phaseNo,
          startSubNo: secondaryParsed.subNo,
          accumulated: ctx.accumulated || null,
        }
      : null;
    return {
      kind: 'retry',
      primaryLabel: `実行: 失敗した ${failedLabel} を埋める`,
      primaryDisabled: false,
      secondaryLabel: secondaryResumeContext
        ? `失敗章を残して ${formatSectionLabel(secondaryRawIndex)} から続行`
        : '最初からやり直す',
      secondaryKind: secondaryResumeContext ? 'resume-ignore-failed' : 'restart',
      startIndex: parsed.phaseNo,
      startSubNo: parsed.subNo,
      retrySections: failures,
      accumulated: null,
      resumeContext: ctx,
      secondaryResumeContext,
    };
  }

  if (hasResume) {
    const resumeLabel = formatSectionLabel(ctx.rawIndex);
    const secondaryResumeContext = buildForwardResumeContext({ progress, phases, ctx });
    return {
      kind: 'resume',
      primaryLabel: `実行: ${resumeLabel} から続行`,
      primaryDisabled: false,
      secondaryLabel: secondaryResumeContext
        ? `${resumeLabel} を残して ${formatSectionLabel(secondaryResumeContext.rawIndex)} から続行`
        : '最初からやり直す',
      secondaryKind: secondaryResumeContext ? 'resume-forward' : 'restart',
      startIndex: ctx.startIndex,
      startSubNo: ctx.startSubNo,
      retrySections: [],
      accumulated: ctx.accumulated || null,
      resumeContext: ctx,
      secondaryResumeContext,
    };
  }

  if (isDraftComplete(progress, phases)) {
    return {
      kind: 'complete',
      primaryLabel: '全章完了済み',
      primaryDisabled: true,
      secondaryLabel: '新規 DRAFT を作成して§0から',
      secondaryKind: 'new-draft-start',
      startIndex: 0,
      startSubNo: null,
      retrySections: [],
      accumulated: null,
      resumeContext: ctx,
    };
  }

  return {
    kind: 'start',
    primaryLabel: '§0 から実行',
    primaryDisabled: false,
    secondaryLabel: '',
    secondaryKind: '',
    startIndex: 0,
    startSubNo: null,
    retrySections: [],
    accumulated: null,
    resumeContext: ctx,
  };
}
