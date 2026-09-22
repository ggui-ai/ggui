// The fit verdict on a lane with no vision judge. The in-loop visual leg has two
// halves: the vision judge's score, which needs a vision provider, and the
// deterministic fit verdict (a frame at the declared box, its scroll height
// against the box's height), which needs a browser and nothing else. A lane
// whose generation provider has no vision judge (OpenAI, OpenRouter) skipped
// the WHOLE leg, so a hello taller than its declared chat card was never told
// so in the loop: the `[fit]` round the cap grants for exactly that case could
// not fire, and the card left the loop cut off.
//
// Pinned here: on a no-vision lane with canvases, the round runs the fit half
// alone — its canvas-overflow fail rides the round's issues and buys the
// `[fit]` round at the cap, the judge is never called, and the coverage still
// says the judge was skipped (with what the fit half measured). A vision lane
// is untouched: its judge path measures fit itself.
//
// RED before `runVisualFit` + the no-vision branch, GREEN after.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import * as realVisualEvaluator from '../../evaluation/visual-evaluator.js';
import type { VisualFitConfig, VisualFitOutcome } from '../../evaluation/visual-evaluator.js';
import type { EvalIssue } from '../../evaluation/types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

const DECLARED = { width: 384, height: 516 } as const;
const OPENAI: AgentSpec = { provider: 'openai', model: 'gpt-6-astra' };
const FIT_FAIL: EvalIssue = {
  tier: 2,
  result: 'fail',
  category: 'visual',
  subcategory: 'canvas-overflow',
  severity: 'critical',
  description:
    '[xs-chat-card] Rendered content is 535px tall on the xs-chat-card canvas (declared 384×516; class box 400×640) — 19px is cut off: the inline card does not scroll.',
  fix: 'Fit the composition to the canvas.',
};
const MEASURED_OVERFLOW: VisualFitOutcome = {
  status: 'measured',
  issues: [FIT_FAIL],
  readings: [{ canvas: 'xs-chat-card', viewport: DECLARED, contentHeight: 535, overflow: true, declared: true }],
};
const MEASURED_FITS: VisualFitOutcome = {
  status: 'measured',
  issues: [],
  readings: [{ canvas: 'xs-chat-card', viewport: DECLARED, contentHeight: 516, overflow: false, declared: true }],
};

interface Calls {
  judged: number;
  fit: VisualFitConfig[];
}

function fakeVisualMod(fit: () => Promise<VisualFitOutcome>): { mod: typeof realVisualEvaluator; calls: Calls } {
  const calls: Calls = { judged: 0, fit: [] };
  const mod: typeof realVisualEvaluator = {
    ...realVisualEvaluator,
    runVisualEval: () => {
      calls.judged += 1;
      return Promise.resolve({ issues: [], coverage: { status: 'ran' } });
    },
    runVisualFit: (_context, config) => {
      calls.fit.push(config);
      return fit();
    },
  };
  return { mod, calls };
}

