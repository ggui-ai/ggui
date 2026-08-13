import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createAgent } from './llm-router.js';

describe('LLMAgent routeOverride — bypasses process.env when supplied', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-key-should-not-be-used';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('AnthropicAgent.createClient() prefers routeOverride.apiKey over process.env.ANTHROPIC_API_KEY', async () => {
    const agent = createAgent({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      routeOverride: { apiKey: 'override-key', useBedrock: false },
    });
    // createClient() is protected; assert via the public surface —
    // constructing the client must not throw on a bogus env key,
    // and the resolved model must NOT take the Bedrock branch since
    // routeOverride.useBedrock=false overrides process.env's '1'.
    const spy = vi.spyOn(await import('../adapters/claude/client.js'), 'createAnthropicClient');
    await agent.callText('claude-sonnet-4-6', 'sys', 'hi', 10).catch(() => {});
    expect(spy).toHaveBeenCalledWith('override-key');
  });
});
