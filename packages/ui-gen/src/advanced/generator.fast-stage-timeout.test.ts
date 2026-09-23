// @vitest-environment node
//
// ggui#1299 — the advanced generator's fast stage when the isolated render
// check runs out of wall-clock time. The SANDBOX is stubbed to report its
// `timeout` outcome, so the real host mapping runs: before #1299 that mapping
// produced a `render-no-throw` FAIL ("runaway component"), the fast stage
// scored below the pass threshold, and the loop re-generated to the iteration
// cap chasing a crash that never happened. A timeout is no evidence either
// way, so it now takes the unverified posture and one generation stands.
// Plain Node environment on purpose: that is what routes the check to the
// isolated worker (whose spawn is the stubbed sandbox).

import { describe, expect, it, vi } from 'vitest';
import type { SandboxResult } from '@ggui-ai/sandbox';
import type { UiGenerateInput, UiGenerateResult, UiGenerator } from '@ggui-ai/mcp-server-core';

vi.mock('@ggui-ai/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ggui-ai/sandbox')>();
  return {
    ...actual,
    runSandboxed: async (): Promise<SandboxResult> => ({
      outcome: 'timeout',
      exitCode: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      durationMs: 30_400,
      stdoutTruncated: false,
      stderrTruncated: false,
      cwd: '/tmp',
      cwdOwnedBySandbox: true,
      nodeHeapMbApplied: true,
      errorMessage: '',
    }),
  };
});

import { createAdvancedUiGenerator } from './generator.js';

const INPUT: UiGenerateInput = {
  request: { prompt: 'a counter', sessionId: 'render-test' },
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  providerKey: { provider: 'anthropic', key: 'sk-test' },
  blueprints: { list: async () => [], get: async () => null },
};

const RESULT: UiGenerateResult = {
  ok: true,
  response: {
    sessionId: 'item-test',
    componentCode: 'export default function C(){ return null; }',
    sourceCode: 'export default function C() { return null; }',
  },
  metadata: {
    provider: 'anthropic',
    generator: 'ui-gen-stub',
    model: 'anthropic/claude-opus-4-7',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 1000,
    cacheHit: false,
    attempts: 1,
  },
};

describe('advanced generator — a fast-stage check that timed out (ggui#1299)', () => {
  it('is non-failing: one generation stands, no re-generation to the cap', async () => {
    const inner: UiGenerator = {
      slug: 'ui-gen-stub',
      tier: 'default',
      model: 'anthropic/claude-haiku-4-5',
      generate: async () => RESULT,
    };
    const innerSpy = vi.spyOn(inner, 'generate');
    const gen = createAdvancedUiGenerator({
      playwright: { chromium: { launch: vi.fn() } },
      innerGenerator: inner,
      maxIterations: 3,
    });

    // No actions → the slow stage is skipped, so the fast stage decides alone.
    const result = await gen.generate({ ...INPUT, contract: { propsSpec: { properties: {} } } });

    expect(result.ok).toBe(true);
    expect(innerSpy, 'a timed-out check is not a crash to regenerate against').toHaveBeenCalledTimes(1);
  });
});
