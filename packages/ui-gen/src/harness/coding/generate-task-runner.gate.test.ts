/**
 * ggui#1380 — the runner's eval gate opens on a probe-only session (no
 * evaluation modules), and the one repair turn such a session buys is
 * turn-scoped: AT MOST ONE eval-fix coding turn per generation.
 *
 * Pinned at the runner seam with the real `initSession` (a real workspace,
 * a real harness carrying a stubbed probe, no evaluation modules) and the
 * real `runEvalRound`; only `runCodingTurn` is scripted at its module seam —
 * each scripted turn is what a coding turn returns, and the script reads
 * the runner's own input (`isEvalFeedback`) to label the phase the way the
 * real turn does, so the counters below are the runner's, not the script's.
 *
 *   - a clean probe: ONE coding turn, the probe once, one eval round,
 *     `pass: ['probe-only']`, eval wall-clock accounted;
 *   - a recoverable FAIL: exactly TWO coding turns (the repair), evalFix 1,
 *     then the second round breaks with the repair's after;
 *   - the repair turn failing self-check: still two turns, no third, the
 *     compiled code is the pre-repair compile, `runtimeProbeRepair:
 *     { attempted: true, compiled: false }`;
 *   - I4 at the runner: today's serve path (no probe, no evaluation) runs
 *     zero eval rounds and carries no evalResult; the evaluation lane is
 *     unchanged (gate opens on tiersMod, the evaluator runs once).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import type { EvalIssue } from '../../evaluation/types-public.js';
import type { RuntimeRenderCheck, RuntimeRenderOutcome, Task } from '../types-public.js';
import type { SingleComponentParams } from '../runtime.js';
import type { CodingTurnInput, CodingTurnResult, runCodingTurn } from './run-coding-turn.js';

const scripted = vi.hoisted(() => ({
  queue: [] as Array<(input: CodingTurnInput) => CodingTurnResult>,
  inputs: [] as CodingTurnInput[],
}));

// The runner reads `runCodingTurn` (and types) from this module — nothing else.
vi.mock('./run-coding-turn.js', () => ({
  runCodingTurn: async (_ctx: Parameters<typeof runCodingTurn>[0], input: CodingTurnInput): Promise<CodingTurnResult> => {
    scripted.inputs.push(input);
    const next = scripted.queue.shift();
    if (next === undefined) throw new Error(`unscripted coding turn #${scripted.inputs.length}`);
    return next(input);
  },
}));

const evaluator = vi.hoisted(() => ({ calls: 0 }));
const mockRunCheck = vi.fn();
// The round reads `runCheck` from the harness index — nothing else at runtime.
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
vi.mock('../../evaluation/llm-evaluator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../evaluation/llm-evaluator.js')>();
  return {
    ...actual,
    preWarmEval: vi.fn(async () => null),
    runLLMEvaluation: vi.fn(async () => {
      evaluator.calls += 1;
      return { issues: [], pass: ['functionality', 'crash'], inputTokens: 1, outputTokens: 1 };
    }),
  };
});

const { initSession, resolveSessionAgents } = await import('./init-session.js');
const { createGenerateTaskRunner, createTelemetry } = await import('./generate-task-runner.js');

const RECOVERABLE_CRASH: EvalIssue = {
  tier: 0,
  result: 'fail',
  category: 'crash',
  subcategory: 'runtime:render-no-throw',
  severity: 'critical',
  description: 'Component crashed at runtime: Render threw: TypeError: function is not iterable',
  fix: 'Render iterated over a non-array. Default to [] before .map.',
};

const PRE_REPAIR = 'var C = () => "before";';
const REPAIRED = 'var C = () => "after";';

/** A coding turn whose self-check passed — the phase labelled the way the real turn labels it. */
function proceed(compiledCode: string): (input: CodingTurnInput) => CodingTurnResult {
  return (input) => ({
    control: 'proceed',
    compiledCode,
    selfCheckPassed: true,
    outcome: 'PASS',
    phase: input.isEvalFeedback ? 'eval-fix' : 'impl',
    tokens: { input: 10, output: 5 },
    llmMs: 1,
    toolMs: 1,
    lastResultText: '',
    lastDiffFailed: false,
    isEvalFeedback: false,
    iconNamesCache: null,
    preWarmedContext: undefined,
  });
}

