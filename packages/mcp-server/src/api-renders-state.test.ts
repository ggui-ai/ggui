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
 *   - The possession renewal (ggui#1496 part B, slice 2): the route mints
 *     through its chained arm with the presented chain's root; a chain
 *     keeps its root's `rootIat`, its last token expires at
 *     `rootIat + window`, and `/state`, `/events`, `/stream` and WS all
 *     refuse that token in the same second. `createGguiServer` refuses a
 *     window shorter than the TTL.
 *
 * Lane 3 of the 4-lane taxonomy (in-process fake, no browser).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER,
  mintWsToken,
  type WsTokenClaims,
} from '@ggui-ai/mcp-server-core';
import { isRecord, type JsonObject } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { mountApiRendersRoutes } from './api-renders-routes.js';
import type { Logger } from './logger.js';
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
  /** Asset host for the content-addressable URLs (ggui#522 slice 1). */
  readonly codeBaseUrl?: string;
  /** The server's ws-token lifetime and refresh window (ggui#1496 part B, slice 2). */
  readonly wsTokenTtlSec?: number;
  readonly wsTokenRefreshWindowSec?: number;
  /** A logger to read the route's lines from (ggui#1540). */
  readonly logger?: Logger;
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
    logger: opts?.logger ?? silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore,
    shortCodeIndex,
    wsTokenSecret: SECRET,
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: 'https://test.example',
    ...(opts?.codeBaseUrl !== undefined ? { codeBaseUrl: opts.codeBaseUrl } : {}),
    ...(opts?.wsTokenTtlSec !== undefined ? { wsTokenTtlSec: opts.wsTokenTtlSec } : {}),
    ...(opts?.wsTokenRefreshWindowSec !== undefined
      ? { wsTokenRefreshWindowSec: opts.wsTokenRefreshWindowSec }
      : {}),
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

  it('composes codeUrl / validatorsUrl on codeBaseUrl (an asset host) while session-API URLs stay on the public origin (ggui#522 slice 1)', async () => {
    fx = await bootWithRender({ withRender: true, codeBaseUrl: 'https://assets.test.example' });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(200);
    const rawBody: unknown = await res.json();
    if (!isRecord(rawBody)) {
      throw new Error('expected a JSON object body');
    }
    const renderMeta = rawBody[MCP_APP_AI_GGUI_RENDER_META_KEY] as
      | McpAppAiGguiRenderMeta
      | undefined;
    // Static, content-addressable → the asset host.
    expect(renderMeta?.codeUrl).toMatch(/^https:\/\/assets\.test\.example\/code\//);
    // Dynamic, credentialed → the public origin, untouched.
    expect(renderMeta?.pollingUrl).toMatch(/^https:\/\/test\.example\/api\/sessions\//);
  });

  it('stamps token-bearing pollingUrl (/events) + sseUrl (/stream) alongside the fresh live trio', async () => {
    fx = await bootWithRender({ withRender: true });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(200);
    const rawBody: unknown = await res.json();
    if (!isRecord(rawBody)) {
      throw new Error('expected a JSON object body');
    }
    const renderMeta = rawBody[MCP_APP_AI_GGUI_RENDER_META_KEY] as
      | McpAppAiGguiRenderMeta
      | undefined;
    // The trio is minted fresh on every /state read; both URLs embed
    // that fresh token and are composed via the protocol's ONE
    // `composeSessionApiUrls` composer.
    const freshToken = renderMeta?.wsToken;
    expect(typeof freshToken).toBe('string');
    const sid = encodeURIComponent(fx.sessionId);
    expect(renderMeta?.pollingUrl).toBe(
      `https://test.example/api/sessions/${sid}/events?wsToken=${encodeURIComponent(freshToken ?? '')}`,
    );
    expect(renderMeta?.sseUrl).toBe(
      `https://test.example/api/sessions/${sid}/stream?wsToken=${encodeURIComponent(freshToken ?? '')}`,
    );
    // Regression pin — the pre-SSE-slice drift stamped a token-less
    // `/api/sessions/<id>/state` pollingUrl, which could only 401
    // through the iframe-runtime's /events composer.
    expect(renderMeta?.pollingUrl).not.toMatch(/\/state/);
  });

  it('mints through its chained arm with the presented chain\'s root, and stamps what the arm returns (ggui#1496 part B, slice 2)', async () => {
    const renderStore = new InMemoryGguiSessionStore();
    const stored = await renderStore.create({ appId: 'app-state-test' });
    const now = Date.now();
    await renderStore.commit({
      render: {
        id: stored.id,
        appId: stored.appId,
        type: 'component',
        componentCode: 'export default function X(){return null}',
        props: {},
        eventSequence: stored.eventSequence,
        createdAt: now,
        lastActivityAt: now,
        expiresAt: now + 60_000,
      },
      appId: stored.appId,
    });
    const calls: Array<{ sessionId: string; appId: string; rootIat: number }> = [];
    let answer: { wsUrl: string; token: string; expiresAt: string } | undefined = {
      wsUrl: 'wss://live.example/ws',
      token: 'chained.token',
      expiresAt: '2026-09-28T00:02:30.000Z',
    };
    const app = express();
    mountApiRendersRoutes({
      app,
      renderStore,
      secret: SECRET,
      publicBaseUrl: 'https://test.example',
      mintChainedBootstrap: (sessionId, appId, rootIat) => {
        calls.push({ sessionId, appId, rootIat });
        return answer;
      },
      resolveRuntimeUrl: () => '/_ggui/iframe-runtime.js',
      logger: silentLogger,
    });
    const httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('server.address() did not return AddressInfo');
      }
      const base = `http://127.0.0.1:${addr.port}/api/sessions/${stored.id}/state?wsToken=`;
      // A root (tag 14's shape, no rootIat): the chain's root is its own iat.
      const root = mintWsToken({ sessionId: stored.id, appId: stored.appId }, SECRET);
      const res = await fetch(base + encodeURIComponent(root.token));
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ sessionId: stored.id, appId: stored.appId, rootIat: root.claims.iat }]);
      const rawBody: unknown = await res.json();
      if (!isRecord(rawBody)) {
        throw new Error('expected a JSON object body');
      }
      const renderMeta = rawBody[MCP_APP_AI_GGUI_RENDER_META_KEY] as
        | McpAppAiGguiRenderMeta
        | undefined;
      expect(renderMeta?.wsUrl).toBe('wss://live.example/ws');
      expect(renderMeta?.wsToken).toBe('chained.token');
      expect(renderMeta?.expiresAt).toBe('2026-09-28T00:02:30.000Z');
      const sid = encodeURIComponent(stored.id);
      expect(renderMeta?.pollingUrl).toBe(
        `https://test.example/api/sessions/${sid}/events?wsToken=chained.token`,
      );
      expect(renderMeta?.sseUrl).toBe(
        `https://test.example/api/sessions/${sid}/stream?wsToken=chained.token`,
      );

      // A renewal carries its chain's root forward, not its own iat.
      const chained = mintWsToken(
        { sessionId: stored.id, appId: stored.appId, rootIat: root.claims.iat - 40 },
        SECRET,
      );
      expect((await fetch(base + encodeURIComponent(chained.token))).status).toBe(200);
      expect(calls[1]).toEqual({ sessionId: stored.id, appId: stored.appId, rootIat: root.claims.iat - 40 });

      // No second left in the chain: the ordinary expiry, readable cross-origin.
      answer = undefined;
      const past = await fetch(base + encodeURIComponent(root.token));
      expect(past.status).toBe(410);
      expect(await past.text()).toBe('wsToken expired');
      expect(past.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
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
    // Refresh signal must be readable cross-origin (see events/stream
    // twins) — gate rejections carry ACAO like the 200 path does.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
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

/** A token's claims, read straight off its payload (no verify). */
function claimsOf(token: string): Record<string, unknown> {
  const [payloadB64 = ''] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function stateRead(
  fx: Fixture,
  token: string,
): Promise<{ status: number; meta: McpAppAiGguiRenderMeta | undefined }> {
  const res = await fetch(
    `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(token)}`,
  );
  if (res.status !== 200) return { status: res.status, meta: undefined };
  const rawBody: unknown = await res.json();
  if (!isRecord(rawBody)) throw new Error('expected a JSON object body');
  return {
    status: res.status,
    meta: rawBody[MCP_APP_AI_GGUI_RENDER_META_KEY] as McpAppAiGguiRenderMeta | undefined,
  };
}

/** The subscribe's answer on the live channel: the ack, or the error code. */
async function wsSubscribeAnswer(fx: Fixture, token: string): Promise<string> {
  const channel = fx.server.renderChannel;
  if (channel === null) throw new Error('renderChannel: true did not create a channel');
  const port = new URL(fx.url).port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${channel.path}?wsToken=${encodeURIComponent(token)}`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const answer = new Promise<string>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; payload: { code?: string } };
        if (msg.type === 'ack') resolve('ack');
        else if (msg.type === 'error') resolve(msg.payload.code ?? 'error');
      });
    });
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        payload: { sessionId: fx.sessionId, appId: fx.appId, wsToken: token },
      }),
    );
    return await answer;
  } finally {
    ws.terminate();
  }
}

describe('/state renewals chain from their root, and the chain ends at rootIat + window (ggui#1496 part B, slice 2)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  const T0 = Date.UTC(2026, 8, 28, 0, 0, 0);
  const at = (sec: number): void => {
    vi.setSystemTime(T0 + sec * 1000);
  };

  it('root → /state → /state keeps the root\'s rootIat; the last token expires at rootIat + window, and all four gates refuse it at that second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 60, wsTokenRefreshWindowSec: 150 });
    // The server's root minter at TTL 60 (the render result's shape: no rootIat).
    const root = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 60 }, SECRET);
    const rootIat = root.claims.iat;

    at(50);
    const first = await stateRead(fx, root.token);
    expect(first.status).toBe(200);
    const c1 = first.meta?.wsToken ?? '';
    expect(claimsOf(c1)).toMatchObject({ rootIat, iat: rootIat + 50, exp: rootIat + 110 });
    expect(first.meta?.expiresAt).toBe(new Date((rootIat + 110) * 1000).toISOString());
    expect(first.meta?.pollingUrl).toContain(`wsToken=${encodeURIComponent(c1)}`);

    at(100);
    const second = await stateRead(fx, c1);
    expect(second.status).toBe(200);
    const c2 = second.meta?.wsToken ?? '';
    // Clamped: min(now + TTL, rootIat + window) = rootIat + 150.
    expect(claimsOf(c2)).toMatchObject({ rootIat, iat: rootIat + 100, exp: rootIat + 150 });

    at(149);
    const last = await stateRead(fx, c2);
    expect(last.status).toBe(200);
    const c3 = last.meta?.wsToken ?? '';
    expect(claimsOf(c3)).toMatchObject({ rootIat, exp: rootIat + 150 });
    // Control: the other three gates accept the chain's last token inside the bound.
    const q = `?wsToken=${encodeURIComponent(c3)}`;
    expect((await fetch(`${fx.url}/api/sessions/${fx.sessionId}/events${q}&sinceSequence=0`)).status).toBe(200);
    const stream = new AbortController();
    const open = await fetch(`${fx.url}/api/sessions/${fx.sessionId}/stream${q}`, { signal: stream.signal });
    expect(open.status).toBe(200);
    stream.abort();
    expect(await wsSubscribeAnswer(fx, c3)).toBe('ack');

    at(150);
    expect((await stateRead(fx, c3)).status).toBe(410);
    expect((await fetch(`${fx.url}/api/sessions/${fx.sessionId}/events${q}&sinceSequence=0`)).status).toBe(410);
    expect((await fetch(`${fx.url}/api/sessions/${fx.sessionId}/stream${q}`)).status).toBe(410);
    expect(await wsSubscribeAnswer(fx, c3)).toBe('BOOTSTRAP_EXPIRED');
  });

  it('logs each /state renewal refused for expiry as state_chain_expired {sessionId, rootAgeSec}; a token it never signed is not counted (ggui#1540)', async () => {
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => void lines.push({ event, fields: fields ?? {} }),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => logger,
    };
    const expired = () => lines.filter((l) => l.event === 'state_chain_expired').map((l) => l.fields);
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 60, wsTokenRefreshWindowSec: 150, logger });
    const root = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 60 }, SECRET);

    // A chain that reached its bound: the last renewal's exp is rootIat + window.
    at(50);
    const c1 = (await stateRead(fx, root.token)).meta?.wsToken ?? '';
    at(100);
    const c2 = (await stateRead(fx, c1)).meta?.wsToken ?? '';
    expect(expired()).toEqual([]);
    at(150);
    expect((await stateRead(fx, c2)).status).toBe(410);
    expect(expired()).toEqual([{ sessionId: fx.sessionId, rootAgeSec: 150 }]);

    // A root that went unrenewed past its TTL.
    const fresh = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 60 }, SECRET);
    at(150 + 61);
    expect((await stateRead(fx, fresh.token)).status).toBe(410);
    expect(expired()[1]).toEqual({ sessionId: fx.sessionId, rootAgeSec: 61 });

    // Control: a token this server never signed is a 401, and no line.
    const forged = `${fresh.token.slice(0, -1)}${fresh.token.endsWith('A') ? 'B' : 'A'}`;
    expect((await stateRead(fx, forged)).status).toBe(401);
    expect(expired()).toHaveLength(2);
  });

  it('logs a chain with no second left the same way, while its token still verifies (ggui#1540)', async () => {
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => void lines.push({ event, fields: fields ?? {} }),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => logger,
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 60, wsTokenRefreshWindowSec: 120, logger });
    const longLived = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 600 }, SECRET);
    at(120);
    expect((await stateRead(fx, longLived.token)).status).toBe(410);
    expect(lines.filter((l) => l.event === 'state_chain_expired').map((l) => l.fields)).toEqual([
      { sessionId: fx.sessionId, rootAgeSec: 120 },
    ]);
  });

  it('the window defaults to DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER × the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 60 });
    const root = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 60 }, SECRET);
    at(50);
    const c1 = (await stateRead(fx, root.token)).meta?.wsToken ?? '';
    at(100);
    const c2 = (await stateRead(fx, c1)).meta?.wsToken ?? '';
    expect(claimsOf(c2)).toMatchObject({
      rootIat: root.claims.iat,
      exp: root.claims.iat + DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER * 60,
    });
  });

  it('mints every root and renewal with the configured TTL, not the 180 s default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 45, wsTokenRefreshWindowSec: 1000 });
    const root = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 45 }, SECRET);
    at(10);
    const c1 = (await stateRead(fx, root.token)).meta?.wsToken ?? '';
    expect(claimsOf(c1)).toMatchObject({ iat: root.claims.iat + 10, exp: root.claims.iat + 55 });
  });

  it('a token minted under a longer window (a config change) gets the ordinary expiry at /state once its chain has no second left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    fx = await bootWithRender({ withRender: true, wsTokenTtlSec: 60, wsTokenRefreshWindowSec: 120 });
    const longLived = mintWsToken({ sessionId: fx.sessionId, appId: fx.appId, ttlSec: 600 }, SECRET);
    at(119);
    const inside = await stateRead(fx, longLived.token);
    expect(inside.status).toBe(200);
    expect(claimsOf(inside.meta?.wsToken ?? '')).toMatchObject({ exp: longLived.claims.iat + 120 });
    // The boundary second: the token still verifies, and the chain has no second left.
    at(120);
    expect((await stateRead(fx, longLived.token)).status).toBe(410);
    // …while a gate that only verifies still accepts it: the documented split.
    expect(
      (await fetch(`${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(longLived.token)}&sinceSequence=0`)).status,
    ).toBe(200);
    at(130);
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/state?wsToken=${encodeURIComponent(longLived.token)}`,
    );
    expect(res.status).toBe(410);
    expect(await res.text()).toBe('wsToken expired');
  });
});

