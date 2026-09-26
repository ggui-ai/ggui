// ggui#1281 — the eval round's tokens carry the eval calls' prompt-cache accounting, so the
// generation's `tokens.total` (non-cached input + cache creation + cache read + output, #1186)
// holds ONE convention across coding and eval calls. Absent when the evaluator reported none.
// RED before `evalTokens` carries the cache fields, GREEN after.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';
import { absorbTokens, createTelemetry } from './generate-task-runner.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

async function buildCtx(llmEvalMod: typeof realLlmEvaluator): Promise<{ ctx: EvalRoundContext; input: EvalRoundInput }> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'test prompt' }), riskTier: 'medium' as const };
  const harness = createHarness({ classification, contract: {}, prompt: 'test prompt' });
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
    visualThreshold: 70,
    qualityMode: 'fast',
    maxEvalRounds: 3,
    costTracker: new CostTracker(null),
    llmEvalMod,
    visualMod: null,
    preWarmPromise: undefined,
    probeOnly: false,
    probeRepairUsed: false,
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

describe('the eval round carries its calls’ prompt-cache accounting (ggui#1281)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('evalTokens carries the evaluator’s measured cache reads and writes', async () => {
    const mod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () =>
        Promise.resolve({ issues: [], pass: [], inputTokens: 21, outputTokens: 350, cacheReadTokens: 84_000, cacheCreationTokens: 2_800 }),
    };
    const { ctx, input } = await buildCtx(mod);

    const round = await runEvalRound(ctx, input);

    expect(round.evalTokens).toEqual({ input: 21, output: 350, cacheRead: 84_000, cacheCreation: 2_800 });
  });

  it('an evaluator that reported no cache leaves evalTokens without cache keys (unreported, never zero)', async () => {
    const mod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 500, outputTokens: 50 }),
    };
    const { ctx, input } = await buildCtx(mod);

    const round = await runEvalRound(ctx, input);

    expect(round.evalTokens).toEqual({ input: 500, output: 50 });
  });
});

describe('absorbTokens — one rule for coding and eval calls', () => {
  it('adds input/output, and cache counts only when reported (seeded on first report; unreported stays absent)', () => {
    const t = createTelemetry();
    absorbTokens(t, { input: 10, output: 5 });
    expect(t.cacheReadTokens).toBeUndefined();
    expect(t.cacheCreationTokens).toBeUndefined();
    absorbTokens(t, { input: 20, output: 7, cacheRead: 80_240 });
    absorbTokens(t, { input: 30, output: 9, cacheRead: 315_461, cacheCreation: 1_200 });
    expect(t.totalIn).toBe(60);
    expect(t.totalOut).toBe(21);
    expect(t.cacheReadTokens).toBe(80_240 + 315_461);
    expect(t.cacheCreationTokens).toBe(1_200);
  });
});
