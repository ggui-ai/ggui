/**
 * Tests for `GET /api/sessions/:sessionId/state?wsToken=<token>` — the
 * R6 wsToken-gated snapshot read of the current render state.
 *
 * # Auth surface
 *
 * wsToken-gated (R5 retired the earlier `/r/<shortCode>` shortCode-gated
 * surface entirely; this is now the only HTTP read path for render
 * state).
 *
 * # What this proves
 *
 *   - Happy path: 200 + slice envelope with `lastSequence` stamped on
 *     the render slice.
 *   - Auth gates: 401 on missing/invalid/wrong-scope wsToken, 410 on
 *     expired, 404 on missing render.
 *   - Slice projection: top renderable render flows through the
 *     same `deriveRenderMeta` helper render uses, so polling clients
 *     see the same render shape regardless of entry point.
 *
 * Lane 3 of the 4-lane taxonomy (in-process fake, no browser).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  mintWsToken,
  type WsTokenClaims,
} from '@ggui-ai/mcp-server-core';
import { isRecord, type JsonObject } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const SECRET = 'deterministic-test-secret-' + 'x'.repeat(32);

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  sessionId: string;
  appId: string;
  validToken: string;
  validClaims: WsTokenClaims;
}

async function bootWithRender(opts?: {
  readonly withRender?: boolean;
  readonly componentCode?: string;
  readonly props?: JsonObject;
}): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const stored = await renderStore.create({ appId: 'app-state-test' });
  if (opts?.withRender) {
    const now = Date.now();
    await renderStore.commit({
      render: {
        id: stored.id,
        appId: stored.appId,
        type: 'component',
        componentCode:
          opts.componentCode ?? 'export default function X(){return null}',
        props: opts.props ?? { count: 0 },
        eventSequence: stored.eventSequence,
        createdAt: now,
        lastActivityAt: now,
        expiresAt: now + 60_000,
      },
      appId: stored.appId,
    });
  }
  const shortCodeIndex = new InMemoryShortCodeIndex();
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore,
    shortCodeIndex,
    wsTokenSecret: SECRET,
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: 'https://test.example',
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const { token, claims } = mintWsToken(
    { sessionId: stored.id, appId: stored.appId },
    SECRET,
  );
  return {
    server,
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    sessionId: stored.id,
    appId: stored.appId,
    validToken: token,
    validClaims: claims,
  };
}

describe('GET /api/sessions/:sessionId/state', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 200 + slice envelope with lastSequence stamped on happy path', async () => {
    fx = await bootWithRender({ withRender: true });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const rawBody: unknown = await res.json();
    if (!isRecord(rawBody)) {
      throw new Error('expected a JSON object body');
    }
    const body = rawBody;
    const renderMeta = body[MCP_APP_AI_GGUI_RENDER_META_KEY] as
      | McpAppAiGguiRenderMeta
      | undefined;
    expect(renderMeta).toBeDefined();
    expect(renderMeta?.sessionId).toBe(fx.sessionId);
    expect(renderMeta?.appId).toBe(fx.appId);
    expect(typeof renderMeta?.runtimeUrl).toBe('string');
    // R6 contract — lastSequence MUST be stamped on every /state read.
    expect(typeof renderMeta?.lastSequence).toBe('number');
    expect(renderMeta?.lastSequence).toBeGreaterThanOrEqual(0);
    // codeUrl wired via codeStore + publicBaseUrl.
    expect(renderMeta?.codeUrl).toMatch(/^https:\/\/test\.example\/code\//);
  });

  it('returns 401 when wsToken query is absent', async () => {
    fx = await bootWithRender();
    const res = await fetch(`${fx.url}/api/sessions/${fx.sessionId}/state`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when wsToken signature is invalid', async () => {
    fx = await bootWithRender();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=tampered.payload`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 410 Gone when wsToken is expired', async () => {
    fx = await bootWithRender();
    // Mint with negative TTL to force expiry; the verify path bails on
    // `exp <= now` (line 314 of ws-tokens.ts).
    const { token: expiredToken } = mintWsToken(
      {
        sessionId: fx.sessionId,
        appId: fx.appId,
        ttlSec: -10,
      },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(expiredToken)}`,
    );
    expect(res.status).toBe(410);
  });

  it('returns 401 when wsToken sessionId does not match URL sessionId', async () => {
    fx = await bootWithRender();
    // Mint a token for a different render; the URL targets fx.sessionId
    // but the token claims a different sessionId — tenancy gate trips.
    const { token: otherSessionToken } = mintWsToken(
      { sessionId: 'other-render', appId: fx.appId },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(otherSessionToken)}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when wsToken appId does not match render appId', async () => {
    fx = await bootWithRender();
    const { token: otherAppToken } = mintWsToken(
      { sessionId: fx.sessionId, appId: 'other-app' },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(otherAppToken)}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when sessionId does not resolve', async () => {
    fx = await bootWithRender();
    // Mint a token for a render that does not exist in the store.
    const { token: ghostToken } = mintWsToken(
      { sessionId: 'sess-ghost', appId: fx.appId },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/sess-ghost/state?wsToken=${encodeURIComponent(ghostToken)}`,
    );
    expect(res.status).toBe(404);
  });
});
