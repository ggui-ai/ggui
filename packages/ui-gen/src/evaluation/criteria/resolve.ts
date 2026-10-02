/**
 * From K judge answers and the capture's measurements to one `CriteriaBlock` — ggui#1436.
 *
 * The judge is asked every `evaluation: judge` row (this block IS their implementation; the row's
 * `status` is carried on the verdict as the author wrote it). An `instrument` row is answered by a
 * measurement the capture already ran when its status is `live` and a binding exists; otherwise it
 * reads `n/a` with the reason from `status`. A `human` row reads `n/a` for the judge. K-majority per
 * id; a tie or an unanswered id reads `n/a` (the CTO's A2) — a `must` at `n/a` is never a pass when
 * a gate later reads the set.
 */
import type { CriteriaAnswer } from '../types.js';
import type { CriteriaAnswerCounts, CriteriaBlock, CriteriaContext, CriteriaVerdict, CriterionVerdict } from '../types-public.js';
import type { VisionFinishReason } from '../../harness/llm-router.js';
import { bankRows, type BankRow, type CriteriaBank } from './bank.js';
import { CRITERIA_SELECTOR_VERSION, type CriteriaSelectionResult } from './select.js';
import type { EdgeVerdict } from './edge.js';

/** The instruments the capture runs today, by the bank ids they answer (v1 binding; a bank field may replace it). */
export const INSTRUMENT_BY_ID: Readonly<Record<string, 'fit' | 'fill'>> = {
  'comp.fit': 'fit',
  'floor.fit': 'fit',
  'finish.canvas.inhabited': 'fill',
};

/**
 * ggui#1663 — instruments that read BESIDE a judge row, report-only: the row keeps the judge's verdict and gains the
 * measurement as `instrument`, so the two can be compared before any verdict moves.
 */
export const INSTRUMENT_BESIDE_JUDGE: Readonly<Record<string, 'edge'>> = {
  'space.edge': 'edge',
};

export interface CriteriaMeasurements {
  readonly overflow: boolean;
  readonly contentHeight: number | null;
  readonly viewportHeight: number;
  readonly inkRatio: number | null;
  /**
   * ggui#1663 — the edge rule on the capture's DOM: absent when this capture had no page to read (a stored frame),
   * `null` when the probe ran and failed.
   */
  readonly edge?: EdgeVerdict | null;
}

function besideRead(kind: 'edge', m: CriteriaMeasurements): Read {
  if (m.edge === undefined) return { verdict: 'n/a', evidence: 'not measured: this capture had no page to read' };
  if (m.edge === null) return { verdict: 'n/a', evidence: 'edge probe failed on this capture' };
  return { verdict: m.edge.verdict, evidence: m.edge.evidence };
}

type Read = { verdict: CriteriaVerdict; evidence: string };

function majority(id: string, answers: readonly CriteriaAnswer[][], unansweredReason: string | undefined): Read {
  const votes = answers.flatMap((a) => a.filter((x) => x.id === id));
  if (votes.length === 0) return { verdict: 'n/a', evidence: unansweredReason ?? 'not answered' };
  const counts = new Map<CriteriaVerdict, number>();
  for (const v of votes) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  if (ranked.length > 1 && ranked[1]![1] === top[1]) return { verdict: 'n/a', evidence: 'no majority' };
  const evidence = votes.find((v) => v.verdict === top[0])?.evidence ?? '';
  return { verdict: top[0], evidence };
}

function instrumentRead(kind: 'fit' | 'fill', m: CriteriaMeasurements): Read {
  if (kind === 'fit') {
    if (m.contentHeight === null) return { verdict: 'n/a', evidence: 'content height unmeasurable' };
    return { verdict: m.overflow ? 'fail' : 'pass', evidence: `content ${m.contentHeight}px against a ${m.viewportHeight}px box` };
  }
  if (m.inkRatio === null) return { verdict: 'n/a', evidence: 'capture unreadable' };
  // Reported, never gated: no fill floor is ruled (hello-finish property 1).
  return { verdict: 'n/a', evidence: `fill ${m.inkRatio.toFixed(3)} reported; no floor ruled` };
}

