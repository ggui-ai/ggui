// ggui#1195 — the in-loop half of "the chat card at the DECLARED viewport":
//   (1) `visualEvaluation.canvasViewports` reaches the visual leg's config
//       verbatim, so an in-loop per-canvas round judges the card at the same
//       box the composer targeted (same-target, condition #5);
//   (2) a `canvas-overflow` FAIL still active at the eval-round cap grants
//       ONE extra round with `[fit]`-tagged feedback — the same shape as the
//       runtime-probe extension — and the round after that stops.
// RED before the threading + the extension, GREEN after.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import * as realVisualEvaluator from '../../evaluation/visual-evaluator.js';
import type { VisualEvalConfig } from '../../evaluation/visual-evaluator.js';
import type { EvalIssue, VisualEvalSummary } from '../../evaluation/types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

const DECLARED = { width: 384, height: 516 } as const;
/** What `runVisualEval` emits for an overflowing inline card (severity critical ⇒ result fail). */
const FIT_FAIL: EvalIssue = {
  tier: 2,
  result: 'fail',
  category: 'visual',
  subcategory: 'canvas-overflow',
  severity: 'critical',
  description: 'Rendered content is 600px tall on the xs-chat-card canvas (declared 384×516; class box 400×640) — 84px is cut off: the inline card does not scroll.',
  fix: 'Fit the composition to the canvas.',
};
const FAILED_SUMMARY: VisualEvalSummary = { score: 80, passed: false, canvases: [] };

async function buildCtx(
  visualEvaluation: EvalRoundContext['visualEvaluation'],
  visualMod: EvalRoundContext['visualMod'],
  maxEvalRounds = 3,
): Promise<{ ctx: EvalRoundContext; input: EvalRoundInput }> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'test prompt' }), riskTier: 'medium' as const };
  const harness = createHarness({ classification, contract: {}, prompt: 'test prompt' });
  const workspace = new AgentWorkspace();
  await workspace.init();
  const compiledCode = 'export default function C() { return null; }';
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
    userPrompt: 'test prompt',
    fixtureProps: undefined,
    classification,
    evaluationAgent,
    visualEvalAgent: evaluationAgent,
    visualEvaluation,
    visualThreshold: 70,
    qualityMode: 'fast',
    maxEvalRounds,
    costTracker: new CostTracker(null),
    llmEvalMod: fakeLlmEvalMod,
    visualMod,
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

describe('ggui#1195 — declared-viewport threading + the [fit] extension at the cap', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it("threads visualEvaluation.canvasViewports into the visual leg's config verbatim; absent ⇒ no key", async () => {
    const captured: VisualEvalConfig[] = [];
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: (_context, config) => {
        captured.push(config);
        return Promise.resolve({ issues: [], summary: { score: 84, passed: true, canvases: [] } });
      },
    };
    const a = await buildCtx({ enabled: true, canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': DECLARED } }, fakeVisualMod);
    await runEvalRound(a.ctx, a.input);
    const b = await buildCtx({ enabled: true, canvases: ['xs-chat-card'] }, fakeVisualMod);
    await runEvalRound(b.ctx, b.input);
    expect(captured.map((c) => c.canvasViewports)).toEqual([{ 'xs-chat-card': DECLARED }, undefined]);
    expect('canvasViewports' in captured[1]!).toBe(false);
  });

  it('a canvas-overflow FAIL active at the cap grants ONE extra round with [fit]-tagged feedback; the round after that stops', async () => {
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: () => Promise.resolve({ issues: [FIT_FAIL], summary: FAILED_SUMMARY }),
    };
    const { ctx, input } = await buildCtx({ enabled: true, canvases: ['xs-chat-card'], canvasViewports: { 'xs-chat-card': DECLARED } }, fakeVisualMod, 1);
    const r1 = await runEvalRound(ctx, input);
    expect(r1.evalRoundsUsed).toBe(1);
    expect(r1.control, 'at the cap with a fit fail active: one more round').toBe('feedback');
    expect(r1.evalDone).toBe(false);
    expect(r1.lastResultText).toContain('[fit]');
    expect(r1.lastResultText).toContain('84px is cut off');
    const r2 = await runEvalRound(ctx, {
      ...input,
      evalRoundsUsed: r1.evalRoundsUsed,
      prevModeSubcats: r1.prevModeSubcats,
      prevFailFingerprints: r1.prevFailFingerprints,
    });
    expect(r2.control, 'the fit extension is ONE round').toBe('break');
    expect(r2.evalDone).toBe(false);
  });
});