async function buildCtx(
  visualEvaluation: EvalRoundContext['visualEvaluation'],
  visualMod: EvalRoundContext['visualMod'],
  visualEvalAgent: AgentSpec,
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
    fixtureProps: { heading: 'Welcome' },
    classification,
    evaluationAgent,
    visualEvalAgent,
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

const DECLARED_CARD: EvalRoundContext['visualEvaluation'] = {
  enabled: true,
  canvases: ['xs-chat-card'],
  canvasViewports: { 'xs-chat-card': DECLARED },
};

describe('the fit verdict on a lane with no vision judge', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('an OpenAI lane runs the fit half at the declared box: the judge is never called, the overflow fail rides the round, and the coverage names both', async () => {
    const { mod, calls } = fakeVisualMod(() => Promise.resolve(MEASURED_OVERFLOW));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, OPENAI);

    const round = await runEvalRound(ctx, input);

    expect(calls.judged, 'no vision judge on this lane').toBe(0);
    expect(calls.fit).toHaveLength(1);
    expect(calls.fit[0]?.canvases).toEqual(['xs-chat-card']);
    expect(calls.fit[0]?.canvasViewports).toEqual({ 'xs-chat-card': DECLARED });
    expect(calls.fit[0]?.sampleProps, 'the fit frame renders the same sample the judge would').toEqual({ heading: 'Welcome' });
    expect(round.evalResult?.issues).toContainEqual(FIT_FAIL);
    const coverage = round.evalResult?.visualCoverage;
    expect(coverage?.status, 'the JUDGE did not run').toBe('skipped');
    expect(coverage?.reason).toContain("no vision judge for provider 'openai'");
    expect(coverage?.reason).toContain('fit measured without the judge');
    expect(coverage?.reason).toContain('xs-chat-card 384×516 content 535px');
  });

  it('the overflow fail at the cap buys the [fit] round on an OpenAI lane — the repair that could never fire there before', async () => {
    const { mod } = fakeVisualMod(() => Promise.resolve(MEASURED_OVERFLOW));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, OPENAI, 1);

    const round = await runEvalRound(ctx, input);

    expect(round.control).toBe('feedback');
    expect(round.evalDone).toBe(false);
    expect(round.lastResultText).toContain('[fit]');
    expect(round.lastResultText).toContain('19px is cut off');
  });

  it('a card that fits adds no issue, and the round passes as it did before', async () => {
    const { mod, calls } = fakeVisualMod(() => Promise.resolve(MEASURED_FITS));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, OPENAI);

    const round = await runEvalRound(ctx, input);

    expect(calls.judged).toBe(0);
    expect(round.evalDone).toBe(true);
    expect(round.evalResult?.issues.some((i) => i.subcategory === 'canvas-overflow')).toBe(false);
    expect(round.evalResult?.visualCoverage?.reason).toContain('xs-chat-card 384×516 content 516px');
  });

  it('a fit half that cannot measure (no browser) says why on the coverage and the round survives', async () => {
    const { mod } = fakeVisualMod(() => Promise.resolve({ status: 'unavailable', reason: 'screenshot failed: no chromium' }));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, OPENAI);

    const round = await runEvalRound(ctx, input);

    expect(round.evalResult?.visualCoverage?.status).toBe('skipped');
    expect(round.evalResult?.visualCoverage?.reason).toContain("no vision judge for provider 'openai'");
    expect(round.evalResult?.visualCoverage?.reason).toContain('fit not measured: screenshot failed: no chromium');
    expect(round.evalResult?.runtimeProbe?.reason ?? '').not.toContain('eval round threw');
  });

  it('a fit half that REJECTS is recorded the same way and never throws the round', async () => {
    const { mod } = fakeVisualMod(() => Promise.reject(new Error('bundle exploded')));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, OPENAI);

    const round = await runEvalRound(ctx, input);

    expect(round.evalResult?.visualCoverage?.reason).toContain('fit not measured: bundle exploded');
    expect(round.evalResult?.runtimeProbe?.reason ?? '').not.toContain('eval round threw');
  });

  it('without canvases there is no fit verdict to take: the fit half is not run and the reason is the judge skip alone', async () => {
    const { mod, calls } = fakeVisualMod(() => Promise.resolve(MEASURED_FITS));
    const { ctx, input } = await buildCtx({ enabled: true }, mod, OPENAI);

    const round = await runEvalRound(ctx, input);

    expect(calls.fit).toHaveLength(0);
    expect(calls.judged).toBe(0);
    expect(round.evalResult?.visualCoverage?.reason).toContain("no vision judge for provider 'openai'");
    expect(round.evalResult?.visualCoverage?.reason).not.toContain('fit');
  });

  it('a vision lane is untouched: the judge runs and measures fit itself, the fit half is never called', async () => {
    const { mod, calls } = fakeVisualMod(() => Promise.resolve(MEASURED_OVERFLOW));
    const { ctx, input } = await buildCtx(DECLARED_CARD, mod, { provider: 'anthropic', model: 'claude-haiku-4-5' });

    await runEvalRound(ctx, input);

    expect(calls.judged).toBe(1);
    expect(calls.fit).toHaveLength(0);
  });
});
