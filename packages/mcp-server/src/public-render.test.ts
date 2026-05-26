/**
 * Tests for `GET /r/:shortCode` — the public HTTP fallback that serves
 * the same self-contained shell as `ui://ggui/session/<sid>` at a real
 * URL.
 *
 * Wired so MCP custom-connector hosts (claude.ai, ChatGPT, etc.) that
 * surface `structuredContent.url` as a clickable link instead of inline-
 * rendering the resource still give users a meaningful place to click.
 *
 * Mount conditions: `mcpApps: true` + `sessionStore` + `shortCodeIndex`.
 * Absent any of those, the route is NOT mounted and Express returns a
 * default 404.
 *
 * Lane 3 of the 4-lane taxonomy (in-process fake, no browser).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

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
  sessionId: string;
  shortCode: string;
}

async function bootWithSession(opts: {
  withComponentCode: boolean;
}): Promise<Fixture> {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.create({ appId: 'app-public-render' });
  if (opts.withComponentCode) {
    await sessionStore.appendStackItem(session.id, {
      id: 'item-1',
      type: 'component',
      componentCode:
        'export default function Demo() { return null; }\n',
      createdAt: new Date().toISOString(),
    });
  }
  const shortCodeIndex = new InMemoryShortCodeIndex();
  const shortCode = 'scode-public-1';
  await shortCodeIndex.put(shortCode, {
    sessionId: session.id,
    appId: session.appId,
  });
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    sessionChannel: true,
    sessionStore,
    shortCodeIndex,
    wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
    // C.2 sig verification adds `?sig=...&exp=...` to render URLs.
    // These tests probe `/r/:shortCode` with bare codes (they don't
    // mint URLs through the push path), so disable signing to keep
    // the test surface focused on the routing + projection logic.
    renderSigning: false,
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
    sessionId: session.id,
    shortCode,
  };
}

describe('GET /r/:shortCode', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 200 + self-contained shell when session has componentCode', async () => {
    fx = await bootWithSession({ withComponentCode: true });
    const res = await fetch(`${fx.url}/r/${fx.shortCode}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    // Cache-Control must be no-store so hosts (claude.ai mobile) don't
    // pin users on stale shells across runtime fixes.
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    // Self-contained shell pins the bootstrap as a JSON variable in
    // the page; the appId we created the session with rides on it.
    expect(body).toContain('app-public-render');
  });

  it('returns 202 + auto-polling page when session has no componentCode yet', async () => {
    fx = await bootWithSession({ withComponentCode: false });
    const res = await fetch(`${fx.url}/r/${fx.shortCode}`);
    // 202 = "request accepted, processing not finished" — operator
    // sees a "Generating UI…" page; the inline poll script reloads
    // every 1.5s until generation lands.
    expect(res.status).toBe(202);
    const body = await res.text();
    expect(body).toContain('Generating UI');
    expect(body).toContain('location.reload');
  });

  it('returns 404 when shortCode does not resolve', async () => {
    fx = await bootWithSession({ withComponentCode: true });
    const res = await fetch(`${fx.url}/r/no-such-code`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('shortCode not found');
  });

  it('returns 404 + loading shell when binding exists but session was evicted', async () => {
    // Bind shortCode against a session id we never persist — session
    // store will return null for `get(sessionId)`.
    const sessionStore = new InMemorySessionStore();
    const shortCodeIndex = new InMemoryShortCodeIndex();
    await shortCodeIndex.put('orphan-code', {
      sessionId: 'sid-never-existed',
      appId: 'app-orphan',
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      mcpApps: true,
      sessionChannel: true,
      sessionStore,
      shortCodeIndex,
      wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
      renderSigning: false,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    fx = {
      server,
      httpServer,
      url: `http://127.0.0.1:${addr.port}`,
      sessionId: 'sid-never-existed',
      shortCode: 'orphan-code',
    };
    const res = await fetch(`${fx.url}/r/orphan-code`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    // The loading shell carries the sessionId so a reload after the
    // session lands picks up componentCode without a route change.
    expect(body).toContain('sid-never-existed');
  });

  it('inlines runtimeUrl on the bootstrap (Slice 14 — closes the blank-page bug)', async () => {
    fx = await bootWithSession({ withComponentCode: true });
    const res = await fetch(`${fx.url}/r/${fx.shortCode}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The shell stamps the bootstrap as a JS literal. Match the
    // `runtimeUrl` field; the test doesn't pin the exact URL because
    // the OSS server's default is `/_ggui/iframe-runtime.js` and a
    // future override would still satisfy the contract.
    expect(body).toMatch(/window\.__GGUI_META__ = \{[^}]*"runtimeUrl"/);
  });

  it('inlines the live-mode trio (wsUrl/token/expiresAt) when the bootstrap minter is wired', async () => {
    // Regression: pre-fix the route emitted a bootstrap without the
    // live trio, so iframe-runtime's `subscribe.ts` refused to open a
    // WS ("live-mode required") and `ggui_update` succeeded server-side
    // but the mounted iframe never re-rendered. Mirrors the JSON
    // `/api/bootstrap/<shortCode>` route which always returns the trio.
    fx = await bootWithSession({ withComponentCode: true });
    const res = await fetch(`${fx.url}/r/${fx.shortCode}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // All three are required for live-mode admission — parseBootstrap
    // rejects half-live envelopes (wsUrl XOR wsToken) as MALFORMED.
    expect(body).toContain('"wsUrl"');
    expect(body).toContain('"wsToken"');
    expect(body).toContain('"expiresAt"');
    // wsUrl rewrite: the minter's default is `ws://localhost/ws`, but
    // serving through a non-localhost host should rewrite the hostname
    // to the request host. `127.0.0.1` is our test fixture's bind addr;
    // the rewrite path admits both `localhost` and `127.0.0.1`.
    expect(body).toMatch(/"wsUrl":"ws:\/\/127\.0\.0\.1:\d+\/ws"/);
  });

  it('inlines contextSlots on the bootstrap when the active stack item declares contextSpec (Slice 14)', async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create({ appId: 'app-public-render' });
    await sessionStore.appendStackItem(session.id, {
      id: 'item-with-contextspec',
      type: 'component',
      componentCode: 'export default function Demo() { return null; }\n',
      createdAt: new Date().toISOString(),
      contextSpec: {
        currentStep: {
          schema: { type: 'number' },
          default: 0,
        },
      },
    });
    const shortCodeIndex = new InMemoryShortCodeIndex();
    const shortCode = 'scode-context';
    await shortCodeIndex.put(shortCode, {
      sessionId: session.id,
      appId: session.appId,
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      mcpApps: true,
      sessionChannel: true,
      sessionStore,
      shortCodeIndex,
      wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
      renderSigning: false,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    fx = {
      server,
      httpServer,
      url: `http://127.0.0.1:${addr.port}`,
      sessionId: session.id,
      shortCode,
    };
    const res = await fetch(`${fx.url}/r/${shortCode}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The contextSlots projection should derive `currentStep` →
    // `CurrentStepContext` and inline it on the bootstrap.
    expect(body).toContain('"contextSlots"');
    expect(body).toContain('CurrentStepContext');
  });

  it('inlines actionNextSteps on the bootstrap when the active stack item declares actionSpec (Slice 14)', async () => {
    const sessionStore = new InMemorySessionStore();
    const session = await sessionStore.create({ appId: 'app-public-render' });
    await sessionStore.appendStackItem(session.id, {
      id: 'item-with-wired-actions',
      type: 'component',
      componentCode: 'export default function Demo() { return null; }\n',
      createdAt: new Date().toISOString(),
      actionSpec: {
        archive: {
          label: 'Archive',
          nextStep: 'gmail_archive',
          schema: { type: 'object' },
        },
      },
    });
    const shortCodeIndex = new InMemoryShortCodeIndex();
    const shortCode = 'scode-wired';
    await shortCodeIndex.put(shortCode, {
      sessionId: session.id,
      appId: session.appId,
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      mcpApps: true,
      sessionChannel: true,
      sessionStore,
      shortCodeIndex,
      wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
      renderSigning: false,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    fx = {
      server,
      httpServer,
      url: `http://127.0.0.1:${addr.port}`,
      sessionId: session.id,
      shortCode,
    };
    const res = await fetch(`${fx.url}/r/${shortCode}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"actionNextSteps"');
    expect(body).toContain('gmail_archive');
  });

  it('does NOT mount /r/:shortCode when mcpApps is off', async () => {
    const sessionStore = new InMemorySessionStore();
    const shortCodeIndex = new InMemoryShortCodeIndex();
    await shortCodeIndex.put('scode-x', {
      sessionId: 'sid-x',
      appId: 'app-x',
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      // mcpApps NOT enabled — there's no shell to serve, so the route
      // is intentionally absent.
      sessionStore,
      shortCodeIndex,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    fx = {
      server,
      httpServer,
      url: `http://127.0.0.1:${addr.port}`,
      sessionId: 'sid-x',
      shortCode: 'scode-x',
    };
    const res = await fetch(`${fx.url}/r/scode-x`);
    // Express default 404 — body is "<!DOCTYPE …>Cannot GET /r/scode-x";
    // good enough as a regression signal that the route did NOT mount.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('shortCode not found');
  });
});
