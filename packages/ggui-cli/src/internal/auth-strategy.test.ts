/**
 * `auth-strategy.ts` unit tests. Covers the explicit `--auth=bearer`
 * branch + the hosted-auth fallthrough. The hosted-auth implementation
 * is stubbed via `acquireHostedAuthJwt` — this test never reaches the
 * cloud-internal IdP code.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_HELP_FRAGMENT,
  acquireAuthToken,
  parseAuthFlags,
} from './auth-strategy.js';

describe('parseAuthFlags', () => {
  it('returns no auth flags + empty rest for empty argv', () => {
    const r = parseAuthFlags([]);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags).toEqual({});
      expect(r.rest).toEqual([]);
    }
  });

  it('parses --auth=bearer (=value form)', () => {
    const r = parseAuthFlags(['--auth=bearer']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags.auth).toBe('bearer');
      expect(r.rest).toEqual([]);
    }
  });

  it('parses --auth bearer (space form)', () => {
    const r = parseAuthFlags(['--auth', 'bearer']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags.auth).toBe('bearer');
    }
  });

  it('parses --token <value>', () => {
    const r = parseAuthFlags(['--auth=bearer', '--token', 'abc']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags).toEqual({ auth: 'bearer', token: 'abc' });
    }
  });

  it('parses --token=<value>', () => {
    const r = parseAuthFlags(['--token=xyz']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags.token).toBe('xyz');
    }
  });

  it('rejects --auth=other', () => {
    const r = parseAuthFlags(['--auth=cognito']);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('--auth must be "bearer"');
  });

  it('rejects --auth with no value', () => {
    const r = parseAuthFlags(['--auth']);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('--auth requires a value');
  });

  it('rejects --token with no value', () => {
    const r = parseAuthFlags(['--token']);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toBe('--token requires a value');
  });

  it('passes non-auth args through `rest` untouched', () => {
    const r = parseAuthFlags(['--dry-run', '--auth=bearer', '--registry', 'https://r']);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.flags.auth).toBe('bearer');
      expect(r.rest).toEqual(['--dry-run', '--registry', 'https://r']);
    }
  });
});

describe('acquireAuthToken', () => {
  const baseDeps = {
    env: {} as NodeJS.ProcessEnv,
    cwd: '/tmp',
    registryUrl: 'https://r.example.com',
  };

  it('bearer + --token: returns the token verbatim, never calls hosted-auth', async () => {
    const acquireHostedAuthJwt = vi.fn();
    const token = await acquireAuthToken({
      ...baseDeps,
      flags: { auth: 'bearer', token: 'token-from-flag' },
      acquireHostedAuthJwt,
    });
    expect(token).toBe('token-from-flag');
    expect(acquireHostedAuthJwt).not.toHaveBeenCalled();
  });

  it('bearer + GGUI_REGISTRY_TOKEN env: returns the env token', async () => {
    const acquireHostedAuthJwt = vi.fn();
    const token = await acquireAuthToken({
      ...baseDeps,
      env: { GGUI_REGISTRY_TOKEN: 'token-from-env' } as NodeJS.ProcessEnv,
      flags: { auth: 'bearer' },
      acquireHostedAuthJwt,
    });
    expect(token).toBe('token-from-env');
    expect(acquireHostedAuthJwt).not.toHaveBeenCalled();
  });

  it('bearer + --token + GGUI_REGISTRY_TOKEN: flag wins', async () => {
    const acquireHostedAuthJwt = vi.fn();
    const token = await acquireAuthToken({
      ...baseDeps,
      env: { GGUI_REGISTRY_TOKEN: 'from-env' } as NodeJS.ProcessEnv,
      flags: { auth: 'bearer', token: 'from-flag' },
      acquireHostedAuthJwt,
    });
    expect(token).toBe('from-flag');
  });

  it('bearer without token (no flag, no env): throws with operator-readable message', async () => {
    const acquireHostedAuthJwt = vi.fn();
    await expect(
      acquireAuthToken({
        ...baseDeps,
        flags: { auth: 'bearer' },
        acquireHostedAuthJwt,
      }),
    ).rejects.toThrow(/bearer auth requires --token .* or GGUI_REGISTRY_TOKEN/);
    expect(acquireHostedAuthJwt).not.toHaveBeenCalled();
  });

  it('default (no auth flag): delegates to acquireHostedAuthJwt', async () => {
    const acquireHostedAuthJwt = vi.fn(async () => 'hosted-jwt');
    const token = await acquireAuthToken({
      ...baseDeps,
      flags: {},
      acquireHostedAuthJwt,
    });
    expect(token).toBe('hosted-jwt');
    expect(acquireHostedAuthJwt).toHaveBeenCalledWith({
      registryUrl: 'https://r.example.com',
      env: baseDeps.env,
      cwd: '/tmp',
    });
  });
});

describe('AUTH_HELP_FRAGMENT', () => {
  it('mentions --auth=bearer + --token but NEVER names any identity-provider vendor', () => {
    expect(AUTH_HELP_FRAGMENT).toContain('--auth=bearer');
    expect(AUTH_HELP_FRAGMENT).toContain('--token');
    expect(AUTH_HELP_FRAGMENT).toContain('GGUI_REGISTRY_TOKEN');
    // Vendor-neutral guard.
    expect(AUTH_HELP_FRAGMENT.toLowerCase()).not.toContain('cognito');
  });
});
