/**
 * ggui#1380 — the probe-only eval round: a serving deployment that wires the
 * runtime-render check and configures NO evaluator runs the probe once after
 * the coding turns, observes, and buys exactly ONE repair turn on a
 * recoverable render crash. Pinned at the round seam with the fixture
 * conventions of `run-eval-round.test.ts` (real classification + harness +
 * workspace, `runCheck` mocked at the module seam, no casts):
 *
 *   - a clean `ran` breaks with `pass: ['probe-only']`, no axis checks, no
 *     evaluator call, no cost record, the probe called ONCE;
 *   - `timed-out` / `infra-skipped` / `not-applicable` break, the meta
 *     stamped verbatim, and the card is served;
 *   - a recoverable FAIL on the first round is `feedback` with the same
 *     `[runtime]` text the low-risk bypass builds; on the second round
 *     (`probeRepairUsed`) it ALWAYS breaks and records the repair's after;
 *   - a `prop-sensitivity` FAIL is recorded, never fed back;
 *   - `riskTier: 'low'` takes the probe-only branch, never the bypass;
 *   - I4: `probeOnly: false` on the evaluation lane is today's round, byte
 *     for byte (runCheck once, evaluator once).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import { notApplicableCoverage } from '../../evaluation/types-public.js';
import type { EvalIssue } from '../../evaluation/types-public.js';
import type { RuntimeRenderCheck, RuntimeRenderOutcome } from '../types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));

// Import AFTER the mock is registered so the module binds the stub.
const { runEvalRound } = await import('./run-eval-round.js');

const RECOVERABLE_CRASH: EvalIssue = {
  tier: 0,
  result: 'fail',
  category: 'crash',
  subcategory: 'runtime:render-no-throw',
  severity: 'critical',
  description: 'Component crashed at runtime: Render threw: TypeError: function is not iterable',
  fix: 'Render iterated over a non-array. Default to [] before .map.',
};

const PROP_SENSITIVITY_FAIL: EvalIssue = {
  tier: 0,
  result: 'fail',
  category: 'contract',
  subcategory: 'runtime:prop-sensitivity:currentUser',
  severity: 'critical',
  description: 'currentUser is declared but a literal renders in its place',
  fix: 'Derive the display from props.currentUser.',
};

function stubProbe(outcome: RuntimeRenderOutcome): { probe: RuntimeRenderCheck; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (): Promise<RuntimeRenderOutcome> => outcome);
  return { probe: { id: 'stub-runtime-render', run }, run };
}

async function buildRound(options: {
  probe: RuntimeRenderCheck | undefined;
  probeOnly: boolean;
  probeRepairUsed?: boolean;
  riskTier?: 'low' | 'medium';
  llmEvalMod?: typeof realLlmEvaluator | null;
  costTracker?: CostTracker | null;
}) {
  const classification = {
    ...classifyAxes({ contract: {}, prompt: 'test prompt' }),
    riskTier: options.riskTier ?? 'medium',
  };
  const harness = createHarness({ classification, contract: {}, prompt: 'test prompt', runtimeRender: options.probe });
  const workspace = new AgentWorkspace();
  await workspace.init();
  const compiledCode = 'export default function C() { return null; }';
  workspace.write(compiledCode);
  const evaluationAgent: AgentSpec = { provider: 'anthropic', model: 'claude-haiku-4-5' };
  const ctx: EvalRoundContext = {
    workspace,
    harness,
    contract: undefined,
    userPrompt: 'test prompt',
    fixtureProps: undefined,
    classification,
    evaluationAgent,
    visualEvalAgent: evaluationAgent,
    visualEvaluation: undefined,
    visualThreshold: 0.7,
    qualityMode: 'fast',
    maxEvalRounds: 3,
    costTracker: options.costTracker === undefined ? null : options.costTracker,
    llmEvalMod: options.llmEvalMod ?? null,
    visualMod: null,
    preWarmPromise: undefined,
    probeOnly: options.probeOnly,
    probeRepairUsed: options.probeRepairUsed ?? false,
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

describe('the probe-only round (ggui#1380)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('a clean ran breaks with pass [probe-only]: no axis checks, no evaluator, no cost record, the probe once', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [], elapsedMs: 812, renderMs: 640 });
    const evaluatorCalls: number[] = [];
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () => {
        evaluatorCalls.push(1);
        return Promise.resolve({ issues: [], pass: ['functionality'], inputTokens: 0, outputTokens: 0 });
      },
    };
    const costTracker = new CostTracker(null);
    const record = vi.spyOn(costTracker, 'record');
    const { ctx, input } = await buildRound({ probe, probeOnly: true, llmEvalMod: fakeLlmEvalMod, costTracker });

    const round = await runEvalRound(ctx, input);

    expect(run).toHaveBeenCalledTimes(1);
    expect(mockRunCheck).not.toHaveBeenCalled();
    expect(evaluatorCalls).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(true);
    expect(round.evalRoundsUsed).toBe(1);
    expect(round.isEvalFeedback).toBe(false);
    expect(round.lastResultText).toBe('');
    expect(round.evalTokens).toEqual({ input: 0, output: 0 });
    expect(round.evalResult).toEqual({
      issues: [],
      pass: ['probe-only'],
      runtimeProbe: { status: 'ran', elapsedMs: 812, renderMs: 640 },
      criteriaCoverage: notApplicableCoverage('probe-only round: no evaluator configured'),
      visualCoverage: { status: 'not-applicable', reason: 'probe-only round: no visual evaluator configured' },
    });
    expect(round.evalResult).not.toHaveProperty('runtimeProbeRepair');
  });

  it.each<RuntimeRenderOutcome>([
    { status: 'timed-out', issues: [], reason: 'render check did not finish within 30000 ms (stopped at 30412 ms)', elapsedMs: 30_412 },
    { status: 'infra-skipped', issues: [], reason: 'happy-dom failed to load', elapsedMs: 41 },
    { status: 'not-applicable', issues: [], reason: 'no contract surface' },
  ])('$status breaks and serves, the meta stamped verbatim', async (outcome) => {
    const { probe, run } = stubProbe(outcome);
    const { ctx, input } = await buildRound({ probe, probeOnly: true });

    const round = await runEvalRound(ctx, input);

    expect(run).toHaveBeenCalledTimes(1);
    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(true);
    expect(round.isEvalFeedback).toBe(false);
    expect(round.evalResult?.pass).toEqual(['probe-only']);
    expect(round.evalResult?.issues).toEqual([]);
    const { status, reason, elapsedMs } = outcome;
    expect(round.evalResult?.runtimeProbe).toEqual({
      status,
      ...(reason !== undefined ? { reason } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    });
    expect(mockRunCheck).not.toHaveBeenCalled();
  });

  it('a recoverable FAIL on the first round is feedback with the [runtime] text — one probe, no repair record yet', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 900 });
    const { ctx, input } = await buildRound({ probe, probeOnly: true, probeRepairUsed: false });

    const round = await runEvalRound(ctx, input);

    expect(run).toHaveBeenCalledTimes(1);
    expect(round.control).toBe('feedback');
    expect(round.evalDone).toBe(false);
    expect(round.isEvalFeedback).toBe(true);
    expect(round.lastResultText).toBe(
      `[runtime] crash/runtime:render-no-throw: ${RECOVERABLE_CRASH.description}\n  Fix: ${RECOVERABLE_CRASH.fix}`,
    );
    expect(round.evalResult?.pass).toEqual(['probe-only']);
    expect(round.evalResult?.issues).toEqual([RECOVERABLE_CRASH]);
    expect(round.evalResult?.runtimeProbe).toEqual({ status: 'ran', elapsedMs: 900 });
    expect(round.evalResult).not.toHaveProperty('runtimeProbeRepair');
    expect(round.evalResult).not.toHaveProperty('contractFeedback');
    expect(round.contractFeedback).toBeUndefined();
  });

  it('the second round (repair used) ALWAYS breaks — a recoverable FAIL after the repair is recorded, not fed back', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 700 });
    const { ctx, input } = await buildRound({ probe, probeOnly: true, probeRepairUsed: true });

    const round = await runEvalRound(ctx, { ...input, evalRoundsUsed: 1 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(round.control).toBe('break');
    expect(round.isEvalFeedback).toBe(false);
    expect(round.lastResultText).toBe('');
    expect(round.evalRoundsUsed).toBe(2);
    expect(round.evalResult?.pass).toEqual(['probe-only']);
    expect(round.evalResult?.issues).toEqual([RECOVERABLE_CRASH]);
    expect(round.evalResult?.runtimeProbeRepair).toEqual({ attempted: true, afterStatus: 'ran', recoverableFailAfter: true });
  });

  it('the second round on a clean re-probe records the repair as taken', async () => {
    const { probe } = stubProbe({ status: 'ran', issues: [], elapsedMs: 500 });
    const { ctx, input } = await buildRound({ probe, probeOnly: true, probeRepairUsed: true });

    const round = await runEvalRound(ctx, { ...input, evalRoundsUsed: 1 });

    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(true);
    expect(round.evalResult?.runtimeProbeRepair).toEqual({ attempted: true, afterStatus: 'ran', recoverableFailAfter: false });
  });

  it('the second round on a timed-out re-probe records that status as the after', async () => {
    const { probe } = stubProbe({ status: 'timed-out', issues: [], reason: 'did not finish', elapsedMs: 30_000 });
    const { ctx, input } = await buildRound({ probe, probeOnly: true, probeRepairUsed: true });

    const round = await runEvalRound(ctx, { ...input, evalRoundsUsed: 1 });

    expect(round.control).toBe('break');
    expect(round.evalResult?.runtimeProbeRepair).toEqual({ attempted: true, afterStatus: 'timed-out', recoverableFailAfter: false });
  });

  it('a prop-sensitivity FAIL is recorded in the issues and never fed back (no contract-feedback round)', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [PROP_SENSITIVITY_FAIL] });
    const { ctx, input } = await buildRound({ probe, probeOnly: true });

    const round = await runEvalRound(ctx, input);

    expect(run).toHaveBeenCalledTimes(1);
    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(true);
    expect(round.isEvalFeedback).toBe(false);
    expect(round.evalResult?.issues).toEqual([PROP_SENSITIVITY_FAIL]);
    expect(round.contractFeedback).toBeUndefined();
    expect(round.evalResult).not.toHaveProperty('contractFeedback');
  });

  it("riskTier 'low' takes the probe-only branch: pass is ['probe-only'], never ['axis.low-risk']", async () => {
    const { probe } = stubProbe({ status: 'ran', issues: [] });
    const { ctx, input } = await buildRound({ probe, probeOnly: true, riskTier: 'low' });

    const round = await runEvalRound(ctx, input);

    expect(round.control).toBe('break');
    expect(round.evalResult?.pass).toEqual(['probe-only']);
    expect(mockRunCheck).not.toHaveBeenCalled();
  });

  it('I4: probeOnly false on the evaluation lane is today’s round — runCheck once, the evaluator once, the same result', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [], elapsedMs: 12, renderMs: 9 });
    const evaluatorCalls: number[] = [];
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () => {
        evaluatorCalls.push(1);
        return Promise.resolve({ issues: [], pass: ['functionality', 'crash'], inputTokens: 3, outputTokens: 2 });
      },
    };
    const { ctx, input } = await buildRound({ probe, probeOnly: false, llmEvalMod: fakeLlmEvalMod, costTracker: new CostTracker(null) });

    const round = await runEvalRound(ctx, input);

    expect(mockRunCheck).toHaveBeenCalledTimes(1);
    expect(evaluatorCalls).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(true);
    expect(round.evalTokens).toEqual({ input: 3, output: 2 });
    expect(round.evalResult).toEqual({
      issues: [],
      pass: ['functionality', 'crash'],
      visualCoverage: { status: 'not-applicable', reason: 'visual leg not configured' },
      runtimeProbe: { status: 'ran', elapsedMs: 12, renderMs: 9 },
    });
  });

  it('D3: the evaluation lane without a cost tracker lands on the infra-skipped stamp with the named reason', async () => {
    const { probe, run } = stubProbe({ status: 'ran', issues: [] });
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 0, outputTokens: 0 }),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, input } = await buildRound({ probe, probeOnly: false, llmEvalMod: fakeLlmEvalMod, costTracker: null });

    const round = await runEvalRound(ctx, input);

    expect(round.control).toBe('break');
    expect(round.evalDone).toBe(false);
    expect(round.evalResult?.pass).toEqual([]);
    expect(round.evalResult?.runtimeProbe?.status).toBe('infra-skipped');
    expect(round.evalResult?.runtimeProbe?.reason).toContain('cost tracker absent on an evaluation round');
    expect(run).not.toHaveBeenCalled();
  });
});
