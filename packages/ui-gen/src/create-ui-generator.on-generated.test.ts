/**
 * Pin for the `onGenerated` factory option: the observer receives the
 * SAME resolved harness result the dispatch seam returned (identity, not
 * a projection), exactly once per successful `generate()`, and is never
 * invoked on the failure path. `dispatchGeneration` is mocked — the
 * property under test is the factory's wiring, not the harness.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';

const dispatchMock = vi.fn<() => Promise<GenerationResult>>();
vi.mock('./adapters/generation-dispatch.js', () => ({
  dispatchGeneration: () => dispatchMock(),
}));

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

function fakeResult(): GenerationResult {
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
  };
}

describe('createUiGenerator — onGenerated observer', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it('fires once per successful generate() with the identical resolved result, before the envelope returns', async () => {
    const result = fakeResult();
    dispatchMock.mockResolvedValue(result);
    const seen: GenerationResult[] = [];
    let envelopeReturned = false;
    const generator = createUiGenerator({
      disableEnvMutation: true,
      onGenerated: (r) => {
        expect(envelopeReturned).toBe(false);
        seen.push(r);
      },
    });
    const out = await generator.generate(fakeInput());
    envelopeReturned = true;
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(result);
    if (!out.ok) return;
    expect(out.metadata.inputTokens).toBe(result.tokens.input);
    expect(out.response.componentCode).toBe(result.compiledCode);
  });

  it('is not invoked when generation fails', async () => {
    dispatchMock.mockRejectedValue(new Error('provider down'));
    const onGenerated = vi.fn();
    const generator = createUiGenerator({ disableEnvMutation: true, onGenerated });
    const out = await generator.generate(fakeInput());
    expect(out.ok).toBe(false);
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('absent (default) — generate() is unchanged', async () => {
    dispatchMock.mockResolvedValue(fakeResult());
    const out = await createUiGenerator({ disableEnvMutation: true }).generate(fakeInput());
    expect(out.ok).toBe(true);
  });
});
