/**
 * Wire test for `GET /code/:hash.js` — the content-addressable
 * componentCode delivery route.
 *
 * Slice 1b of `docs/plans/2026-05-03-content-addressable-code-delivery.md`.
 * Covers:
 *   - 200 + bytes + Content-Type + Cache-Control: immutable on hit
 *   - 404 on unknown hash (with no-store cache header — never cache misses)
 *   - 400 on malformed hash (path-traversal defense)
 *   - CORS `*` always present (iframe origin differs from server origin)
 *   - Route absent when `codeStore` opt is omitted
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { sha256Hex } from '@ggui-ai/mcp-server-core';
import { InMemoryCodeStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiServer,
  type CreateGguiServerOptions,
  type GguiServer,
} from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  store: InMemoryCodeStore;
}

async function boot(
  opts: CreateGguiServerOptions = {},
  store?: InMemoryCodeStore,
): Promise<Fixture> {
  const codeStore = store ?? new InMemoryCodeStore();
  const server = createGguiServer({
    logger: silentLogger,
    codeStore,
    ...opts,
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return {
    server,
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    store: codeStore,
  };
}

describe('GET /code/:hash.js', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await new Promise<void>((resolve) => fx!.httpServer.close(() => resolve()));
      fx = null;
    }
  });

  it('returns 200 with the stored code, immutable cache, JS content-type, and CORS *', async () => {
    fx = await boot();
    const code = 'export default function Card(){return null;}';
    const hash = sha256Hex(code);
    await fx.store.put(hash, code);

    const res = await fetch(`${fx.url}/code/${hash}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(
      /application\/javascript;\s*charset=utf-8/i,
    );
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toBe(code);
  });

  it('returns 404 with no-store on unknown hash', async () => {
    fx = await boot();
    const unknown = sha256Hex('never-stored');
    const res = await fetch(`${fx.url}/code/${unknown}.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'not_found', message: 'unknown code hash' },
    });
  });

  it('returns 400 on malformed hash (too short)', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/code/abc.js`);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 on malformed hash (uppercase hex)', async () => {
    fx = await boot();
    const code = 'const A = 1;';
    const upper = sha256Hex(code).toUpperCase();
    const res = await fetch(`${fx.url}/code/${upper}.js`);
    expect(res.status).toBe(400);
  });

  it('rejects path-traversal attempts at the route layer (express decodes %2e)', async () => {
    fx = await boot();
    // Express's path matcher strips slashes; the regex narrows charset.
    // Try a hash-shaped string with non-hex chars.
    const res = await fetch(
      `${fx.url}/code/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.js`,
    );
    expect(res.status).toBe(400);
  });

  it('does NOT mount the route when codeStore opt is omitted', async () => {
    // boot without passing a store — pass `codeStore: undefined` explicitly
    // to suppress the helper's default.
    const server = createGguiServer({
      logger: silentLogger,
      codeStore: undefined,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    try {
      const code = 'const A = 1;';
      const hash = sha256Hex(code);
      const res = await fetch(`http://127.0.0.1:${addr.port}/code/${hash}.js`);
      // Without the route, the express 404 handler returns "Cannot GET ..."
      // — the body is text/html, NOT our JSON envelope. That's the
      // signal that the codeStore route did not mount.
      expect(res.status).toBe(404);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toMatch(/application\/javascript/);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('preserves UTF-8 bytes through the round-trip', async () => {
    fx = await boot();
    const code = 'const greeting = "Привет 你好 🚀";';
    const hash = sha256Hex(code);
    await fx.store.put(hash, code);
    const res = await fetch(`${fx.url}/code/${hash}.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(code);
  });
});
