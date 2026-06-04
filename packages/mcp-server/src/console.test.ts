/**
 * Wiring tests for `createGguiServer({ console })`.
 *
 * Covers the Slice-1 surface locked in
 * `docs/plans/2026-04-20-core-server-console-mvp.md`:
 *
 *   - disabled by default (no routes mount, same surface as pre-console)
 *   - info endpoint shape (server + version + optional description +
 *     pairing: { enabled, pending })
 *   - pairing block reflects `pairingService.activeInit()` when
 *     pairing is enabled, reflects `enabled: false, pending: null`
 *     when pairing is disabled
 *   - static handler serves `index.html` at the mount path from the
 *     supplied `distDir`, honors `path:` override
 *   - missing-distDir falls back to 503 with the operator-facing hint
 *
 * Uses a tmp-dir fixture for `distDir` so the test doesn't depend on
 * the console package having been built — the point of this suite
 * is the wire between mcp-server and the landing bundle, not the
 * bundle's internals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Server as HttpServer } from 'node:http';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';
import { DEVTOOL_CSP } from './console-headers.js';

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
  distDir?: string;
}

async function boot(
  opts: Parameters<typeof createGguiServer>[0] = {},
): Promise<Fixture> {
  const server = createGguiServer({ logger: silentLogger, ...opts });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
}

function makeDistFixture(indexBody: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ggui-console-'));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), indexBody, 'utf-8');
  writeFileSync(
    path.join(dir, 'assets', 'app.js'),
    'console.log("stub")',
    'utf-8',
  );
  return dir;
}

describe('createGguiServer — console opt-in', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      if (fx.distDir) rmSync(fx.distDir, { recursive: true, force: true });
      fx = null;
    }
  });

  it('default (console omitted) does not mount any console routes', async () => {
    fx = await boot();
    const info = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(info.status).toBe(404);
    const root = await fetch(`${fx.url}/`);
    expect(root.status).toBe(404);
  });

  it('console: false is equivalent to omitted', async () => {
    fx = await boot({ console: false });
    const info = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(info.status).toBe(404);
  });

  it('info endpoint returns server identity + pairing-disabled block', async () => {
    const distDir = makeDistFixture('<html><body>landing</body></html>');
    fx = await boot({
      console: { distDir },
      info: { name: 'test-server', version: '1.2.3', description: 'hello' },
    });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      server: string;
      version: string;
      description?: string;
      pairing: { enabled: boolean; pending: unknown };
    };
    expect(body.server).toBe('test-server');
    expect(body.version).toBe('1.2.3');
    expect(body.description).toBe('hello');
    expect(body.pairing.enabled).toBe(false);
    expect(body.pairing.pending).toBeNull();
  });

  it('info endpoint surfaces pairing.activeInit() when pairing is enabled', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      pairing: true,
      console: { distDir },
    });
    fx.distDir = distDir;
    // Mint a pending code via the programmatic seam.
    const init = await fx.server.pairingService!.initPairing();

    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pairing: {
        enabled: boolean;
        pending: {
          code: string;
          codeExpiresAt: number;
          serverName: string;
        } | null;
      };
    };
    expect(body.pairing.enabled).toBe(true);
    expect(body.pairing.pending).not.toBeNull();
    expect(body.pairing.pending!.code).toBe(init.code);
    expect(body.pairing.pending!.codeExpiresAt).toBe(init.codeExpiresAt);
  });

  it('info endpoint exposes capabilities + storage (Slice 2 dashboard fields)', async () => {
    // The status-dashboard page reads these to paint its cards. Bare
    // boot: no uiRegistry, no primitiveCatalogs, no generation, no
    // custom stores → the endpoint must still land valid defaults.
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as {
      capabilities: {
        toolCount: number;
        blueprintCount: number;
        primitiveCount: number;
        agentWired: boolean;
        generation: { wired: boolean; hasCredentials: boolean };
      };
      storage: {
        renderStore: 'memory' | 'custom';
        vectorStore: 'memory' | 'custom';
      };
    };
    expect(body.capabilities.toolCount).toBeGreaterThanOrEqual(0);
    expect(body.capabilities.blueprintCount).toBe(0);
    expect(body.capabilities.primitiveCount).toBe(0);
    expect(body.capabilities.agentWired).toBe(false);
    // No generation dep bound and no credential probe runs.
    expect(body.capabilities.generation).toEqual({
      wired: false,
      hasCredentials: false,
    });
    // Bare boot falls back to in-memory for both stores.
    expect(body.storage.renderStore).toBe('memory');
    expect(body.storage.vectorStore).toBe('memory');
  });

  it('info endpoint reports primitiveCount summed across all catalogs', async () => {
    fx = await boot({
      console: {},
      primitiveCatalogs: [
        {
          source: 'package' as const,
          import: '@ggui-ai/design/primitives',
          manifestPath: '/tmp/design/ggui.primitives.json',
          manifest: {
            schema: '1' as const,
            import: '@ggui-ai/design/primitives',
            primitives: [{ name: 'Button' }, { name: 'Card' }],
          },
        },
        {
          source: 'local' as const,
          import: './ui/primitives',
          manifestPath: '/tmp/app/ui/primitives/ggui.primitives.json',
          manifest: {
            schema: '1' as const,
            import: './ui/primitives',
            primitives: [{ name: 'Brand' }],
          },
        },
      ],
    });
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as {
      capabilities: { primitiveCount: number };
    };
    expect(body.capabilities.primitiveCount).toBe(3);
  });

  it('info endpoint reports pending:null when pairing enabled but idle', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      pairing: true,
      console: { distDir },
    });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as {
      pairing: { enabled: boolean; pending: unknown };
    };
    expect(body.pairing.enabled).toBe(true);
    expect(body.pairing.pending).toBeNull();
  });

  it('static handler serves index.html at / when distDir exists', async () => {
    const distDir = makeDistFixture('<!doctype html><title>ok</title>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>ok</title>');
  });

  it('static handler serves asset files from dist/assets', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  it('path:"/ui" remounts the static handler at the alternate prefix', async () => {
    const distDir = makeDistFixture('<html><body>under /ui</body></html>');
    fx = await boot({ console: { path: '/ui', distDir } });
    fx.distDir = distDir;
    // Root is NOT the console mount anymore.
    const rootRes = await fetch(`${fx.url}/`);
    expect(rootRes.status).toBe(404);
    // The /ui path is.
    const uiRes = await fetch(`${fx.url}/ui`);
    expect(uiRes.status).toBe(200);
    expect(await uiRes.text()).toContain('under /ui');
    // Info endpoint is unaffected by `path:` (always `/ggui/...`).
    const infoRes = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(infoRes.status).toBe(200);
  });

  it('missing distDir -> 503 + operator hint (never silent 404)', async () => {
    // Point at a path that demonstrably does not exist.
    const missing = path.join(tmpdir(), `ggui-console-missing-${Date.now()}`);
    fx = await boot({ console: { distDir: missing } });
    const res = await fetch(`${fx.url}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toMatch(/console bundle not built/);
    expect(body).toMatch(/pnpm .*console.*build/);
  });

  it('info endpoint still works when distDir is missing (route ordering)', async () => {
    // Info is NOT gated on distDir — reading server identity shouldn't
    // require the bundle to be built. This pins the register-order
    // invariant: info endpoint is mounted BEFORE the static/fallback.
    const missing = path.join(tmpdir(), `ggui-console-missing-${Date.now()}`);
    fx = await boot({ console: { distDir: missing } });
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
  });

  it('static mount serves index.html for client-side route paths (SPA fallback)', async () => {
    // The SPA router owns `/s/<shortCode>` on the client; the server
    // must serve index.html for ANY non-asset, non-API path under
    // the mount so the React app can handle the route switch.
    const distDir = makeDistFixture('<!doctype html><title>spa</title>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/s/anything-goes-here`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>spa</title>');
  });

  it('SPA fallback does NOT catch asset 404s under /assets/', async () => {
    // A typo'd `/assets/foo.js` must 404 rather than silently return
    // HTML — that would mask build errors where the SPA references
    // an asset that doesn't exist.
    const distDir = makeDistFixture('<!doctype html><title>spa</title>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/assets/missing.js`);
    expect(res.status).toBe(404);
  });
});

/*
 * Slice 2 C4 — render-cookie flow + scope isolation.
 *
 * Covers:
 *   - construction errors when preconditions missing
 *   - cookie-mint happy path (200 + Set-Cookie)
 *   - unknown shortCode → 404 + no Set-Cookie
 *   - 400 on missing/bad body
 *   - cookie does NOT authenticate /mcp (scope invariant)
 *   - cookie DOES authenticate the live-channel WS upgrade, scoped
 *     to the bound render (subscribe renderId mismatch rejected)
 */
