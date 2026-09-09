/**
 * `createUiGenerator({ designMode })` reaches the dispatch seam — and,
 * through it, the harness / prompt builder — typed end to end.
 *
 * `dispatchGeneration` is mocked and its params captured; the load-bearing
 * assertion is that the option travels structurally (no string threading,
 * no casts) and that the canvas is derived from `input.rendering`.
 * Omitting the option leaves the params byte-identical to today's shape
 * (no `designMode` key at all).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';
import type { GenerationDispatchParams } from './adapters/generation-dispatch.js';

const captured: GenerationDispatchParams[] = [];
vi.mock('./adapters/generation-dispatch.js', () => ({
  dispatchGeneration: (params: GenerationDispatchParams): Promise<GenerationResult> => {
    captured.push(params);
    return Promise.resolve({
      compiledCode: 'export default function C(){return null;}',
      sourceCode: 'export default function C(){return null;}',
      tokens: { input: 1, output: 1, total: 2 },
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
    });
  },
}));

const { createUiGenerator } = await import('./create-ui-generator.js');

function fakeInput(rendering?: UiGenerateInput['rendering']): UiGenerateInput {
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
    ...(rendering ? { rendering } : {}),
  };
}

describe('createUiGenerator — designMode option threading', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('omitted → dispatch params carry NO designMode / canvas keys (constrained default, byte-identical shape)', async () => {
    await createUiGenerator({ disableEnvMutation: true }).generate(fakeInput());
    expect(captured).toHaveLength(1);
    expect('designMode' in captured[0]!).toBe(false);
    expect('canvas' in captured[0]!).toBe(false);
  });

  it("designMode: 'free' reaches dispatch structurally", async () => {
    await createUiGenerator({ designMode: 'free', disableEnvMutation: true }).generate(fakeInput());
    expect(captured[0]!.designMode).toBe('free');
  });

  it('derives the canvas from input.rendering (chat → xs-card; desktop fullscreen → lg; viewport refines)', async () => {
    const gen = createUiGenerator({ designMode: 'free', disableEnvMutation: true });
    await gen.generate(fakeInput({ device: 'desktop', shell: 'chat' }));
    await gen.generate(fakeInput({ device: 'desktop', shell: 'fullscreen' }));
    await gen.generate(fakeInput({ device: 'mobile', shell: 'fullscreen' }));
    await gen.generate(fakeInput({ device: 'desktop', shell: 'fullscreen', viewport: { width: 1600, height: 900 } }));
    await gen.generate(fakeInput({ device: 'desktop', shell: 'partial' }));
    expect(captured.map((p) => p.canvas)).toEqual(['xs-card', 'lg', 'mobile', 'xl', 'md']);
  });
});
