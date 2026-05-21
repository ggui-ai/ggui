/**
 * Unit tests for `googleLoginProvider`. Mock fetch via the `fetch`
 * option seam; never hits the network. Covers authorize-URL shape,
 * happy-path exchange, non-2xx error surface, and missing-email
 * id_token decoding.
 */
import { describe, expect, it, vi } from 'vitest';
import { googleLoginProvider } from './google.js';

const CLIENT_ID = 'cid.example.com';
const CLIENT_SECRET = 'csecret';
const REDIRECT_URI = 'https://srv.example/ggui/oauth-login/google/callback';

function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('googleLoginProvider.authorizeUrl', () => {
  it('builds the canonical authorize URL with all params URL-encoded', () => {
    const provider = googleLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const url = provider.authorizeUrl({
      state: 'st+ate=',
      codeChallenge: 'cc/+=',
      redirectUri: REDIRECT_URI,
    });
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const u = new URL(url);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toBe('st+ate=');
    expect(u.searchParams.get('code_challenge')).toBe('cc/+=');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('online');
    expect(u.searchParams.get('prompt')).toBe('consent');
  });

  it('honors override scopes', () => {
    const provider = googleLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['openid', 'email'],
    });
    const url = provider.authorizeUrl({
      state: 's',
      codeChallenge: 'c',
      redirectUri: REDIRECT_URI,
    });
    expect(new URL(url).searchParams.get('scope')).toBe('openid email');
  });
});

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function mockFetch(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): FetchMock {
  return vi.fn<typeof fetch>(handler);
}

describe('googleLoginProvider.exchangeCode', () => {
  it('returns providerSubject + email + displayName from id_token payload', async () => {
    const idToken = makeIdToken({
      sub: '1234567890',
      email: 'u@example.com',
      name: 'User One',
    });
    const fetchMock = mockFetch(async () =>
      jsonResponse({ id_token: idToken, access_token: 'at' }),
    );
    const provider = googleLoginProvider({
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
      providerSubject: '1234567890',
      email: 'u@example.com',
      displayName: 'User One',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(typeof init?.body).toBe('string');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
  });

  it('throws google_token_exchange_failed with status on non-2xx', async () => {
    const fetchMock = mockFetch(
      async () =>
        new Response('invalid_grant', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );
    const provider = googleLoginProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchMock,
    });
    await expect(
      provider.exchangeCode({
        code: 'bad',
        codeVerifier: 'v',
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/google_token_exchange_failed: 400 invalid_grant/);
  });

  it('returns email/displayName as undefined when id_token omits them', async () => {
    const idToken = makeIdToken({ sub: 'sub-only' });
    const fetchMock = mockFetch(async () =>
      jsonResponse({ id_token: idToken, access_token: 'at' }),
    );
    const provider = googleLoginProvider({
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
      providerSubject: 'sub-only',
      email: undefined,
      displayName: undefined,
    });
  });
});