function readRow(row: BankRow, answers: readonly CriteriaAnswer[][], m: CriteriaMeasurements, unansweredReason: string | undefined): Read {
  if (row.evaluation === 'judge') return majority(row.id, answers, unansweredReason);
  if (row.evaluation === 'human') return { verdict: 'n/a', evidence: `reader's column (status ${row.status})` };
  if (row.status !== 'live') return { verdict: 'n/a', evidence: `not implemented (status ${row.status})` };
  const kind = INSTRUMENT_BY_ID[row.id];
  return kind === undefined ? { verdict: 'n/a', evidence: 'instrument not wired (status live, no binding)' } : instrumentRead(kind, m);
}

export function resolveCriteriaBlock(args: {
  readonly bank: CriteriaBank;
  readonly context: CriteriaContext;
  readonly selected: CriteriaSelectionResult;
  readonly answers: readonly CriteriaAnswer[][];
  readonly measurements: CriteriaMeasurements;
  /**
   * ggui#1127 — why a judge row has no answer, when the caller knows: a salvaged criteria answer keeps no criteria,
   * so its rows say so instead of reading as a clean `n/a`. Absent ⇒ "not answered".
   */
  readonly unansweredReason?: string;
  /** ggui#1687 — the call that answered, as it came back: its answer's counts and its stop reason. */
  readonly call?: { readonly answer: CriteriaAnswerCounts; readonly finishReason?: VisionFinishReason };
}): CriteriaBlock {
  const byId = new Map<string, BankRow>(bankRows(args.bank).map((r) => [r.id, r]));
  const verdicts: CriterionVerdict[] = [];
  for (const s of args.selected.selection) {
    const row = byId.get(s.id);
    if (row === undefined) continue;
    const read = readRow(row, args.answers, args.measurements, args.unansweredReason);
    const beside = INSTRUMENT_BESIDE_JUDGE[row.id];
    verdicts.push({
      id: row.id,
      severity: row.severity,
      method: row.evaluation,
      status: row.status,
      source: s.source,
      verdict: read.verdict,
      evidence: read.evidence,
      ...(beside !== undefined && row.evaluation === 'judge' ? { instrument: besideRead(beside, args.measurements) } : {}),
    });
  }
  return {
    criteriaSetId: args.selected.criteriaSetId,
    bankVersion: args.bank.version,
    selectorVersion: CRITERIA_SELECTOR_VERSION,
    context: args.context,
    selection: args.selected.selection,
    verdicts,
    ...(args.call !== undefined
      ? {
          call: {
            answer: args.call.answer,
            // Kept answers whose id names no row of the bank: the judge answered something nobody asked.
            unknownIds: args.answers.flat().filter((a) => !byId.has(a.id)).length,
            ...(args.call.finishReason !== undefined ? { finishReason: args.call.finishReason } : {}),
          },
        }
      : {})
  };
}

/** The judge's prompt block for the selected `judge` rows; empty when none is selected. */
/** The capture the judge is handed: its canvas class and the box it was taken at (the class box, or a declared one). */
export interface CriteriaJudgeFrame {
  readonly canvas: CriteriaContext['canvas'];
  readonly width: number;
  readonly height: number;
  /** ggui#1492 — the host whose presentation framed this canvas (e.g. "a chat widget, inline, reference theme"); absent ⇒ the judge's own stand-in. */
  readonly hostLabel?: string;
}

/** What the block carries besides the selected rows: the frame's box, and the props the card was rendered with. */
export interface CriteriaJudgeInputs {
  readonly frame?: CriteriaJudgeFrame;
  /** JSON text of the props the card was rendered with; bounded by {@link CRITERIA_PROPS_MAX_CHARS}. */
  readonly propsJson?: string;
}

