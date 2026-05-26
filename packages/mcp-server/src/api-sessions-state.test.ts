/**
 * Tests for `GET /api/sessions/:sessionId/state?wsToken=<token>` — the
 * R6 wsToken-gated snapshot read of the current session state.
 *
 * # Why a separate file from `public-bootstrap.test.ts`
 *
 * `/r/<shortCode>` (JSON branch) is shortCode-gated; `/api/sessions/...`
 * is wsToken-gated. Distinct auth surfaces, distinct mount conditions,
 * distinct invariants. Sharing a fixture would smear the two contracts.
 *
 * # What this proves
 *
 *   - Happy path: 200 + slice envelope with `lastSequence` stamped on
 *     the session slice.
 *   - Auth gates: 401 on missing/invalid/wrong-scope wsToken, 410 on
 *     expired, 404 on missing session.
 *   - Slice projection: top renderable stack item flows through the
 *     same `deriveStackItemMeta` helper push / `/r/` JSON branch use,
 *     so polling clients see the same render shape regardless of
 *     entry point.
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
import {
  mintWsToken,
  type WsTokenClaims,
} from '@ggui-ai/mcp-server-core';
import type { JsonObject } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_SESSION_META_KEY,
  MCP_APP_AI_GGUI_STACK_ITEM_META_KEY,
  type McpAppAiGguiSessionMeta,
  type McpAppAiGguiStackItemMeta,
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

async function bootWithSession(opts?: {
  readonly withStackItem?: boolean;
  readonly componentCode?: string;
  readonly props?: JsonObject;
}): Promise<Fixture> {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.create({ appId: 'app-state-test' });
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
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    sessionChannel: true,
    sessionStore,
    shortCodeIndex,
    wsTokenSecret: SECRET,
    renderSigning: false,
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: 'https://test.example',
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const { token, claims } = mintWsToken(
    { sessionId: session.id, appId: session.appId },
    SECRET,
  );
  return {
    server,
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    sessionId: session.id,
    appId: session.appId,
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
    fx = await bootWithSession({ withStackItem: true });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const body = (await res.json()) as Record<string, unknown>;
    const sessionSlice = body[MCP_APP_AI_GGUI_SESSION_META_KEY] as
      | McpAppAiGguiSessionMeta
      | undefined;
    expect(sessionSlice).toBeDefined();
    expect(sessionSlice?.sessionId).toBe(fx.sessionId);
    expect(sessionSlice?.appId).toBe(fx.appId);
    expect(typeof sessionSlice?.runtimeUrl).toBe('string');
    // R6 contract — lastSequence MUST be stamped on every /state read.
    expect(typeof sessionSlice?.lastSequence).toBe('number');
    expect(sessionSlice?.lastSequence).toBeGreaterThanOrEqual(0);

    const stackItem = body[MCP_APP_AI_GGUI_STACK_ITEM_META_KEY] as
      | McpAppAiGguiStackItemMeta
      | undefined;
    expect(stackItem).toBeDefined();
    expect(stackItem?.stackItemId).toBe('item-1');
    // codeUrl wired via codeStore + publicBaseUrl.
    expect(stackItem?.codeUrl).toMatch(/^https:\/\/test\.example\/code\//);
  });

  it('returns 200 + session slice only when stack is empty', async () => {
    fx = await bootWithSession();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[MCP_APP_AI_GGUI_SESSION_META_KEY]).toBeDefined();
    expect(body[MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]).toBeUndefined();
  });

  it('returns 401 when wsToken query is absent', async () => {
    fx = await bootWithSession();
    const res = await fetch(`${fx.url}/api/sessions/${fx.sessionId}/state`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when wsToken signature is invalid', async () => {
    fx = await bootWithSession();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=tampered.payload`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 410 Gone when wsToken is expired', async () => {
    fx = await bootWithSession();
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
    fx = await bootWithSession();
    // Mint a token for a different session; the URL targets fx.sessionId
    // but the token claims a different sessionId — tenancy gate trips.
    const { token: otherSessionToken } = mintWsToken(
      { sessionId: 'other-session', appId: fx.appId },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(otherSessionToken)}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when wsToken appId does not match session appId', async () => {
    fx = await bootWithSession();
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
    fx = await bootWithSession();
    // Mint a token for a session that does not exist in the store.
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