/** A coding turn whose self-check FAILED — the loop would ordinarily feed the violations back. */
function selfCheckFail(): (input: CodingTurnInput) => CodingTurnResult {
  return (input) => ({
    control: 'continue',
    compiledCode: '',
    selfCheckPassed: false,
    outcome: 'SELF_CHECK_FAIL',
    phase: input.isEvalFeedback ? 'eval-fix' : 'impl',
    tokens: { input: 10, output: 5 },
    llmMs: 1,
    toolMs: 1,
    lastResultText: '[TYPECHECK] x is not defined',
    lastDiffFailed: false,
    isEvalFeedback: false,
    iconNamesCache: null,
    preWarmedContext: undefined,
  });
}

/** A probe that answers from a queue, one outcome per call, and takes a few ms so the wall-clock reads. */
function queuedProbe(outcomes: RuntimeRenderOutcome[]): { probe: RuntimeRenderCheck; calls: () => number } {
  let calls = 0;
  const probe: RuntimeRenderCheck = {
    id: 'stub-runtime-render',
    run: async () => {
      calls += 1;
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error(`unscripted probe call #${calls}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return outcome;
    },
  };
  return { probe, calls: () => calls };
}

async function buildRunner(options: {
  probe: RuntimeRenderCheck | undefined;
  evaluation?: SingleComponentParams['evaluation'];
  riskTier?: 'low' | 'medium';
  maxTurns?: number;
}) {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a card' }), riskTier: options.riskTier ?? ('medium' as const) };
  const harness = createHarness({ classification, contract: {}, prompt: 'a card', runtimeRender: options.probe });
  const params: SingleComponentParams = {
    userPrompt: 'a card',
    ...(options.evaluation !== undefined ? { evaluation: options.evaluation } : {}),
  };
  const agents = resolveSessionAgents({ codingAgent: { provider: 'anthropic', model: 'claude-haiku-4-5' } });
  const session = await initSession({ harness, params, agents });
  const telemetry = createTelemetry();
  const generate = createGenerateTaskRunner({ session, params, classification, telemetry, maxTurns: options.maxTurns ?? 8 });
  const task: Task = {
    id: 'generate',
    systemPrompt: '',
    contextBuilder: () => '',
    outputFormat: 'text',
    outputParser: (raw) => (typeof raw === 'string' ? raw : ''),
    outputName: 'source',
  };
  const run = () => generate(task, { harness, priorResults: {}, classification, prompt: 'a card', contract: {} });
  return { session, telemetry, run };
}

describe('the runner gate on a probe-only session (ggui#1380)', () => {
  beforeEach(() => {
    scripted.queue.length = 0;
    scripted.inputs.length = 0;
    evaluator.calls = 0;
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('opens without tiersMod: one coding turn, the probe once, one round, pass [probe-only], eval wall-clock accounted', async () => {
    const { probe, calls } = queuedProbe([{ status: 'ran', issues: [], elapsedMs: 40 }]);
    scripted.queue.push(proceed(PRE_REPAIR));
    const { session, telemetry, run } = await buildRunner({ probe });
    expect(session.tiersMod).toBeNull();
    expect(session.probeOnlyEnabled).toBe(true);

    await run();

    expect(scripted.inputs).toHaveLength(1);
    // one definition of a turn on both lanes (rnd): a clean run is turn 1, no feedback turn
    expect(telemetry.turnsUsed).toBe(1);
    expect(scripted.inputs[0]?.isEvalFeedback).toBe(false);
    expect(calls()).toBe(1);
    expect(telemetry.evalRoundsUsed).toBe(1);
    expect(telemetry.evalResult?.pass).toEqual(['probe-only']);
    expect(telemetry.evalResult?.runtimeProbe).toEqual({ status: 'ran', verdict: 'pass', elapsedMs: 40 });
    expect(telemetry.cumulativeEvalWallMs).toBeGreaterThan(0);
    expect(telemetry.compiledCode).toBe(PRE_REPAIR);
    expect(telemetry.counters.phases.evalFix).toBe(0);
    expect(telemetry.probeRepairUsed).toBe(false);
  });

  it('a recoverable FAIL buys exactly TWO coding turns (the repair), evalFix 1, then the second round breaks', async () => {
    const { probe, calls } = queuedProbe([
      { status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 50 },
      { status: 'ran', issues: [], elapsedMs: 30 },
    ]);
    scripted.queue.push(proceed(PRE_REPAIR), proceed(REPAIRED));
    const { telemetry, run } = await buildRunner({ probe });

    await run();

    expect(scripted.inputs).toHaveLength(2);
    expect(scripted.inputs[1]?.isEvalFeedback).toBe(true);
    expect(scripted.inputs[1]?.lastResultText.startsWith('[runtime] crash/runtime:render-no-throw:')).toBe(true);
    expect(calls()).toBe(2);
    expect(telemetry.turnsUsed).toBe(2);
    expect(telemetry.evalRoundsUsed).toBe(2);
    expect(telemetry.counters.phases.evalFix).toBe(1);
    expect(telemetry.probeRepairUsed).toBe(true);
    expect(telemetry.compiledCode).toBe(REPAIRED);
    expect(telemetry.evalResult?.pass).toEqual(['probe-only']);
    expect(telemetry.evalResult?.runtimeProbe).toEqual({ status: 'ran', verdict: 'pass', elapsedMs: 30 });
    expect(telemetry.evalResult?.runtimeProbeRepair).toEqual({
      attempted: true,
      compiled: true,
      after: { status: 'ran', verdict: 'pass', elapsedMs: 30 },
    });
  });

  it('a recoverable FAIL that survives the repair still ends after the second round — no third turn', async () => {
    const { probe, calls } = queuedProbe([
      { status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 50 },
      { status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 45 },
    ]);
    scripted.queue.push(proceed(PRE_REPAIR), proceed(REPAIRED), proceed('var never = 1;'));
    const { telemetry, run } = await buildRunner({ probe });

    await run();

    expect(scripted.inputs).toHaveLength(2);
    expect(calls()).toBe(2);
    expect(telemetry.compiledCode).toBe(REPAIRED);
    expect(telemetry.evalResult?.runtimeProbeRepair).toEqual({
      attempted: true,
      compiled: true,
      after: { status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 45 },
    });
  });

  it('the repair turn failing self-check: two turns, no third, the pre-repair card, runtimeProbeRepair { attempted, compiled: false }', async () => {
    const { probe, calls } = queuedProbe([{ status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 50 }]);
    scripted.queue.push(proceed(PRE_REPAIR), selfCheckFail(), proceed('var never = 1;'));
    const { telemetry, run } = await buildRunner({ probe });

    const source = await run();

    expect(scripted.inputs).toHaveLength(2);
    expect(calls()).toBe(1);
    expect(telemetry.turnsUsed).toBe(2);
    expect(telemetry.evalRoundsUsed).toBe(1);
    expect(telemetry.counters.phases.evalFix).toBe(1);
    expect(telemetry.counters.outcomes.selfCheckFail).toBe(1);
    expect(telemetry.compiledCode).toBe(PRE_REPAIR);
    expect(telemetry.selfCheckPassed).toBe(true);
    expect(source).toBe(telemetry.pairedSource);
    expect(telemetry.evalResult?.pass).toEqual(['probe-only']);
    expect(telemetry.evalResult?.runtimeProbe).toEqual({ status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 50 });
    expect(telemetry.evalResult?.runtimeProbeRepair).toEqual({ attempted: true, compiled: false });
  });

  it('a risk=low generation still gets the probe-only round AND the repair — risk tier classifies the LLM-eval need, not crash risk (rnd)', async () => {
    const { probe, calls } = queuedProbe([
      { status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 50 },
      { status: 'ran', issues: [], elapsedMs: 30 },
    ]);
    scripted.queue.push(proceed(PRE_REPAIR), proceed(REPAIRED));
    const { telemetry, run } = await buildRunner({ probe, riskTier: 'low' });

    await run();

    expect(scripted.inputs).toHaveLength(2);
    expect(scripted.inputs[1]?.isEvalFeedback).toBe(true);
    expect(calls()).toBe(2);
    expect(telemetry.turnsUsed).toBe(2);
    expect(telemetry.evalResult?.pass).toEqual(['probe-only']);
    expect(telemetry.evalResult?.pass).not.toContain('axis.low-risk');
    expect(telemetry.evalResult?.runtimeProbeRepair).toEqual({
      attempted: true,
      compiled: true,
      after: { status: 'ran', verdict: 'pass', elapsedMs: 30 },
    });
    expect(telemetry.compiledCode).toBe(REPAIRED);
  });

  it('at the turn cap the granted repair is not taken: one turn, the probe record stays, no repair record, and the cap is said out loud', async () => {
    const { probe, calls } = queuedProbe([{ status: 'ran', issues: [RECOVERABLE_CRASH], elapsedMs: 50 }]);
    scripted.queue.push(proceed(PRE_REPAIR), proceed('var never = 1;'));
    const { telemetry, run } = await buildRunner({ probe, maxTurns: 1 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run();

    expect(scripted.inputs).toHaveLength(1);
    expect(calls()).toBe(1);
    expect(telemetry.turnsUsed).toBe(1);
    expect(telemetry.probeRepairUsed).toBe(true);
    expect(telemetry.compiledCode).toBe(PRE_REPAIR);
    expect(telemetry.evalResult?.runtimeProbe).toEqual({ status: 'ran', verdict: 'fail', failChecks: ['render-no-throw'], elapsedMs: 50 });
    expect(telemetry.evalResult).not.toHaveProperty('runtimeProbeRepair');
    expect(log.mock.calls.some(([m]) => typeof m === 'string' && m.startsWith('[simple] probe-only repair turn not taken — turn cap (1) reached'))).toBe(true);
  });

  it('I4 at the runner: today’s serve path (no probe, no evaluation) runs no eval round and carries no evalResult', async () => {
    scripted.queue.push(proceed(PRE_REPAIR));
    const { session, telemetry, run } = await buildRunner({ probe: undefined });
    expect(session.probeOnlyEnabled).toBe(false);

    await run();

    expect(scripted.inputs).toHaveLength(1);
    expect(telemetry.evalRoundsUsed).toBe(0);
    expect(telemetry.evalResult).toBeUndefined();
    expect(telemetry.cumulativeEvalWallMs).toBe(0);
    expect(telemetry.compiledCode).toBe(PRE_REPAIR);
  });

  it('I4 at the runner: the evaluation lane is unchanged — the gate opens on tiersMod and the evaluator runs once', async () => {
    const { probe, calls } = queuedProbe([{ status: 'ran', issues: [], elapsedMs: 20 }]);
    scripted.queue.push(proceed(PRE_REPAIR));
    const { session, telemetry, run } = await buildRunner({ probe, evaluation: { enabled: true, passThreshold: 70 } });
    expect(session.probeOnlyEnabled).toBe(false);
    expect(session.tiersMod).not.toBeNull();

    await run();

    expect(scripted.inputs).toHaveLength(1);
    expect(mockRunCheck).toHaveBeenCalledTimes(1);
    expect(evaluator.calls).toBe(1);
    expect(calls()).toBe(1);
    expect(telemetry.evalRoundsUsed).toBe(1);
    expect(telemetry.evalResult?.pass).toEqual(['functionality', 'crash']);
    expect(telemetry.evalResult?.runtimeProbe).toEqual({ status: 'ran', verdict: 'pass', elapsedMs: 20 });
    expect(telemetry.evalResult).not.toHaveProperty('runtimeProbeRepair');
  });
});
