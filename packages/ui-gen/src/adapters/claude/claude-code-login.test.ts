/**
 * ggui#1185 — the options that keep a Claude-Code-login generation honest:
 * no provider key can win over the login, no built-in tool, no ~/.claude
 * config leaking in, the non-bare path pinned (`--bare` skips keychain reads
 * and is slated to become the `-p` default upstream), model pinned by the
 * caller. Pure, so the measurement is a table and not a spawned process.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_LOGIN_CREDENTIAL,
  PROVIDER_KEY_ENV_NAMES,
  claudeCodeLoginQueryOptions,
  stripProviderKeyEnv,
} from './claude-code-login';

describe('claude-code-login (ggui#1185)', () => {
  it('the sentinel is the literal the CLI and the router agree on', () => {
    expect(CLAUDE_CODE_LOGIN_CREDENTIAL).toBe('claude-code-login');
  });
  it('strips every provider-key env the spawned binary would otherwise prefer, keeps the rest', () => {
    const env = { ANTHROPIC_API_KEY: 'a', CLAUDE_API_KEY: 'b', ANTHROPIC_AUTH_TOKEN: 'c', ANTHROPIC_BASE_URL: 'http://localhost:4000', PATH: '/usr/bin', HOME: '/home/x' };
    const out = stripProviderKeyEnv(env);
    for (const k of PROVIDER_KEY_ENV_NAMES) expect(k in out, `${k} must be absent`).toBe(false);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
    expect(env.ANTHROPIC_API_KEY, 'input not mutated').toBe('a');
  });
  it('pins tool-less, config-less, non-bare', () => {
    expect(claudeCodeLoginQueryOptions()).toEqual({ tools: [], settingSources: [], });
  });
});
