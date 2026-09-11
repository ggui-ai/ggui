/**
 * `UiGenerateInput.fixtureProps` — the caller's sample for the in-loop
 * render check and runtime probe (and the in-loop visual round). Two pins:
 *  - it reaches `dispatchGeneration` verbatim (RED before the forward);
 *  - invariant: with it set, the prompts are byte-identical to
 *    without — asserted by digest, not by "reaches the probe" alone.
 * `dispatchGeneration` is mocked and its params captured.
 */
import { createHash } from 'node:crypto';
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

const SAMPLE = { heading: 'Welcome to Trimly', quickReplies: [{ id: 'book', label: 'Book a slot' }] };

function fakeInput(fixtureProps?: UiGenerateInput['fixtureProps']): UiGenerateInput {
  return {
    request: { sessionId: 's1', prompt: 'welcome card with quick replies' },
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
    ...(fixtureProps !== undefined ? { fixtureProps } : {}),
  };
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('createUiGenerator — fixtureProps threading', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('reaches dispatchGeneration verbatim; omitted ⇒ no key (byte-identical param shape)', async () => {
    const gen = createUiGenerator({ disableEnvMutation: true });
    await gen.generate(fakeInput(SAMPLE));
    await gen.generate(fakeInput());
    expect(captured[0]!.fixtureProps).toEqual(SAMPLE);
    expect('fixtureProps' in captured[1]!).toBe(false);
  });

  it('invariant: the prompts are byte-identical with and without fixtureProps (digests), and nothing else moves', async () => {
    const gen = createUiGenerator({ disableEnvMutation: true });
    await gen.generate(fakeInput(SAMPLE));
    await gen.generate(fakeInput());
    const [withFixture, without] = captured as [GenerationDispatchParams, GenerationDispatchParams];
    expect(sha256(withFixture.userPrompt)).toBe(sha256(without.userPrompt));
    expect(sha256(withFixture.originalPrompt ?? '')).toBe(sha256(without.originalPrompt ?? ''));
    const project = (p: GenerationDispatchParams) => ({
      provider: p.provider,
      model: p.model,
      contract: p.contract,
      designMode: p.designMode,
      canvas: p.canvas,
      profile: p.profile,
      enableRuntimeRender: p.enableRuntimeRender,
      maxAttempts: p.maxAttempts,
      maxEvalRounds: p.maxEvalRounds,
      evaluation: p.evaluation,
    });
    expect(project(withFixture)).toEqual(project(without));
  });
});
