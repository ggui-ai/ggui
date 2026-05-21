/**
 * Email magic-link login route tests.
 *
 * Boots an Express app with a captured `EmailSender` so we can
 * inspect the message that would have gone over the wire.
 *
 *   - /config returns enabled:true when mounted
 *   - /start happy path: 200 + sender called + token minted
 *   - /start invalid email: 400
 *   - /start malformed email body: 400
 *   - /start missing email: 400
 *   - /start always 200 even when sender throws (no enumeration)
 *   - /verify happy path: 302 + cookie + token consumed (single-use)
 *   - /verify replay: 403 (token already consumed)
 *   - /verify expired: 403
 *   - /verify missing token: 400
 *   - InMemoryMagicLinkStore directly: mint+consume+expire
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import {
  ConsoleEmailSender,
  InMemoryMagicLinkStore,
  mountEmailLoginRoutes,
  type EmailMessage,
  type EmailSender,
} from './email-login.js';
import { USER_SESSION_COOKIE_NAME } from './user-session-auth.js';
import { createConsoleLogger } from './logger.js';

const PUBLIC_BASE_URL = 'http://127.0.0.1:9999';
const FROM_ADDRESS = 'ggui <noreply@ggui.test>';

class CapturedSender implements EmailSender {
  public messages: EmailMessage[] = [];
  public throwOnSend = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.throwOnSend) throw new Error('sender failure');
    this.messages.push(message);
  }
}

interface Harness {
  readonly app: express.Express;
  readonly sender: CapturedSender;
  readonly auth: InMemoryAuthAdapter;
  readonly store: InMemoryMagicLinkStore;
}

/**
 * Pull the magic-link token out of an email body. Tests assert this
 * non-null so a missing match should fail the assertion explicitly,
 * not silently propagate `undefined` through to the next call.
 */
function extractTokenFromBody(text: string): string {
  const match = /token=([a-f0-9]{64})/.exec(text);
  if (!match || match[1] === undefined) {
    throw new Error('expected magic-link token in email body, found none');
  }
  return match[1];
}

function buildHarness(): Harness {
  const app = express();
  app.use(express.json());
  const sender = new CapturedSender();
  const auth = new InMemoryAuthAdapter({ devAllowAll: false });
  const store = new InMemoryMagicLinkStore();
  mountEmailLoginRoutes(app, {
    sender,
    auth,
    store,
    logger: createConsoleLogger({ level: 'silent' }),
    publicBaseUrl: PUBLIC_BASE_URL,
    fromAddress: FROM_ADDRESS,
  });
  return { app, sender, auth, store };
}

interface ResponseRecord {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function asyncRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
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
        headers:
          method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
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

describe('mountEmailLoginRoutes — GET /config', () => {
  it('returns 200 + {enabled: true} when mounted', async () => {
    const { app } = buildHarness();
    const res = await asyncRequest(app, 'GET', '/ggui/email-login/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });
});

describe('mountEmailLoginRoutes — POST /start', () => {
  it('mints a token, sends an email, returns 200', async () => {
    const { app, sender, store } = buildHarness();
    const res = await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sender.messages.length).toBe(1);
    const message = sender.messages[0]!;
    expect(message.to).toBe('alice@example.test');
    expect(message.from).toBe(FROM_ADDRESS);
    // Verify URL is in both text + html bodies.
    expect(message.text).toContain('/ggui/email-login/verify?token=');
    expect(message.html).toContain('/ggui/email-login/verify?token=');
    // Token is in the store.
    const token = extractTokenFromBody(message.text);
    const consumed = await store.consumeToken(token);
    expect(consumed?.email).toBe('alice@example.test');
  });

  it('lowercases + trims the email before persisting', async () => {
    const { app, sender, store } = buildHarness();
    await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: '  Alice@Example.TEST  ',
    });
    const token = extractTokenFromBody(sender.messages[0]!.text);
    const record = await store.consumeToken(token);
    expect(record?.email).toBe('alice@example.test');
  });

  it('rejects an obviously-invalid email with 400', async () => {
    const { app, sender } = buildHarness();
    const res = await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'not-an-email',
    });
    expect(res.status).toBe(400);
    expect(sender.messages.length).toBe(0);
  });

  it('rejects empty body with 400', async () => {
    const { app } = buildHarness();
    const res = await asyncRequest(app, 'POST', '/ggui/email-login/start', {});
    expect(res.status).toBe(400);
  });

