/**
 * #484 final-review Important — `callLLM`/`callLLMWithTools` called
 * `createAgent(config.provider)` (the bare-string overload) instead of
 * `createAgent(config)`, silently dropping `config.routeOverride`. A
 * self-hoster supplying `routeOverride` (per the field's own docstring
 * promise: "bypasses process.env entirely when supplied") got ambient
 * `process.env` instead — exactly the concurrency race #484 exists to
 * close, and `callLLM` is re-exported on the published surface.
 *
 * `createAgent` is defined in this same module, so it cannot be
 * `vi.mock`-intercepted from a test exercising `callLLM`/
 * `callLLMWithTools` (same-module internal calls resolve against the
 * module's own local bindings, not the mocked export — verified by
 * hand: a same-file `vi.mock(..., importOriginal)` self-mock never
 * observed the call). Mirrors `llm-router.env-injection.test.ts`'s
 * pattern instead: spy on the real client factory and assert
 * `routeOverride.apiKey` reaches it, proving the override survived
 * the full `callLLM`/`callLLMWithTools` → `createAgent` → `AnthropicAgent`
 * → `createClient()` chain rather than asserting on a mocked
 * intermediate call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLLM, callLLMWithTools } from './llm-router.js';
import type { AgentConfig } from './llm-router.js';

describe('callLLM/callLLMWithTools — routeOverride threading (#484)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-key-should-not-be-used';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('callLLM threads config.routeOverride.apiKey to the real Anthropic client factory, not process.env', async () => {
    const spy = vi.spyOn(
      await import('../adapters/claude/client.js'),
      'createAnthropicClient',
    );
    const config: AgentConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      routeOverride: { apiKey: 'override-key-callLLM' },
    };
    await callLLM(config, 'sys', 'user').catch(() => {
      // Expected — no real network access in this test; the assertion
      // is on how the client was CONSTRUCTED, not on a successful call.
    });
    expect(spy).toHaveBeenCalledWith('override-key-callLLM');
  });

  it('callLLMWithTools threads config.routeOverride.apiKey to the real Anthropic client factory, not process.env', async () => {
    const spy = vi.spyOn(
      await import('../adapters/claude/client.js'),
      'createAnthropicClient',
    );
    const config: AgentConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      routeOverride: { apiKey: 'override-key-callLLMWithTools' },
    };
    await callLLMWithTools(config, 'sys', 'user', []).catch(() => {
      // Expected — see above.
    });
    expect(spy).toHaveBeenCalledWith('override-key-callLLMWithTools');
  });
});
