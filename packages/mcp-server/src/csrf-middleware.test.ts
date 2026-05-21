/**
 * CSRF middleware tests — Slice B C5
 * (`docs/plans/2026-05-01-end-user-auth-slices.md`).
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import {
  CSRF_HEADER_NAME,
  CSRF_RESPONSE_HEADER_NAME,
  createCsrfMiddleware,
  mintCsrfToken,
  mountCsrfTokenRoute,
} from './csrf-middleware.js';
import { USER_SESSION_COOKIE_NAME } from './user-session-auth.js';
import { createConsoleLogger } from './logger.js';

const SECRET = 'test-csrf-secret-bytes-very-long-please';

function buildApp(secret = SECRET): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    createCsrfMiddleware({
      secret,
      logger: createConsoleLogger({ level: 'silent' }),
    }),
  );
  app.get('/safe', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post('/state-change', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post('/pair', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  mountCsrfTokenRoute(app, { secret });
  return app;
}

async function asyncRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: unknown;
  headers: Record<string, string | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        server.close();
        reject(new Error('listen returned non-info'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // leave as text
          }
          const respHeaders: Record<string, string | undefined> = {};
          res.headers.forEach((v, k) => {
            respHeaders[k.toLowerCase()] = v;
          });
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

describe('mintCsrfToken', () => {
  it('produces tokens in `${random}.${hmac}` format', () => {
    const token = mintCsrfToken({ sessionBearer: null, secret: SECRET });
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    const [random, sig] = parts;
    expect(random?.length).toBeGreaterThan(0);
    expect(sig?.length).toBeGreaterThan(0);
  });

  it('binds the HMAC to the session bearer (token from cookieA fails for cookieB)', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createCsrfMiddleware({
        secret: SECRET,
        logger: createConsoleLogger({ level: 'silent' }),
      }),
    );
    app.post('/state-change', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const tokenForA = mintCsrfToken({
      sessionBearer: 'bearer-A',
      secret: SECRET,
    });

    // Same token replayed under a different cookie (different bearer)
    // must fail validation.
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      {
        Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-B`,
        [CSRF_HEADER_NAME]: tokenForA,
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('createCsrfMiddleware', () => {
  it('lets GET requests pass and sets X-Ggui-CSRF-Token on the response', async () => {
    const app = buildApp();
    const res = await asyncRequest(app, 'GET', '/safe');
    expect(res.status).toBe(200);
    expect(res.headers[CSRF_RESPONSE_HEADER_NAME.toLowerCase()]).toBeDefined();
  });

  it('rejects POST without X-Ggui-CSRF header (403, csrf_required)', async () => {
    const app = buildApp();
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      { Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A` },
    );
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('csrf_required');
  });

  it('rejects POST with mismatched CSRF token (403)', async () => {
    const app = buildApp();
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      {
        Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A`,
        [CSRF_HEADER_NAME]: 'not-a-real-token.bogus',
      },
    );
    expect(res.status).toBe(403);
  });

  it('accepts POST with a CSRF token bound to the current session bearer', async () => {
    const app = buildApp();
    const token = mintCsrfToken({
      sessionBearer: 'bearer-A',
      secret: SECRET,
    });
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      {
        Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A`,
        [CSRF_HEADER_NAME]: token,
      },
    );
    expect(res.status).toBe(200);
  });

  it('accepts POST with no cookie when token is bound to empty bearer (anonymous path)', async () => {
    const app = buildApp();
    const token = mintCsrfToken({ sessionBearer: null, secret: SECRET });
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      { [CSRF_HEADER_NAME]: token },
    );
    expect(res.status).toBe(200);
  });

  it('skips CSRF when Authorization: Bearer is present and no session cookie', async () => {
    const app = buildApp();
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      { Authorization: 'Bearer programmatic-token' },
    );
    // No CSRF header sent — should still succeed because programmatic
    // bearer + no cookie context means non-browser path.
    expect(res.status).toBe(200);
  });

  it('still enforces CSRF when Authorization: Bearer AND session cookie present', async () => {
    const app = buildApp();
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      {
        Authorization: 'Bearer programmatic-token',
        Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A`,
      },
    );
    expect(res.status).toBe(403);
  });

  it('skips CSRF for POST /pair (pre-auth pair-code consume)', async () => {
    const app = buildApp();
    const res = await asyncRequest(app, 'POST', '/pair', {});
    expect(res.status).toBe(200);
  });

  it('honors operator-supplied skipPaths (overrides default)', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      createCsrfMiddleware({
        secret: SECRET,
        logger: createConsoleLogger({ level: 'silent' }),
        skipPaths: ['/custom-skip'],
      }),
    );
    app.post('/custom-skip', (_req, res) => res.status(200).json({ ok: true }));
    app.post('/pair', (_req, res) => res.status(200).json({ ok: true }));

    // Custom path now skipped.
    const skipped = await asyncRequest(app, 'POST', '/custom-skip', {});
    expect(skipped.status).toBe(200);
    // /pair no longer in default skipPaths → CSRF required.
    const required = await asyncRequest(
      app,
      'POST',
      '/pair',
      {},
      { Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A` },
    );
    expect(required.status).toBe(403);
  });

  it('rejects malformed token (length-mismatch path) without throwing', async () => {
    const app = buildApp();
    // The middleware uses `timingSafeEqual` which throws on mismatched
    // lengths; the validator must short-circuit on the length check
    // before calling it. Pass a single-character token.
    const res = await asyncRequest(
      app,
      'POST',
      '/state-change',
      {},
      {
        Cookie: `${USER_SESSION_COOKIE_NAME}=bearer-A`,
        [CSRF_HEADER_NAME]: 'x',
      },
    );
    expect(res.status).toBe(403);
  });
});

describe('mountCsrfTokenRoute', () => {
  it('returns { token, expiresAt } at GET /ggui/csrf-token', async () => {
    const app = buildApp();
    const res = await asyncRequest(app, 'GET', '/ggui/csrf-token');
    expect(res.status).toBe(200);
    const body = res.body as { token: string; expiresAt: number };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(2);
    expect(typeof body.expiresAt).toBe('number');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});
