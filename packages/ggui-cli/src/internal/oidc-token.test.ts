/**
 * `resolveOidcToken` precedence tests (Bucket B'', LOCKED-24).
 *
 * Covers the four-tier resolution chain — flag, env, GitHub Actions
 * ambient, interactive — and pins the precedence between them. The
 * interactive flow is exercised through its short-circuit (the
 * `interactive: false` test seam) — the real OAuth listener +
 * code-for-token exchange is harder to test deterministically without
 * a real browser, so we cover the *gating* (not the OAuth dance) here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  resolveOidcToken,
  OidcResolutionError,
  type OidcResolveOptions,
} from './oidc-token.js';

function emptyEnv(): NodeJS.ProcessEnv {
  return {};
}

describe('resolveOidcToken — precedence', () => {
  it('--identity-token flag wins over everything', async () => {
    const env: NodeJS.ProcessEnv = {
      GGUI_OIDC_TOKEN: 'env-token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc',
    };
    const fetchImpl = vi.fn(); // should not be called
    const res = await resolveOidcToken({
      identityTokenFlag: 'flag-token',
      env,
      isTty: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('flag');
    expect(res.token).toBe('flag-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('env wins over GH-Actions ambient when no flag', async () => {
    const env: NodeJS.ProcessEnv = {
      GGUI_OIDC_TOKEN: 'env-token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc',
    };
    const fetchImpl = vi.fn();
    const res = await resolveOidcToken({
      env,
      isTty: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('env');
    expect(res.token).toBe('env-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses GH-Actions ambient when flag + env absent', async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc?api-version=2.0',
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: 'gh-issued-jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const res = await resolveOidcToken({
      env,
      isTty: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('github-actions');
    expect(res.token).toBe('gh-issued-jwt');
    // Verify we appended audience=sigstore and used bearer auth.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toContain('audience=sigstore');
    expect(url).toContain('api-version=2.0'); // existing query preserved
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('bearer gh-req-token');
  });

  it('GH-Actions fetch failure surfaces github_actions_fetch_failed', async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc',
    };
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    );
    await expect(
      resolveOidcToken({
        env,
        isTty: false,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OidcResolutionError',
      code: 'github_actions_fetch_failed',
    });
  });

  it('GH-Actions JSON missing `value` → github_actions_fetch_failed', async () => {
    const env: NodeJS.ProcessEnv = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc',
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ wrong: 'shape' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      resolveOidcToken({
        env,
        isTty: false,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OidcResolutionError',
      code: 'github_actions_fetch_failed',
    });
  });

  it('no sources available + non-TTY → throws no_token_available', async () => {
    await expect(
      resolveOidcToken({ env: emptyEnv(), isTty: false }),
    ).rejects.toMatchObject({
      name: 'OidcResolutionError',
      code: 'no_token_available',
    });
  });

  it('error message lists all four options', async () => {
    try {
      await resolveOidcToken({ env: emptyEnv(), isTty: false });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OidcResolutionError);
      const msg = (err as Error).message;
      expect(msg).toContain('--identity-token');
      expect(msg).toContain('GGUI_OIDC_TOKEN');
      expect(msg).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
      expect(msg).toContain('TTY');
    }
  });

  it('interactive: false short-circuits even with TTY → no_token_available', async () => {
    // TTY-gate would otherwise route to the interactive flow; the test
    // seam disables it so the resolver fails fast instead of opening
    // a real localhost listener.
    const opts: OidcResolveOptions = {
      env: emptyEnv(),
      isTty: true,
      interactive: false,
    };
    await expect(resolveOidcToken(opts)).rejects.toMatchObject({
      name: 'OidcResolutionError',
      code: 'no_token_available',
    });
  });

  // Interactive flow is exercised by the gating tests above
  // (`isTty: false` skips, `interactive: false` short-circuits). The
  // OAuth listener + token exchange against `oauth2.sigstore.dev`
  // require a real browser + network — covered by manual smoke tests,
  // not vitest. The seams (stdout, openBrowser, prompt) keep the path
  // mockable for future expansion.
});

describe('resolveOidcToken — empty strings', () => {
  it('empty --identity-token falls through to env', async () => {
    const env: NodeJS.ProcessEnv = { GGUI_OIDC_TOKEN: 'env-token' };
    const res = await resolveOidcToken({
      identityTokenFlag: '',
      env,
      isTty: false,
    });
    expect(res.source).toBe('env');
    expect(res.token).toBe('env-token');
  });

  it('empty GGUI_OIDC_TOKEN falls through to GH-Actions', async () => {
    const env: NodeJS.ProcessEnv = {
      GGUI_OIDC_TOKEN: '',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-req-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/oidc',
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: 'gh-jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const res = await resolveOidcToken({
      env,
      isTty: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(res.source).toBe('github-actions');
    expect(res.token).toBe('gh-jwt');
  });
});