describe('createGguiServer — console.sessionCookie', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      if (fx.distDir) rmSync(fx.distDir, { recursive: true, force: true });
      fx = null;
    }
  });

  it('throws when sessionCookie is enabled without renderChannel', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        console: { sessionCookie: true },
        shortCodeIndex: new InMemoryShortCodeIndex(),
      }),
    ).toThrow(/renderChannel: true/);
  });

  it('throws when sessionCookie is enabled without shortCodeIndex', async () => {
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        renderChannel: true,
        console: { sessionCookie: true },
      }),
    ).toThrow(/shortCodeIndex/);
  });

  it('POST /render-cookie returns 404 for unknown short-code', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      renderChannel: true,
      shortCodeIndex: new InMemoryShortCodeIndex(),
      console: { sessionCookie: true },
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /render-cookie returns 400 on missing shortCode', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      renderChannel: true,
      shortCodeIndex: new InMemoryShortCodeIndex(),
      console: { sessionCookie: true },
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /render-cookie mints a cookie for a known short-code', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });

    fx = await boot({
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('ggui_console_session=');
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const body = (await res.json()) as {
      renderId: string;
      appId: string;
      expiresAt: number;
    };
    expect(body.renderId).toBe('sess-1');
    expect(body.appId).toBe('app-1');
    expect(typeof body.expiresAt).toBe('number');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('cookie does NOT authenticate /mcp (scope isolation)', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    // Mint the cookie.
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    const setCookie = mintRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';')[0]; // `ggui_console_session=<token>`

    // Try to use the cookie against /mcp — should fail auth since
    // /mcp uses the AuthAdapter bearer path, not cookies.
    const mcpRes = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookiePair,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(mcpRes.status).toBe(401);
  });

  it('cookie does NOT authenticate /ggui/auth-check either', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    const cookiePair = (mintRes.headers.get('set-cookie') ?? '').split(';')[0];
    const probe = await fetch(`${fx.url}/ggui/auth-check`, {
      headers: { cookie: cookiePair ?? '' },
    });
    // auth-check uses the AuthAdapter bearer path; cookies are
    // invisible to it.
    expect(probe.status).toBe(401);
  });

  it('cookie authenticates /ws upgrade and binds to the cookie session', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    // Mint the cookie via HTTP so the token was really produced by
    // the server (don't shortcut the plumbing).
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    const setCookie = mintRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';')[0];
    if (!cookiePair) throw new Error('no cookie minted');

    const { WebSocket } = await import('ws');
    const wsUrl = fx.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie: cookiePair } });

    const ack = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { renderId: 'sess-1', appId: 'app-1' },
            requestId: 'r1',
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        resolve(JSON.parse(String(raw)));
      });
      ws.on('error', (err: Error) => reject(err));
    });
    ws.close();
    expect(ack).toMatchObject({ type: 'ack' });
  });

  it('cookie-bound subscribe rejects mismatched renderId', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    const cookiePair = (mintRes.headers.get('set-cookie') ?? '').split(';')[0];
    if (!cookiePair) throw new Error('no cookie minted');

    const { WebSocket } = await import('ws');
    const wsUrl = fx.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie: cookiePair } });

    const msg = await new Promise<{
      type: string;
      payload?: { code?: string };
    }>((resolve, reject) => {
      ws.on('open', () => {
        // Try to subscribe to a DIFFERENT session than the cookie
        // is bound to.
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { renderId: 'sess-other', appId: 'app-1' },
            requestId: 'r1',
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        resolve(
          JSON.parse(String(raw)) as {
            type: string;
            payload?: { code?: string };
          },
        );
      });
      ws.on('error', (err: Error) => reject(err));
    });
    ws.close();
    expect(msg.type).toBe('error');
    expect(msg.payload?.code).toBe('DEVTOOL_COOKIE_RENDER_MISMATCH');
  });

  it('invalid cookie on /ws upgrade rejects the handshake (401)', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: new InMemoryShortCodeIndex(),
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    const { WebSocket } = await import('ws');
    const wsUrl = fx.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, {
      headers: { cookie: 'ggui_console_session=not-a-real-token' },
    });
    await new Promise<void>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        ws.close();
        resolve();
      });
      ws.on('error', () => {
        // Some ws versions surface 401 as a plain error.
        resolve();
      });
    });
  });
});

