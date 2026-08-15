/**
 * #504 — the visual evaluator's provider calls must run through the
 * shared vision agent (`createVisionAgent`), not inline SDK clients.
 * Pinned the same way `llm-router.free-fns-route-override.test.ts`
 * pins #484: spy on the real Anthropic client factory and assert the
 * config's `routeOverride.apiKey` reaches construction — proving the
 * whole `VisualEvalConfig` → `createVisionAgent` → `AnthropicAgent`
 * → `createClient()` chain (including the `'claude'` → `'anthropic'`
 * provider mapping, which is what routes the call INTO that chain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callMultimodalLLM } from './visual-evaluator.js';

describe('callMultimodalLLM — routes through createVisionAgent (#504)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-key-should-not-be-used';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("provider 'claude' threads routeOverride.apiKey to the real Anthropic client factory", async () => {
    const spy = vi.spyOn(
      await import('../adapters/claude/client.js'),
      'createAnthropicClient',
    );
    await callMultimodalLLM(
      {
        provider: 'claude',
        passThreshold: 70,
        routeOverride: { apiKey: 'override-key-visual-eval' },
      },
      'claude-haiku-4-5',
      'system prompt',
      Buffer.from('png-bytes'),
      'original prompt',
    ).catch(() => {
      // Expected — no real network access in this test; the assertion
      // is on how the client was CONSTRUCTED, not on a successful call.
    });
    expect(spy).toHaveBeenCalledWith('override-key-visual-eval');
  });
});
