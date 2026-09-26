/**
 * Tests for `createUiGenerator`'s adapter-result → `GenerationMetadata`
 * mapping.
 *
 * `dispatchGeneration` is mocked so the generation pipeline is driven
 * deterministically — the load-bearing logic under test is purely how
 * the factory threads the adapter result's token counters (including
 * the provider-specific prompt-cache counters) into the metadata the
 * caller sees. The harness, compiler, and LLM are out of scope here
 * (they have their own tests).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';
import type { EvalResult } from './evaluation/types-public.js';
import { generatorBuild } from './generator-build.js';

// Mock the dispatch seam. The factory imports `dispatchGeneration`
// from this module path; the mock returns a controllable result so we
// can assert the metadata projection without a real LLM round-trip.
const dispatchMock = vi.fn<() => Promise<GenerationResult>>();
vi.mock('./adapters/generation-dispatch.js', () => ({
  dispatchGeneration: () => dispatchMock(),
}));

// Import AFTER the mock is registered so the factory binds the stub.
const { createUiGenerator } = await import('./create-ui-generator.js');

function fakeInput(): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'weather card' },
    llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
    providerKey: { provider: 'anthropic', key: 'sk-test' },
    blueprints: {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    },
  };
}

/**
 * Build a `GenerationResult` with only the fields the factory reads,
 * plus any cache-token overrides the test wants to exercise.
 */
function fakeResult(
  overrides: Partial<
    Pick<GenerationResult, 'cacheReadTokens' | 'cacheCreationTokens' | 'evalResult' | 'breakdown'>
  > = {},
): GenerationResult {
  return {
    compiledCode: 'export default function C(){return null;}',
    sourceCode: 'export default function C(){return null;}',
    tokens: { input: 100, output: 50, total: 150 },
    generationTimeMs: 1,
    turnsUsed: 1,
    passesUsed: 1,
    selfCheckPassed: true,
    needsBackgroundImprovement: false,
    timing: { totalMs: 1 },
    breakdown: {
      phases: { impl: 1, patch: 0, evalFix: 0, scaffold: 0, fill: 0 },
      outcomes: { pass: 1, patchInvalid: 0, selfCheckFail: 0, diffFail: 0 },
      evalRounds: 0,
      llmMs: 1,
      evalLlmMs: 0,
      toolMs: 0,
      evalMs: 0,
      codingMs: 1,
      setupMs: 0,
    },
    ...overrides,
  };
}

describe('createUiGenerator — cache-token metadata passthrough', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it('threads cacheReadTokens/cacheCreationTokens onto metadata when the adapter reports them (Claude)', async () => {
    dispatchMock.mockResolvedValue(
      fakeResult({ cacheReadTokens: 4096, cacheCreationTokens: 1024 }),
    );
    const generator = createUiGenerator();
    const out = await generator.generate(fakeInput());

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata.cacheReadTokens).toBe(4096);
    expect(out.metadata.cacheCreationTokens).toBe(1024);
    // Base counters are unaffected.
    expect(out.metadata.inputTokens).toBe(100);
    expect(out.metadata.outputTokens).toBe(50);
  });

  it('leaves cache-token fields undefined when the adapter omits them (non-Claude)', async () => {
    dispatchMock.mockResolvedValue(fakeResult());
    const generator = createUiGenerator();
    const out = await generator.generate(fakeInput());

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Truthful passthrough — absent on the adapter result means absent
    // on the metadata, never defaulted to 0.
    expect(out.metadata.cacheReadTokens).toBeUndefined();
    expect(out.metadata.cacheCreationTokens).toBeUndefined();
  });
});

// ggui#1280 — every generation names the BUILD that made it (the digests are
// template keys, never per-request), so a reused render can be told apart from
// a fresh one by the triad build that minted it.
describe('createUiGenerator — the build identity rides the metadata (ggui#1280)', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it('a default generation stamps the constrained build', async () => {
    dispatchMock.mockResolvedValue(fakeResult());
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    expect(out.metadata?.build).toEqual(generatorBuild('constrained'));
    expect(out.metadata?.build?.mode).toBe('constrained');
  });

  it('a free-design generation stamps the free build', async () => {
    dispatchMock.mockResolvedValue(fakeResult());
    const out = await createUiGenerator({ designMode: 'free' }).generate(fakeInput());
    expect(out.metadata?.build).toEqual(generatorBuild('free'));
  });

  it('a harness failure still names the build that failed', async () => {
    dispatchMock.mockRejectedValue(new Error('harness exploded'));
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(false);
    expect(out.metadata?.build).toEqual(generatorBuild('constrained'));
  });
});

