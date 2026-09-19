import { describe, it, expect, afterEach } from 'vitest';
import { createGguiServer, type GguiServer } from './server.js';
import type { Logger } from './logger.js';

// ggui#1193 — `POST /oauth/register` is open RFC 7591 DCR by design (#1174's ruling), and an
// open door with no limiter is an unbounded anonymous write into one replica's memory. The
// door gets the same per-IP limiter `/pair` has, with its own quota, and — the bar's fourth
// criterion — a denial that NAMES ITSELF on both surfaces the parties read: the caller's
// 429 body + `Retry-After`, and the operator's `rate_limit_hit` log line.
type LogRecord = { readonly level: string; readonly msg: string; readonly meta: unknown };
function recordingLogger(sink: LogRecord[]): Logger {
  const make = (): Logger => ({
    info: (msg, meta) => { sink.push({ level: 'info', msg, meta }); },
    warn: (msg, meta) => { sink.push({ level: 'warn', msg, meta }); },
    error: (msg, meta) => { sink.push({ level: 'error', msg, meta }); },
    debug: () => {},
    child: () => make(),
  });
  return make();
}

type Fx = { readonly server: GguiServer; readonly url: string; readonly logs: LogRecord[] };
async function boot(trustProxy?: boolean): Promise<Fx> {
  const logs: LogRecord[] = [];
  const server = createGguiServer({
    logger: recordingLogger(logs),
    oauth: { issuerUrl: 'https://mcp.example.test' },
    ...(trustProxy !== undefined ? { trustProxy } : {}),
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { server, url: `http://127.0.0.1:${addr.port}`, logs };
}
async function register(fx: Fx, ip?: string): Promise<Response> {
  return fetch(`${fx.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip !== undefined ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
  });
}

describe('ggui#1193 — per-IP rate limit on POST /oauth/register', () => {
  let fx: Fx;
  afterEach(async () => { await fx.server.close(); });

  it('allows 10 registrations per IP per window, refuses the 11th with 429 + Retry-After + a body that names the reason, and logs rate_limit_hit under its own quotaKey', async () => {
    fx = await boot();
    for (let i = 0; i < 10; i++) {
      expect((await register(fx)).status, `registration ${i + 1}`).toBe(201);
    }
    const denied = await register(fx);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await denied.json()) as { error?: { code?: string; retryAfter?: number } };
    expect(body.error?.code).toBe('rate_limited');
    const hits = fx.logs.filter((l) => l.msg === 'rate_limit_hit');
    expect(hits).toHaveLength(1);
    expect((hits[0]!.meta as { quotaKey?: string }).quotaKey).toBe('oauth-register');
  });

  it('with trustProxy, each X-Forwarded-For address is its own bucket — a second client is not throttled by the first', async () => {
    fx = await boot(true);
    for (let i = 0; i < 10; i++) expect((await register(fx, '203.0.113.1')).status).toBe(201);
    expect((await register(fx, '203.0.113.1')).status).toBe(429);
    expect((await register(fx, '203.0.113.2')).status).toBe(201);
  });
});