/*
 * Slice 3 C1 — CSP + security headers for console responses.
 *
 * Covers:
 *   - headers land on the static HTML response
 *   - headers land on static asset responses
 *   - headers land on the SPA fallback (client-routed paths like /s/...)
 *   - headers land on the 503 distDir-missing fallback
 *   - headers land on the info endpoint
 *   - headers land on the cookie-mint endpoint (all status codes)
 *   - headers do NOT bleed onto /mcp, /ggui/health, /ggui/auth-check
 *   - exact CSP string reaches the wire (guards against middleware
 *     re-ordering or an accidental header mutation)
 */
describe('createGguiServer — console security headers', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      if (fx.distDir) rmSync(fx.distDir, { recursive: true, force: true });
      fx = null;
    }
  });

  const expectDevtoolHeaders = (res: Response): void => {
    expect(res.headers.get('content-security-policy')).toBe(DEVTOOL_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  };

  it('emits full security header set on the landing index.html response', async () => {
    const distDir = makeDistFixture('<!doctype html><title>landing</title>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/`);
    expect(res.status).toBe(200);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on static asset responses', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on SPA fallback (client-side routes)', async () => {
    const distDir = makeDistFixture('<!doctype html><title>spa</title>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/s/any-code`);
    expect(res.status).toBe(200);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on /ggui/console/info', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on cookie-mint 400 (missing body)', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      renderChannel: true,
      shortCodeIndex: new InMemoryShortCodeIndex(),
      console: { sessionCookie: true },
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on cookie-mint 404 (unknown short-code)', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      renderChannel: true,
      shortCodeIndex: new InMemoryShortCodeIndex(),
      console: { sessionCookie: true },
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'nope' }),
    });
    expect(res.status).toBe(404);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on cookie-mint 200 (happy path)', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('abc12345', { renderId: 'sess-1', appId: 'app-1' });
    fx = await boot({
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'x'.repeat(32),
    });
    const res = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'abc12345' }),
    });
    expect(res.status).toBe(200);
    expectDevtoolHeaders(res);
  });

  it('emits full security header set on the 503 distDir-missing fallback', async () => {
    const missing = path.join(tmpdir(), `ggui-console-missing-${Date.now()}`);
    fx = await boot({ console: { distDir: missing } });
    const res = await fetch(`${fx.url}/`);
    expect(res.status).toBe(503);
    expectDevtoolHeaders(res);
  });

  it('does NOT emit CSP on /mcp (scope lock — API surface stays headerless)', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    // Any request method to /mcp works for this assertion — we're
    // checking the boundary, not the endpoint's behavior.
    const res = await fetch(`${fx.url}/mcp`, { method: 'GET' });
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('does NOT emit CSP on /ggui/health (scope lock)', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/ggui/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('does NOT emit CSP on /ggui/auth-check (scope lock)', async () => {
    const distDir = makeDistFixture('<html></html>');
    fx = await boot({ console: { distDir } });
    fx.distDir = distDir;
    const res = await fetch(`${fx.url}/ggui/auth-check`);
    // Status will be 401 (no bearer) or 204 (devAllowAll), either way
    // the boundary assertion is about the header NOT being set.
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('emits CSP only when console is enabled (disabled → no CSP anywhere)', async () => {
    fx = await boot(); // console omitted
    const health = await fetch(`${fx.url}/ggui/health`);
    expect(health.headers.get('content-security-policy')).toBeNull();
    // And /ggui/console/info doesn't even exist.
    const info = await fetch(`${fx.url}/ggui/console/info`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(info.status).toBe(404);
  });

  // Slice 4 follow-on — dynamic `import(blob:URL)` + bare-specifier
  // data-URL rewriting are the documented rendering path for generated
  // componentCode. Stripping `blob:` or `data:` from script-src silently
  // breaks the whole viewer: the renderer's `loadModule` calls
  // `URL.createObjectURL` on a Blob containing the compiled ESM and
  // dynamically imports that URL, and the compiled module's bare
  // `import React from 'react'` is rewritten to
  // `import React from 'data:text/javascript,…'` by
  // `@ggui-ai/design/rendering/rewrite-imports.ts`. Without both, the
  // browser rejects the imports and every stack entry renders as
  // "Failed to load component". These assertions pin both directives
  // so a future CSP tightening requires an explicit re-justification
  // instead of silently regressing the render path.
  it('permits `blob:` + `data:` in script-src for the renderer import paths', () => {
    expect(DEVTOOL_CSP).toMatch(/script-src\s+[^;]*\sblob:(\s|;|$)/);
    expect(DEVTOOL_CSP).toMatch(/script-src\s+[^;]*\sdata:(\s|;|$)/);
  });
});

/*
 * Slice 3 C2 — full ceremony integration coverage.
 *
 * The Slice-2 tests cover each seam individually: cookie mints,
 * cookie authenticates /ws, scope isolation, short-code lookup. This
 * block pins the FULL happy-path ceremony — the chain that the
 * console viewer actually walks from "operator opens
 * /s/<shortCode>" to "agent push appears on the browser":
 *
 *   1. shortCodeIndex.put (simulates the write ggui_render does).
 *   2. POST /ggui/console/render-cookie → 200 + Set-Cookie.
 *   3. WebSocket upgrade to /ws carrying the cookie.
 *   4. subscribe → ack (cookie-bound, no bearer in sight).
 *   5. server-side sendToRender → subscriber receives the data frame.
 *
 * Tests the integration across packages (mcp-server-core short-code
 * index + mcp-server console routes + mcp-server session-channel
 * cookie-auth) that no single-seam test can catch.
 *
 * Reserved channel `_ggui:preview` is used for the test delivery
 * because reserved channels bypass streamSpec declaration (matching
 * the A2UI provisional-preview path that console actually
 * consumes). A non-reserved channel would require seeding a stack
 * item with a declared streamSpec — orthogonal plumbing that would
 * obscure what this test is pinning.
 */
describe('createGguiServer — console full ceremony integration', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      if (fx.distDir) rmSync(fx.distDir, { recursive: true, force: true });
      fx = null;
    }
  });

  it('short-code → cookie mint → WS subscribe → sendToRender delivers to subscriber', async () => {
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('xyz98765', { renderId: 'sess-42', appId: 'app-42' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'y'.repeat(32),
    });

    // Step 1: mint the cookie via HTTP (no shortcut around the
    // endpoint — this is what the SPA calls).
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'xyz98765' }),
    });
    expect(mintRes.status).toBe(200);
    const setCookie = mintRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';')[0];
    if (!cookiePair) throw new Error('no cookie minted');

    // Step 2: open the WebSocket with the cookie. No bearer — cookie
    // is the sole upgrade credential.
    const { WebSocket } = await import('ws');
    const wsUrl = fx.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie: cookiePair } });

    const messages: unknown[] = [];
    const ack = await new Promise<{ type: string }>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { renderId: 'sess-42', appId: 'app-42' },
            requestId: 'r1',
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        messages.push(msg);
        if (msg.type === 'ack') resolve(msg);
      });
      ws.on('error', (err: Error) => reject(err));
    });
    expect(ack.type).toBe('ack');

    // Step 3: server-side fan-out. Reserved channel bypasses
    // streamSpec declaration — matches the A2UI preview path
    // console actually consumes.
    const dataPromise = new Promise<{
      type: string;
      payload: { channel: string; payload: unknown };
    }>((resolve) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(String(raw)) as {
          type: string;
          payload?: { channel?: string; payload?: unknown };
        };
        if (msg.type === 'data' && msg.payload?.channel === '_ggui:preview') {
          resolve(
            msg as {
              type: string;
              payload: { channel: string; payload: unknown };
            },
          );
        }
      });
    });
    // `_ggui:preview` payloads validate against the A2UI v0.9 write-path
    // union (server defaults compose the A2UI validator via Item 4
    // injection). Use the smallest valid shape — `deleteSurface` — so
    // the test proves fan-out wiring without coupling to a fake payload.
    await fx.server.renderChannel!.sendToRender({
      renderId: 'sess-42',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { version: 'v0.9', deleteSurface: { surfaceId: 'surf-1' } },
    });
    const data = await dataPromise;
    expect(data.payload.payload).toEqual({
      version: 'v0.9',
      deleteSurface: { surfaceId: 'surf-1' },
    });

    ws.close();
  });

  it('full ceremony — cookie-scoped subscribe rejects hostile renderId even after ack attempt', async () => {
    // Belt-and-braces: the ceremony WITHOUT a cookie-session match
    // must not leak frames into the wrong session. Pins that cookie
    // binding is enforced at subscribe time, not just advisory.
    const { InMemoryShortCodeIndex } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    const index = new InMemoryShortCodeIndex();
    await index.put('xyz98765', { renderId: 'sess-42', appId: 'app-42' });

    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      renderChannel: true,
      shortCodeIndex: index,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-secret-' + 'z'.repeat(32),
    });
    const mintRes = await fetch(`${fx.url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shortCode: 'xyz98765' }),
    });
    const cookiePair = (mintRes.headers.get('set-cookie') ?? '').split(';')[0];
    if (!cookiePair) throw new Error('no cookie minted');

    const { WebSocket } = await import('ws');
    const wsUrl = fx.url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie: cookiePair } });

    const firstMessage = await new Promise<{
      type: string;
      payload?: { code?: string };
    }>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: { renderId: 'other-session', appId: 'app-42' },
            requestId: 'r1',
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        resolve(
          JSON.parse(String(raw)) as {
            type: string;
            payload?: { code?: string };
          },
        );
      });
      ws.on('error', (err: Error) => reject(err));
    });
    expect(firstMessage.type).toBe('error');
    expect(firstMessage.payload?.code).toBe(
      'DEVTOOL_COOKIE_RENDER_MISMATCH',
    );

    // Even a server-side fan-out to the LEGITIMATE session the
    // cookie is bound to must not reach this rejected subscriber —
    // the rejection terminated before the subscriber was registered.
    const frames: unknown[] = [];
    ws.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(String(raw)));
    });
    await fx.server.renderChannel!.sendToRender({
      renderId: 'sess-42', // the cookie's real session
      channel: '_ggui:preview',
      mode: 'append',
      // Valid A2UI shape (payload passes the injected validator) — the
      // rejection must come from the cookie-session mismatch path, not
      // from a malformed-payload fluke.
      payload: { version: 'v0.9', deleteSurface: { surfaceId: 'surf-42' } },
    });
    // Give the event loop a tick to deliver any (erroneous) frames.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(frames).toEqual([]);
    ws.close();
  });
});
