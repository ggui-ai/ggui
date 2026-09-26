/**
 * From K judge answers and the capture's measurements to one `CriteriaBlock` — ggui#1436.
 *
 * The judge is asked only the `judge` criteria; `instrument` criteria are answered by a
 * measurement the capture already ran (v1: the fit column and the ink/fill column) or read `n/a`
 * "instrument not run" until their instrument exists; `human` criteria read `n/a` for the judge.
 * K-majority per id; a tie or an unanswered id reads `n/a` (the CTO's A2) — a `must` at `n/a` is
 * never a pass when a gate later reads the set.
 */
import type { CriteriaAnswer } from '../types.js';
import type { CriteriaBlock, CriteriaContext, CriteriaVerdict, CriterionVerdict } from '../types-public.js';
import type { BankCriterion, CriteriaBank } from './bank.js';
import { CRITERIA_SELECTOR_VERSION, type CriteriaSelectionResult } from './select.js';

/** The instruments the capture runs today, by the bank ids they answer (v1 binding; a bank field may replace it). */
export const INSTRUMENT_BY_ID: Readonly<Record<string, 'fit' | 'fill'>> = {
  'floor.fit': 'fit',
  'finish.canvas.inhabited': 'fill',
};

export interface CriteriaMeasurements {
  readonly overflow: boolean;
  readonly contentHeight: number | null;
  readonly viewportHeight: number;
  readonly inkRatio: number | null;
}

function majority(id: string, answers: readonly CriteriaAnswer[][]): { verdict: CriteriaVerdict; evidence: string } {
  const votes = answers.flatMap((a) => a.filter((x) => x.id === id));
  if (votes.length === 0) return { verdict: 'n/a', evidence: 'not answered' };
  const counts = new Map<CriteriaVerdict, number>();
  for (const v of votes) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  if (ranked.length > 1 && ranked[1]![1] === top[1]) return { verdict: 'n/a', evidence: 'no majority' };
  const evidence = votes.find((v) => v.verdict === top[0])?.evidence ?? '';
  return { verdict: top[0], evidence };
}

function instrumentVerdict(kind: 'fit' | 'fill', m: CriteriaMeasurements): { verdict: CriteriaVerdict; evidence: string } {
  if (kind === 'fit') {
    if (m.contentHeight === null) return { verdict: 'n/a', evidence: 'content height unmeasurable' };
    return {
      verdict: m.overflow ? 'fail' : 'pass',
      evidence: `content ${m.contentHeight}px against a ${m.viewportHeight}px box`,
    };
  }
  if (m.inkRatio === null) return { verdict: 'n/a', evidence: 'capture unreadable' };
  // Reported, never gated: no fill floor is ruled (hello-finish property 1).
  return { verdict: 'n/a', evidence: `fill ${m.inkRatio.toFixed(3)} reported; no floor ruled` };
}

export function resolveCriteriaBlock(args: {
  readonly bank: CriteriaBank;
  readonly context: CriteriaContext;
  readonly selected: CriteriaSelectionResult;
  readonly answers: readonly CriteriaAnswer[][];
  readonly measurements: CriteriaMeasurements;
}): CriteriaBlock {
  const byId = new Map<string, BankCriterion>(args.bank.criteria.map((c) => [c.id, c]));
  const verdicts: CriterionVerdict[] = [];
  for (const s of args.selected.selection) {
    const c = byId.get(s.id);
    if (c === undefined) continue;
    let read: { verdict: CriteriaVerdict; evidence: string };
    if (c.checker === 'judge') read = majority(c.id, args.answers);
    else if (c.checker === 'instrument') {
      const kind = INSTRUMENT_BY_ID[c.id];
      read = kind === undefined ? { verdict: 'n/a', evidence: 'instrument not run' } : instrumentVerdict(kind, args.measurements);
    } else read = { verdict: 'n/a', evidence: "reader's column" };
    verdicts.push({ id: c.id, level: c.level, checker: c.checker, source: s.source, verdict: read.verdict, evidence: read.evidence });
  }
  return {
    criteriaSetId: args.selected.criteriaSetId,
    bankVersion: args.bank.version,
    selectorVersion: CRITERIA_SELECTOR_VERSION,
    context: args.context,
    selection: args.selected.selection,
    verdicts,
  };
}

/** The judge's prompt block for the selected `judge` criteria; empty when none is selected. */
export function buildCriteriaJudgeBlock(bank: CriteriaBank, selected: CriteriaSelectionResult): string {
  const byId = new Map<string, BankCriterion>(bank.criteria.map((c) => [c.id, c]));
  const asked = selected.selection.map((s) => byId.get(s.id)).filter((c): c is BankCriterion => c !== undefined && c.checker === 'judge');
  if (asked.length === 0) return '';
  const lines = asked.map((c) => `- ${c.id} (${c.level}): ${c.text} Evidence must name: ${c.evidence}`);
  return (
    '## Criteria — answer each one from the FRAME only\n' +
    'Read these off the screenshot. Never infer them from the request, the styling profile or any direction text above.\n' +
    `${lines.join('\n')}\n` +
    'Add to your JSON a top-level "criteria" array with exactly these ids: ' +
    '[{ "id": "<id>", "verdict": "pass" | "fail" | "n/a", "evidence": "<one sentence naming the region or element you read it from>" }]. ' +
    'Use "n/a" when the frame cannot show it.'
  );
}
