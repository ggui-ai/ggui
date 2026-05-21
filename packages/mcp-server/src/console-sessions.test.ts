/**
 * Wire tests for `GET /ggui/console/sessions` — the active-session
 * catalog the console SPA's `/sessions` page consumes.
 *
 * Covers the shape locked in
 * `docs/plans/2026-04-22-console-page-construction.md` §3.3:
 *
 *   - zero-config empty shape when no sessionStore is wired (pure
 *     MCP boot without sessionChannel / mcpApps)
 *   - populated shape reads sessionId / appId / stackSize /
 *     lastActivityAt / createdAt from each `Session`
 *   - shortCode enrichment via `shortCodeIndex.findBySessionId(id)`,
 *     optional on the wire (absent-key semantics, not `null`)
 *   - limit query param clamps to [1, 100], defaults to 25
 *   - ordering: most-recent `lastActivityAt` first, stable by id tie
 *   - `status: 'active'` hardcoded (we only filter for active)
 *   - console-disabled → 404 (route doesn't mount)
 *   - sessionStore.list() failure → 500 with structured error
 *   - shortCodeIndex.findBySessionId() failure doesn't fail the
 *     whole request — the row lands without a shortCode
 *
 * Lane 3 of the 4-lane test taxonomy (vitest, in-process fake
 * storage, no browser, no spawned CLI).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  SessionStore,
  ShortCodeIndex,
} from '@ggui-ai/mcp-server-core';
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

interface SessionsResponse {
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly shortCode?: string;
    readonly appId: string;
    readonly stackSize: number;
    readonly lastActivityAt: number;
    readonly createdAt: number;
    readonly status: 'active';
  }>;
  readonly total: number;
}

describe('GET /ggui/console/sessions', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns an empty shape when no sessionStore is wired', async () => {
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as SessionsResponse;
    expect(body).toEqual({ sessions: [], total: 0 });
  });

  it('surfaces sessionId + appId + stackSize from an active session', async () => {
    const sessionStore: SessionStore = new InMemorySessionStore();
    const created = await sessionStore.create({ appId: 'app-alpha' });
    fx = await boot({ console: {}, sessionStore });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.total).toBe(1);
    const row = body.sessions[0];
    if (!row) throw new Error('expected row');
    expect(row.sessionId).toBe(created.id);
    expect(row.appId).toBe('app-alpha');
    expect(row.stackSize).toBe(0);
    expect(row.status).toBe('active');
    expect(typeof row.lastActivityAt).toBe('number');
    expect(typeof row.createdAt).toBe('number');
    // shortCode is only present when the ShortCodeIndex reverse-
    // lookup finds one — absent key on the wire for zero-config.
    expect(Object.keys(row)).not.toContain('shortCode');
  });

  it('enriches rows with shortCode via shortCodeIndex.findBySessionId', async () => {
    const sessionStore: SessionStore = new InMemorySessionStore();
    const shortCodeIndex: ShortCodeIndex = new InMemoryShortCodeIndex();
    const created = await sessionStore.create({ appId: 'app-alpha' });
    await shortCodeIndex.put('share12345', {
      sessionId: created.id,
      appId: 'app-alpha',
    });
    fx = await boot({ console: {}, sessionStore, shortCodeIndex });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.shortCode).toBe('share12345');
  });

  it('orders rows by lastActivityAt descending (most-recent first)', async () => {
    const sessionStore: SessionStore = new InMemorySessionStore();
    const s1 = await sessionStore.create({ appId: 'a' });
    const s2 = await sessionStore.create({ appId: 'a' });
    const s3 = await sessionStore.create({ appId: 'a' });
    // Bump s2's activity to the latest so it lands at the top.
    await sessionStore.update(s2.id, { lastActivityAt: Date.now() + 10_000 });
    await sessionStore.update(s3.id, { lastActivityAt: Date.now() + 5_000 });
    fx = await boot({ console: {}, sessionStore });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions.map((r) => r.sessionId)).toEqual([
      s2.id,
      s3.id,
      s1.id,
    ]);
  });

  it('honors ?limit= and clamps to [1, 100]', async () => {
    const sessionStore: SessionStore = new InMemorySessionStore();
    // Seed 3 sessions so we can verify a limit of 2 returns 2 rows.
    await sessionStore.create({ appId: 'a' });
    await sessionStore.create({ appId: 'a' });
    await sessionStore.create({ appId: 'a' });
    fx = await boot({ console: {}, sessionStore });

    const res2 = await fetch(`${fx.url}/ggui/console/sessions?limit=2`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body2 = (await res2.json()) as SessionsResponse;
    expect(body2.sessions).toHaveLength(2);
    expect(body2.total).toBe(2);

    // Nonsense input → default (25). 3 rows is well under, so all
    // three come back.
    const resBogus = await fetch(`${fx.url}/ggui/console/sessions?limit=abc`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const bodyBogus = (await resBogus.json()) as SessionsResponse;
    expect(bodyBogus.sessions).toHaveLength(3);

    // Zero / negative → default (clamped up to positive).
    const resZero = await fetch(`${fx.url}/ggui/console/sessions?limit=0`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const bodyZero = (await resZero.json()) as SessionsResponse;
    expect(bodyZero.sessions).toHaveLength(3);

    // Oversized → capped at 100. Hard to prove directly without
    // creating 101 sessions; we assert the handler accepts the
    // request and returns a valid response shape.
    const resBig = await fetch(`${fx.url}/ggui/console/sessions?limit=9999`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(resBig.status).toBe(200);
  });

  it('shortCode absence for a specific row does NOT break the request', async () => {
    // A mixed case: one session has a shortCode, the other doesn't.
    // Row-wise enrichment; absent shortCode → absent key on the wire.
    const sessionStore: SessionStore = new InMemorySessionStore();
    const shortCodeIndex: ShortCodeIndex = new InMemoryShortCodeIndex();
    const withCode = await sessionStore.create({ appId: 'a' });
    const withoutCode = await sessionStore.create({ appId: 'a' });
    await shortCodeIndex.put('share0000', {
      sessionId: withCode.id,
      appId: 'a',
    });
    fx = await boot({ console: {}, sessionStore, shortCodeIndex });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as SessionsResponse;
    const rowWith = body.sessions.find((r) => r.sessionId === withCode.id);
    const rowWithout = body.sessions.find(
      (r) => r.sessionId === withoutCode.id,
    );
    expect(rowWith?.shortCode).toBe('share0000');
    expect(Object.keys(rowWithout ?? {})).not.toContain('shortCode');
  });

  it('shortCodeIndex.findBySessionId() failure lands the row without a shortCode', async () => {
    // A reverse-index implementation could throw (misconfigured GSI,
    // backend hiccup). The row must still land — just without the
    // click-through link — rather than 500ing the whole list.
    const sessionStore: SessionStore = new InMemorySessionStore();
    await sessionStore.create({ appId: 'a' });
    const flakyIndex: ShortCodeIndex = {
      async put() {
        /* no-op */
      },
      async lookup() {
        return null;
      },
      async findBySessionId() {
        throw new Error('reverse-index unavailable');
      },
      async revoke() {
        /* no-op */
      },
      async revokeBySessionId() {
        return 0;
      },
      async revokeByStackItemId() {
        return 0;
      },
    };
    fx = await boot({
      console: {},
      sessionStore,
      shortCodeIndex: flakyIndex,
    });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionsResponse;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.shortCode).toBeUndefined();
  });

  it('404s when console is not enabled', async () => {
    const sessionStore: SessionStore = new InMemorySessionStore();
    await sessionStore.create({ appId: 'a' });
    fx = await boot({ sessionStore });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(404);
  });

  it('500s with a structured error when sessionStore.list() throws', async () => {
    const flakyStore: SessionStore = {
      async create() {
        throw new Error('not used');
      },
      async get() {
        return null;
      },
      async list() {
        throw new Error('session store backend unavailable');
      },
      async update() {
        throw new Error('not used');
      },
      async delete() {
        /* no-op */
      },
      async appendStackItem() {
        throw new Error('not used');
      },
      async popStackItem() {
        throw new Error('not used');
      },
      async getSessionByStackItemId() {
        return null;
      },
      async appendEvent() {
        return 1;
      },
      observe() {
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) } as never;
      },
    };
    fx = await boot({ console: {}, sessionStore: flakyStore });
    const res = await fetch(`${fx.url}/ggui/console/sessions`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('sessions_unavailable');
    expect(body.message).toContain('session store backend unavailable');
  });
});
