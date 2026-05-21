/**
 * Thread-transport end-to-end tests.
 *
 * Boots a real HTTP server on an ephemeral port and exercises every
 * mounted thread route. Uses `InMemoryThreadStore` as the backing
 * plane (same impl that passes `threadStoreContract`), and
 * `InMemoryAuthAdapter` to stamp each bearer token with a distinct
 * identity so the wrong-owner indistinguishability rule can be
 * observed over the wire.
 *
 * What this suite locks:
 *
 *   - All six routes mount at the default prefix.
 *   - Each route resolves ownerId once via the AuthAdapter and forwards
 *     to the shared handler.
 *   - 400 / 404 / 409 / 401 mappings are stable.
 *   - Wrong-owner + missing-thread return the SAME 404 envelope — no
 *     distinguishing field leaks.
 *   - `createGguiServer({ threads: undefined })` mounts NO thread
 *     routes (default-off).
 *   - `threads: { store }` enables the full route family.
 *   - Pairing-minted identities resolve to `paired_<pairingId>` ownerIds
 *     so two paired devices get partitioned storage automatically.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryThreadStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

interface BootedFixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

async function boot(
  opts: Parameters<typeof createGguiServer>[0] = {},
): Promise<BootedFixture> {
  const server = createGguiServer({ logger: silentLogger, ...opts });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
}

type RequestBody = Record<string, unknown> | undefined;

async function call(
  url: string,
  method: string,
  path: string,
  token: string | null,
  body?: RequestBody,
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(`${url}${path}`, init);
  const text = await resp.text();
  // Unmounted routes return Express's HTML 404. Treating that as a
  // parse failure would mask the actual status code — caller only
  // cares about status in the opt-in test.
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: resp.status, json };
}

describe('thread transport — opt-in', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('undefined / omitted: no thread routes mounted', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    });
    const resp = await call(fx.url, 'POST', '/threads', 'dev-token', {
      appId: 'app-1',
    });
    expect(resp.status).toBe(404);
  });

  it('threads: { store } mounts all six routes', async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      threads: { store },
    });
    // Quick smoke: POST /threads returns 201 with a Thread.
    const resp = await call(fx.url, 'POST', '/threads', 'dev-token', {
      appId: 'app-1',
    });
    expect(resp.status).toBe(201);
    expect(resp.json).toMatchObject({
      appId: 'app-1',
      lastSeq: 0,
      status: 'active',
    });
  });
});

describe('thread transport — auth + ownerId resolution', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('rejects unauthenticated calls with 401 unauthenticated', async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      threads: { store },
    });
    const resp = await call(fx.url, 'POST', '/threads', null, {
      appId: 'app-1',
    });
    expect(resp.status).toBe(401);
    expect(resp.json).toMatchObject({
      error: { code: 'unauthenticated' },
    });
  });

  it('devAllowAll: every token collapses to the builder owner', async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      threads: { store },
    });
    // Two tokens — both authenticated as `builder` under devAllowAll;
    // default resolver collapses them to the same ownerId. Both see
    // each other's threads.
    const createA = await call(fx.url, 'POST', '/threads', 'token-a', {
      appId: 'app-1',
    });
    expect(createA.status).toBe(201);
    const createdA = createA.json as { id: string };
    const fetchViaB = await call(
      fx.url,
      'GET',
      `/threads/${createdA.id}`,
      'token-b',
    );
    expect(fetchViaB.status).toBe(200);
  });

  it('custom ownerFromIdentity partitions distinct tokens', async () => {
    const store = new InMemoryThreadStore();
    // Register two tokens in the adapter with metadata that our custom
    // resolver inspects. Both authenticate, but they land in DIFFERENT
    // owner partitions — cross-owner reads must return 404.
    const auth = new InMemoryAuthAdapter({ devAllowAll: false });
    auth.registerToken('tok-alice', {
      identity: { kind: 'builder' },
      source: 'pairing',
      metadata: { pairingId: 'alice-device' },
    });
    auth.registerToken('tok-bob', {
      identity: { kind: 'builder' },
      source: 'pairing',
      metadata: { pairingId: 'bob-device' },
    });
    fx = await boot({ auth, threads: { store } });

    const createdA = await call(
      fx.url,
      'POST',
      '/threads',
      'tok-alice',
      { appId: 'app-1' },
    );
    expect(createdA.status).toBe(201);
    const threadA = createdA.json as { id: string };

    // Bob cannot see Alice's thread. MUST return 404 not_found — the
    // same envelope a truly missing thread would return. Wrong-owner +
    // missing collapse by design.
    const bobFetch = await call(
      fx.url,
      'GET',
      `/threads/${threadA.id}`,
      'tok-bob',
    );
    expect(bobFetch.status).toBe(404);
    expect(bobFetch.json).toMatchObject({
      error: { code: 'not_found' },
    });

    // Missing thread for Bob returns the SAME shape.
    const bobMissing = await call(
      fx.url,
      'GET',
      '/threads/thr_ghost',
      'tok-bob',
    );
    expect(bobMissing.status).toBe(404);
    expect(bobMissing.json).toMatchObject({
      error: { code: 'not_found' },
    });

    // Bob sees only his own list.
    const aliceList = await call(fx.url, 'GET', '/threads', 'tok-alice');
    expect(aliceList.status).toBe(200);
    expect(
      (aliceList.json as { threads: Array<{ id: string }> }).threads,
    ).toHaveLength(1);
    const bobList = await call(fx.url, 'GET', '/threads', 'tok-bob');
    expect(bobList.status).toBe(200);
    expect(
      (bobList.json as { threads: Array<{ id: string }> }).threads,
    ).toHaveLength(0);
  });
});

describe('thread transport — error mapping', () => {
  let fx: BootedFixture;
  beforeEach(async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      threads: { store },
    });
  });
  afterEach(async () => {
    await fx.server.close();
  });

  async function seededThread(): Promise<{ threadId: string }> {
    const resp = await call(fx.url, 'POST', '/threads', 'dev', {
      appId: 'app-1',
    });
    expect(resp.status).toBe(201);
    return { threadId: (resp.json as { id: string }).id };
  }

  it('400 bad_request: missing appId on createThread', async () => {
    const resp = await call(fx.url, 'POST', '/threads', 'dev', {});
    expect(resp.status).toBe(400);
    expect(resp.json).toMatchObject({
      error: { code: 'bad_request' },
    });
  });

  it('400 bad_request: unknown filter value on listThreads query', async () => {
    // The handler's strict schema rejects extras even when coerced in.
    const resp = await call(
      fx.url,
      'GET',
      '/threads?status=unknown-value',
      'dev',
    );
    expect(resp.status).toBe(400);
  });

  it('400 bad_request: unknown action value on PATCH', async () => {
    const { threadId } = await seededThread();
    const resp = await call(
      fx.url,
      'PATCH',
      `/threads/${threadId}`,
      'dev',
      { action: 'snooze' },
    );
    expect(resp.status).toBe(400);
    expect(resp.json).toMatchObject({
      error: { code: 'bad_request' },
    });
  });

  it('404 not_found: getThread on missing id', async () => {
    const resp = await call(fx.url, 'GET', '/threads/missing', 'dev');
    expect(resp.status).toBe(404);
  });

  it('404 not_found: appendMessage on missing thread', async () => {
    const resp = await call(
      fx.url,
      'POST',
      '/threads/missing/messages',
      'dev',
      {
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'hi',
      },
    );
    expect(resp.status).toBe(404);
  });

  it('409 conflict: restore on an active thread', async () => {
    const { threadId } = await seededThread();
    const resp = await call(
      fx.url,
      'PATCH',
      `/threads/${threadId}`,
      'dev',
      { action: 'restore' },
    );
    expect(resp.status).toBe(409);
    expect(resp.json).toMatchObject({
      error: { code: 'conflict' },
    });
  });
});

describe('thread transport — full round-trip', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('create → append → list → patch → get (happy path)', async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      threads: { store },
    });

    // POST /threads
    const created = await call(fx.url, 'POST', '/threads', 'dev', {
      appId: 'app-1',
      firstMessageHint: 'hi',
    });
    expect(created.status).toBe(201);
    const thread = created.json as { id: string; title?: string };
    expect(thread.title).toBe('hi');

    // POST /threads/:id/messages (idempotency surfaces here)
    const first = await call(
      fx.url,
      'POST',
      `/threads/${thread.id}/messages`,
      'dev',
      {
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'hello' }],
        textPreview: 'hello',
      },
    );
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ seq: 1, textPreview: 'hello' });

    const retry = await call(
      fx.url,
      'POST',
      `/threads/${thread.id}/messages`,
      'dev',
      {
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'different',
      },
    );
    expect(retry.status).toBe(201);
    // Store returns the original row; transport doesn't re-wrap.
    expect(retry.json).toMatchObject({ seq: 1, textPreview: 'hello' });

    // GET /threads/:id/messages
    const messages = await call(
      fx.url,
      'GET',
      `/threads/${thread.id}/messages`,
      'dev',
    );
    expect(messages.status).toBe(200);
    expect(
      (messages.json as { messages: Array<{ seq: number }> }).messages,
    ).toHaveLength(1);

    // PATCH /threads/:id — pin + archive sequence.
    const pinned = await call(
      fx.url,
      'PATCH',
      `/threads/${thread.id}`,
      'dev',
      { action: 'pin' },
    );
    expect(pinned.status).toBe(200);
    expect(pinned.json).toMatchObject({ pinned: true });

    // GET /threads lists it.
    const listing = await call(fx.url, 'GET', '/threads', 'dev');
    expect(listing.status).toBe(200);
    const list = listing.json as { threads: Array<{ id: string }> };
    expect(list.threads.map((t) => t.id)).toEqual([thread.id]);

    // GET /threads/:id returns the current state.
    const fetched = await call(
      fx.url,
      'GET',
      `/threads/${thread.id}`,
      'dev',
    );
    expect(fetched.status).toBe(200);
    expect(fetched.json).toMatchObject({
      id: thread.id,
      pinned: true,
      lastSeq: 1,
    });
  });
});

// ── SSE /threads/:id/stream ─────────────────────────────────────────

/**
 * Parse an SSE stream into typed events. Reads the response body until
 * `maxEvents` have been collected OR the stream ends. Returns an array
 * of `{id, event, data}` objects for the caller to assert against.
 */
