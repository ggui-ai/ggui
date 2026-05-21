/**
 * OAuth login route tests — Slice C agent A
 * (`docs/plans/2026-05-01-end-user-auth-slices.md`).
 *
 * Boots a minimal Express app with `mountOAuthLoginRoutes` against a
 * fake provider whose `exchangeCode` is deterministic. Asserts:
 *   - /start happy path: 302 + PKCE cookie + state in Location
 *   - /start unknown provider: 404
 *   - /start with hostile next param: state's nextPath = /settings
 *   - /start with safe next param: state encodes `/settings` etc.
 *   - /callback happy path: bearer registered, session cookie set,
 *     PKCE cookie cleared, 302 to nextPath
 *   - /callback ?error=...: 400 oauth_provider_error
 *   - /callback tampered state: 403 oauth_state_mismatch
 *   - /callback expired state: 403
 *   - /callback providerId mismatch: 403
 *   - /callback no PKCE cookie: 403 oauth_pkce_missing
 *   - /callback exchange throws: 400 oauth_exchange_failed
 *   - audit-sink entries for start/success/failure
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import {
  InMemoryAuditSink,
  InMemoryAuthAdapter,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { AuditSink, AuthAdapter } from '@ggui-ai/mcp-server-core';
import {
  mountOAuthLoginRoutes,
  OAUTH_PKCE_COOKIE_NAME,
} from './oauth-login.js';
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  OAuthExchangeResult,
  OAuthLoginProvider,
} from './oauth-login-types.js';
import { USER_SESSION_COOKIE_NAME } from './user-session-auth.js';
import { createConsoleLogger } from './logger.js';
import { createHmac } from 'node:crypto';

const STATE_SECRET = 'unit-test-state-secret-32-bytes-min!!';
const PUBLIC_BASE_URL = 'http://127.0.0.1:9999';

class FakeProvider implements OAuthLoginProvider {
  readonly providerId = 'fake';
  readonly displayName = 'Fake';
  public lastExchangeInput: ExchangeCodeInput | null = null;
  public lastAuthorizeInput: AuthorizeUrlInput | null = null;
  constructor(
    private readonly result: OAuthExchangeResult = {
      providerSubject: 'sub-123',
      email: 'u@example.com',
    },
    private readonly throwOnExchange = false,
  ) {}
  authorizeUrl(input: AuthorizeUrlInput): string {
    this.lastAuthorizeInput = input;
    const u = new URL('https://fake.example/authorize');
    u.searchParams.set('state', input.state);
    u.searchParams.set('code_challenge', input.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('scope', 'openid email');
    u.searchParams.set('response_type', 'code');
    return u.toString();
  }
  async exchangeCode(input: ExchangeCodeInput): Promise<OAuthExchangeResult> {
    this.lastExchangeInput = input;
    if (this.throwOnExchange) throw new Error('provider exchange failure');
    return this.result;
  }
}

interface Harness {
  readonly app: express.Express;
  readonly auth: AuthAdapter;
  readonly auditSink: InMemoryAuditSink;
  readonly provider: FakeProvider;
}

function buildHarness(opts?: {
  provider?: FakeProvider;
  auditSink?: AuditSink;
  auth?: AuthAdapter;
}): Harness {
  const provider = opts?.provider ?? new FakeProvider();
  const auth = opts?.auth ?? new InMemoryAuthAdapter({ devAllowAll: false });
  const auditSink = (opts?.auditSink as InMemoryAuditSink) ??
    new InMemoryAuditSink();
  const app = express();
  app.use(express.json());
  mountOAuthLoginRoutes(app, {
    providers: [provider],
    auth,
    logger: createConsoleLogger({ level: 'silent' }),
    stateSecret: STATE_SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
    auditSink,
  });
  return { app, auth, auditSink, provider };
}

interface ResponseRecord {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function asyncRequest(
  app: express.Express,
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<ResponseRecord> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        server.close();
        reject(new Error('listen returned non-info'));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}${path}`;
      fetch(url, {
        method,
        redirect: 'manual',
        headers: { ...headers },
      })
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // leave as text
          }
          const respHeaders: Record<string, string | string[] | undefined> = {};
          // Capture set-cookie specially — fetch's headers.get joins
          // multi-value headers with `, ` which corrupts cookies.
          const rawSetCookie = (res.headers as unknown as {
            getSetCookie?: () => string[];
          }).getSetCookie?.() ?? null;
          res.headers.forEach((v, k) => {
            respHeaders[k.toLowerCase()] = v;
          });
          if (rawSetCookie && rawSetCookie.length > 0) {
            respHeaders['set-cookie'] =
              rawSetCookie.length === 1 ? rawSetCookie[0] : rawSetCookie;
          }
          server.close();
          resolve({ status: res.status, body: parsed, headers: respHeaders });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function extractCookie(
  setCookie: string | string[] | undefined,
  name: string,
): { readonly raw: string; readonly value: string } | null {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    if (!c.startsWith(`${name}=`)) continue;
    const valueWithAttrs = c.slice(name.length + 1);
    const semi = valueWithAttrs.indexOf(';');
    const valueRaw = semi === -1 ? valueWithAttrs : valueWithAttrs.slice(0, semi);
    return { raw: c, value: decodeURIComponent(valueRaw) };
  }
  return null;
}

function decodeStatePayload(state: string): {
  random: string;
  providerId: string;
  nextPath: string;
  expiresAt: number;
} {
  const [payloadB64] = state.split('.');
  const padded = (payloadB64 ?? '') +
    '='.repeat((4 - ((payloadB64?.length ?? 0) % 4)) % 4);
  const json = Buffer.from(
    padded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
  return JSON.parse(json);
}

function signWithSecret(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function buildState(
  secret: string,
  payload: {
    random: string;
    providerId: string;
    nextPath: string;
    expiresAt: number;
  },
): string {
  const json = JSON.stringify(payload);
  const payloadB64 = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${payloadB64}.${signWithSecret(payloadB64, secret)}`;
}

describe('mountOAuthLoginRoutes — GET /providers', () => {
  it('returns 200 + array of {providerId, displayName} for configured providers', async () => {
    const { app, provider } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/providers',
    );
    expect(res.status).toBe(200);
    const body = res.body as { providers?: unknown };
    expect(Array.isArray(body.providers)).toBe(true);
    const list = body.providers as Array<{
      providerId?: unknown;
      displayName?: unknown;
    }>;
    expect(list.length).toBe(1);
    expect(list[0]?.providerId).toBe(provider.providerId);
    expect(list[0]?.displayName).toBe(provider.displayName);
    // MUST NOT leak any client_id / client_secret / source field.
    expect(list[0]).not.toHaveProperty('clientId');
    expect(list[0]).not.toHaveProperty('clientSecret');
    expect(list[0]).not.toHaveProperty('source');
  });

  it('returns 200 + empty array when no providers are configured', async () => {
    const app = express();
    app.use(express.json());
    mountOAuthLoginRoutes(app, {
      providers: [],
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      logger: createConsoleLogger({ level: 'silent' }),
      stateSecret: STATE_SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/providers',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: [] });
  });

  it('reflects dynamic getter — picks up newly-configured provider without restart', async () => {
    const live: OAuthLoginProvider[] = [];
    const app = express();
    app.use(express.json());
    mountOAuthLoginRoutes(app, {
      providers: () => live,
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      logger: createConsoleLogger({ level: 'silent' }),
      stateSecret: STATE_SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    const before = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/providers',
    );
    expect((before.body as { providers: unknown[] }).providers).toEqual([]);

    live.push(new FakeProvider());

    const after = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/providers',
    );
    expect((after.body as { providers: unknown[] }).providers).toEqual([
      { providerId: 'fake', displayName: 'Fake' },
    ]);
  });
});

describe('mountOAuthLoginRoutes — GET /start', () => {
  it('redirects to provider authorize URL and sets the PKCE cookie', async () => {
    const { app, provider } = buildHarness();
    const res = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    expect(res.status).toBe(302);
    const location = res.headers['location'] as string | undefined;
    expect(location).toBeDefined();
    expect(location).toContain('https://fake.example/authorize');
    const setCookie = res.headers['set-cookie'];
    const pkce = extractCookie(setCookie, OAUTH_PKCE_COOKIE_NAME);
    expect(pkce).not.toBeNull();
    expect(pkce!.raw).toMatch(/HttpOnly/i);
    expect(pkce!.raw).toMatch(/SameSite=Lax/i);
    expect(pkce!.raw).toMatch(/Max-Age=600/);
    // Provider received the matching challenge (S256 of verifier).
    expect(provider.lastAuthorizeInput).not.toBeNull();
    expect(provider.lastAuthorizeInput!.codeChallenge).toBeTruthy();
    expect(provider.lastAuthorizeInput!.redirectUri).toBe(
      `${PUBLIC_BASE_URL}/ggui/oauth-login/fake/callback`,
    );
  });

  it('returns 404 for unknown provider', async () => {
    const { app } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/missing/start',
    );
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('unknown_provider');
  });

  it('rejects open-redirect next param and falls back to /settings', async () => {
    const { app, provider } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/fake/start?next=' + encodeURIComponent('//evil.com/x'),
    );
    expect(res.status).toBe(302);
    const state = provider.lastAuthorizeInput!.state;
    const payload = decodeStatePayload(state);
    expect(payload.nextPath).toBe('/settings');
    expect(payload.providerId).toBe('fake');
  });

  it('preserves a safe relative next param in state', async () => {
    const { app, provider } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/fake/start?next=' + encodeURIComponent('/settings'),
    );
    expect(res.status).toBe(302);
    const state = provider.lastAuthorizeInput!.state;
    const payload = decodeStatePayload(state);
    expect(payload.nextPath).toBe('/settings');
  });

  it('emits auth.oauth.start to the audit sink', async () => {
    const { app, auditSink } = buildHarness();
    await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const entries = auditSink.snapshot();
    const hit = entries.find((e) => e.action === 'auth.oauth.start');
    expect(hit).toBeDefined();
    expect(hit!.actor.kind).toBe('anonymous');
    expect(hit!.resource).toEqual({ kind: 'oauth-provider', id: 'fake' });
  });
});

describe('mountOAuthLoginRoutes — GET /callback', () => {
  it('mints bearer + sets session cookie + clears PKCE on happy path', async () => {
    const { app, auth, provider } = buildHarness();
    // Run /start to capture verifier + state.
    const start = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/fake/start?next=' + encodeURIComponent('/settings'),
    );
    expect(start.status).toBe(302);
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    expect(pkce).not.toBeNull();
    const state = provider.lastAuthorizeInput!.state;

    const cb = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=okcode&state=${encodeURIComponent(state)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );

    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe('/settings');
    const setCookie = cb.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const session = extractCookie(setCookie, USER_SESSION_COOKIE_NAME);
    expect(session).not.toBeNull();
    expect(session!.value).toMatch(/^ggui_user_/);
    // PKCE cookie cleared (Max-Age=0).
    const cleared = extractCookie(setCookie, OAUTH_PKCE_COOKIE_NAME);
    expect(cleared).not.toBeNull();
    expect(cleared!.raw).toMatch(/Max-Age=0/);
    // Bearer registers as a user identity at the auth adapter.
    const result = await auth.authenticate(session!.value);
    expect(result).not.toBeNull();
    expect(result!.identity.kind).toBe('user');
    expect(result!.source).toBe('oauth');
    if (result!.identity.kind === 'user') {
      expect(result!.identity.userId).toBe('fake:sub-123');
    }
  });

  it('400s with oauth_provider_error on ?error=', async () => {
    const { app, auditSink } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/oauth-login/fake/callback?error=access_denied',
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('oauth_provider_error');
    expect(body.error.detail).toBe('access_denied');
    const failure = auditSink.snapshot().find((e) =>
      e.action === 'auth.oauth.failure',
    );
    expect(failure).toBeDefined();
    expect(failure!.metadata?.reason).toBe('provider_error');
  });

  it('403s on tampered state', async () => {
    const { app, auditSink } = buildHarness();
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const tampered = buildState('different-secret', {
      random: 'xyz',
      providerId: 'fake',
      nextPath: '/settings',
      expiresAt: Date.now() + 60_000,
    });
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(tampered)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('oauth_state_mismatch');
    const fail = auditSink.snapshot().find((e) => e.action === 'auth.oauth.failure');
    expect(fail).toBeDefined();
  });

  it('403s on expired state', async () => {
    const { app } = buildHarness();
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const expired = buildState(STATE_SECRET, {
      random: 'xyz',
      providerId: 'fake',
      nextPath: '/settings',
      expiresAt: Date.now() - 1_000,
    });
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(expired)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('oauth_state_mismatch');
  });

  it('403s on providerId mismatch between state and URL', async () => {
    // Build a harness with two providers so /start for `other` mints a
    // valid state token whose payload.providerId === 'other', then
    // POST that state to /fake/callback. State HMAC validates but
    // payload.providerId !== URL providerId → 403.
    const auth = new InMemoryAuthAdapter({ devAllowAll: false });
    const auditSink = new InMemoryAuditSink();
    const fakeP = new FakeProvider();
    const otherP = new FakeProvider();
    Object.assign(otherP, { providerId: 'other' });
    const app2 = express();
    app2.use(express.json());
    mountOAuthLoginRoutes(app2, {
      providers: [fakeP, otherP],
      auth,
      logger: createConsoleLogger({ level: 'silent' }),
      stateSecret: STATE_SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      auditSink,
    });
    const start = await asyncRequest(app2, 'GET', '/ggui/oauth-login/other/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const stateOther = otherP.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app2,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(stateOther)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('oauth_state_mismatch');
  });

  it('403s on missing PKCE cookie', async () => {
    const { app, provider } = buildHarness();
    await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const state = provider.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('oauth_pkce_missing');
  });

  it('400s when provider exchangeCode throws', async () => {
    const provider = new FakeProvider({ providerSubject: 'x' }, true);
    const { app, auditSink } = buildHarness({ provider });
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const state = provider.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('oauth_exchange_failed');
    const fail = auditSink.snapshot().find((e) => e.action === 'auth.oauth.failure');
    expect(fail).toBeDefined();
    expect(fail!.metadata?.reason).toBe('exchange_failed');
  });

  it('emits auth.oauth.success on happy path with provider + email metadata', async () => {
    const { app, auditSink, provider } = buildHarness();
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const state = provider.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(302);
    const success = auditSink.snapshot().find((e) =>
      e.action === 'auth.oauth.success',
    );
    expect(success).toBeDefined();
    expect(success!.actor).toEqual({ kind: 'user', id: 'fake:sub-123' });
    expect(success!.resource).toEqual({ kind: 'oauth-provider', id: 'fake' });
    expect(success!.metadata?.providerId).toBe('fake');
    expect(success!.metadata?.email).toBe('u@example.com');
  });

  it('501s when AuthAdapter has no registerToken', async () => {
    const noRegisterAuth: AuthAdapter = {
      authenticate: async () => null,
      getIdentity: async () => null,
    };
    const provider = new FakeProvider();
    const auditSink = new InMemoryAuditSink();
    const app = express();
    mountOAuthLoginRoutes(app, {
      providers: [provider],
      auth: noRegisterAuth,
      logger: createConsoleLogger({ level: 'silent' }),
      stateSecret: STATE_SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      auditSink,
    });
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const state = provider.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(501);
  });

  it('swallows audit-sink failures so a callback still succeeds', async () => {
    const failingSink: AuditSink = {
      record: vi.fn().mockRejectedValue(new Error('audit-down')),
    };
    const provider = new FakeProvider();
    const auth = new InMemoryAuthAdapter({ devAllowAll: false });
    const app = express();
    mountOAuthLoginRoutes(app, {
      providers: [provider],
      auth,
      logger: createConsoleLogger({ level: 'silent' }),
      stateSecret: STATE_SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      auditSink: failingSink,
    });
    const start = await asyncRequest(app, 'GET', '/ggui/oauth-login/fake/start');
    const pkce = extractCookie(start.headers['set-cookie'], OAUTH_PKCE_COOKIE_NAME);
    const state = provider.lastAuthorizeInput!.state;
    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/oauth-login/fake/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        Cookie: `${OAUTH_PKCE_COOKIE_NAME}=${encodeURIComponent(pkce!.value)}`,
      },
    );
    expect(res.status).toBe(302);
  });
});

