/**
 * Tests for `GET /api/sessions/:sessionId/events?wsToken=&sinceSequence=N&limit=M`
 * — the R7 wsToken-gated cursor-replay read from the GguiSessionEvent
 * ledger.
 *
 * # Auth surface
 *
 * wsToken-gated, identical posture to `/state` (R6). Same credential
 * the live-channel WS upgrade uses (`?wsToken=<token>` on `/ws`).
 *
 * # What this proves
 *
 *   - Happy path: 200 + `{events, lastSequence, hasMore}` body shape.
 *   - sinceSequence=0 returns the full backlog (the Anthropic
 *     first-mount race fix — iframe boots without inline meta, fetches
 *     /events?sinceSequence=0&limit=1 to bootstrap from the first push).
 *   - limit truncation sets `hasMore: true`.
 *   - Auth gates: 401 missing/invalid/wrong-scope wsToken, 410 expired,
 *     404 missing render.
 *   - REPLAY_HORIZON_PASSED: 410 + JSON envelope when sinceSequence is
 *     above lastSequence (cursor from stale deployment).
 *   - Empty events page: 200 + `events: []` when no events match.
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
import { mintWsToken } from '@ggui-ai/mcp-server-core';
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
  store: InMemoryGguiSessionStore;
}

interface BootOpts {
  readonly eventCount?: number;
}

async function bootWithRender(opts: BootOpts = {}): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const stored = await renderStore.create({ appId: 'app-events-test' });
  // Seed N synthetic events so cursor / pagination scenarios have
  // something to walk. Type `'ui.created'` is one of the canonical
  // ledger types; the wire shape we project is opaque on payload.
  const seedCount = opts.eventCount ?? 0;
  for (let i = 0; i < seedCount; i += 1) {
    await renderStore.appendEvent({
      sessionId: stored.id,
      type: 'ui.created',
      data: { i, label: `event-${i}` },
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
  const { token } = mintWsToken(
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
    store: renderStore,
  };
}

describe('GET /api/sessions/:sessionId/events', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 200 + full backlog when sinceSequence=0 on a render with events', async () => {
    fx = await bootWithRender({ eventCount: 3 });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const body = (await res.json()) as {
      events: Array<{ seq: number; timestamp: string; type: string; data: unknown }>;
      lastSequence: number;
      hasMore: boolean;
    };
    expect(body.events.length).toBe(3);
    expect(body.events[0]?.seq).toBe(1);
    expect(body.events[1]?.seq).toBe(2);
    expect(body.events[2]?.seq).toBe(3);
    expect(body.events[0]?.type).toBe('ui.created');
    expect(typeof body.events[0]?.timestamp).toBe('string');
    expect(body.lastSequence).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('returns 200 + empty events page when sinceSequence equals lastSequence', async () => {
    fx = await bootWithRender({ eventCount: 2 });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      lastSequence: number;
      hasMore: boolean;
    };
    expect(body.events).toEqual([]);
    expect(body.lastSequence).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  it('returns 200 + truncated page with hasMore=true when limit is hit', async () => {
    fx = await bootWithRender({ eventCount: 5 });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0&limit=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ seq: number }>;
      lastSequence: number;
      hasMore: boolean;
    };
    expect(body.events.length).toBe(2);
    expect(body.events[0]?.seq).toBe(1);
    expect(body.events[1]?.seq).toBe(2);
    expect(body.lastSequence).toBe(5);
    expect(body.hasMore).toBe(true);
  });

  it('returns 200 + empty events on a render with no events (sinceSequence=0)', async () => {
    fx = await bootWithRender();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      lastSequence: number;
      hasMore: boolean;
    };
    expect(body.events).toEqual([]);
    expect(body.lastSequence).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it('returns 401 when wsToken query is absent', async () => {
    fx = await bootWithRender();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?sinceSequence=0`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when wsToken signature is invalid', async () => {
    fx = await bootWithRender();
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=tampered.payload&sinceSequence=0`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 410 Gone when wsToken is expired', async () => {
    fx = await bootWithRender();
    const { token: expiredToken } = mintWsToken(
      {
        sessionId: fx.sessionId,
        appId: fx.appId,
        ttlSec: -10,
      },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(expiredToken)}&sinceSequence=0`,
    );
    expect(res.status).toBe(410);
  });

  it('returns 401 when wsToken sessionId does not match URL sessionId', async () => {
    fx = await bootWithRender();
    const { token: otherSessionToken } = mintWsToken(
      { sessionId: 'other-render', appId: fx.appId },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(otherSessionToken)}&sinceSequence=0`,
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
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(otherAppToken)}&sinceSequence=0`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when sessionId does not resolve', async () => {
    fx = await bootWithRender();
    const { token: ghostToken } = mintWsToken(
      { sessionId: 'sess-ghost', appId: fx.appId },
      SECRET,
    );
    const res = await fetch(
      `${fx.url}/api/sessions/sess-ghost/events?wsToken=${encodeURIComponent(ghostToken)}&sinceSequence=0`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 410 REPLAY_HORIZON_PASSED when sinceSequence exceeds lastSequence', async () => {
    // GguiSession has 2 events (lastSequence=2). Cursor at 99 is a stale
    // cursor from a different deployment / reset render.
    fx = await bootWithRender({ eventCount: 2 });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=99`,
    );
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as {
      reason: string;
      currentSequence: number;
    };
    expect(body.reason).toBe('REPLAY_HORIZON_PASSED');
    expect(body.currentSequence).toBe(2);
  });

  it('returns 400 when sinceSequence is missing or non-integer', async () => {
    fx = await bootWithRender();
    // Missing.
    let res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}`,
    );
    expect(res.status).toBe(400);
    // Non-integer.
    res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=abc`,
    );
    expect(res.status).toBe(400);
    // Negative.
    res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=-1`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when limit is out of range', async () => {
    fx = await bootWithRender();
    // Above max.
    let res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0&limit=501`,
    );
    expect(res.status).toBe(400);
    // Below min.
    res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0&limit=0`,
    );
    expect(res.status).toBe(400);
  });

  it('honors mid-cursor sinceSequence to return only newer events', async () => {
    fx = await bootWithRender({ eventCount: 4 });
    const res = await fetch(
      `${fx.url}/api/sessions/${fx.sessionId}/events?wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=2`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ seq: number }>;
      lastSequence: number;
      hasMore: boolean;
    };
    expect(body.events.length).toBe(2);
    expect(body.events[0]?.seq).toBe(3);
    expect(body.events[1]?.seq).toBe(4);
    expect(body.lastSequence).toBe(4);
  });
});
