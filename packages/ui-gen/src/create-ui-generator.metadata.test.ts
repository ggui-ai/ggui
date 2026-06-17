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
    Pick<GenerationResult, 'cacheReadTokens' | 'cacheCreationTokens'>
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
