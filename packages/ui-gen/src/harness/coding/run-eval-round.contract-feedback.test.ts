// A contract defect the exit probe diagnoses reaches the model. The runtime
// probe runs once at each exit decision (the clean-PASS exit, the cap, and the
// stuck exit).
// Until now it bought an extra turn only for a CRASH class (re-render loops,
// TDZ, `undefined is not`…), so a `prop-sensitivity` FAIL — the component
// ignores a declared prop and bakes a literal in its place ("You" for
// `currentUser`) — was recorded and shipped: the loop never showed the model
// the finding its own evaluator made, fix text included.
//
// Pinned here: a `prop-sensitivity` FAIL from the exit probe buys ONE feedback
// round with the probe's diagnosis, at any exit; the round after it re-runs
// the probe, so the result the generation ends with carries the POST-fix probe
// stamp (the verdict a reader of `runtimeProbe` + `runtime:*` issues sees);
// the same finding recurring after its round ships as recorded, never loops;
// and only the named class buys the round. At the STUCK exit (every fail
// recurring, and non-runtime by construction) the round carries the probe's
// diagnosis and never the recurring fail: the stuck premise is "the model saw
// these and did not resolve them", and the probe's finding was never delivered
// (Exp 011, candidate r5: the one FAIL that shipped without a round).
//
// RED before the contract-feedback branch, GREEN after.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import type { EvalIssue } from '../../evaluation/types-public.js';
import type { RuntimeRenderCheck, RuntimeRenderOutcome } from '../types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

const PROP_FAIL: EvalIssue = {
  tier: 0,
  result: 'fail',
  category: 'contract',
  subcategory: 'runtime:prop-sensitivity:currentUser',
  severity: 'critical',
  description: 'changing props.currentUser left the DOM byte-identical — the value is baked in',
  fix: 'Derive the display AND any logic from props.currentUser — render {props.currentUser} and branch on the prop’s value.',
};
const OTHER_PROBE_FAIL: EvalIssue = {
  tier: 0,
  result: 'fail',
  category: 'contract',
  subcategory: 'runtime:action-no-effect:chooseReply',
  severity: 'critical',
  description: 'clicking chooseReply produced no required signal',
  fix: 'Give the tap a visible acknowledgement.',
};
const PROP_COVERAGE_WARN: EvalIssue = {
  tier: 0,
  result: 'warn',
  category: 'contract',
  subcategory: 'runtime:prop-coverage:greeting',
  severity: 'major',
  description: 'props.greeting is never rendered',
  fix: 'Render props.greeting somewhere in the JSX.',
};
const ran = (issues: readonly EvalIssue[]): RuntimeRenderOutcome => ({ status: 'ran', issues });
const SOURCE = 'export default function C() { return null; }';

function fakeProbe(outcomes: RuntimeRenderOutcome[]): { probe: RuntimeRenderCheck; calls: () => number } {
  let calls = 0;
  const probe: RuntimeRenderCheck = {
    id: 'fake-runtime-render',
    run: () => {
      calls += 1;
      const next = outcomes.shift();
      return Promise.resolve(next ?? ran([]));
    },
  };
  return { probe, calls: () => calls };
}

async function buildCtx(
  probe: RuntimeRenderCheck,
  maxEvalRounds = 3,
): Promise<{ ctx: EvalRoundContext; input: EvalRoundInput }> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a chat window' }), riskTier: 'medium' as const };
  const base = createHarness({ classification, contract: {}, prompt: 'a chat window' });
  const harness = { ...base, check: { ...base.check, runtimeRender: probe } };
  const workspace = new AgentWorkspace();
  await workspace.init();
  const compiledCode = SOURCE;
  workspace.write(compiledCode);
  const evaluationAgent: AgentSpec = { provider: 'anthropic', model: 'claude-haiku-4-5' };
  const fakeLlmEvalMod: typeof realLlmEvaluator = {
    ...realLlmEvaluator,
    runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 0, outputTokens: 0 }),
  };
  const ctx: EvalRoundContext = {
    workspace,
    harness,
    contract: undefined,
    userPrompt: 'a chat window',
    fixtureProps: { currentUser: 'alice' },
    classification,
    evaluationAgent,
    visualEvalAgent: evaluationAgent,
    visualEvaluation: undefined,
    visualThreshold: 70,
    qualityMode: 'fast',
    maxEvalRounds,
    costTracker: new CostTracker(null),
    llmEvalMod: fakeLlmEvalMod,
    visualMod: null,
    preWarmPromise: undefined,
  };
  const input: EvalRoundInput = {
    compiledCode,
    evalRoundsUsed: 0,
    preWarmedContext: undefined,
    prevModeSubcats: new Set(),
    prevFailFingerprints: new Set(),
  };
  return { ctx, input };
}