describe('createGguiServer — wsTokenTtlSec / wsTokenRefreshWindowSec (ggui#1496 part B, slice 2)', () => {
  const base = {
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore: new InMemoryGguiSessionStore(),
    wsTokenSecret: SECRET,
  } as const;

  it('refuses a window shorter than the TTL: a renewal chain could then outlive its bound', () => {
    expect(() => createGguiServer({ ...base, wsTokenTtlSec: 120, wsTokenRefreshWindowSec: 119 })).toThrow(
      /wsTokenRefreshWindowSec/,
    );
  });

  it('refuses a window shorter than the default TTL when only the window is set', () => {
    expect(() => createGguiServer({ ...base, wsTokenRefreshWindowSec: 179 })).toThrow(
      /wsTokenRefreshWindowSec/,
    );
  });

  it('refuses a TTL or window that is not a positive whole number of seconds', () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createGguiServer({ ...base, wsTokenTtlSec: bad })).toThrow(/wsTokenTtlSec/);
      expect(() =>
        createGguiServer({ ...base, wsTokenTtlSec: 1, wsTokenRefreshWindowSec: bad }),
      ).toThrow(/wsTokenRefreshWindowSec/);
    }
  });

  it('accepts a window equal to the TTL — control', async () => {
    const server = createGguiServer({ ...base, wsTokenTtlSec: 90, wsTokenRefreshWindowSec: 90 });
    await server.close();
  });
});
