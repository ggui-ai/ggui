/**
 * Rate-limit middleware tests — Slice B C4 of
 * `docs/plans/2026-05-01-end-user-auth-slices.md`.
 *
 * Boots a minimal Express harness and exercises the middleware against a
 * real `FixedWindowRateLimiter` + `InMemoryQuotaStore` pair so the policy
 * boundary is exercised end-to-end. A virtual clock injected into both
 * keeps the test deterministic without fake timers (real fetch needs real
 * time; only the limiter's window arithmetic is faked).
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import {
  FixedWindowRateLimiter,
  InMemoryQuotaStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createPairLoginRateLimitMiddleware } from './rate-limit-middleware.js';
import { createConsoleLogger } from './logger.js';

interface Harness {
  readonly app: express.Express;
  readonly clock: { value: number };
  readonly advance: (ms: number) => void;
}

function buildHarness(opts: {
  quotaKey: 'pair' | 'login';
  trustProxy?: boolean;
  limit?: number;
  windowMs?: number;
  /** Optional shared limiter across multiple harnesses (e.g. quota-key isolation test). */
  limiter?: FixedWindowRateLimiter;
  clock?: { value: number };
}): Harness {
  const clock = opts.clock ?? { value: 1_700_000_000_000 };
  const limiter =
    opts.limiter ??
    new FixedWindowRateLimiter({
      store: new InMemoryQuotaStore({ now: () => clock.value }),
      limit: opts.limit ?? 5,
      windowMs: opts.windowMs ?? 300_000,
      now: () => clock.value,
    });
  const app = express();
  app.use(
    createPairLoginRateLimitMiddleware({
      limiter,
      logger: createConsoleLogger({ test: 'rate-limit-mw' }),
      quotaKey: opts.quotaKey,
      ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
    }),
  );
  app.post('/probe', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return {
    app,
    clock,
    advance: (ms) => {
      clock.value += ms;
    },
  };
}

async function asyncRequest(
  app: express.Express,
  path: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: unknown;
  retryAfter: string | null;
}> {
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      })
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // leave as text
          }
          server.close();
          resolve({
            status: res.status,
            body: parsed,
            retryAfter: res.headers.get('retry-after'),
          });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('createPairLoginRateLimitMiddleware', () => {
  it('allows requests up to the limit, then 429s the next one', async () => {
    const { app } = buildHarness({ quotaKey: 'pair', limit: 5 });
    for (let i = 0; i < 5; i++) {
      const res = await asyncRequest(app, '/probe');
      expect(res.status).toBe(200);
    }
    const blocked = await asyncRequest(app, '/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.retryAfter).toBeTruthy();
    const retryAfterNum = Number(blocked.retryAfter);
    expect(Number.isFinite(retryAfterNum)).toBe(true);
    expect(retryAfterNum).toBeGreaterThanOrEqual(1);
    const body = blocked.body as {
      error: { code: string; message: string; retryAfter: number };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfter).toBe(retryAfterNum);
    expect(body.error.message).toContain(`${retryAfterNum} seconds`);
  });

  it('separates buckets per X-Forwarded-For hop when trustProxy=true', async () => {
    const { app } = buildHarness({
      quotaKey: 'pair',
      trustProxy: true,
      limit: 2,
    });
    // IP A: burns its quota.
    for (let i = 0; i < 2; i++) {
      const res = await asyncRequest(app, '/probe', {
        'X-Forwarded-For': '203.0.113.10',
      });
      expect(res.status).toBe(200);
    }
    const blockedA = await asyncRequest(app, '/probe', {
      'X-Forwarded-For': '203.0.113.10',
    });
    expect(blockedA.status).toBe(429);
    // IP B: still has full quota.
    const okB = await asyncRequest(app, '/probe', {
      'X-Forwarded-For': '198.51.100.20',
    });
    expect(okB.status).toBe(200);
  });

  it('uses only the first hop of X-Forwarded-For', async () => {
    const { app } = buildHarness({
      quotaKey: 'pair',
      trustProxy: true,
      limit: 1,
    });
    const first = await asyncRequest(app, '/probe', {
      'X-Forwarded-For': '203.0.113.10, 10.0.0.1, 10.0.0.2',
    });
    expect(first.status).toBe(200);
    // Same first hop, different downstream chain — must still hit the same bucket.
    const second = await asyncRequest(app, '/probe', {
      'X-Forwarded-For': '203.0.113.10, 10.0.0.99',
    });
    expect(second.status).toBe(429);
  });

  it('counter resets after the window expires', async () => {
    const { app, advance } = buildHarness({
      quotaKey: 'pair',
      limit: 2,
      windowMs: 60_000,
    });
    expect((await asyncRequest(app, '/probe')).status).toBe(200);
    expect((await asyncRequest(app, '/probe')).status).toBe(200);
    expect((await asyncRequest(app, '/probe')).status).toBe(429);
    // Advance past window boundary.
    advance(61_000);
    expect((await asyncRequest(app, '/probe')).status).toBe(200);
  });

  it('separates counters per quota key on a shared limiter', async () => {
    // Share a single limiter so the only thing isolating buckets is the
    // composed key (`pair:<ip>` vs `login:<ip>`).
    const clock = { value: 1_700_000_000_000 };
    const limiter = new FixedWindowRateLimiter({
      store: new InMemoryQuotaStore({ now: () => clock.value }),
      limit: 2,
      windowMs: 60_000,
      now: () => clock.value,
    });
    const pair = buildHarness({ quotaKey: 'pair', limiter, clock });
    const login = buildHarness({ quotaKey: 'login', limiter, clock });
    // Burn /pair.
    expect((await asyncRequest(pair.app, '/probe')).status).toBe(200);
    expect((await asyncRequest(pair.app, '/probe')).status).toBe(200);
    expect((await asyncRequest(pair.app, '/probe')).status).toBe(429);
    // /login still has its full quota — same IP, different quota-key prefix.
    expect((await asyncRequest(login.app, '/probe')).status).toBe(200);
    expect((await asyncRequest(login.app, '/probe')).status).toBe(200);
    expect((await asyncRequest(login.app, '/probe')).status).toBe(429);
  });

  it('fails open if the limiter throws', async () => {
    const throwingLimiter = {
      check: async (): Promise<never> => {
        throw new Error('limiter exploded');
      },
    };
    const app = express();
    app.use(
      createPairLoginRateLimitMiddleware({
        limiter: throwingLimiter,
        logger: createConsoleLogger({ test: 'rate-limit-mw' }),
        quotaKey: 'pair',
      }),
    );
    app.post('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const res = await asyncRequest(app, '/probe');
    expect(res.status).toBe(200);
  });
});
