// ggui#1522 — the in-loop visual judge's spend reaches the round. RED fixture: the harness adapter
// (`runVisualEval`) returned only issues / summary / coverage, so a round that ran the visual leg recorded the
// text evaluator's tokens alone — `usage` under-reported, and `costTracker.canContinue()` never saw visual spend,
// so a self-hoster's `maxCostPerGeneration` under-counted whenever the visual leg was on.
//
// Pinned: the leg's tokens (scoring calls, and the report-only criteria calls apart) ride the round as
// `inLoopVisualTokens`, NOT inside `evalTokens`; the cost tracker records them at the VISUAL agent's model;
// and the runner folds them into the run's own part, never into the coding/text totals.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import * as realVisualEvaluator from '../../evaluation/visual-evaluator.js';
import type { VisualEvalOutcome, VisualLegTokens } from '../../evaluation/visual-evaluator.js';
import type { RuntimeRenderCheck } from '../types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';
import { absorbInLoopVisualTokens, createTelemetry } from './generate-task-runner.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

const SOURCE = 'export default function C() { return null; }';
const TEXT_MODEL = 'claude-haiku-4-5';
const VISUAL_MODEL = 'claude-sonnet-5';
const LEG: VisualLegTokens = { inputTokens: 1800, outputTokens: 420, criteria: { inputTokens: 3600, outputTokens: 2200 } };
const cleanProbe: RuntimeRenderCheck = { id: 'fake-runtime-render', run: () => Promise.resolve({ status: 'ran', issues: [] }) };

async function buildCtx(
  visualOutcome: VisualEvalOutcome | null,
  costTracker: CostTracker,
  textCache: { cacheReadTokens?: number; cacheCreationTokens?: number } = {},
): Promise<{ ctx: EvalRoundContext; input: EvalRoundInput }> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a chat window' }), riskTier: 'medium' as const };
  const base = createHarness({ classification, contract: {}, prompt: 'a chat window' });
  const harness = { ...base, check: { ...base.check, runtimeRender: cleanProbe } };
  const workspace = new AgentWorkspace();
  await workspace.init();
  workspace.write(SOURCE);
  const evaluationAgent: AgentSpec = { provider: 'anthropic', model: TEXT_MODEL };
  const visualEvalAgent: AgentSpec = { provider: 'anthropic', model: VISUAL_MODEL };
  const fakeLlmEvalMod: typeof realLlmEvaluator = {
    ...realLlmEvaluator,
    runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 500, outputTokens: 100, ...textCache }),
  };
  const fakeVisualMod: typeof realVisualEvaluator | null =
    visualOutcome === null ? null : { ...realVisualEvaluator, runVisualEval: () => Promise.resolve(visualOutcome) };
  const ctx: EvalRoundContext = {
    workspace,
    harness,
    contract: undefined,
    userPrompt: 'a chat window',
    fixtureProps: {},
    classification,
    evaluationAgent,
    visualEvalAgent,
    visualEvaluation: undefined,
    visualThreshold: 70,
    qualityMode: 'fast',
    maxEvalRounds: 3,
    costTracker,
    llmEvalMod: fakeLlmEvalMod,
    visualMod: fakeVisualMod,
    preWarmPromise: undefined,
    probeOnly: false,
    probeRepairUsed: false,
  };
  const input: EvalRoundInput = { compiledCode: SOURCE, evalRoundsUsed: 0, preWarmedContext: undefined, prevModeSubcats: new Set(), prevFailFingerprints: new Set() };
  return { ctx, input };
}

describe('the in-loop visual judge’s spend reaches the round (ggui#1522)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('a round whose visual leg ran carries its tokens apart from evalTokens, and the tracker records them at the visual model', async () => {
    const tracker = new CostTracker(null);
    const { ctx, input } = await buildCtx({ issues: [], coverage: { status: 'ran' }, tokens: LEG }, tracker);
    const round = await runEvalRound(ctx, input);
    expect(round.inLoopVisualTokens).toEqual(LEG);
    expect(round.evalTokens).toMatchObject({ input: 500, output: 100 }); // the text evaluator's alone
    const expected = new CostTracker(null);
    expected.record(TEXT_MODEL, 500, 100);
    expected.record(VISUAL_MODEL, LEG.inputTokens, LEG.outputTokens);
    expected.record(VISUAL_MODEL, LEG.criteria!.inputTokens, LEG.criteria!.outputTokens);
    const textOnly = new CostTracker(null);
    textOnly.record(TEXT_MODEL, 500, 100);
    expect(tracker.getTotal()).toBeCloseTo(expected.getTotal(), 10);
    expect(tracker.getTotal()).toBeGreaterThan(textOnly.getTotal()); // the RED: before, the tracker held only this
  });

  it('a budget the visual spend exhausts stops the loop — canContinue() sees it', async () => {
    const probeTracker = new CostTracker(null);
    probeTracker.record(TEXT_MODEL, 500, 100);
    const textSpend = probeTracker.getTotal();
    // A budget the text evaluator alone stays under, and the visual spend crosses.
    const tracker = new CostTracker(textSpend * 1.01);
    const { ctx, input } = await buildCtx({ issues: [], coverage: { status: 'ran' }, tokens: LEG }, tracker);
    await runEvalRound(ctx, input);
    expect(tracker.canContinue()).toBe(false);
  });

  it('no visual leg, or a leg that reported no tokens → no part on the round, and the tracker holds the text evaluator alone', async () => {
    for (const outcome of [null, { issues: [], coverage: { status: 'skipped' as const, reason: 'no browser' } }]) {
      const tracker = new CostTracker(null);
      const { ctx, input } = await buildCtx(outcome, tracker);
      const round = await runEvalRound(ctx, input);
      expect('inLoopVisualTokens' in round).toBe(false);
      const textOnly = new CostTracker(null);
      textOnly.record(TEXT_MODEL, 500, 100);
      expect(tracker.getTotal()).toBeCloseTo(textOnly.getTotal(), 10);
    }
  });

  it('the runner folds each round’s part into the run’s own part — never into the coding / text totals', () => {
    const telemetry = createTelemetry();
    absorbInLoopVisualTokens(telemetry, LEG);
    absorbInLoopVisualTokens(telemetry, { inputTokens: 200, outputTokens: 80 });
    absorbInLoopVisualTokens(telemetry, undefined);
    expect(telemetry.inLoopVisualTokens).toEqual({ inputTokens: 2000, outputTokens: 500, criteria: { inputTokens: 3600, outputTokens: 2200 } });
    expect(telemetry.totalIn).toBe(0);
    expect(telemetry.totalOut).toBe(0);
  });
});

describe('the text evaluator’s prompt-cache spend reaches the cap (ggui#1524)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('a round whose text evaluator read and wrote the cache records both, at the evaluator’s cache rates', async () => {
    const tracker = new CostTracker(null);
    const { ctx, input } = await buildCtx(null, tracker, { cacheReadTokens: 40_000, cacheCreationTokens: 8000 });
    await runEvalRound(ctx, input);
    const expected = new CostTracker(null);
    expected.record(TEXT_MODEL, 500, 100, { read: 40_000, write: 8000 });
    const uncachedOnly = new CostTracker(null);
    uncachedOnly.record(TEXT_MODEL, 500, 100);
    expect(tracker.getTotal()).toBeCloseTo(expected.getTotal(), 12);
    expect(tracker.getTotal()).toBeGreaterThan(uncachedOnly.getTotal()); // the RED: before, the tracker held only this
  });
});
