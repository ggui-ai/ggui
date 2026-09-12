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
import * as realVisualEvaluator from '../../evaluation/visual-evaluator.js';
import type { VisualEvalConfig } from '../../evaluation/visual-evaluator.js';
import type { VisualEvalSummary } from '../../evaluation/types-public.js';
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

/**
 * Per-canvas visual judging reaches the harness result: the round
 * threads `visualEvaluation.canvases` into the visual leg's config and
 * stamps the leg's PNG-free summary on `evalResult.visual` (→
 * `GenerationResult.evalResult.visual`, the bench's
 * `tierEvaluation.visual`). Without canvases the field is absent — the
 * pre-canvas result shape, byte for byte.
 */
describe('runEvalRound — per-canvas visual summary → evalResult.visual', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  async function buildCtx(
    visualEvaluation: EvalRoundContext['visualEvaluation'],
    visualMod: EvalRoundContext['visualMod'],
  ) {
    const classification = {
      ...classifyAxes({ contract: {}, prompt: 'test prompt' }),
      riskTier: 'medium' as const,
    };
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
      maxEvalRounds: 3,
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

  it("the in-loop visual round renders the caller's fixtureProps as its sample unless the config names its own (the round judges the same sample the runtime probe renders)", async () => {
    const fixture = { heading: 'Welcome', quickReplies: [{ id: 'a', label: 'A' }] };
    const configSample = { heading: 'From config' };
    const summary: VisualEvalSummary = { score: 84, passed: true, canvases: [] };
    const captured: VisualEvalConfig[] = [];
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: (_context, config) => {
        captured.push(config);
        return Promise.resolve({ issues: [], summary });
      },
    };
    const a = await buildCtx({ enabled: true }, fakeVisualMod);
    await runEvalRound({ ...a.ctx, fixtureProps: fixture }, a.input);
    const b = await buildCtx({ enabled: true, sampleProps: configSample }, fakeVisualMod);
    await runEvalRound({ ...b.ctx, fixtureProps: fixture }, b.input);
    const c = await buildCtx({ enabled: true }, fakeVisualMod);
    await runEvalRound(c.ctx, c.input);
    expect(captured.map((cfg) => cfg.sampleProps)).toEqual([fixture, configSample, undefined]);
  });

  it("the caller's cssTokens reach the visual round's config verbatim; absent ⇒ no key", async () => {
    const summary: VisualEvalSummary = { score: 84, passed: true, canvases: [] };
    const captured: Parameters<typeof realVisualEvaluator.runVisualEval>[0][] = [];
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: (context, _config) => {
        captured.push(context);
        return Promise.resolve({ issues: [], summary });
      },
    };
    const themed = await buildCtx({ enabled: true, cssTokens: ':root{--ggui-color-onContainer:#fff}' }, fakeVisualMod);
    await runEvalRound(themed.ctx, themed.input);
    const plain = await buildCtx({ enabled: true }, fakeVisualMod);
    await runEvalRound(plain.ctx, plain.input);
    expect(captured[0]?.cssTokens).toBe(':root{--ggui-color-onContainer:#fff}');
    expect('cssTokens' in captured[1]!).toBe(false);
  });

  it('threads canvases into the visual config and stamps the summary on evalResult.visual', async () => {
    const summary: VisualEvalSummary = {
      score: 84,
      passed: true,
      canvases: [
        { canvas: 'xs-chat-card', viewport: { width: 400, height: 640 }, score: 80, passed: true, contentHeight: 600, overflow: false },
        { canvas: 'xl', viewport: { width: 1440, height: 900 }, score: 88, passed: true, contentHeight: 1200, overflow: true },
      ],
    };
    const captured: VisualEvalConfig[] = [];
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: (_context, config) => {
        captured.push(config);
        return Promise.resolve({ issues: [], summary });
      },
    };
    const { ctx, input } = await buildCtx({ enabled: true, canvases: ['xs-chat-card', 'xl'] }, fakeVisualMod);

    const round = await runEvalRound(ctx, input);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.canvases).toEqual(['xs-chat-card', 'xl']);
    expect(captured[0]?.passThreshold).toBe(70);
    expect(round.evalResult?.visual).toEqual(summary);
  });

  it('without canvases the visual leg returns no summary and evalResult carries no `visual` key', async () => {
    const fakeVisualMod: typeof realVisualEvaluator = {
      ...realVisualEvaluator,
      runVisualEval: () => Promise.resolve({ issues: [] }),
    };
    const { ctx, input } = await buildCtx({ enabled: true }, fakeVisualMod);

    const round = await runEvalRound(ctx, input);

    expect(round.evalResult).toBeDefined();
    expect('visual' in round.evalResult!).toBe(false);
  });
});

/**
 * Pin (ggui#1046 / #1053): the cap check runs BEFORE the feedback turn. With
 * `maxEvalRounds: 1` a blocking tier-0 issue found in round 1 is recorded and
 * the round breaks — no feedback turn is ever sent, so the fail is a report,
 * never a fix. With 2 the same issue buys the feedback turn. This is the
 * order that made a serving deployment's minting lane (round cap 1) leave a
 * flagged board stacked while a local run (default 2) composed it — the
 * lane's cap is a config choice, and this pin is the contract it chooses on.
 */
describe('runEvalRound — the round cap is checked before the feedback turn (ggui#1046 / #1053)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
  });

  async function roundWithBlockingFail(maxEvalRounds: number) {
    const classification = { ...classifyAxes({ contract: {}, prompt: 'a kanban board' }), riskTier: 'medium' as const };
    const harness = createHarness({ classification, contract: {}, prompt: 'a kanban board' });
    const workspace = new AgentWorkspace();
    await workspace.init();
    const compiledCode = 'export default function C() { return null; }';
    workspace.write(compiledCode);
    mockRunCheck.mockResolvedValue({
      issues: [
        {
          tier: 0,
          result: 'fail',
          category: 'mode',
          priority: 'P0',
          subcategory: 'grid.board_columns_side_by_side',
          description: 'The board\'s `columns` are composed under <Stack>.',
          fix: 'Wrap the columns map in <Grid columns={{ base: 1, md: columns.length }}>.',
        },
      ],
    });
    const fakeLlmEvalMod: typeof realLlmEvaluator = {
      ...realLlmEvaluator,
      runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 0, outputTokens: 0 }),
    };
    const evaluationAgent: AgentSpec = { provider: 'anthropic', model: 'claude-haiku-4-5' };
    const ctx: EvalRoundContext = {
      workspace,
      harness,
      contract: undefined,
      userPrompt: 'a kanban board',
      fixtureProps: undefined,
      classification,
      evaluationAgent,
      visualEvalAgent: evaluationAgent,
      visualEvaluation: undefined,
      visualThreshold: 0.7,
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
    return runEvalRound(ctx, input);
  }

  it('maxEvalRounds 1: the blocking tier-0 fail is recorded and the round BREAKS — no feedback turn', async () => {
    const out = await roundWithBlockingFail(1);
    expect(out.control).toBe('break');
    expect(out.evalRoundsUsed).toBe(1);
    expect(out.evalResult).toBeDefined();
    expect(out.evalResult?.issues.some((i) => i.subcategory === 'grid.board_columns_side_by_side' && i.result === 'fail')).toBe(true);
  });

  it('maxEvalRounds 2: the same fail buys the feedback turn', async () => {
    const out = await roundWithBlockingFail(2);
    expect(out.control).toBe('feedback');
    expect(out.evalRoundsUsed).toBe(1);
  });
});