describe('a contract defect the exit probe diagnoses reaches the model', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('at the clean-PASS exit, a prop-sensitivity FAIL buys one feedback round carrying the probe’s diagnosis', async () => {
    const { probe } = fakeProbe([ran([PROP_FAIL])]);
    const { ctx, input } = await buildCtx(probe);

    const round = await runEvalRound(ctx, input);

    expect(round.control).toBe('feedback');
    expect(round.evalDone).toBe(false);
    expect(round.isEvalFeedback).toBe(true);
    expect(round.lastResultText).toContain('prop-sensitivity');
    expect(round.lastResultText).toContain('Derive the display AND any logic from props.currentUser');
    // The round's record — what bought it and the source it was fed back on (the before of a before/after read).
    expect(round.contractFeedback).toEqual({ firedOn: ['runtime:prop-sensitivity:currentUser'], sourceBefore: SOURCE });
  });

  it('the round after it re-runs the probe, so the generation ends on the POST-fix stamp (the verdict a reader of the result sees)', async () => {
    const { probe, calls } = fakeProbe([ran([PROP_FAIL]), ran([])]);
    const { ctx, input } = await buildCtx(probe);

    const r1 = await runEvalRound(ctx, input);
    const r2 = await runEvalRound(ctx, {
      ...input,
      evalRoundsUsed: r1.evalRoundsUsed,
      prevModeSubcats: r1.prevModeSubcats,
      prevFailFingerprints: r1.prevFailFingerprints,
    });

    expect(r1.control, 'precondition: the FAIL bought the round').toBe('feedback');
    expect(calls()).toBe(2);
    expect(r2.control).toBe('break');
    expect(r2.evalDone).toBe(true);
    expect(r2.evalResult?.runtimeProbe?.status).toBe('ran');
    expect(r2.evalResult?.issues.some((i) => i.subcategory?.startsWith('runtime:prop-sensitivity'))).toBe(false);
  });

  it('the same finding recurring after its round ships as recorded — one attempt, never a loop', async () => {
    const { probe } = fakeProbe([ran([PROP_FAIL]), ran([PROP_FAIL])]);
    const { ctx, input } = await buildCtx(probe);

    const r1 = await runEvalRound(ctx, input);
    const r2 = await runEvalRound(ctx, {
      ...input,
      evalRoundsUsed: r1.evalRoundsUsed,
      prevModeSubcats: r1.prevModeSubcats,
      prevFailFingerprints: r1.prevFailFingerprints,
    });

    expect(r1.control).toBe('feedback');
    expect(r2.control).toBe('break');
    expect(r2.contractFeedback, 'the recurrence ships; it grants no second round').toBeUndefined();
    expect(r2.evalResult?.issues).toContainEqual(PROP_FAIL);
    expect(r2.evalResult?.runtimeProbe?.status).toBe('ran');
  });

  it('at the cap, the same FAIL buys the one extra round too (bounded at cap + 1)', async () => {
    mockRunCheck.mockResolvedValue({
      issues: [{ tier: 0, result: 'fail', category: 'mode', subcategory: 'token-fallback', severity: 'critical', description: 'hardcoded colour', fix: 'use a token' }],
    });
    const { probe } = fakeProbe([ran([PROP_FAIL])]);
    const { ctx, input } = await buildCtx(probe, 1);

    const round = await runEvalRound(ctx, input);

    expect(round.evalRoundsUsed).toBe(1);
    expect(round.control).toBe('feedback');
    expect(round.lastResultText).toContain('prop-sensitivity');
    expect(round.contractFeedback).toEqual({ firedOn: ['runtime:prop-sensitivity:currentUser'], sourceBefore: SOURCE });
  });

  // A recurring non-runtime fail, so round 2 is the STUCK exit (runtime-only fail-sets are exempt from it).
  const STUCK_MODE_FAIL: EvalIssue = {
    tier: 0,
    result: 'fail',
    category: 'mode',
    subcategory: 'token-fallback',
    severity: 'critical',
    description: 'hardcoded colour',
    fix: 'use a token',
  };
  function alwaysProbe(outcome: () => RuntimeRenderOutcome): { probe: RuntimeRenderCheck; calls: () => number } {
    let calls = 0;
    return {
      probe: { id: 'fake-runtime-render', run: () => { calls += 1; return Promise.resolve(outcome()); } },
      calls: () => calls,
    };
  }

  it('at the STUCK exit, an undelivered prop-sensitivity FAIL buys the round — with the probe’s diagnosis, never the stuck fail', async () => {
    mockRunCheck.mockResolvedValue({ issues: [STUCK_MODE_FAIL] });
    const { probe } = alwaysProbe(() => ran([PROP_FAIL]));
    const { ctx, input } = await buildCtx(probe);

    const r1 = await runEvalRound(ctx, input);
    const r2 = await runEvalRound(ctx, {
      ...input,
      evalRoundsUsed: r1.evalRoundsUsed,
      prevModeSubcats: r1.prevModeSubcats,
      prevFailFingerprints: r1.prevFailFingerprints,
    });

    expect(r1.control, 'precondition: round 1 feeds the mode fail back').toBe('feedback');
    expect(r1.contractFeedback, 'precondition: round 1 is not the contract round').toBeUndefined();
    expect(r2.control).toBe('feedback');
    expect(r2.isEvalFeedback).toBe(true);
    expect(r2.lastResultText).toContain('Derive the display AND any logic from props.currentUser');
    expect(r2.lastResultText, 'the recurring stuck fail is not fed back again').not.toContain('hardcoded colour');
    expect(r2.contractFeedback).toEqual({ firedOn: ['runtime:prop-sensitivity:currentUser'], sourceBefore: SOURCE });
    expect(r2.evalResult?.runtimeProbe?.status).toBe('ran');
  });

  it('after the stuck-exit round, the same finding recurring ships as recorded — stuck again, no second round', async () => {
    mockRunCheck.mockResolvedValue({ issues: [STUCK_MODE_FAIL] });
    const { probe } = alwaysProbe(() => ran([PROP_FAIL]));
    const { ctx, input } = await buildCtx(probe, 5);

    const r1 = await runEvalRound(ctx, input);
    const next = (r: typeof r1) => ({ ...input, evalRoundsUsed: r.evalRoundsUsed, prevModeSubcats: r.prevModeSubcats, prevFailFingerprints: r.prevFailFingerprints });
    const r2 = await runEvalRound(ctx, next(r1));
    const r3 = await runEvalRound(ctx, next(r2));

    expect(r2.contractFeedback, 'precondition: the stuck exit bought the round').toBeDefined();
    expect(r3.control).toBe('break');
    expect(r3.contractFeedback).toBeUndefined();
    expect(r3.evalResult?.issues).toContainEqual(PROP_FAIL);
    expect(r3.evalResult?.runtimeProbe?.status).toBe('ran');
  });

  it('at the STUCK exit with a clean probe, the loop still exits as before', async () => {
    mockRunCheck.mockResolvedValue({ issues: [STUCK_MODE_FAIL] });
    const { probe, calls } = alwaysProbe(() => ran([]));
    const { ctx, input } = await buildCtx(probe);

    const r1 = await runEvalRound(ctx, input);
    const r2 = await runEvalRound(ctx, {
      ...input,
      evalRoundsUsed: r1.evalRoundsUsed,
      prevModeSubcats: r1.prevModeSubcats,
      prevFailFingerprints: r1.prevFailFingerprints,
    });

    expect(r2.control).toBe('break');
    expect(r2.contractFeedback).toBeUndefined();
    expect(r2.evalResult?.runtimeProbe?.status).toBe('ran');
    expect(calls(), 'the stuck exit still probes the shipped code').toBeGreaterThan(0);
  });

  it('only the named class buys the round: another probe FAIL class and a prop-coverage WARN ship as recorded', async () => {
    const other = fakeProbe([ran([OTHER_PROBE_FAIL])]);
    const a = await buildCtx(other.probe);
    const ra = await runEvalRound(a.ctx, a.input);
    expect(ra.control).toBe('break');
    expect(ra.evalResult?.issues).toContainEqual(OTHER_PROBE_FAIL);
    expect(ra.contractFeedback, 'no round fired, no record').toBeUndefined();

    const warn = fakeProbe([ran([PROP_COVERAGE_WARN])]);
    const b = await buildCtx(warn.probe);
    const rb = await runEvalRound(b.ctx, b.input);
    expect(rb.control).toBe('break');
    expect(rb.evalDone).toBe(true);
  });
});
