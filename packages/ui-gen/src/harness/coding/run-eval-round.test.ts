/**
 * Unit tests for `runEvalRound` — #484 routeOverride + #489 onRetry
 * threading.
 *
 * Scope: this file exists to close a specific regression class a
 * prior review caught — the tier-1/2 LLM-eval config object literal
 * built inside `runEvalRound` dropped `evaluationAgent.routeOverride`
 * on the floor, silently reopening the `process.env` concurrency race
 * for the evaluation phase even when `disableEnvMutation` was set.
 * The identical class recurred with `evaluationAgent.onRetry` (#489
 * final-review finding): the field is threaded onto `AgentSpec` but
 * silently dropped at this same object literal, making eval-leg 429
 * retries invisible to a host application's `provider_429_retrying`
 * structured log even though they still happen. Both fields are
 * pinned in the same test now, at the same seam, so a future field
 * addition that repeats this drop pattern has one obvious place to
 * extend rather than a new file. It is not a general-purpose `runEvalRound` test
 * suite — the fixture below is deliberately minimal (low-risk-bypass
 * avoided via an explicit `riskTier` override, `runCheck` mocked,
 * visual eval disabled) so the real seam under test — the object
 * literal passed to `llmEvalMod.runLLMEvaluation` — is exercised
 * without needing a full harness/coding-agent integration setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import type { LLMEvalConfig, LLMEvalContext, PreWarmedEvalContext } from '../../evaluation/llm-evaluator.js';
import { LLM_EVAL_STATIC_CRITERIA } from '../../evaluation/types-public.js';
import type { CriterionCoverage } from '../../evaluation/types-public.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));

// Import AFTER the mock is registered so the module binds the stub.
const { runEvalRound } = await import('./run-eval-round.js');

describe('runEvalRound — routeOverride + onRetry threading (#484, #489)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it("threads evaluationAgent.routeOverride and onRetry into runLLMEvaluation's config (fails if the object literal drops either)", async () => {
    // Real Classification, forced off the low-risk-bypass path so
    // execution reaches the tier-1/2 LLM-eval block.
    const classification = {
      ...classifyAxes({ contract: {}, prompt: 'test prompt' }),
      riskTier: 'medium' as const,
    };
    const harness = createHarness({ classification, contract: {}, prompt: 'test prompt' });
    const workspace = new AgentWorkspace();
    await workspace.init();
    const compiledCode = 'export default function C() { return null; }';
    workspace.write(compiledCode);
    const costTracker = new CostTracker(null);

    const capturedConfigs: LLMEvalConfig[] = [];
    // Typed override via spread from the REAL module — no cast. Only
    // `runLLMEvaluation` is replaced; every other export (incl. types)
    // passes through untouched.
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: (
        _context: LLMEvalContext,
        config: LLMEvalConfig,
        _preWarmedContext?: PreWarmedEvalContext | null,
      ) => {
        capturedConfigs.push(config);
        return Promise.resolve({ issues: [], pass: [], inputTokens: 0, outputTokens: 0 });
      },
    };

    const onRetrySpy = vi.fn();
    const evaluationAgent: AgentSpec = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      routeOverride: { apiKey: 'eval-route-key' },
      onRetry: onRetrySpy,
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
      visualEvaluation: undefined,
      visualThreshold: 0.7,
      qualityMode: 'fast',
      maxEvalRounds: 3,
      costTracker,
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

    await runEvalRound(ctx, input);

    expect(capturedConfigs).toHaveLength(1);
    // The load-bearing assertions — routeOverride is the field the
    // #484 regression dropped; onRetry is the field the #489
    // final-review found dropped at this exact same object literal.
    expect(capturedConfigs[0]?.routeOverride).toEqual({ apiKey: 'eval-route-key' });
    expect(capturedConfigs[0]?.onRetry).toBe(onRetrySpy);
  });
});

/**
 * Same drop-at-the-literal class, third field: `criteriaCoverage`.
 * `runLLMEvaluation` stamps it; `runEvalRound` rebuilds `evalResult`
 * by object literal at every exit and (before this pin) dropped it —
 * the bench reporter then saw the exact silent-absence class the field
 * exists to close (benchmark's adversarial verify, 2026-09-02).
 */
describe('runEvalRound — criteriaCoverage carry-through + bypass stamp', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  async function buildCtx(riskTier: 'low' | 'medium', llmEvalMod: typeof realLlmEvaluator | null) {
    const classification = {
      ...classifyAxes({ contract: {}, prompt: 'test prompt' }),
      riskTier,
    };
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
      visualThreshold: 0.7,
      qualityMode: 'fast',
      maxEvalRounds: 3,
      costTracker: new CostTracker(null),
      llmEvalMod,
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

  it("carries runLLMEvaluation's criteriaCoverage onto the round's evalResult (fails if any exit literal drops it)", async () => {
    const stamped: CriterionCoverage[] = LLM_EVAL_STATIC_CRITERIA.map(({ criterion, tier }, i) =>
      i === 1
        ? { criterion, tier, status: 'skipped', reason: 'API rate limit exceeded' }
        : { criterion, tier, status: 'ran' },
    );
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () =>
        Promise.resolve({ issues: [], pass: [], criteriaCoverage: stamped, inputTokens: 0, outputTokens: 0 }),
    };
    const { ctx, input } = await buildCtx('medium', fakeLlmEvalMod);

    const round = await runEvalRound(ctx, input);

    expect(round.evalResult?.criteriaCoverage).toEqual(stamped);
    // The probe meta is stamped on this exit too — proves the spread
    // kept coverage while the literal re-stamped runtimeProbe.
    expect(round.evalResult?.runtimeProbe).toBeDefined();
  });

  it('stamps every criterion not-applicable (with the bypass reason) on the same-image low-risk bypass exit', async () => {
    const { ctx, input } = await buildCtx('low', null);

    const round = await runEvalRound(ctx, input);

    expect(round.evalResult?.pass).toContain('axis.low-risk');
    const cov = round.evalResult?.criteriaCoverage ?? [];
    expect(cov.map((c) => c.criterion)).toEqual(LLM_EVAL_STATIC_CRITERIA.map((c) => c.criterion));
    expect(cov.every((c) => c.status === 'not-applicable')).toBe(true);
    expect(cov.every((c) => typeof c.reason === 'string' && c.reason.includes('low-risk bypass'))).toBe(true);
  });
});