async function collectSseEvents(
  resp: Response,
  maxEvents: number,
): Promise<Array<{ id?: string; event: string; data: unknown }>> {
  const reader = resp.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  const out: Array<{ id?: string; event: string; data: unknown }> = [];
  let buffer = '';
  try {
    while (out.length < maxEvents) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are terminated by a blank line (`\n\n`).
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) {
          out.push(parsed);
          if (out.length >= maxEvents) break;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return out;
}

function parseSseFrame(frame: string):
  | { id?: string; event: string; data: unknown }
  | null {
  const lines = frame.split('\n');
  let id: string | undefined;
  let event = 'message';
  let dataRaw = '';
  for (const line of lines) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
  }
  if (!dataRaw) return null;
  let data: unknown = dataRaw;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    // leave as string — tests can still assert
  }
  return id !== undefined ? { id, event, data } : { event, data };
}

describe('thread transport — SSE /threads/:id/stream', () => {
  let fx: BootedFixture;
  beforeEach(async () => {
    const store = new InMemoryThreadStore();
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      threads: { store },
    });
  });
  afterEach(async () => {
    await fx.server.close();
  });

  async function seedThreadWithMessages(count: number): Promise<string> {
    const created = await call(fx.url, 'POST', '/threads', 'dev', {
      appId: 'app-1',
    });
    expect(created.status).toBe(201);
    const { id } = created.json as { id: string };
    for (let i = 1; i <= count; i++) {
      const msg = await call(
        fx.url,
        'POST',
        `/threads/${id}/messages`,
        'dev',
        {
          key: `k${i}`,
          authorRole: 'agent',
          kind: 'text',
          blocks: [],
          textPreview: `m${i}`,
        },
      );
      expect(msg.status).toBe(201);
    }
    return id;
  }

  it('401 before SSE headers when unauthenticated', async () => {
    // The default `devAllowAll: true` adapter authenticates a missing
    // header as builder (claude.ai connector pre-OAuth probe semantics),
    // so this test must boot a separate strict fixture to exercise the
    // 401 path. Mirrors the wrong-owner test below.
    await fx.server.close();
    const store = new InMemoryThreadStore();
    const auth = new InMemoryAuthAdapter({ devAllowAll: false });
    fx = await boot({ auth, threads: { store } });
    const resp = await fetch(`${fx.url}/threads/any-id/stream`);
    expect(resp.status).toBe(401);
    expect(resp.headers.get('content-type')).toContain('application/json');
    await resp.body?.cancel();
  });

  it('404 before SSE headers when thread is missing', async () => {
    const resp = await fetch(`${fx.url}/threads/does-not-exist/stream`, {
      headers: { authorization: 'Bearer dev' },
    });
    expect(resp.status).toBe(404);
    // Crucially the response is JSON, not text/event-stream — we did
    // NOT flush 200 before discovering the not-found state.
    expect(resp.headers.get('content-type')).toContain('application/json');
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('404 before SSE headers for wrong owner (partition-indistinguishable)', async () => {
    // Give the server a resolver that distinguishes tokens by header,
    // register both owners, and verify that wrong-owner returns the
    // same 404 envelope as missing-thread above.
    await fx.server.close();
    const store = new InMemoryThreadStore();
    const auth = new InMemoryAuthAdapter({ devAllowAll: false });
    auth.registerToken('tok-alice', {
      identity: { kind: 'builder' },
      source: 'pairing',
      metadata: { pairingId: 'alice' },
    });
    auth.registerToken('tok-bob', {
      identity: { kind: 'builder' },
      source: 'pairing',
      metadata: { pairingId: 'bob' },
    });
    fx = await boot({ auth, threads: { store } });

    const created = await call(
      fx.url,
      'POST',
      '/threads',
      'tok-alice',
      { appId: 'app-1' },
    );
    expect(created.status).toBe(201);
    const { id } = created.json as { id: string };

    const resp = await fetch(`${fx.url}/threads/${id}/stream`, {
      headers: { authorization: 'Bearer tok-bob' },
    });
    expect(resp.status).toBe(404);
    expect(resp.headers.get('content-type')).toContain('application/json');
    await resp.body?.cancel();
  });

  it('400 before SSE headers on malformed fromSeq', async () => {
    const id = await seedThreadWithMessages(0);
    const resp = await fetch(
      `${fx.url}/threads/${id}/stream?fromSeq=-1`,
      { headers: { authorization: 'Bearer dev' } },
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get('content-type')).toContain('application/json');
    await resp.body?.cancel();
  });

  it('snapshot: pre-existing messages are delivered as thread-message frames', async () => {
    const id = await seedThreadWithMessages(3);
    const resp = await fetch(`${fx.url}/threads/${id}/stream`, {
      headers: { authorization: 'Bearer dev' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const events = await collectSseEvents(resp, 3);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event)).toEqual([
      'thread-message',
      'thread-message',
      'thread-message',
    ]);
    expect(events.map((e) => e.id)).toEqual(['1', '2', '3']);
    const data0 = events[0]!.data as { type: string; message: { seq: number } };
    expect(data0.type).toBe('thread-message');
    expect(data0.message.seq).toBe(1);
  });

  it('tail: appended messages after stream open arrive as frames', async () => {
    const id = await seedThreadWithMessages(1);
    const resp = await fetch(`${fx.url}/threads/${id}/stream`, {
      headers: { authorization: 'Bearer dev' },
    });
    expect(resp.status).toBe(200);

    // Start reading in the background so the server's SSE loop
    // actually makes forward progress — writes can back-pressure if
    // nothing is draining the socket.
    const collectPromise = collectSseEvents(resp, 2);

    // Append a new message via the JSON route; the tail should see it.
    const appended = await call(
      fx.url,
      'POST',
      `/threads/${id}/messages`,
      'dev',
      {
        key: 'tail1',
        authorRole: 'agent',
        kind: 'text',
        blocks: [],
        textPreview: 'tail1',
      },
    );
    expect(appended.status).toBe(201);

    const events = await collectPromise;
    expect(events.map((e) => (e.data as { message: { seq: number } }).message.seq)).toEqual([1, 2]);
  });

  it('fromSeq=<n> resumes past earlier messages', async () => {
    const id = await seedThreadWithMessages(3);
    const resp = await fetch(
      `${fx.url}/threads/${id}/stream?fromSeq=2`,
      { headers: { authorization: 'Bearer dev' } },
    );
    expect(resp.status).toBe(200);
    const events = await collectSseEvents(resp, 2);
    expect(events.map((e) => (e.data as { message: { seq: number } }).message.seq)).toEqual([2, 3]);
  });

  it('stream opens for an empty thread (tail) then delivers first append', async () => {
    const id = await seedThreadWithMessages(0);
    const resp = await fetch(`${fx.url}/threads/${id}/stream`, {
      headers: { authorization: 'Bearer dev' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    // Start draining the body so writes can flush, then append.
    const collectPromise = collectSseEvents(resp, 1);

    // Small delay so the SSE header-write + flush actually reaches
    // the kernel buffer before the append fires — on very fast hosts
    // the append can otherwise land before the server's writeHead
    // task is scheduled, which doesn't break correctness but makes
    // the test assertion racey for no gain. Sleep is in microseconds'
    // ballpark; test duration is unchanged on slow CI.
    await new Promise((r) => setTimeout(r, 10));

    const appended = await call(
      fx.url,
      'POST',
      `/threads/${id}/messages`,
      'dev',
      {
        key: 'first',
        authorRole: 'agent',
        kind: 'text',
        blocks: [],
        textPreview: 'first',
      },
    );
    expect(appended.status).toBe(201);

    const events = await collectPromise;
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { message: { seq: number } }).message.seq).toBe(1);
  });
});