/** Bound on the props text handed to the judge beside the frame, in characters. */
export const CRITERIA_PROPS_MAX_CHARS = 2000;

/**
 * The frame's box and how the card occupies it, named so the judge reads the capture it was handed and
 * never guesses it: without it, phone rows described a 390×844 frame as a 768×1024 tablet, and the
 * inline card's verdicts flipped between near-identical frames (the evidence audit on ggui#1438).
 * The inline chat card is sized to its content by the host (the box grows and shrinks with the card; a
 * `maxHeight` caps and scrolls), so the judge captures it at its natural height on the host's ground
 * (ggui#1475) and composition is judged within the card's extent; every other canvas is a fixed box the
 * card fills.
 */
export function criteriaFrameLine(frame: CriteriaJudgeFrame): string {
  const box = `${frame.width}×${frame.height}`;
  if (frame.canvas === 'xs-chat-card') {
    const framedBy =
      frame.hostLabel !== undefined
        ? `inside the host's own frame (${frame.hostLabel}), on the host's ground`
        : "inside a generic stand-in for the host's frame — the card's surface with a thin ring and rounded corners, on the page ground";
    return `This frame is an inline chat card captured at its natural height (at most ${box}, the host's ceiling), ${framedBy}: the host sizes the card to its content and draws that frame, so judge composition and space within the card's own extent, and read the frame and the ground round it as the host's, not the card's.`;
  }
  return `This frame is ${box}, a fixed full-screen box the card fills${frame.hostLabel !== undefined ? ` (${frame.hostLabel})` : ''}: judge composition and space against the whole box, edge to edge.`;
}

/**
 * The one declared input besides the frame. Rows whose evidence names props (whether a rendered string
 * came from content or props, whether the primary action is the one the props and contract name) cannot
 * be answered from pixels alone; every other row stays frame-only.
 */
function criteriaPropsSection(propsJson: string): string {
  const text = propsJson.length > CRITERIA_PROPS_MAX_CHARS ? `${propsJson.slice(0, CRITERIA_PROPS_MAX_CHARS)}… (truncated)` : propsJson;
  return (
    'The one input besides the frame — the props this card was rendered with. Read them ONLY for rows whose evidence names props ' +
    '(for example, whether a rendered string came from them); every other row is read off the frame alone:\n' +
    `${text}\n`
  );
}

/** The judge's prompt block for the selected `judge` rows; empty when none is selected. */
export function buildCriteriaJudgeBlock(bank: CriteriaBank, selected: CriteriaSelectionResult, inputs: CriteriaJudgeInputs = {}): string {
  const byId = new Map<string, BankRow>(bankRows(bank).map((r) => [r.id, r]));
  const asked = selected.selection.map((s) => byId.get(s.id)).filter((r): r is BankRow => r !== undefined && r.evaluation === 'judge');
  if (asked.length === 0) return '';
  const lines = asked.map((r) => `- ${r.id} (${r.severity}): ${r.text} Evidence must name: ${r.evidence}`);
  return (
    '## Criteria — answer each one from the FRAME only\n' +
    'Read these off the screenshot. Never infer them from the request, the styling profile or any direction text above.\n' +
    (inputs.frame !== undefined ? `${criteriaFrameLine(inputs.frame)}\n` : '') +
    (inputs.propsJson !== undefined ? criteriaPropsSection(inputs.propsJson) : '') +
    `${lines.join('\n')}\n` +
    'Add to your JSON a top-level "criteria" array with exactly these ids: ' +
    '[{ "id": "<id>", "verdict": "pass" | "fail" | "n/a", "evidence": "<one sentence naming the region or element you read it from>" }]. ' +
    'Every row here was selected as applicable to this card, so "n/a" never means "does not apply": ' +
    'use it ONLY when this frame cannot show the criterion — it is then recorded as not evaluated.'
  );
}
