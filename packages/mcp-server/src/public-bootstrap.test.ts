/**
 * Tests for `GET /api/bootstrap/:shortCode` — the JSON bootstrap-envelope
 * endpoint for the thin-shell's Path A fallback.
 *
 * The production thin shell (`GGUI_SESSION_SHELL_HTML`) prefers the
 * spec-shaped Path B (`params._meta.ggui.bootstrap` on
 * `ui/notifications/tool-result`), but empirically claude.ai Connector
 * and Claude Desktop strip `_meta` from those notifications. Path A is
 * the fallback: `fetch(<publicBase>/api/bootstrap/<shortCode>)`.
 *
 * Mount conditions: `mcpApps: true` + `sessionStore` + `shortCodeIndex`
 * + `mintBootstrap` (auto-constructed when `mcpApps: true`). Mirrors
 * `/r/:shortCode`'s gate. CORS posture: `Access-Control-Allow-Origin: *`
 * (read-only endpoint; the minted token is the auth, the shortCode is
 * the capability).
 *
 * Lane 3 of the 4-lane taxonomy (in-process fake, no browser).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { JsonObject } from '@ggui-ai/protocol';
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
  appId: string;
  shortCode: string;
}

async function bootWithSession(opts?: {
  readonly withStackItem?: boolean;
  readonly componentCode?: string;
  readonly props?: JsonObject;
}): Promise<Fixture> {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.create({ appId: 'app-bootstrap-test' });
  if (opts?.withStackItem) {
    await sessionStore.appendStackItem(session.id, {
      id: 'item-1',
      type: 'component',
      componentCode:
        opts.componentCode ?? 'export default function X(){return null}',
      props: opts.props ?? { count: 0 },
      createdAt: new Date().toISOString(),
    });
  }
  const shortCodeIndex = new InMemoryShortCodeIndex();
  const shortCode = 'scode-bootstrap-1';
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
    bootstrapSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
    // C.2 sig verification adds `?sig=...&exp=...` to render URLs.
    // These tests probe `/api/bootstrap/:shortCode` with bare codes
    // (not push-minted), so disable signing here.
    renderSigning: false,
    // T3-1 (2026-05-13): bootstrap emits `codeUrl` instead of inline
    // base64 `componentCode`. Wire codeStore + publicBaseUrl so the
    // happy-path test sees the URL channel populated.
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: 'https://test.example',
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
    appId: session.appId,
    shortCode,
  };
}

describe('GET /api/bootstrap/:shortCode', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 200 + a well-shaped McpAppAiGguiMountView on the happy path', async () => {
    fx = await bootWithSession();
    const res = await fetch(`${fx.url}/api/bootstrap/${fx.shortCode}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // CORS — bootstrap is read-only + the minted token is the auth, so
    // exposing it cross-origin is safe and required for the iframe
    // (claude.ai sandbox origin) to fetch from the public-base-url.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // No-store — each response carries a fresh single-use token.
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as {
      wsUrl: string;
      token: string;
      expiresAt: string;
      sessionId: string;
      appId: string;
      runtimeUrl: string;
    };
    expect(body.sessionId).toBe(fx.sessionId);
    expect(body.appId).toBe(fx.appId);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
    expect(typeof body.expiresAt).toBe('string');
    // ISO 8601 sanity — Date should parse to a finite timestamp.
    expect(Number.isFinite(new Date(body.expiresAt).getTime())).toBe(true);
    // The route absolutises a same-origin runtimeUrl using the request
    // host so iframes loaded from cross-origin / srcdoc contexts can
    // resolve the bundle URL. The default OSS bundle path lives at
    // `/_ggui/iframe-runtime.js`.
    expect(body.runtimeUrl).toMatch(/^https?:\/\/.+\/_ggui\/iframe-runtime\.js$/);
    // Same absolute-host fix for the default `ws://localhost/ws` —
    // a localhost wsUrl gets rewritten to the request host so the
    // iframe's WS open lands on this listener regardless of tunnel.
    expect(body.wsUrl).toMatch(/^wss?:\/\/127\.0\.0\.1:\d+\/ws$/);
    // pollingUrl — iframe-runtime's `PollingTransport` fetches this
    // URL on a cadence when the WebSocket is unavailable (host CSP
    // blocks `wss://`) or fails irrecoverably. It points back at this
    // very same endpoint — diffing `propsJson` between fetches lets
    // the iframe synthesize `props_update` frames without a WS round-
    // trip.
    expect(
      (body as unknown as { pollingUrl: string }).pollingUrl,
    ).toMatch(/^https?:\/\/.+\/api\/bootstrap\/.+$/);
    expect((body as unknown as { pollingUrl: string }).pollingUrl).toContain(
      fx.shortCode,
    );
  });

  it('projects the active stack item through the canonical bootstrap view (codeUrl + propsJson)', async () => {
    // Regression for the 2026-05-13 live smoke finding: pre-fix the
    // endpoint returned only the live trio + identity fields and
    // omitted everything stack-item-derived. The iframe-runtime's
    // refetch path landed a fresh bootstrap on every `ggui_update`
    // but had no new propsJson / codeUrl to apply — the spec-compliant
    // postMessage live-update was a structural no-op.
    //
    // T3-1 (2026-05-13): static-component delivery moved from inline
    // base64 `componentCode` to content-addressable `codeUrl`. The
    // happy path emits both `codeUrl` + `codeHash` (computed by the
    // wired codeStore from the top stack item's componentCode).
    fx = await bootWithSession({
      withStackItem: true,
      componentCode: 'export default function Todo() { return null; }\n',
      props: { items: [{ id: 1, text: 'buy milk', done: false }] },
    });
    const res = await fetch(`${fx.url}/api/bootstrap/${fx.shortCode}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // stackItemId pin — the iframe routes the late-arrival
    // postMessage to the right mount via this field.
    expect(body['stackItemId']).toBe('item-1');
    // codeUrl + codeHash from the wired codeStore (T3-1).
    expect(typeof body['codeUrl']).toBe('string');
    expect(body['codeUrl']).toMatch(/^https:\/\/test\.example\/code\/.+\.js$/);
    expect(typeof body['codeHash']).toBe('string');
    // No inline componentCode — retired in T3-1.
    expect(body['componentCode']).toBeUndefined();
    // propsJson reflects the LIVE stack-item state — for the live-
    // update path this is what makes the iframe re-render with new
    // values post-`ggui_update`.
    expect(body['propsJson']).toBe(
      JSON.stringify({ items: [{ id: 1, text: 'buy milk', done: false }] }),
    );
  });

  it('returns 200 with the live trio + identity even when no renderable stack item exists', async () => {
    // Sanity: the projection-augmented endpoint must still serve a
    // valid live-trio bootstrap for sessions whose stack is empty
    // (between `ggui_new_session` + `ggui_handshake` and the first
    // `ggui_push`). Without this, the public-render polling shell
    // wedges on bootstrap fetches that 500.
    fx = await bootWithSession({ withStackItem: false });
    const res = await fetch(`${fx.url}/api/bootstrap/${fx.shortCode}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['sessionId']).toBe(fx.sessionId);
    expect(typeof body['token']).toBe('string');
    // No renderable → stack-item-derived fields absent.
    expect(body['stackItemId']).toBeUndefined();
    expect(body['componentCode']).toBeUndefined();
    expect(body['propsJson']).toBeUndefined();
  });

  it('returns 404 with a structured error when shortCode does not resolve', async () => {
    fx = await bootWithSession();
    const res = await fetch(`${fx.url}/api/bootstrap/no-such-code`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // CORS still set on the failure path — the iframe fetch still needs
    // to be able to read the response body to surface a useful error.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('shortCode not recognised');
  });

  it('does NOT mount /api/bootstrap/:shortCode when mcpApps is off', async () => {
    // Same gate as `/r/:shortCode` — without mcpApps there's no
    // bootstrap minter, so the route is intentionally absent. Express
    // returns its default 404 (HTML body, NOT our JSON envelope).
    const sessionStore = new InMemorySessionStore();
    const shortCodeIndex = new InMemoryShortCodeIndex();
    await shortCodeIndex.put('scode-x', {
      sessionId: 'sid-x',
      appId: 'app-x',
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      // mcpApps NOT enabled.
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
      appId: 'app-x',
      shortCode: 'scode-x',
    };
    const res = await fetch(`${fx.url}/api/bootstrap/scode-x`);
    expect(res.status).toBe(404);
    const body = await res.text();
    // Default Express 404 — not our JSON envelope.
    expect(body).not.toContain('shortCode not recognised');
  });
});
