/**
 * ggui#1185 — when the adapter runs on the machine's Claude Code login it must
 * hand the SDK exactly the options that keep the run honest: an env with no
 * provider key or endpoint override, no built-in tools, no ~/.claude settings,
 * the non-bare path pinned, and the caller's model. Asserted on the options
 * the SDK receives — the process is never spawned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const seen = vi.hoisted(() => ({ options: [] as Options[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Options }) => {
    seen.options.push(args.options);
    // One final message with no compiled code: the adapter may fail AFTER the
    // call; the assertions below are on what it sent, not on what came back.
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {} };
    })();
  },
}));

import { ClaudeSdkAdapter } from './sdk.js';

const PARAMS = { userPrompt: 'u', systemPrompt: 's', model: 'claude-haiku-4-5-20251001', maxTurns: 1, tools: [] };

describe('ClaudeSdkAdapter — claude-code-login path (ggui#1185)', () => {
  afterEach(() => { seen.options.length = 0; });

  it('strips every provider key from the spawned env, pins tools/settings/non-bare, keeps the model', async () => {
    const adapter = new ClaudeSdkAdapter({
      claudeCodeLogin: true,
      env: { ANTHROPIC_API_KEY: 'sk-ant-stale', CLAUDE_API_KEY: 'stale', ANTHROPIC_AUTH_TOKEN: 'stale', ANTHROPIC_BASE_URL: 'http://localhost:4000', PATH: '/usr/bin' },
    });
    await adapter.generate(PARAMS).catch(() => undefined);
    expect(seen.options).toHaveLength(1);
    const o = seen.options[0]!;
    const env = o.env as Record<string, string>;
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) expect(k in env, `${k} must not reach the binary`).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.extraArgs).toEqual({ 'no-bare': null });
    expect(o.model).toBe('claude-haiku-4-5-20251001');
  });

  it('reports itself available on the login path even with no key anywhere', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      expect(new ClaudeSdkAdapter({ env: {} }).isAvailable(), 'control: no key, no login → unavailable').toBe(false);
      expect(new ClaudeSdkAdapter({ claudeCodeLogin: true, env: {} }).isAvailable()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('off the login path, nothing is pinned and the env is passed as configured', async () => {
    const adapter = new ClaudeSdkAdapter({ env: { ANTHROPIC_API_KEY: 'sk-ant-real', PATH: '/usr/bin' } });
    await adapter.generate(PARAMS).catch(() => undefined);
    const o = seen.options[0]!;
    expect((o.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(o.tools).toBeUndefined();
    expect(o.settingSources).toBeUndefined();
    expect(o.extraArgs).toBeUndefined();
  });
});
