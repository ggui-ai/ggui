/**
 * ggui#1279 — a declared CHAT rendering composes for the chat card.
 *
 * `createUiGenerator` mapped `input.rendering` into the user-prompt text and
 * the harness `canvas`, but never into the harness shell. So a declared chat
 * card composed on the FULLSCREEN WHAT leg (`<Box padding="lg">`, "this root
 * FILLS the frame … bands use the whole width") under the fullscreen shell
 * descriptor ("the full host viewport … the frame stretches your root to its
 * height"), while the user prompt said "chat card 384×516" and the fit
 * verdict measured an inline card. Pinned here:
 *  - a declared chat shell reaches `dispatchGeneration` as `shellType: 'chat'`
 *    (RED before the forward), and that shell selects the chat layout;
 *  - every other rendering, and no rendering, passes NO shell — the dispatch
 *    params are byte-identical to before, so fullscreen generations do not move.
 * `dispatchGeneration` is mocked and its params captured.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UiGenerateInput } from '@ggui-ai/mcp-server-core';
import type { GenerationResult } from './harness/result-types.js';
import type { GenerationDispatchParams } from './adapters/generation-dispatch.js';
import { generateBoilerplate } from './boilerplate/generate.js';

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
    ...(rendering !== undefined ? { rendering } : {}),
  };
}

async function dispatchedFor(rendering?: UiGenerateInput['rendering']): Promise<GenerationDispatchParams> {
  await createUiGenerator().generate(fakeInput(rendering));
  const params = captured.at(-1);
  if (params === undefined) throw new Error('dispatchGeneration was not called');
  return params;
}

describe('createUiGenerator — the harness shell follows a declared chat rendering (ggui#1279)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('a declared chat card composes for the chat shell', async () => {
    const params = await dispatchedFor({ device: 'desktop', shell: 'chat', viewport: { width: 384, height: 516 } });
    expect(params.shellType).toBe('chat');
  });

  it('a fullscreen rendering, a partial one, and no rendering pass no shell — the dispatch is byte-identical to before', async () => {
    for (const rendering of [
      { device: 'desktop' as const, shell: 'fullscreen' as const },
      { device: 'mobile' as const, shell: 'fullscreen' as const, viewport: { width: 390, height: 844 } },
      { device: 'desktop' as const, shell: 'partial' as const },
      undefined,
    ]) {
      const params = await dispatchedFor(rendering);
      expect('shellType' in params, `rendering ${JSON.stringify(rendering)}`).toBe(false);
    }
  });

  it('the chat shell selects the inline-card layout — compact, and adding no chrome the chat bubble already draws', () => {
    const chat = generateBoilerplate('welcome card with quick replies', undefined, 'chat');
    const chatMobile = generateBoilerplate('welcome card with quick replies', undefined, 'chat', 'mobile');
    const fullscreen = generateBoilerplate('welcome card with quick replies', undefined, undefined);
    for (const scaffold of [chat, chatMobile]) {
      expect(scaffold).toContain('<Box padding="md">');
      expect(scaffold).toContain('the chat bubble around it');
      // The chat shell hint the same generation carries says the parent provides the card
      // border + shadow: the scaffold must not add its own (the old <Card shadow="sm"> did).
      expect(scaffold).not.toContain('shadow="sm"');
      expect(scaffold).not.toContain('<Card');
    }
    expect(chat).not.toContain('this root FILLS the frame');
    expect(fullscreen).toContain('this root FILLS the frame');
    expect(fullscreen).toBe(generateBoilerplate('welcome card with quick replies', undefined, 'fullscreen'));
  });
});