// ggui#1380 — the runtime probe's record and the eval rounds' wall-clock ride
// the metadata a host reads (`runtimeProbe`, `evalMs`): a serving deployment
// that runs the probe once after the coding turns can see its status, timing
// and whether the one repair turn was bought and what came of it. Absent on
// the harness result stays absent here — never a default status, never 0.
describe('createUiGenerator — the runtime probe rides the metadata (ggui#1380)', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  const probed = (evalResult: EvalResult, evalRounds: number, evalMs: number): GenerationResult =>
    fakeResult({
      evalResult,
      breakdown: {
        phases: { impl: 1, patch: 0, evalFix: evalRounds > 1 ? 1 : 0, scaffold: 0, fill: 0 },
        outcomes: { pass: evalRounds, patchInvalid: 0, selfCheckFail: 0, diffFail: 0 },
        evalRounds,
        llmMs: 1,
        evalLlmMs: 0,
        toolMs: 0,
        evalMs,
        codingMs: 1,
        setupMs: 0,
      },
    });

  it('a probe that ran: status + elapsedMs + evalMs, no repair key when no repair turn was bought', async () => {
    dispatchMock.mockResolvedValue(
      probed({ issues: [], pass: ['probe-only'], runtimeProbe: { status: 'ran', elapsedMs: 812, renderMs: 640 } }, 1, 1234),
    );
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata.runtimeProbe).toEqual({ status: 'ran', elapsedMs: 812 });
    expect(out.metadata.evalMs).toBe(1234);
  });

  it('a repair that compiled: repair { attempted, compiled: true, afterStatus } from the re-probe record', async () => {
    dispatchMock.mockResolvedValue(
      probed(
        {
          issues: [],
          pass: ['probe-only'],
          runtimeProbe: { status: 'ran', elapsedMs: 30 },
          runtimeProbeRepair: { attempted: true, afterStatus: 'ran', recoverableFailAfter: false },
        },
        2,
        90,
      ),
    );
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata.runtimeProbe).toEqual({
      status: 'ran',
      elapsedMs: 30,
      repair: { attempted: true, compiled: true, afterStatus: 'ran' },
    });
    expect(out.metadata.evalMs).toBe(90);
  });

  it('a repair that did not compile: repair { attempted, compiled: false }, the pre-repair probe as the status', async () => {
    dispatchMock.mockResolvedValue(
      probed(
        {
          issues: [],
          pass: ['probe-only'],
          runtimeProbe: { status: 'ran', elapsedMs: 50 },
          runtimeProbeRepair: { attempted: true, compiled: false },
        },
        1,
        55,
      ),
    );
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata.runtimeProbe).toEqual({ status: 'ran', elapsedMs: 50, repair: { attempted: true, compiled: false } });
  });

  it('a not-applicable probe carries its status and nothing else', async () => {
    dispatchMock.mockResolvedValue(
      probed({ issues: [], pass: ['probe-only'], runtimeProbe: { status: 'not-applicable', reason: 'no contract surface' } }, 1, 3),
    );
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata.runtimeProbe).toEqual({ status: 'not-applicable' });
    expect(out.metadata.evalMs).toBe(3);
  });

  it('absent stays absent: no eval round on the harness result → neither field on the metadata', async () => {
    dispatchMock.mockResolvedValue(fakeResult());
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.metadata).not.toHaveProperty('runtimeProbe');
    expect(out.metadata).not.toHaveProperty('evalMs');
  });

  it('the harness-failed arm carries neither field', async () => {
    dispatchMock.mockRejectedValue(new Error('harness exploded'));
    const out = await createUiGenerator().generate(fakeInput());
    expect(out.ok).toBe(false);
    expect(out.metadata).toBeDefined();
    expect(out.metadata).not.toHaveProperty('runtimeProbe');
    expect(out.metadata).not.toHaveProperty('evalMs');
  });

  it('the route-resolution-failed arm carries neither field', async () => {
    const out = await createUiGenerator().generate({
      ...fakeInput(),
      llm: { provider: 'openai', model: 'gpt-5.5' },
      providerKey: { provider: 'openai', key: '' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.details).toEqual({ kind: 'route-resolution-failed' });
    expect(out.metadata).toBeDefined();
    expect(out.metadata).not.toHaveProperty('runtimeProbe');
    expect(out.metadata).not.toHaveProperty('evalMs');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
