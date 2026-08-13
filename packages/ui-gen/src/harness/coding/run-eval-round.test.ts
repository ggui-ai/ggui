/**
 * Unit tests for `runEvalRound` — #484 routeOverride threading.
 *
 * Scope: this file exists to close one specific regression a prior
 * review caught — the tier-1/2 LLM-eval config object literal built
 * inside `runEvalRound` dropped `evaluationAgent.routeOverride` on
 * the floor, silently reopening the `process.env` concurrency race
 * for the evaluation phase even when `disableEnvMutation` was set.
 * It is not a general-purpose `runEvalRound` test suite — the
 * fixture below is deliberately minimal (low-risk-bypass avoided via
 * an explicit `riskTier` override, `runCheck` mocked, visual eval
 * disabled) so the real seam under test — the object literal passed
 * to `llmEvalMod.runLLMEvaluation` — is exercised without needing a
 * full harness/coding-agent integration setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import type { LLMEvalConfig, LLMEvalContext, PreWarmedEvalContext } from '../../evaluation/llm-evaluator.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));

// Import AFTER the mock is registered so the module binds the stub.
const { runEvalRound } = await import('./run-eval-round.js');

describe('runEvalRound — routeOverride threading (#484)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it("threads evaluationAgent.routeOverride into runLLMEvaluation's config (fails if the object literal drops it)", async () => {
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

    const evaluationAgent: AgentSpec = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      routeOverride: { apiKey: 'eval-route-key' },
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
    // The load-bearing assertion — this is exactly the field the
    // reviewed regression dropped.
    expect(capturedConfigs[0]?.routeOverride).toEqual({ apiKey: 'eval-route-key' });
  });
});