  it('returns 200 even when sender throws (no email enumeration)', async () => {
    const { app, sender } = buildHarness();
    sender.throwOnSend = true;
    const res = await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects open-redirect next param and falls back to /settings', async () => {
    const { app, sender, store } = buildHarness();
    await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
      next: 'https://evil.example/',
    });
    const token = extractTokenFromBody(sender.messages[0]!.text);
    const record = await store.consumeToken(token);
    expect(record?.nextPath).toBe('/settings');
  });

  it('preserves a safe relative next param', async () => {
    const { app, sender, store } = buildHarness();
    await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
      next: '/admin/keys',
    });
    const token = extractTokenFromBody(sender.messages[0]!.text);
    const record = await store.consumeToken(token);
    expect(record?.nextPath).toBe('/admin/keys');
  });
});

describe('mountEmailLoginRoutes — GET /verify', () => {
  it('mints session cookie + 302 to nextPath on happy path', async () => {
    const { app, sender, auth } = buildHarness();
    // Drive a real /start to mint a token.
    await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
      next: '/settings',
    });
    const token = extractTokenFromBody(sender.messages[0]!.text);

    const res = await asyncRequest(
      app,
      'GET',
      `/ggui/email-login/verify?token=${token}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/settings');

    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    expect(cookieStr).toContain(`${USER_SESSION_COOKIE_NAME}=`);

    // Bearer registered → adapter authenticates the cookie value.
    const bearerMatch = new RegExp(
      `${USER_SESSION_COOKIE_NAME}=([^;]+)`,
    ).exec(cookieStr);
    expect(bearerMatch).not.toBeNull();
    const bearer = decodeURIComponent(bearerMatch![1]!);
    const result = await auth.authenticate(bearer);
    expect(result?.identity).toEqual({
      kind: 'user',
      userId: 'email:alice@example.test',
      roles: [],
    });
    expect(result?.source).toBe('email');
  });

  it('403s on token replay (single-use)', async () => {
    const { app, sender } = buildHarness();
    await asyncRequest(app, 'POST', '/ggui/email-login/start', {
      email: 'alice@example.test',
    });
    const token = extractTokenFromBody(sender.messages[0]!.text);

    // First verify succeeds.
    const first = await asyncRequest(
      app,
      'GET',
      `/ggui/email-login/verify?token=${token}`,
    );
    expect(first.status).toBe(302);

    // Replay: same token rejected.
    const replay = await asyncRequest(
      app,
      'GET',
      `/ggui/email-login/verify?token=${token}`,
    );
    expect(replay.status).toBe(403);
  });

  it('400s on missing token query', async () => {
    const { app } = buildHarness();
    const res = await asyncRequest(app, 'GET', '/ggui/email-login/verify');
    expect(res.status).toBe(400);
  });

  it('403s on unknown token', async () => {
    const { app } = buildHarness();
    const res = await asyncRequest(
      app,
      'GET',
      '/ggui/email-login/verify?token=' + 'a'.repeat(64),
    );
    expect(res.status).toBe(403);
  });
});

describe('InMemoryMagicLinkStore', () => {
  it('mintToken returns a hex token; consumeToken returns the record once', async () => {
    const store = new InMemoryMagicLinkStore();
    const token = await store.mintToken({
      email: 'alice@example.test',
      nextPath: '/settings',
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const first = await store.consumeToken(token);
    expect(first?.email).toBe('alice@example.test');
    expect(first?.nextPath).toBe('/settings');
    const second = await store.consumeToken(token);
    expect(second).toBeNull();
  });

  it('consumeToken returns null past expiry', async () => {
    const store = new InMemoryMagicLinkStore();
    const token = await store.mintToken({
      email: 'alice@example.test',
      nextPath: '/settings',
      ttlMs: -1, // already expired
    });
    const result = await store.consumeToken(token);
    expect(result).toBeNull();
  });
});

describe('ConsoleEmailSender', () => {
  it('logs the message to the provided logger', async () => {
    const child = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child,
    };
    child.mockReturnValue(logger);
    const sender = new ConsoleEmailSender(logger);
    await sender.send({
      to: 'alice@example.test',
      from: FROM_ADDRESS,
      subject: 'hi',
      text: 'click here',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'email_console_sender',
      expect.objectContaining({
        to: 'alice@example.test',
        subject: 'hi',
        text: 'click here',
      }),
    );
  });
});
