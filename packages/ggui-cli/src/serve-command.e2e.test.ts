/**
 * End-to-end smoke — proves `ggui serve` actually boots
 * `@ggui-ai/mcp-server` and speaks the protocol over HTTP.
 * Separate file so the fast-path `serve-command.test.ts` stays
 * genuinely unit (no network, no listeners).
 *
 * We don't invoke the binary via spawn — that would pull in the full
 * CLI dispatcher + signal handlers. Instead we compose the same
 * `runServe` + `createGguiServer` path the bin uses, on an ephemeral
 * port, and verify the HTTP surface is live.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGguiServer } from '@ggui-ai/mcp-server';
import {
  DEFAULT_SERVE_HOST,
  runServe,
  type ServeBackend,
} from './serve-command.js';

describe('runServe + createGguiServer (end-to-end)', () => {
  const controllers: AbortController[] = [];

  afterEach(async () => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
    // Let the post-abort `close()` microtasks settle so the next test
    // boots on a clean slate.
    await new Promise((resolve) => setImmediate(resolve));
  });

  /**
   * Mirror `cli.ts`'s adapter: takes a `createGguiServer()` instance
   * and wraps it in the `ServeBackend` shape.
   */
  function toBackend(
    inner: ReturnType<typeof createGguiServer>,
    toolCount = 3,
  ): ServeBackend {
    return {
      toolCount,
      serverName: 'ggui-mcp-server',
      serverVersion: '0.0.1',
      primitiveCatalogCount: inner.primitiveCatalogs.length,
      themeSource: inner.theme.source,
      adapters: inner.adapters,
      pairingService: inner.pairingService,
      adminToken: inner.adminToken,
      async listen(port, host) {
        const httpServer = await inner.listen(port, host);
        const addr = httpServer.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('server.address() returned an unexpected shape');
        }
        return addr.port;
      },
      close: () => inner.close(),
    };
  }

  it('binds an ephemeral port and serves /ggui/health', async () => {
    const silentLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => silentLogger,
    };
    const server = createGguiServer({ logger: silentLogger });
    const controller = new AbortController();
    controllers.push(controller);

    // Capture the banner so we can extract the bound URL — same
    // flow `cli.ts` runs in production.
    const out: string[] = [];
    const servePromise = runServe({
      flags: { port: 0, host: DEFAULT_SERVE_HOST, mcpOnly: true },
      backendFactory: () => toBackend(server),
      agentStatus: { kind: 'disabled', reason: '--mcp-only' },
      stdout: { write: (chunk) => out.push(chunk) },
      shutdownSignal: controller.signal,
    });

    // Give `runServe` a tick to complete `listen` + print the banner.
    await new Promise((resolve) => setImmediate(resolve));

    // Parse the bound port out of the banner. Defensive — the banner
    // copy is pinned by describeServeBanner() tests, so this regex is
    // stable.
    const banner = out.join('');
    const match = banner.match(/http:\/\/127\.0\.0\.1:(\d+)\/ggui\/health/);
    if (!match) {
      controller.abort();
      throw new Error(`banner did not surface a health URL:\n${banner}`);
    }
    const boundPort = Number(match[1]);
    expect(boundPort).toBeGreaterThan(0);
    expect(boundPort).not.toBe(0);

    // Real HTTP probe — proves the Express app is accepting
    // connections behind the banner.
    const health = await fetch(
      `http://127.0.0.1:${boundPort}/ggui/health`,
    );
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      server: 'ggui-mcp-server',
      version: '0.0.1',
    });
    // Bare `ggui serve` (no `ggui.json` in cwd) registers the
    // always-on subset: 2 blueprint-read handlers + the render-
    // lifecycle / handshake-first / runtime gesture tools. The exact
    // count grows over time as new lifecycle tools land — pin a
    // sanity floor instead of an exact match so additive growth
    // doesn't regress the smoke test.
    expect(body['tools']).toEqual(expect.any(Number));
    expect(body['tools'] as number).toBeGreaterThanOrEqual(3);

    // Graceful shutdown via the signal.
    controller.abort();
    const exitCode = await servePromise;
    expect(exitCode).toBe(0);

    // After close, subsequent connects fail.
    await expect(
      fetch(`http://127.0.0.1:${boundPort}/ggui/health`),
    ).rejects.toThrow();
  });
});
