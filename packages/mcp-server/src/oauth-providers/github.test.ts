/**
 * Unit tests for `githubLoginProvider`. Mock fetch via the `fetch`
 * option seam; never hits the network. Covers authorize-URL shape,
 * happy-path two-call flow (token + user), `/user/emails` fallback
 * when `/user` returns null email, and non-2xx surfaces on both
 * endpoints.
 */
import { describe, expect, it, vi } from 'vitest';
import { githubLoginProvider } from './github.js';

const CLIENT_ID = 'gh-cid';
const CLIENT_SECRET = 'gh-csecret';
const REDIRECT_URI = 'https://srv.example/ggui/oauth-login/github/callback';

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function mockFetch(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): FetchMock {
  return vi.fn<typeof fetch>(handler);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('githubLoginProvider.authorizeUrl', () => {
  it('builds the canonical authorize URL with default scopes', () => {
    const provider = githubLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const url = provider.authorizeUrl({
      state: 'st',
      codeChallenge: 'cc',
      redirectUri: REDIRECT_URI,
    });
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const u = new URL(url);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('scope')).toBe('read:user user:email');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('code_challenge')).toBe('cc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('githubLoginProvider.exchangeCode', () => {
  it('returns providerSubject (string of numeric id) + email + displayName', async () => {
    const fetchMock = mockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'gho_xyz' });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({
          id: 42,
          login: 'octocat',
          name: 'Octo Cat',
          email: 'octo@example.com',
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const provider = githubLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });
    const result = await provider.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'pkce-verifier',
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      providerSubject: '42',
      email: 'octo@example.com',
      displayName: 'Octo Cat',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(tokenInit?.method).toBe('POST');
    const tokenHeaders = tokenInit?.headers as Record<string, string>;
    expect(tokenHeaders['Accept']).toBe('application/json');
    expect(tokenHeaders['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(typeof tokenInit?.body).toBe('string');
    const tokenBody = new URLSearchParams(tokenInit?.body as string);
    expect(tokenBody.get('client_id')).toBe(CLIENT_ID);
    expect(tokenBody.get('client_secret')).toBe(CLIENT_SECRET);
    expect(tokenBody.get('code')).toBe('auth-code');
    expect(tokenBody.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(tokenBody.get('code_verifier')).toBe('pkce-verifier');

    const [userUrl, userInit] = fetchMock.mock.calls[1]!;
    expect(userUrl).toBe('https://api.github.com/user');
    const userHeaders = userInit?.headers as Record<string, string>;
    expect(userHeaders['Authorization']).toBe('Bearer gho_xyz');
    expect(userHeaders['Accept']).toBe('application/vnd.github+json');
    expect(userHeaders['User-Agent']).toBe('ggui-oss-server');
  });

  it('falls back to /user/emails when /user has null email and user:email is in scope', async () => {
    const fetchMock = mockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'gho_xyz' });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({
          id: 7,
          login: 'mona',
          name: null,
          email: null,
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse([
          { email: 'old@example.com', primary: false, verified: true },
          { email: 'mona@example.com', primary: true, verified: true },
          { email: 'unverified@example.com', primary: false, verified: false },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const provider = githubLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });
    const result = await provider.exchangeCode({
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      providerSubject: '7',
      email: 'mona@example.com',
      displayName: 'mona',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws github_token_exchange_failed on non-2xx token response', async () => {
    const fetchMock = mockFetch(
      async () =>
        new Response('bad_verifier', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    const provider = githubLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });
    await expect(
      provider.exchangeCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/github_token_exchange_failed: 400 bad_verifier/);
  });

  it('throws github_user_fetch_failed on non-2xx /user response', async () => {
    const fetchMock = mockFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'gho_xyz' });
      }
      return new Response('rate_limited', {
        status: 429,
        headers: { 'Content-Type': 'text/plain' },
      });
    });
    const provider = githubLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });
    await expect(
      provider.exchangeCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/github_user_fetch_failed: 429 rate_limited/);
  });
});
