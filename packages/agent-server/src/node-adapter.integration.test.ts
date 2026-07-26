/**
 * Integration contract for the `@hono/node-server` adapter boundary.
 *
 * Every other suite in this package drives the app through `app.fetch`,
 * which is the Hono handler — it never opens a socket, so the Node
 * adapter underneath is completely unexercised. That gap became visible
 * during the `@hono/node-server` 1.19.11 → 2.0.12 bump: v2 is a rewrite
 * of the request/response and streaming path, and the 2.0.x line then
 * shipped corrections specifically there ("recover complete request
 * bodies after client disconnect" in 2.0.9, "preserve status and
 * statusText when cloning a Response" in 2.0.6, "copy headers when init
 * is a foreign Response" in 2.0.12). None of that is visible to
 * `tsc` — the v1 and v2 `serve()` signatures are byte-identical — and
 * none of it was covered by a test.
 *
 * So this asserts what `src/server.ts` actually depends on from the
 * adapter, at the socket level:
 *
 *   - `serve()` binds a real listener and `server.close(cb)` calls back
 *   - request bodies and query strings survive the crossing
 *   - status and custom headers survive on a bodyless response
 *   - an SSE response streams INCREMENTALLY rather than buffering to
 *     completion
 *   - a client disconnect propagates into `stream.onAbort`
 *
 * The last one is the load-bearing case: `src/app.ts` wires
 * `stream.onAbort(() => abortController.abort())` so that a browser
 * closing an `/agent` stream actually stops the LLM turn behind it. If
 * the adapter ever stops propagating disconnects, nothing else in this
 * repo notices — the turn just keeps running and burning tokens for a
 * client that left.
 *
 * Deliberately built on a local Hono app rather than `createAgentApp`:
 * the subject under test is the adapter crossing, and a real agent app
 * would drag in an LLM adapter, MCP servers and a sandbox proxy, none of
 * which say anything about whether a socket abort reaches a handler.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AddressInfo } from 'node:net';

type ServerHandle = ReturnType<typeof serve>;

let server: ServerHandle | null = null;

async function listen(app: Hono): Promise<string> {
  const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  server = started;
  await new Promise<void>((resolve) => started.once('listening', () => resolve()));
  const address = started.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server === null) return;
  const closing = server;
  server = null;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

describe('@hono/node-server adapter boundary', () => {
  it('binds a real listener and round-trips a JSON response', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));

    const base = await listen(app);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('carries the query string and request body across the crossing', async () => {
    const app = new Hono();
    app.get('/echo', (c) => c.text(c.req.query('v') ?? ''));
    app.post('/body', async (c) => c.json({ got: await c.req.json() }));

    const base = await listen(app);

    expect(await (await fetch(`${base}/echo?v=hello`)).text()).toBe('hello');

    const posted = await fetch(`${base}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, nested: { b: 'two' } }),
    });
    expect(await posted.json()).toEqual({ got: { a: 1, nested: { b: 'two' } } });
  });

  it('preserves status and custom headers on a bodyless response', async () => {
    // `src/app.ts` returns bare 204s on the CORS preflight path; v2's
    // response-cloning fixes were precisely about losing these.
    const app = new Hono();
    app.get('/no-content', () => new Response(null, { status: 204, headers: { 'x-custom': 'kept' } }));

    const base = await listen(app);
    const res = await fetch(`${base}/no-content`);

    expect(res.status).toBe(204);
    expect(res.headers.get('x-custom')).toBe('kept');
  });

  it('streams SSE incrementally instead of buffering the whole response', async () => {
    let framesWritten = 0;
    const app = new Hono();
    app.get('/sse', (c) =>
      streamSSE(c, async (stream) => {
        for (let i = 0; i < 50; i += 1) {
          await stream.writeSSE({ data: `frame-${i}`, event: 'tick' });
          framesWritten += 1;
          await stream.sleep(20);
        }
      }),
    );

    const base = await listen(app);
    const res = await fetch(`${base}/sse`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    for (let chunk = 0; chunk < 2; chunk += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(received).toContain('frame-0');
    // The producer must still be mid-loop — if the adapter buffered the
    // response, all 50 frames would already be written before the first
    // read returned.
    expect(framesWritten).toBeLessThan(50);
  });

  it('propagates a client disconnect into stream.onAbort', async () => {
    // The one that matters: `src/app.ts` hangs LLM-turn cancellation off
    // this callback. Without propagation, an abandoned stream keeps the
    // turn running.
    let aborted = false;
    const app = new Hono();
    app.get('/sse', (c) =>
      streamSSE(c, async (stream) => {
        stream.onAbort(() => {
          aborted = true;
        });
        // Long enough that the producer cannot possibly run out of frames
        // inside the wait deadline below — so a pass can only mean the
        // abort propagated, never "the stream happened to end".
        for (let i = 0; i < 5_000; i += 1) {
          await stream.writeSSE({ data: `frame-${i}` });
          await stream.sleep(20);
        }
      }),
    );

    const base = await listen(app);
    const controller = new AbortController();
    const res = await fetch(`${base}/sse`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();

    controller.abort();
    await reader.cancel().catch(() => {
      // Cancelling an already-aborted body rejects on some Node versions;
      // the abort itself is what this test is about.
    });

    const deadline = Date.now() + 3_000;
    while (!aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(aborted, 'handler never observed the client disconnect').toBe(true);
  });
});
