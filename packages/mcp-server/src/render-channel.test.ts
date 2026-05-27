/**
 * End-to-end OSS live-channel tests.
 *
 * Boots a real `createGguiServer({sessionChannel: true})` on an
 * ephemeral port, connects with the real `ws` client (NOT a hand-rolled
 * framer), and exercises every enforcement path the shared
 * session-mutations helpers govern:
 *
 *   - subscribe → ack (with stack) round-trip
 *   - allowed event (type in subscription) → ack
 *   - disallowed event type → `EVENT_NOT_ALLOWED`
 *   - data:submit with wrong action id → `CONTRACT_VIOLATION`
 *   - outbound fan-out delivers when payload matches streamSpec
 *   - outbound fan-out throws when payload violates streamSpec
 *   - unauthorized upgrade → HTTP 401 before WS handshake
 *   - cross-session spoof event → `SESSION_MISMATCH`
 *
 * Proves OSS is now a second real consumer of the shared enforcement
 * codepath alongside the hosted Lambda.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  ActionSpec,
  ContractErrorPayload,
  EventType,
  JsonValue,
  Session,
  Render,
  StreamSpec,
  SubscribePayload,
} from '@ggui-ai/protocol';
import { ContractViolationError, PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  SessionEvent,
  SessionFilter,
  SessionPatch,
  RenderStore,
  ObserveOptions,
  CreateSessionInput,
} from '@ggui-ai/mcp-server-core';
import {
  InMemoryAuthAdapter,
  InMemorySessionStreamBuffer,
  InMemoryTelemetrySink,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  channelEnforcementContract,
  type ChannelEnforcementHarness,
  type ChannelEnforcementOutcome,
} from '@ggui-ai/mcp-server-core/contract-tests';
import { createGguiServer, type GguiServer } from './server.js';

const TEST_APP_ID = 'test-app';
const TEST_SESSION_ID = 'sess-channel-test';

const ACTION_SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
};

const STREAM_SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

function makeRender(): Render {
  return {
    id: 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    subscription: {
      events: ['data:submit', 'lifecycle:session_end'],
    },
    actionSpec: ACTION_SPEC,
    streamSpec: STREAM_SPEC,
  };
}

/**
 * Test-only RenderStore that pre-seeds a session with a specific stack.
 * Production InMemoryRenderStore exposes no stack-mutation path today
 * (stack mutation is gated behind OSS `ggui_push` extraction which is
 * its own slice); this shim fills the gap for test wire-level coverage.
 */
function makeSeededStore(seedStack: Render[]): RenderStore {
  const seeded: Session = {
    id: TEST_SESSION_ID,
    appId: TEST_APP_ID,
    stack: seedStack,
    currentStackIndex: seedStack.length - 1,
    adapterPermissions: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  const recordedEvents: SessionEvent[] = [];

  function clone(s: Session): Session {
    return { ...s, stack: [...s.stack], adapterPermissions: { ...s.adapterPermissions } };
  }

  return {
    async get(id: string): Promise<Session | null> {
      return id === seeded.id ? clone(seeded) : null;
    },
    async create(input: CreateSessionInput): Promise<Session> {
      if (input.id === seeded.id) return clone(seeded);
      throw new Error(
        `makeSeededStore.create: unexpected id ${input.id ?? '<generated>'}`,
      );
    },
    async list(_filter: SessionFilter): Promise<Session[]> {
      return [clone(seeded)];
    },
    async update(id: string, patch: SessionPatch): Promise<Session> {
      if (id !== seeded.id) throw new Error('unknown session');
      if (patch.lastActivityAt !== undefined) seeded.lastActivityAt = patch.lastActivityAt;
      if (patch.expiresAt !== undefined) seeded.expiresAt = patch.expiresAt;
      // Honor activeStackItemId patches;
      // `null` clears so the next consume falls back to top-of-stack.
      if (patch.activeStackItemId !== undefined) {
        if (patch.activeStackItemId === null) {
          delete seeded.activeStackItemId;
        } else {
          seeded.activeStackItemId = patch.activeStackItemId;
        }
      }
      return clone(seeded);
    },
    async delete(_id: string): Promise<void> {
      /* no-op for test shim */
    },
    async commit(renderId: string, entry): Promise<Session> {
      if (renderId !== seeded.id) throw new Error('unknown session');
      seeded.stack.push(entry);
      seeded.currentStackIndex = seeded.stack.length - 1;
      return clone(seeded);
    },
    async popRender() {
      throw new Error('popRender is not exercised by session-channel tests');
    },
    async getSessionByStackItemId(renderId: string) {
      const hit = seeded.stack.find((item) => item.id === renderId);
      return hit ? { renderId: seeded.id, appId: seeded.appId } : null;
    },
    async appendEvent(input: AppendEventInput): Promise<number> {
      if (input.renderId !== seeded.id) throw new Error('unknown session');
      seeded.eventSequence += 1;
      recordedEvents.push({
        seq: seeded.eventSequence,
        type: input.type,
        timestamp: Date.now(),
        data: input.data,
      });
      return seeded.eventSequence;
    },
    async listEventsSince(renderId: string, sinceSeq: number, limit: number) {
      if (renderId !== seeded.id) return null;
      const filtered = recordedEvents.filter((e) => e.seq > sinceSeq);
      const hasMore = filtered.length > limit;
      return {
        events: filtered.slice(0, limit),
        lastSequence: seeded.eventSequence,
        hasMore,
        horizonSeq: 0,
      };
    },
    observe(_id: string, _opts?: ObserveOptions): AsyncIterable<SessionEvent> {
      throw new Error('observe is not exercised by session-channel tests');
    },
  };
}

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
  wsUrl: string;
}

async function boot(
  opts: Partial<Parameters<typeof createGguiServer>[0]> & {
    renderStore?: RenderStore;
  } = {},
): Promise<Fixture> {
  const server = createGguiServer({
    logger: silentLogger,
    sessionChannel: true,
    ...opts,
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  return { server, httpServer, wsUrl };
}

/** Connect with a dev-mode bearer. Returns the open WS. */
async function connectAuthed(wsUrl: string, bearer = 'test-token'): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function recvMessage(ws: WebSocket): Promise<WebSocketMessage> {
  return new Promise<WebSocketMessage>((resolve, reject) => {
    const onMessage = (raw: RawData): void => {
      ws.off('error', onError);
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      try {
        resolve(JSON.parse(text) as WebSocketMessage);
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error): void => {
      ws.off('message', onMessage);
      reject(err);
    };
    ws.once('message', onMessage);
    ws.once('error', onError);
  });
}

/**
 * Persistent-queue variant of {@link recvMessage}. ws frames arriving
 * back-to-back between `recvMessage` calls are dropped by the
 * `once('message')` pattern — the Slice 11.5 wiredActionRouter fires
 * data + ack in the same microtask block, so tests that assert both
 * need a queue that buffers anything arriving with no live waiter.
 *
 * Returns `{next, close}`: `next()` resolves to the next buffered
 * frame, or waits for one; `close()` stops buffering (call in test
 * teardown to avoid leaking listeners across fixtures).
 */
function makeMessageQueue(ws: WebSocket): {
  next(): Promise<WebSocketMessage>;
  close(): void;
} {
  const buffer: WebSocketMessage[] = [];
  const waiters: Array<(msg: WebSocketMessage) => void> = [];
  const errors: Array<(err: Error) => void> = [];
  const onMessage = (raw: RawData): void => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let msg: WebSocketMessage;
    try {
      msg = JSON.parse(text) as WebSocketMessage;
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      buffer.push(msg);
    }
  };
  const onError = (err: Error): void => {
    const reject = errors.shift();
    if (reject) reject(err);
  };
  ws.on('message', onMessage);
  ws.on('error', onError);
  return {
    next(): Promise<WebSocketMessage> {
      const buffered = buffer.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<WebSocketMessage>((resolve, reject) => {
        waiters.push(resolve);
        errors.push(reject);
      });
    },
    close(): void {
      ws.off('message', onMessage);
      ws.off('error', onError);
    },
  };
}

function sendMessage(ws: WebSocket, message: WebSocketMessage): void {
  ws.send(JSON.stringify(message));
}

function makeSubscribe(): WebSocketMessage & { type: 'subscribe' } {
  return {
    type: 'subscribe',
    payload: {
      renderId: TEST_SESSION_ID,
      appId: TEST_APP_ID,
      role: 'user',
    } as SubscribePayload,
    requestId: 'sub-1',
  };
}


describe('createRenderChannelServer — OSS live-channel end-to-end', () => {
  let fix: Fixture | null = null;

  beforeEach(async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('handshakes + subscribes + returns stack on ack', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type !== 'ack') throw new Error('unexpected message');
    expect(ack.payload.sequence).toBe(0);
    expect(ack.payload.stack?.length).toBe(1);
    expect(ack.payload.stack?.[0].id).toBe('page-0');
    ws.close();
  });

  it('accepts a declared data:submit event matching actionSpec', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws); // subscribe ack

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'hi' } },
      }),
    );
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.payload.sequence).toBeGreaterThan(0);
    }
    ws.close();
  });

  it('rejects an event type not in the subscription allowlist', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    // Stack item's subscription is ['data:submit', 'lifecycle:session_end'].
    // interaction:click is NOT in that list → EVENT_NOT_ALLOWED.
    sendMessage(ws, makeActionEnvelope({ type: 'interaction:click' }));
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('EVENT_NOT_ALLOWED');
      const details = err.payload.details as {
        error: string;
        eventType: string;
        allowedEvents: string[];
      };
      expect(details.error).toBe('event_not_allowed');
      expect(details.eventType).toBe('interaction:click');
      expect(details.allowedEvents).toContain('data:submit');
    }
    ws.close();
  });

  it('rejects a data:submit payload that violates actionSpec', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    // actionSpec declares 'submit' only — 'deleteAccount' is undeclared.
    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'deleteAccount', data: {} },
      }),
    );
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('CONTRACT_VIOLATION');
      const details = err.payload.details as { error: string; tool: string };
      expect(details.error).toBe('contract_violation');
      expect(details.tool).toBe('ggui_event');
    }
    ws.close();
  });

  it('sendToSession fans out an envelope matching streamSpec', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    const channel = fix!.server.sessionChannel!;
    const result = await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'tick',
      mode: 'append',
      payload: { count: 7 },
    });
    // Seq plumbed out of fanOut so ggui_emit's wire output carries
    // ordering. Monotonic per session; this is the first send so seq=1.
    expect(result.seq).toBe(1);

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('data');
    if (msg.type === 'data') {
      expect(msg.payload.renderId).toBe(TEST_SESSION_ID);
      expect(msg.payload.channel).toBe('tick');
      expect(msg.payload.mode).toBe('append');
      expect(msg.payload.payload).toEqual({ count: 7 });
      // Wire envelope's seq matches what sendToSession returned.
      expect(msg.payload.seq).toBe(result.seq);
    }
    ws.close();
  });

  it('sendToSession throws + does NOT fan out when envelope violates streamSpec', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    const channel = fix!.server.sessionChannel!;
    // streamSpec declares only 'tick' — 'garbage' is undeclared.
    await expect(
      channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'garbage',
        mode: 'append',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(ContractViolationError);

    // Client MUST NOT receive anything. Race: send a follow-up valid
    // message and confirm that's the next frame — i.e., no garbage
    // slipped through ahead of it.
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'tick',
      mode: 'append',
      payload: { count: 99 },
    });
    const next = await recvMessage(ws);
    expect(next.type).toBe('data');
    if (next.type === 'data') {
      expect(next.payload.channel).toBe('tick');
      expect(next.payload.payload).toEqual({ count: 99 });
    }
    ws.close();
  });

  it('rejects cross-session spoof actions with SESSION_MISMATCH', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'x' } },
        renderId: 'sess-OTHER',
      }),
    );
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('SESSION_MISMATCH');
    }
    ws.close();
  });
});

describe('createRenderChannelServer — health introspection', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('/ggui/health reports channel path + subscriber/session counts', async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const addr = fix.httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Baseline: no subscribers yet.
    let resp = await fetch(`${baseUrl}/ggui/health`);
    expect(resp.status).toBe(200);
    let body = (await resp.json()) as {
      status: string;
      channel?: { path: string; subscribers: number; sessions: number };
    };
    expect(body.status).toBe('ok');
    expect(body.channel).toEqual({
      path: '/ws',
      subscribers: 0,
      sessions: 0,
    });

    // Connect a subscriber; health should reflect it.
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    resp = await fetch(`${baseUrl}/ggui/health`);
    body = (await resp.json()) as typeof body;
    expect(body.channel?.subscribers).toBe(1);
    expect(body.channel?.sessions).toBe(1);

    ws.close();
  });

  it('/ggui/health omits channel block when sessionChannel is disabled', async () => {
    const server = createGguiServer({ logger: silentLogger });
    try {
      const httpServer = await server.listen(0, '127.0.0.1');
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      const resp = await fetch(`http://127.0.0.1:${addr.port}/ggui/health`);
      const body = (await resp.json()) as { channel?: unknown };
      expect(body.channel).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('createRenderChannelServer — notifyStackPush (B1)', () => {
  let fix: Fixture | null = null;

  beforeEach(async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('fans a `{type:"push", payload:{stackItem}}` frame to live subscribers', async () => {
    // Closes the QA-observed B1 chat-inline-handoff hang. The chat
    // surface keeps one live subscription across turns; on the second
    // turn the push handler appends to the RenderStore but the
    // subscriber never hears unless the channel emits a delta.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');

    const channel = fix!.server.sessionChannel!;
    const newItem: Render = {
      id: 'page-second-turn',
      componentCode: '/* generated on turn 2 */',
      createdAt: new Date().toISOString(),
    };
    channel.notifyStackPush(TEST_SESSION_ID, newItem);

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('push');
    if (msg.type === 'push') {
      expect(msg.payload.stackItem.id).toBe('page-second-turn');
      // No matchType supplied — payload omits the field rather than
      // emitting `undefined` (keeps the wire payload minimal and the
      // client's `matchType` branch quiet on cold pushes).
      expect(msg.payload.matchType).toBeUndefined();
    }
    ws.close();
  });

  it('forwards `matchType: "cached"` so the client can branch on cache-hit vs cold', async () => {
    // The push handler tags cache-hit pushes with `matchType: 'cached'`
    // so the client `GguiSession.handleServerMessage` can synthesize
    // a matching progress event ("Found matching blueprint"). Pin
    // the pass-through so a future server change can't drop it
    // silently.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    const channel = fix!.server.sessionChannel!;
    const cachedItem: Render = {
      id: 'page-cache-hit',
      componentCode: '/* reused from cache */',
      createdAt: new Date().toISOString(),
    };
    channel.notifyStackPush(TEST_SESSION_ID, cachedItem, 'cached');

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('push');
    if (msg.type === 'push') {
      expect(msg.payload.stackItem.id).toBe('page-cache-hit');
      expect(msg.payload.matchType).toBe('cached');
    }
    ws.close();
  });

  it('is a best-effort no-op when there are no subscribers for the session', () => {
    // No subscribe step here — the call should not throw, should
    // not log a hot error, and most importantly should not block the
    // caller (push handler must be free to fire-and-forget).
    const channel = fix!.server.sessionChannel!;
    expect(() =>
      channel.notifyStackPush(TEST_SESSION_ID, {
        id: 'page-orphan',
        componentCode: '',
        createdAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it('does NOT cross-deliver to subscribers on a different session', async () => {
    // Same load-bearing isolation invariant as `sendToSession`. The
    // notify must not leak across sessions even when the payload's
    // `stackItem.id` happens to collide.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    const channel = fix!.server.sessionChannel!;
    // First, a notify for an UNRELATED session — subscriber must not
    // receive it.
    channel.notifyStackPush('sess-OTHER', {
      id: 'page-other',
      componentCode: '/* belongs to another session */',
      createdAt: new Date().toISOString(),
    });
    // Then a notify for the bound session — the next frame the
    // subscriber sees MUST be this one (proves the prior call did
    // not slip through).
    channel.notifyStackPush(TEST_SESSION_ID, {
      id: 'page-mine',
      componentCode: '/* mine */',
      createdAt: new Date().toISOString(),
    });

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('push');
    if (msg.type === 'push') {
      expect(msg.payload.stackItem.id).toBe('page-mine');
    }
    ws.close();
  });
});

describe('createRenderChannelServer — auth', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('rejects upgrade without a bearer token with 401', async () => {
    // Explicit non-devAllowAll adapter — the default
    // `InMemoryAuthAdapter({ devAllowAll: true })` treats no-header as
    // authenticated (claude.ai connector pre-OAuth probe semantics),
    // so this test must opt out to exercise the 401 path.
    fix = await boot({
      renderStore: makeSeededStore([makeRender()]),
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
    });
    const ws = new WebSocket(fix.wsUrl); // no Authorization header
    const err = await new Promise<Error>((resolve) => {
      ws.once('error', (e) => resolve(e));
      ws.once('unexpected-response', (_req, res) => {
        resolve(new Error(`unexpected-response ${res.statusCode}`));
      });
      ws.once('open', () => resolve(new Error('socket opened unexpectedly')));
    });
    // Either path is acceptable — ws throws on 401 directly on some
    // node/ws versions and emits 'unexpected-response' on others.
    // What matters is the socket did NOT open.
    expect(err).toBeTruthy();
    expect(ws.readyState).not.toBe(ws.OPEN);
  });

  it('returns 404 on upgrade to a non-channel path', async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const addr = fix.httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const wrongPath = `ws://127.0.0.1:${addr.port}/not-the-channel`;
    const ws = new WebSocket(wrongPath, {
      headers: { Authorization: 'Bearer test-token' },
    });
    const err = await new Promise<Error>((resolve) => {
      ws.once('error', (e) => resolve(e));
      ws.once('unexpected-response', (_req, res) => {
        resolve(new Error(`unexpected-response ${res.statusCode}`));
      });
      ws.once('open', () => resolve(new Error('opened unexpectedly')));
    });
    expect(err).toBeTruthy();
    expect(ws.readyState).not.toBe(ws.OPEN);
  });
});

// ─────────────────────────────────────────────────────────────────────
// OSS channel as a consumer of channelEnforcementContract
// ─────────────────────────────────────────────────────────────────────
//
// This is the first REAL consumer wired to the shared contract suite
// from @ggui-ai/mcp-server-core/contract-tests. Each contract case
// routes inputs through the actual /ws endpoint (not a mock), proving
// OSS satisfies the same normative enforcement invariants the hosted
// Lambda does.
//
// Hosted wiring is deferred — cloud's 44-pre-existing-failure test
// baseline makes adding a handler-level integration harness noisy;
// the clean path is a follow-on slice that either factors hosted's
// enforcement into a pure function or improves cloud's test infra.

/** Mutable store that lets the harness rewrite the session's stack
 *  between contract cases. The contract expects `makeHarness()` to
 *  return a fresh subject per `it`, so each case gets a clean mutator
 *  without cross-test bleed. */
function makeMutableStore(): {
  store: RenderStore;
  setStack: (stack: Render[]) => void;
} {
  const session: Session = {
    id: TEST_SESSION_ID,
    appId: TEST_APP_ID,
    stack: [],
    currentStackIndex: -1,
    adapterPermissions: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  function clone(s: Session): Session {
    return { ...s, stack: [...s.stack], adapterPermissions: { ...s.adapterPermissions } };
  }
  const store: RenderStore = {
    async get(id) {
      return id === session.id ? clone(session) : null;
    },
    async create(input: CreateSessionInput) {
      if (input.id === session.id) return clone(session);
      throw new Error(`makeMutableStore.create: unexpected id ${input.id ?? '<gen>'}`);
    },
    async list(_f: SessionFilter) {
      return [clone(session)];
    },
    async update(id: string, patch: SessionPatch) {
      if (id !== session.id) throw new Error('unknown');
      if (patch.lastActivityAt !== undefined) session.lastActivityAt = patch.lastActivityAt;
      if (patch.expiresAt !== undefined) session.expiresAt = patch.expiresAt;
      return clone(session);
    },
    async delete(_id: string) {
      /* no-op for test */
    },
    async commit(renderId: string, entry) {
      if (renderId !== session.id) throw new Error('unknown');
      session.stack.push(entry);
      session.currentStackIndex = session.stack.length - 1;
      return clone(session);
    },
    async popRender() {
      throw new Error('popRender is not exercised by these tests');
    },
    async getSessionByStackItemId(renderId: string) {
      const hit = session.stack.find((item) => item.id === renderId);
      return hit ? { renderId: session.id, appId: session.appId } : null;
    },
    async appendEvent(input: AppendEventInput) {
      if (input.renderId !== session.id) throw new Error('unknown');
      session.eventSequence += 1;
      return session.eventSequence;
    },
    async listEventsSince(renderId: string, _sinceSeq: number, _limit: number) {
      if (renderId !== session.id) return null;
      return {
        events: [],
        lastSequence: session.eventSequence,
        hasMore: false,
        horizonSeq: 0,
      };
    },
    observe(_id: string, _opts?: ObserveOptions): AsyncIterable<SessionEvent> {
      throw new Error('observe not used by channel-enforcement contract');
    },
  };
  return {
    store,
    setStack(stack: Render[]) {
      session.stack = stack;
      session.currentStackIndex = stack.length - 1;
    },
  };
}

describe('channel enforcement contract — OSS /ws consumer', () => {
  let servers: GguiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
    servers = [];
  });

  channelEnforcementContract('OSS /ws endpoint', async () => {
    // Fresh server + mutable store per contract case. Each case gets a
    // clean enforcement subject — no cross-case state bleed. Cleanup
    // happens in the outer `afterEach`.
    const mutable = makeMutableStore();
    const server = createGguiServer({
      logger: silentLogger,
      sessionChannel: true,
      renderStore: mutable.store,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    servers.push(server);
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;

    async function openSubscribed(): Promise<WebSocket> {
      const ws = await connectAuthed(wsUrl);
      sendMessage(ws, makeSubscribe());
      await recvMessage(ws); // subscribe ack
      return ws;
    }

    /** Map the OSS wire response back to the contract outcome shape. */
    function toOutcome(msg: WebSocketMessage): ChannelEnforcementOutcome {
      if (msg.type === 'ack') return { kind: 'pass' };
      if (msg.type === 'error') {
        const code = msg.payload.code;
        if (code === 'EVENT_NOT_ALLOWED' || code === 'CONTRACT_VIOLATION') {
          return { kind: 'reject', code };
        }
        throw new Error(`unexpected channel error code: ${code}`);
      }
      throw new Error(`unexpected response type: ${String(msg.type)}`);
    }

    const harness: ChannelEnforcementHarness = {
      async processInboundEvent(stackItem, envelope) {
        mutable.setStack(stackItem ? [stackItem] : []);
        const ws = await openSubscribed();
        try {
          // Rewrite envelope.renderId to match the subscriber's real
          // session. The contract's fixture renderId is a placeholder;
          // the harness owns consumer-specific session binding. Keeping
          // the rest of the envelope (type, payload, stackIndex) intact
          // is what makes the contract exercise the right behavior.
          const bound: ActionEnvelope = {
            ...envelope,
            renderId: TEST_SESSION_ID,
          };
          sendMessage(ws, { type: 'action', payload: bound });
          const resp = await recvMessage(ws);
          return toOutcome(resp);
        } finally {
          ws.close();
        }
      },
      async processOutboundData(stackItem, channel, payload) {
        mutable.setStack(stackItem ? [stackItem] : []);
        const ws = await openSubscribed();
        try {
          try {
            await server.sessionChannel!.sendToSession({
              renderId: TEST_SESSION_ID,
              channel,
              mode: 'append',
              payload,
            });
          } catch (err) {
            if (err instanceof ContractViolationError) {
              return { kind: 'reject', code: 'CONTRACT_VIOLATION' };
            }
            throw err;
          }
          // Delivery succeeded — drain the `data` frame so the next
          // test isn't confused by a stray message (paranoia: each
          // harness call opens + closes its own ws, so this drain is
          // bound to THIS call's socket anyway).
          await recvMessage(ws);
          return { kind: 'pass' };
        } finally {
          ws.close();
        }
      },
    };
    return harness;
  });
});

// ─────────────────────────────────────────────────────────────────────
// Replay semantics — end-to-end over the real /ws endpoint
// ─────────────────────────────────────────────────────────────────────
//
// Covers the operationalization of streamSpec[name].replay:
//
//   - 'none'   → no replay on reconnect.
//   - 'latest' → only the most recent envelope per channel.
//   - 'all'    → every envelope with seq > fromSeq, subject to the
//                bounded buffer's retention.
//
// Also covers the race-free fan-out guard: replayCompletedSeq gates
// live delivery so a reconnecting subscriber doesn't double-receive
// envelopes that their replay already returned.
//
// The existing fixture (makeSeededStore with a fixed stack) is
// extended here via a `replaySpec`-typed stack item builder. Each
// test boots a fresh server with its own in-memory stream buffer so
// seq counters start at 1.

function makeStackItemWithStreamSpec(streamSpec: StreamSpec): Render {
  return {
    id: 'page-0',
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    subscription: { events: ['data:submit', 'lifecycle:session_end'] },
    streamSpec,
  };
}

/**
 * Attach a persistent `message` listener BEFORE any producer action
 * fires, so replay frames arriving in rapid succession after ack are
 * never dropped. `once()`-based receive patterns lose frames because
 * the listener is only registered for a single event.
 */
function attachInbox(ws: WebSocket): {
  readonly frames: WebSocketMessage[];
  waitIdle: (idleMs: number) => Promise<void>;
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
} {
  const frames: WebSocketMessage[] = [];
  ws.on('message', (raw: RawData) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    try {
      frames.push(JSON.parse(text) as WebSocketMessage);
    } catch {
      /* ignore malformed */
    }
  });
  return {
    frames,
    async waitIdle(idleMs: number): Promise<void> {
      // Wait until `idleMs` passes with no new frames arriving.
      let last = frames.length;
      for (;;) {
        await new Promise((r) => setTimeout(r, idleMs));
        if (frames.length === last) return;
        last = frames.length;
      }
    },
    async waitFor(n: number, timeoutMs = 500): Promise<void> {
      const start = Date.now();
      while (frames.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timeout after ${timeoutMs}ms waiting for ${n} frames; got ${frames.length}: ${JSON.stringify(frames)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

function subscribeFrame(
  fromSeq: number | undefined,
): WebSocketMessage & { type: 'subscribe' } {
  const payload: SubscribePayload = {
    renderId: TEST_SESSION_ID,
    appId: TEST_APP_ID,
    role: 'user',
    ...(fromSeq !== undefined ? { fromSeq } : {}),
  };
  return { type: 'subscribe', payload, requestId: 'sub-1' };
}

/**
 * R7 — subscribe with a SessionEvent ledger cursor (`sinceSequence`).
 * Distinct from `fromSeq` (per-stream-channel replay) — see
 * `SubscribePayload.sinceSequence` docstring.
 */
function subscribeFrameWithSinceSequence(
  sinceSequence: number,
): WebSocketMessage & { type: 'subscribe' } {
  const payload: SubscribePayload = {
    renderId: TEST_SESSION_ID,
    appId: TEST_APP_ID,
    role: 'user',
    sinceSequence,
  };
  return { type: 'subscribe', payload, requestId: 'sub-1' };
}

describe('OSS /ws — replay semantics end-to-end', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('fresh subscribe (no fromSeq) receives no replay frames — only ack', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    // Prime the buffer with 3 envelopes — a later fresh subscriber
    // should NOT see them.
    const channel = fix.server.sessionChannel!;
    for (let i = 1; i <= 3; i++) {
      await channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'feed',
        mode: 'append',
        payload: { i },
      });
    }

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(undefined));
    await inbox.waitFor(1);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(1);
    const ack = inbox.frames[0];
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(3);
      expect(ack.payload.replayTruncated).toBeUndefined();
    }
    ws.close();
  });

  it("replay: 'none' — reconnect with fromSeq=0 receives no frames, ack streamSeq reflects cursor", async () => {
    const spec: StreamSpec = {
      silent: { schema: { type: 'object', additionalProperties: true }, replay: 'none' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'silent',
      mode: 'append',
      payload: { x: 1 },
    });
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'silent',
      mode: 'append',
      payload: { x: 2 },
    });

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    await inbox.waitFor(1);
    await inbox.waitIdle(50);
    // Seq still advanced for 'none' channels (cursor is policy-agnostic),
    // but nothing was stored — replay has nothing to return.
    expect(inbox.frames).toHaveLength(1);
    const ack = inbox.frames[0];
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(2);
      expect(ack.payload.replayTruncated).toBeUndefined();
    }
    ws.close();
  });

  it("replay: 'latest' — reconnect receives only the latest envelope per channel", async () => {
    const spec: StreamSpec = {
      snap: { schema: { type: 'object', additionalProperties: true }, replay: 'latest' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'snap',
      mode: 'replace',
      payload: { v: 'a' },
    });
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'snap',
      mode: 'replace',
      payload: { v: 'b' },
    });
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'snap',
      mode: 'replace',
      payload: { v: 'c' },
    });

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    await inbox.waitFor(2); // ack + 1 replay
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(2);
    const [ack, data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(3);
    }
    expect(data.type).toBe('data');
    if (data.type === 'data') {
      expect(data.payload.channel).toBe('snap');
      expect(data.payload.payload).toEqual({ v: 'c' });
      expect(data.payload.seq).toBe(3);
      expect(data.payload.mode).toBe('replace');
    }
    ws.close();
  });

  it("replay: 'all' — reconnect receives every buffered envelope in seq order", async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    for (let i = 1; i <= 3; i++) {
      await channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'feed',
        mode: 'append',
        payload: { i },
      });
    }

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    await inbox.waitFor(4); // ack + 3 replay
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(4);
    const [ack, ...data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(3);
      expect(ack.payload.replayTruncated).toBeUndefined();
    }
    const payloads = data.map((m) => {
      if (m.type !== 'data') throw new Error('unexpected frame');
      return { seq: m.payload.seq, i: (m.payload.payload as { i: number }).i };
    });
    expect(payloads).toEqual([
      { seq: 1, i: 1 },
      { seq: 2, i: 2 },
      { seq: 3, i: 3 },
    ]);
    ws.close();
  });

  it('replay honors fromSeq — only envelopes with seq > fromSeq are replayed', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    for (let i = 1; i <= 5; i++) {
      await channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'feed',
        mode: 'append',
        payload: { i },
      });
    }

    // Subscriber saw up to seq 3 — reconnect with fromSeq=3.
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(3));
    await inbox.waitFor(3); // ack + 2 replay
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(3);
    const [ack, ...data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(5);
    }
    expect(data.map((m) => (m.type === 'data' ? m.payload.seq : -1))).toEqual([
      4, 5,
    ]);
    ws.close();
  });

  it('flags replayTruncated when fromSeq is older than the oldest retained seq', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
      // Tiny buffer so the 5-envelope producer overflows + evicts.
      streamBuffer: new InMemorySessionStreamBuffer({ maxPerSession: 2 }),
    });
    const channel = fix.server.sessionChannel!;
    for (let i = 1; i <= 5; i++) {
      await channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'feed',
        mode: 'append',
        payload: { i },
      });
    }
    // Buffer retains seq 4,5. Subscriber says they last saw seq 1 —
    // they're missing seq 2,3 (evicted).

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(1));
    await inbox.waitFor(3); // ack + 2 replay
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(3);
    const [ack, ...data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(5);
      expect(ack.payload.replayTruncated).toBe(true);
    }
    expect(data.map((m) => (m.type === 'data' ? m.payload.seq : -1))).toEqual([
      4, 5,
    ]);
    ws.close();
  });

  it('mixed policies replay correctly together in one reconnect', async () => {
    const spec: StreamSpec = {
      silent: { schema: { type: 'object', additionalProperties: true }, replay: 'none' },
      snap: { schema: { type: 'object', additionalProperties: true }, replay: 'latest' },
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 1 } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'silent', mode: 'append', payload: {} });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'snap', mode: 'replace', payload: { v: 'a' } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 2 } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'snap', mode: 'replace', payload: { v: 'b' } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 3 } });

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    // feed: all three (seq 1, 4, 6). snap: latest (seq 5). silent: none.
    // Total frames: ack + 4 replay = 5.
    await inbox.waitFor(5);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(5);
    const [ack, ...data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(6);
    }
    const summary = data.map((m) => {
      if (m.type !== 'data') throw new Error('unexpected frame');
      return { seq: m.payload.seq, channel: m.payload.channel };
    });
    expect(summary).toEqual([
      { seq: 1, channel: 'feed' },
      { seq: 4, channel: 'feed' },
      { seq: 5, channel: 'snap' },
      { seq: 6, channel: 'feed' },
    ]);
    ws.close();
  });

  it('live tail resumes after replay without duplicating replayed envelopes', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;

    // Seed some envelopes BEFORE any subscribe.
    for (let i = 1; i <= 2; i++) {
      await channel.sendToSession({
        renderId: TEST_SESSION_ID,
        channel: 'feed',
        mode: 'append',
        payload: { i },
      });
    }

    // Reconnect from seq=0 → replay delivers seq 1,2.
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    await inbox.waitFor(3); // ack + 2 replay
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(3);
    const replayedSeqs = inbox.frames
      .slice(1)
      .map((m) => (m.type === 'data' ? m.payload.seq : -1));
    expect(replayedSeqs).toEqual([1, 2]);

    // NEW envelope after subscribe → live fan-out delivers once.
    // Subscriber's replayCompletedSeq is 2, so seq 3 is > that.
    await channel.sendToSession({
      renderId: TEST_SESSION_ID,
      channel: 'feed',
      mode: 'append',
      payload: { i: 3 },
    });
    await inbox.waitFor(4);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(4);
    const live = inbox.frames[3];
    expect(live.type).toBe('data');
    if (live.type === 'data') {
      expect(live.payload.seq).toBe(3);
      expect(live.payload.payload).toEqual({ i: 3 });
    }
    ws.close();
  });

  it('new subscriber joining mid-stream sees only future deliveries (not the existing ring)', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;
    // Prior traffic seeds the buffer.
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 1 } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 2 } });

    // Fresh subscribe → ack streamSeq=2, no replay.
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(undefined));
    await inbox.waitFor(1);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(1);
    const ack = inbox.frames[0];
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(2);
    }

    // New envelope → live fan-out reaches the fresh subscriber.
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 3 } });
    await inbox.waitFor(2);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(2);
    const live = inbox.frames[1];
    if (live.type === 'data') {
      expect(live.payload.seq).toBe(3);
    }
    ws.close();
  });

  it('monotonic seq across mixed fan-outs (validates cursor correctness under producer interleave)', async () => {
    const spec: StreamSpec = {
      feed: { schema: { type: 'object', additionalProperties: true }, replay: 'all' },
      snap: { schema: { type: 'object', additionalProperties: true }, replay: 'latest' },
    };
    fix = await boot({
      renderStore: makeSeededStore([makeStackItemWithStreamSpec(spec)]),
    });
    const channel = fix.server.sessionChannel!;

    // Interleaved producers — each envelope gets the next seq.
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 1 } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'snap', mode: 'replace', payload: { v: 'a' } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'feed', mode: 'append', payload: { i: 2 } });
    await channel.sendToSession({ renderId: TEST_SESSION_ID, channel: 'snap', mode: 'replace', payload: { v: 'b' } });

    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(0));
    // feed seq 1, 3; snap latest at seq 4. 3 frames + 1 ack = 4 total.
    await inbox.waitFor(4);
    await inbox.waitIdle(50);
    expect(inbox.frames).toHaveLength(4);
    const [ack, ...data] = inbox.frames;
    if (ack.type === 'ack') {
      expect(ack.payload.streamSeq).toBe(4);
    }
    const seqs = data.map((m) =>
      m.type === 'data' && m.payload.seq !== undefined ? m.payload.seq : -1,
    );
    expect(seqs).toEqual([1, 3, 4]);
    // Seq is strictly increasing.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────
// R7 — SessionEvent ledger replay via subscribe.sinceSequence
// ─────────────────────────────────────────────────────────────────────
//
// Distinct cursor model from `fromSeq` (per-stream-channel replay).
// Same ledger the HTTP `/api/renders/:id/events?sinceSequence=N`
// endpoint reads from; the WS path emits each ledger entry as a
// `session_event` wire frame BEFORE entering live-stream mode.
//
// Three cases:
//   - No sinceSequence (existing behavior): no SessionEvent frames.
//   - sinceSequence with available history: replay in order.
//   - sinceSequence past lastSequence: REPLAY_HORIZON_PASSED error.

describe("OSS /ws — SessionEvent ledger replay (R7 sinceSequence)", () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it("no sinceSequence — subscriber sees only ack, no session_event frames", async () => {
    const store = makeSeededStore([makeRender()]);
    // Seed two events directly via the store's appendEvent.
    await store.appendEvent({
      renderId: TEST_SESSION_ID,
      type: 'ui.created',
      data: { label: 'first' },
    });
    await store.appendEvent({
      renderId: TEST_SESSION_ID,
      type: 'ui.updated',
      data: { label: 'second' },
    });
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrame(undefined));
    await inbox.waitFor(1);
    await inbox.waitIdle(50);
    const sessionEvents = inbox.frames.filter(
      (f) => f.type === 'session_event',
    );
    expect(sessionEvents).toHaveLength(0);
    expect(inbox.frames[0]?.type).toBe('ack');
    ws.close();
  });

  it("sinceSequence=0 — subscriber gets full ledger replayed as session_event frames before live tail", async () => {
    const store = makeSeededStore([makeRender()]);
    await store.appendEvent({
      renderId: TEST_SESSION_ID,
      type: 'ui.created',
      data: { label: 'one' },
    });
    await store.appendEvent({
      renderId: TEST_SESSION_ID,
      type: 'ui.updated',
      data: { label: 'two' },
    });
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrameWithSinceSequence(0));
    await inbox.waitFor(3); // 1 ack + 2 session_event
    await inbox.waitIdle(50);
    expect(inbox.frames.length).toBeGreaterThanOrEqual(3);
    expect(inbox.frames[0]?.type).toBe('ack');
    const sessionEvents = inbox.frames.filter(
      (f) => f.type === 'session_event',
    );
    expect(sessionEvents).toHaveLength(2);
    const first = sessionEvents[0];
    const second = sessionEvents[1];
    if (first?.type === 'session_event' && second?.type === 'session_event') {
      expect(first.payload.sequence).toBe(1);
      expect(first.payload.type).toBe('ui.created');
      expect(second.payload.sequence).toBe(2);
      expect(second.payload.type).toBe('ui.updated');
    }
    ws.close();
  });

  it("sinceSequence=N — subscriber gets only events with seq > N", async () => {
    const store = makeSeededStore([makeRender()]);
    for (let i = 0; i < 4; i++) {
      await store.appendEvent({
        renderId: TEST_SESSION_ID,
        type: 'ui.created',
        data: { i },
      });
    }
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrameWithSinceSequence(2));
    await inbox.waitFor(3); // ack + 2 session_event
    await inbox.waitIdle(50);
    const sessionEvents = inbox.frames.filter(
      (f) => f.type === 'session_event',
    );
    expect(sessionEvents).toHaveLength(2);
    if (
      sessionEvents[0]?.type === 'session_event' &&
      sessionEvents[1]?.type === 'session_event'
    ) {
      expect(sessionEvents[0].payload.sequence).toBe(3);
      expect(sessionEvents[1].payload.sequence).toBe(4);
    }
    ws.close();
  });

  it("sinceSequence past lastSequence — emits REPLAY_HORIZON_PASSED error", async () => {
    const store = makeSeededStore([makeRender()]);
    await store.appendEvent({
      renderId: TEST_SESSION_ID,
      type: 'ui.created',
      data: { label: 'only' },
    });
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    const inbox = attachInbox(ws);
    sendMessage(ws, subscribeFrameWithSinceSequence(99));
    await inbox.waitFor(2); // ack + error
    await inbox.waitIdle(50);
    const errors = inbox.frames.filter((f) => f.type === 'error');
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (err?.type === 'error') {
      expect(err.payload.code).toBe('REPLAY_HORIZON_PASSED');
      // currentSequence carried in details for client recovery.
      const details = err.payload.details as
        | { currentSequence?: number }
        | undefined;
      expect(details?.currentSequence).toBe(1);
    }
    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Inbound ActionEnvelope — end-to-end
// ─────────────────────────────────────────────────────────────────────
//
// Canonical `type: 'action'` ingress, including renderId routing and
// cross-session spoof rejection. Shares enforcement helpers
// (assertEventAllowed, assertActionContract) with the hosted ingress.

function makeActionEnvelope(params: {
  type: EventType;
  payload?: JsonValue;
  renderId?: string;
  stackIndex?: number;
  renderId?: string;
}): WebSocketMessage & { type: 'action' } {
  const envelope: ActionEnvelope = {
    renderId: params.renderId ?? TEST_SESSION_ID,
    type: params.type,
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
    ...(params.stackIndex !== undefined ? { stackIndex: params.stackIndex } : {}),
    ...(params.renderId !== undefined ? { renderId: params.renderId } : {}),
  };
  return { type: 'action', payload: envelope, requestId: 'act-1' };
}

describe('createRenderChannelServer — inbound ActionEnvelope symmetry', () => {
  let fix: Fixture | null = null;

  beforeEach(async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it("accepts a valid 'action' envelope with a declared data:submit payload", async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws); // subscribe ack

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'hi' } },
      }),
    );
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.payload.sequence).toBeGreaterThan(0);
    }
    ws.close();
  });

  it("rejects an 'action' envelope whose type is not in the subscription allowlist", async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    // Stack item's subscription is ['data:submit', 'lifecycle:session_end'].
    // interaction:click is NOT in that list → EVENT_NOT_ALLOWED.
    sendMessage(ws, makeActionEnvelope({ type: 'interaction:click' }));
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('EVENT_NOT_ALLOWED');
      const details = err.payload.details as {
        error: string;
        eventType: string;
        allowedEvents: string[];
      };
      expect(details.eventType).toBe('interaction:click');
      expect(details.allowedEvents).toContain('data:submit');
    }
    ws.close();
  });

  it("rejects a data:submit 'action' envelope with an undeclared action id (CONTRACT_VIOLATION)", async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'deleteAccount', data: {} },
      }),
    );
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('CONTRACT_VIOLATION');
      const details = err.payload.details as { error: string; tool: string };
      expect(details.tool).toBe('ggui_event');
    }
    ws.close();
  });

  it("rejects an 'action' envelope whose envelope.renderId doesn't match (SESSION_MISMATCH)", async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'x' } },
        renderId: 'sess-OTHER',
      }),
    );
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('SESSION_MISMATCH');
    }
    ws.close();
  });

  it("rejects an 'action' envelope before any subscribe (NOT_SUBSCRIBED)", async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    // Skip subscribe; go straight to action.
    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'x' } },
      }),
    );
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('NOT_SUBSCRIBED');
    }
    ws.close();
  });

  it("routes contract lookup by renderId when present, falling back to stackIndex", async () => {
    // Custom server with two stack items. renderId='page-0' is the seeded
    // item; envelope with renderId targets it explicitly regardless of
    // stackIndex.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'via-renderId' } },
        renderId: 'page-0',
      }),
    );
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    ws.close();
  });

});

/**
 * End-to-end interactive data-contract proof — the "user submits, server
 * persists, agent pushes consequence, UI receives push" loop on a real
 * `createGguiServer` + real `ws` client.
 *
 * Each of the individual seams is already covered in dedicated tests
 * above:
 *
 *   - data:submit persistence + ack → `inbound ActionEnvelope symmetry`
 *   - contract validation (allowlist + payload) → same block
 *   - outbound `notifyStackPush` fanout → `notifyStackPush (B1)` block
 *
 * What this test adds is the COMPOSITION: all four steps run against a
 * single `createGguiServer` + a single open WebSocket, in the shape the
 * product actually uses at runtime. A future refactor that breaks any
 * ordering invariant between persistence, seq-monotonicity, and
 * outbound delivery on the same subscription flips this assertion even
 * when the individual-seam tests stay green.
 *
 * ## Why Lane 3 (vitest), not Lane 1 (browser)
 *
 *   - Lane 1 would require a stack item with a non-empty `componentCode`
 *     + `actionSpec` to reach the browser. On the current OSS path the
 *     only writer of `componentCode` is real LLM generation (BYOK),
 *     which is non-deterministic and lives in the advisory lane. A
 *     deterministic browser proof would need either a pre-baked "seed"
 *     admin endpoint or a test-only mcpMount with direct session-store
 *     access — both are feature infra, outside this slice.
 *   - Lane 3 exercises every real wire between the client action
 *     envelope and the consequence push. The only difference from the
 *     Lane-1 version is the renderer that would paint the new stack
 *     item in a browser. The renderer is covered by
 *     `packages/console/src/routes/StackSurface.test.tsx` (jsdom).
 *     Between the two, "user click → consequence rendered" is proven
 *     without requiring LLM or new feature seams.
 *
 * ## What this test does NOT prove
 *
 *   - Browser DOM re-render after the push. Covered by
 *     `StackSurface.test.tsx` ("hands off from provisional preview to
 *     final-render when componentCode flips non-empty").
 *   - Agent-side MCP observation of the submitted event. There is no
 *     `ggui_consume` handler on OSS today; the test driver plays the
 *     agent's role by holding a reference to the channel + session
 *     store. A real agent-observed loop would layer on top of this
 *     seam once consume lands.
 *   - Cache / generation behavior. Orthogonal to the contract wire.
 */
describe('createRenderChannelServer — interactive data-contract consequence loop', () => {
  let fix: Fixture | null = null;
  let store: RenderStore | null = null;

  beforeEach(async () => {
    // Keep a handle on the store so the test-driver-as-agent step can
    // inspect persistence directly (what `ggui_consume` would do in
    // production). `makeSeededStore` closes over its own internal state,
    // so holding the same reference the server holds is the way to see
    // `appendEvent` results.
    store = makeSeededStore([makeRender()]);
    fix = await boot({ renderStore: store });
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
    store = null;
  });

  it('composes submit → ack → consequence-push in one subscription', async () => {
    // Step 1 — subscriber (representing the browser viewer) connects,
    // subscribes, receives initial stack via ack.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    const subAck = await recvMessage(ws);
    expect(subAck.type).toBe('ack');
    if (subAck.type !== 'ack') throw new Error('unexpected subscribe response');
    expect(subAck.payload.stack?.length).toBe(1);
    expect(subAck.payload.stack?.[0].id).toBe('page-0');
    const initialSeq = subAck.payload.sequence;
    expect(initialSeq).toBe(0);

    // Step 2 — subscriber emits a declared data:submit envelope. This
    // is the wire shape a React `useAction('submit', data)` produces
    // via `GguiSession.dispatchAction`.
    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: { text: 'hello from user' } },
      }),
    );
    const submitAck = await recvMessage(ws);
    expect(submitAck.type).toBe('ack');
    if (submitAck.type !== 'ack') throw new Error('unexpected submit response');

    // Persistence proof: the envelope was appended to the session
    // store's event log, which bumped the server's monotonic sequence.
    // The ack MUST carry a seq > initialSeq — otherwise the server
    // silently dropped the envelope.
    expect(submitAck.payload.sequence).toBeGreaterThan(initialSeq);

    // Step 3 — test driver plays the agent: it reads what the user
    // submitted directly from the session store (a production agent
    // would use `ggui_consume`, not implemented on OSS yet — see block
    // header). The data MUST match what the client sent; anything else
    // would mean the contract-validated payload was mutated in flight.
    const storedSession = await store!.get(TEST_SESSION_ID);
    if (!storedSession) throw new Error('session should exist post-submit');
    expect(storedSession.eventSequence).toBe(submitAck.payload.sequence);

    // Step 4 — the agent appends a consequence stack item (a new UI
    // page that reflects what the user submitted), and announces the
    // delta to live subscribers via `channel.notifyStackPush`. This is
    // exactly the wire the push handler uses on B1 — the agent role
    // here calls it directly instead of routing through `ggui_push`
    // (which needs a generator/BYOK). The invariant is the same:
    // commit + notifyStackPush, in that order.
    const consequenceItem: Render = {
      id: 'page-consequence',
      componentCode: '/* consequence of user submission */',
      createdAt: new Date().toISOString(),
    };
    await store!.commit(TEST_SESSION_ID, consequenceItem);
    const channel = fix!.server.sessionChannel!;
    channel.notifyStackPush(TEST_SESSION_ID, consequenceItem);

    // Step 5 — the subscriber (client) receives the push frame with
    // the new stack item. This is the "consequence rendered" edge in
    // the product loop — the browser would swap its DOM at this
    // point; here we assert the wire frame carries everything the
    // renderer needs. If the earlier appendEvent had blocked the
    // notify or reordered delivery, this frame would be absent /
    // mis-shaped.
    const pushFrame = await recvMessage(ws);
    expect(pushFrame.type).toBe('push');
    if (pushFrame.type !== 'push') throw new Error('expected push frame');
    expect(pushFrame.payload.stackItem.id).toBe('page-consequence');
    const pushedItem = pushFrame.payload.stackItem;
    if (pushedItem.type === 'mcpApps' || pushedItem.type === 'system') {
      throw new Error('expected component stack item');
    }
    expect(pushedItem.componentCode).toBe(
      '/* consequence of user submission */',
    );
    // No matchType on this path — it's a cold consequence push, not a
    // cache-hit reuse. Pinning the absence catches a regression that
    // would silently tag user-driven pushes as 'cached'.
    expect(pushFrame.payload.matchType).toBeUndefined();

    ws.close();
  });

  it('enforces the contract before persistence — violating submit does NOT bump seq or trigger a consequence', async () => {
    // The symmetric negative: if contract validation rejects the
    // envelope, persistence must not happen and no consequence push
    // should be observable downstream. Pins the "validate-first"
    // ordering that keeps a bogus submit from polluting the event log.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    const subAck = await recvMessage(ws);
    if (subAck.type !== 'ack') throw new Error('unexpected subscribe response');
    expect(subAck.payload.sequence).toBe(0);

    // Undeclared action id → CONTRACT_VIOLATION before appendEvent.
    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'deleteAccount', data: {} },
      }),
    );
    const errFrame = await recvMessage(ws);
    expect(errFrame.type).toBe('error');
    if (errFrame.type === 'error') {
      expect(errFrame.payload.code).toBe('CONTRACT_VIOLATION');
    }

    // Load-bearing: the session's `eventSequence` MUST still be 0. If
    // the rejection path accidentally appends first, this flips.
    const storedSession = await store!.get(TEST_SESSION_ID);
    if (!storedSession) throw new Error('session should exist');
    expect(
      storedSession.eventSequence,
      'contract violation must reject before appendEvent — seq should not bump',
    ).toBe(0);

    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice 11.5 C2 — wiredActionRouter
// ─────────────────────────────────────────────────────────────────────
//
// The router fires declared `actionSpec[name].dispatch.tool` handlers
// (when `dispatch.kind === 'tool'`) after validation, refreshes every
// streamSpec channel with a `tool` hint, and emits canonical
// `_ggui:contract-error` envelopes on any failure mode. Covers the 7
// unit-test cases from the hardened plan
// (§C2). Each test stands up a narrow inline router so the failure
// mode under scrutiny is clean.

type RouterHandler = (
  input: Record<string, unknown>,
  ctx: import('./session-channel.js').WiredActionContext,
) => Promise<unknown>;

function makeRouter(
  handlers: Record<string, RouterHandler>,
): import('./session-channel.js').WiredActionRouter & {
  calls: Array<{
    tool: string;
    input: Record<string, unknown>;
    ctx: import('./session-channel.js').WiredActionContext;
  }>;
} {
  const calls: Array<{
    tool: string;
    input: Record<string, unknown>;
    ctx: import('./session-channel.js').WiredActionContext;
  }> = [];
  return {
    calls,
    has(toolName) {
      return Object.prototype.hasOwnProperty.call(handlers, toolName);
    },
    async invoke(toolName, input, ctx) {
      calls.push({ tool: toolName, input, ctx });
      const handler = handlers[toolName];
      if (!handler) {
        throw new Error(`router has no handler for ${toolName}`);
      }
      return handler(input, ctx);
    },
  };
}

/** Render with Todo-style wired action + refresh-stream hint. */
function makeWiredRender(): Render {
  const actionSpec: ActionSpec = {
    toggleTask: {
      label: 'Toggle task',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      nextStep: 'tasks_complete',
    },
  };
  const streamSpec: StreamSpec = {
    tasks: {
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['items'],
      },
      tool: 'tasks_list',
    },
  };
  return {
    id: 'page-wired',
    componentCode: '/* wired */',
    createdAt: new Date().toISOString(),
    subscription: { events: ['data:submit', 'lifecycle:session_end'] },
    actionSpec,
    streamSpec,
  };
}

function wiredActionEnvelope(data: Record<string, unknown>): WebSocketMessage & {
  type: 'action';
} {
  return makeActionEnvelope({
    type: 'data:submit',
    payload: {
      action: 'toggleTask',
      data,
      tool: 'tasks_complete',
    } as JsonValue,
  });
}

describe('createRenderChannelServer — wiredActionRouter', () => {
  let fix: Fixture | null = null;
  let queue: ReturnType<typeof makeMessageQueue> | null = null;

  afterEach(async () => {
    if (queue) {
      queue.close();
      queue = null;
    }
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  async function openSubscribed(
    bootOpts: Parameters<typeof boot>[0],
  ): Promise<{ ws: WebSocket; q: ReturnType<typeof makeMessageQueue> }> {
    fix = await boot(bootOpts);
    const ws = await connectAuthed(fix.wsUrl);
    const q = makeMessageQueue(ws);
    queue = q;
    sendMessage(ws, makeSubscribe());
    const subAck = await q.next();
    expect(subAck.type).toBe('ack');
    return { ws, q };
  }

  it('happy path — action tool runs, refresh tool runs, result emits on channel', async () => {
    const router = makeRouter({
      async tasks_complete(input) {
        expect(input).toEqual({ id: 'task-1' });
        return { ok: true };
      },
      async tasks_list() {
        return { items: [{ id: 'task-1', done: true }] };
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));

    const refresh = await q.next();
    expect(refresh.type).toBe('data');
    if (refresh.type === 'data') {
      expect(refresh.payload.channel).toBe('tasks');
      expect(refresh.payload.payload).toEqual({
        items: [{ id: 'task-1', done: true }],
      });
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');

    expect(router.calls.map((c) => c.tool)).toEqual([
      'tasks_complete',
      'tasks_list',
    ]);
    ws.close();
  });

  it('emits TOOL_NOT_FOUND when action.tool is undeclared on the router', async () => {
    const router = makeRouter({
      async tasks_list() {
        return { items: [] };
      },
      // tasks_complete deliberately absent
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));

    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('_ggui:contract-error');
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.toolName).toBe('tasks_complete');
      expect(body.actionName).toBe('toggleTask');
      expect(body.sourceAction?.type).toBe('wired-action');
      expect(body.error.code).toBe('TOOL_NOT_FOUND');
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');

    expect(router.calls.map((c) => c.tool)).not.toContain('tasks_complete');
    ws.close();
  });

  it('emits TOOL_THREW + session survives when the action tool throws', async () => {
    const router = makeRouter({
      async tasks_complete() {
        throw new Error('tasks_complete is intentionally broken');
      },
      async tasks_list() {
        throw new Error('refresh should NOT run after a failed action');
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('_ggui:contract-error');
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.toolName).toBe('tasks_complete');
      expect(body.error.code).toBe('TOOL_THREW');
      expect(body.error.message).toContain('intentionally broken');
      expect(body.error.causedBy).toContain('Error: tasks_complete');
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');

    // Refresh must NOT have fired.
    expect(router.calls.map((c) => c.tool)).toEqual(['tasks_complete']);

    // Session channel is still live — a follow-up action validates again.
    sendMessage(ws, makeActionEnvelope({ type: 'interaction:click' }));
    const afterErr = await q.next();
    expect(afterErr.type).toBe('error'); // per subscription allowlist
    ws.close();
  });

  it('default sanitizer redacts credential-shaped tokens in TOOL_THREW causedBy', async () => {
    // Build an error whose `.stack` contains patterns the default
    // sanitizer MUST redact. The fact that the session-channel router
    // wires the protocol's `sanitizeCausedBy` by default is the
    // load-bearing claim — raw stacks must never leak secret-shaped
    // substrings onto `_ggui:contract-error`, which persists on
    // `replay: 'all'` and is operator-visible.
    const secretMessage =
      'Auth failed with Bearer sk-ant-leak-12345 via https://api.example.com?token=leakme&page=2 AWS_SECRET_ACCESS_KEY=wJalrXUtnDONOTLEAK';
    const router = makeRouter({
      async tasks_complete() {
        throw new Error(secretMessage);
      },
      async tasks_list() {
        throw new Error('refresh should NOT run after a failed action');
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });
    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.error.code).toBe('TOOL_THREW');
      // The plaintext message STILL carries the raw error text — message
      // is author-intended surface and sanitizer scope is causedBy only.
      expect(body.error.message).toContain('Bearer sk-ant-leak-12345');
      // But the causedBy stack string must have each pattern redacted.
      const causedBy = body.error.causedBy ?? '';
      expect(causedBy).not.toContain('sk-ant-leak-12345');
      expect(causedBy).not.toContain('token=leakme');
      expect(causedBy).not.toContain('wJalrXUtnDONOTLEAK');
      expect(causedBy).toContain('[REDACTED]');
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    ws.close();
  });

  it('operator-supplied sanitizeCausedBy overrides the default', async () => {
    const router = makeRouter({
      async tasks_complete() {
        throw new Error('anything at all');
      },
      async tasks_list() {
        throw new Error('refresh should not run');
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
      // Replace with a sentinel-emitting sanitizer so the test can prove
      // the plumbing reached the emission site.
      sanitizeCausedBy: () => '<<sanitized-by-operator>>',
    });
    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.error.causedBy).toBe('<<sanitized-by-operator>>');
    }
    ws.close();
  });

  it('emits TOOL_TIMEOUT after the configured budget and continues', async () => {
    const router = makeRouter({
      async tasks_complete() {
        return new Promise(() => {});
      },
      async tasks_list() {
        throw new Error('should NOT reach refresh');
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
      wiredActionTimeoutMs: 40,
    });

    const t0 = Date.now();
    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    const elapsed = Date.now() - t0;
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('_ggui:contract-error');
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.error.code).toBe('TOOL_TIMEOUT');
      expect(body.error.message).toContain('40ms');
    }
    expect(elapsed).toBeLessThan(2000);

    const ack = await q.next();
    expect(ack.type).toBe('ack');
    ws.close();
  });

  it('refresh path — SCHEMA_VIOLATION when the refresh tool returns a shape violating streamSpec', async () => {
    const router = makeRouter({
      async tasks_complete() {
        return { ok: true };
      },
      async tasks_list() {
        return { wrong: 'shape' };
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('_ggui:contract-error');
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.toolName).toBe('tasks_list');
      expect(body.sourceAction?.type).toBe('refresh-stream');
      expect(body.error.code).toBe('SCHEMA_VIOLATION');
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    ws.close();
  });

  it('refresh path — TOOL_THREW preserves previous state (no channel emit) when refresh errors', async () => {
    const router = makeRouter({
      async tasks_complete() {
        return { ok: true };
      },
      async tasks_list() {
        throw new Error('refresh blew up');
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('_ggui:contract-error');
      const body = frame.payload.payload as unknown as ContractErrorPayload;
      expect(body.toolName).toBe('tasks_list');
      expect(body.sourceAction?.type).toBe('refresh-stream');
      expect(body.error.code).toBe('TOOL_THREW');
      expect(body.error.message).toContain('refresh blew up');
    }
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    ws.close();
  });

  it('concurrent dispatches — both execute and emit in order (no idempotency — honest non-goal)', async () => {
    let completeCalls = 0;
    const router = makeRouter({
      async tasks_complete() {
        completeCalls += 1;
        return { ok: true };
      },
      async tasks_list() {
        return { items: [{ id: 'task-1', done: completeCalls % 2 === 1 }] };
      },
    });
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));

    const frames: WebSocketMessage[] = [];
    for (let i = 0; i < 4; i += 1) frames.push(await q.next());

    const dataFrames = frames.filter((f) => f.type === 'data');
    const acks = frames.filter((f) => f.type === 'ack');
    expect(dataFrames.length).toBe(2);
    expect(acks.length).toBe(2);

    for (const f of dataFrames) {
      if (f.type === 'data') expect(f.payload.channel).toBe('tasks');
    }
    expect(completeCalls).toBe(2); // non-idempotency — intentional
    // Each dispatch fires complete + list exactly once, but back-to-back
    // WS messages start dispatching in parallel — the intra-dispatch
    // order is locked (complete before list) but the two dispatches
    // can interleave. Count is the load-bearing assertion, not order.
    const toolCounts: Record<string, number> = {};
    for (const call of router.calls) {
      toolCounts[call.tool] = (toolCounts[call.tool] ?? 0) + 1;
    }
    expect(toolCounts).toEqual({ tasks_complete: 2, tasks_list: 2 });
    ws.close();
  });

  it('no router configured — falls through with plain ack, no synthetic frames', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      // wiredActionRouter omitted
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') expect(ack.payload.sequence).toBeGreaterThan(0);
    ws.close();
  });

  it('no action.tool declared — router is a no-op even when present', async () => {
    const router = makeRouter({
      async tasks_complete() {
        throw new Error('should not run — action has no tool hint');
      },
    });
    const bareAction: Render = {
      id: 'page-bare',
      componentCode: '/* bare */',
      createdAt: new Date().toISOString(),
      subscription: { events: ['data:submit', 'lifecycle:session_end'] },
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: { type: 'object', additionalProperties: true },
        },
      },
    };
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([bareAction]),
      wiredActionRouter: router,
    });

    sendMessage(
      ws,
      makeActionEnvelope({
        type: 'data:submit',
        payload: { action: 'submit', data: {} } as JsonValue,
      }),
    );
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    expect(router.calls).toEqual([]);
    ws.close();
  });

  // ── C12 telemetry ─────────────────────────────────────────────────
  //
  // On successful wired-tool dispatch, the channel emits a
  // `wired-tool.invoked` TelemetryEvent on the shared TelemetrySink.
  // Distinct from the renderer's client-side ObservabilityEvent of
  // the same name — two independent signals, two consumers (backend
  // metrics vs host inspector UI). See C12 plan.

  it('emits wired-tool.invoked telemetry on successful dispatch', async () => {
    const router = makeRouter({
      async tasks_complete() {
        return { ok: true };
      },
      async tasks_list() {
        return { items: [] };
      },
    });
    const telemetry = new InMemoryTelemetrySink();
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
      telemetry,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));

    // Drain the refresh frame + ack the dispatch emits after telemetry.
    await q.next(); // refresh
    const ack = await q.next();
    expect(ack.type).toBe('ack');

    const events = telemetry
      .snapshot()
      .filter((e) => e.name === 'wired-tool.invoked');
    expect(events.length).toBe(1);
    const evt = events[0];
    expect(evt?.attributes?.toolName).toBe('tasks_complete');
    expect(evt?.attributes?.actionName).toBe('toggleTask');
    expect(typeof evt?.attributes?.renderId).toBe('string');
    // latencyMs MUST be a non-negative number (may be 0 on fast tools).
    expect(typeof evt?.attributes?.latencyMs).toBe('number');
    expect(
      (evt?.attributes?.latencyMs as number | undefined) ?? -1,
    ).toBeGreaterThanOrEqual(0);
    ws.close();
  });

  it('does NOT emit wired-tool.invoked telemetry when the dispatch fails', async () => {
    const router = makeRouter({
      async tasks_complete() {
        throw new Error('boom');
      },
    });
    const telemetry = new InMemoryTelemetrySink();
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
      telemetry,
    });

    sendMessage(ws, wiredActionEnvelope({ id: 'task-1' }));

    // Drain the contract-error emission + ack.
    const err = await q.next();
    expect(err.type).toBe('data');
    const ack = await q.next();
    expect(ack.type).toBe('ack');

    const events = telemetry
      .snapshot()
      .filter((e) => e.name === 'wired-tool.invoked');
    expect(events).toEqual([]);
    ws.close();
  });
});

describe('createRenderChannelServer — primeStreams (Gap 5 close-out)', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('invokes refresh tools + fans out + survives to a late subscriber when replay=latest', async () => {
    const router = makeRouter({
      async tasks_list() {
        return { items: [{ id: 'seed-1', done: false }] };
      },
    });
    // Channel declares replay:'latest' so the primed envelope stays in
    // the buffer for a subscriber that connects AFTER priming. With
    // the default 'none' policy the prime would fire + drop (fan-out
    // only — no storage), which is useless for the try-live flow where
    // the viewer navigates to the URL after the endpoint returns.
    const primedRender: Render = {
      id: 'page-primed',
      componentCode: '/* primed */',
      createdAt: new Date().toISOString(),
      subscription: { events: ['data:submit', 'lifecycle:session_end'] },
      streamSpec: {
        tasks: {
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
              },
            },
            required: ['items'],
          },
          tool: 'tasks_list',
          replay: 'latest',
        },
      },
    };
    fix = await boot({
      renderStore: makeSeededStore([primedRender]),
      wiredActionRouter: router,
    });
    const channel = fix.server.sessionChannel;
    if (!channel) throw new Error('sessionChannel should be present');

    // Prime the channel BEFORE any subscriber attaches. Because
    // replay: 'latest', the envelope stays in the buffer.
    await channel.primeStreams(TEST_SESSION_ID, primedRender);

    // Subscribe with `fromSeq: 0` so the server replays buffered
    // envelopes up to the current seq. This matches the semantics a
    // reconnecting SDK client uses to resume state.
    const ws = await connectAuthed(fix.wsUrl);
    const q = makeMessageQueue(ws);
    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        fromSeq: 0,
      } as SubscribePayload,
      requestId: 'sub-1',
    });
    const ack = await q.next();
    expect(ack.type).toBe('ack');
    const frame = await q.next();
    expect(frame.type).toBe('data');
    if (frame.type === 'data') {
      expect(frame.payload.channel).toBe('tasks');
      expect(frame.payload.payload).toEqual({
        items: [{ id: 'seed-1', done: false }],
      });
    }
    expect(router.calls.map((c) => c.tool)).toEqual(['tasks_list']);
    q.close();
    ws.close();
  });

  it('is a no-op when the stack item has no streamSpec', async () => {
    const router = makeRouter({
      async tasks_list() {
        throw new Error('MUST NOT be called — no streamSpec');
      },
    });
    fix = await boot({
      renderStore: makeSeededStore([makeRender()]),
      wiredActionRouter: router,
    });
    const channel = fix.server.sessionChannel;
    if (!channel) throw new Error('sessionChannel should be present');

    // makeRender() has no streamSpec — primeStreams MUST skip
    // entirely rather than call any router.
    await channel.primeStreams(TEST_SESSION_ID, makeRender());
    expect(router.calls).toEqual([]);
  });

  it('skips channels without a .tool hint + continues through siblings', async () => {
    const router = makeRouter({
      async tasks_list() {
        return { items: [] };
      },
    });
    const stackItem: Render = {
      id: 'multi-stream',
      componentCode: '/* */',
      createdAt: new Date().toISOString(),
      subscription: { events: ['data:submit', 'lifecycle:session_end'] },
      streamSpec: {
        tasks: {
          schema: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'object' } } },
            required: ['items'],
          },
          tool: 'tasks_list',
        },
        // Channel without a .tool — stays undeclared.
        ambient: {
          schema: { type: 'object', additionalProperties: true },
        },
      },
    };
    fix = await boot({
      renderStore: makeSeededStore([stackItem]),
      wiredActionRouter: router,
    });
    const channel = fix.server.sessionChannel;
    if (!channel) throw new Error('sessionChannel should be present');

    await channel.primeStreams(TEST_SESSION_ID, stackItem);

    // Only tasks_list was called — ambient has no .tool.
    expect(router.calls.map((c) => c.tool)).toEqual(['tasks_list']);
  });

  it('swallows refresh-tool failures per-channel without propagating', async () => {
    const router = makeRouter({
      async tasks_list() {
        throw new Error('refresh intentionally broken');
      },
    });
    fix = await boot({
      renderStore: makeSeededStore([makeWiredRender()]),
      wiredActionRouter: router,
    });
    const channel = fix.server.sessionChannel;
    if (!channel) throw new Error('sessionChannel should be present');

    // Must not throw — a broken refresh tool MUST NOT fail the whole
    // prime call (per-channel isolation).
    await expect(
      channel.primeStreams(TEST_SESSION_ID, makeWiredRender()),
    ).resolves.toBeUndefined();
    expect(router.calls.map((c) => c.tool)).toEqual(['tasks_list']);
  });
});

describe('createRenderChannelServer — protocol-version handshake (SPEC §11.2.2)', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('stamps AckPayload.serverVersion on every successful subscribe', async () => {
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, makeSubscribe());
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type !== 'ack') throw new Error('unexpected message');
    expect(ack.payload.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    ws.close();
  });

  it('subscribes normally when supportedVersions contains PROTOCOL_SCHEMA_VERSION', async () => {
    // Client declares the matching version → server acks + subscribe
    // completes; no error frame in between.
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        supportedVersions: [PROTOCOL_SCHEMA_VERSION, 'future-version-2'],
      } as SubscribePayload,
      requestId: 'sub-ok',
    });
    const first = await recvMessage(ws);
    expect(first.type).toBe('ack');
    if (first.type === 'ack') {
      expect(first.payload.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    }
    ws.close();
  });

  it('emits UPGRADE_REQUIRED error AND closes the connection when supportedVersions omits the server version (reject default)', async () => {
    // Phase 3.5 launch-cutover: versionPolicy defaults to 'reject'.
    // No `versionPolicy` option passed → mismatch emits UPGRADE_REQUIRED
    // AND tears down the WebSocket so a caller cannot accidentally
    // proceed against a version-mismatched session.
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const ws = await connectAuthed(fix.wsUrl);

    const closePromise = new Promise<void>((resolve) =>
      ws.once('close', () => resolve()),
    );

    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        supportedVersions: ['ancient-version-only'],
      } as SubscribePayload,
      requestId: 'sub-mismatch',
    });

    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('UPGRADE_REQUIRED');
      expect(err.payload.message).toContain(PROTOCOL_SCHEMA_VERSION);
      expect(err.requestId).toBe('sub-mismatch');
    }

    // Reject posture: the server closes the socket after emitting.
    // Race-safe — `closePromise` was registered before the subscribe.
    await closePromise;
  });

  it('keeps the connection open on mismatch when versionPolicy = "advisory" is explicitly opt-in', async () => {
    // Legacy opt-out posture for controlled migration windows.
    // Error frame emitted, socket stays open, subscribe stops
    // (no ack, no stack). Clients that ignore the error code
    // continue exactly as pre-handshake.
    fix = await boot({
      renderStore: makeSeededStore([makeRender()]),
      versionPolicy: 'advisory',
    });
    const ws = await connectAuthed(fix.wsUrl);

    // Hook a close listener to verify the advisory path does NOT
    // tear down the connection.
    let closed = false;
    ws.once('close', () => {
      closed = true;
    });

    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        supportedVersions: ['ancient-version-only'],
      } as SubscribePayload,
      requestId: 'sub-mismatch-advisory',
    });

    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('UPGRADE_REQUIRED');
    }

    // Advisory posture: connection kept open. Give the event loop a
    // tick to rule out a late 'close' event race — 50ms is enough
    // for any pending teardown in the same process.
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);

    ws.close();
  });

  it('treats an absent supportedVersions field as legacy-pass-through', async () => {
    // Clients that don't wire the handshake subscribe exactly as
    // pre-Phase-1 — no error, no special behavior. `serverVersion` is
    // still stamped on the ack (it's server-unconditional).
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        // NO supportedVersions — legacy payload shape
      } as SubscribePayload,
      requestId: 'sub-legacy',
    });
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.payload.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
      expect(ack.payload.stack?.length).toBe(1);
    }
    ws.close();
  });

  it('treats an empty supportedVersions array as legacy-pass-through', async () => {
    // Degenerate case: client sent an empty array (bug in client code
    // or a proxy that stripped the list). Server treats identically
    // to absent — policy is "opt in by listing something." Skips
    // the mismatch check so the subscribe proceeds.
    fix = await boot({ renderStore: makeSeededStore([makeRender()]) });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, {
      type: 'subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        role: 'user',
        supportedVersions: [],
      } as SubscribePayload,
      requestId: 'sub-empty',
    });
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.payload.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    }
    ws.close();
  });
});

// ─── EE+ 1b — channel_subscribe / channel_unsubscribe ──────────────────────

/**
 * Build a stack item carrying a `streamSpec[ticker].source.tool` so the
 * channel_subscribe handler has something concrete to resolve against.
 */
function makeSourceRender(opts: {
  channelName: string;
  toolName: string;
  args?: import('@ggui-ai/protocol').JsonObject;
}): Render {
  return {
    id: 'page-source',
    componentCode: '/* source-fed */',
    createdAt: new Date().toISOString(),
    subscription: { events: ['data:submit', 'lifecycle:session_end'] },
    streamSpec: {
      [opts.channelName]: {
        schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
        source: {
          tool: opts.toolName,
          ...(opts.args ? { args: opts.args } : {}),
        },
      },
    },
  };
}

describe('createRenderChannelServer — channel_subscribe (EE+ 1b)', () => {
  let fix: Fixture | null = null;
  let queue: ReturnType<typeof makeMessageQueue> | null = null;

  afterEach(async () => {
    if (queue) {
      queue.close();
      queue = null;
    }
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  async function openSubscribed(
    bootOpts: Parameters<typeof boot>[0],
  ): Promise<{ ws: WebSocket; q: ReturnType<typeof makeMessageQueue> }> {
    fix = await boot(bootOpts);
    const ws = await connectAuthed(fix.wsUrl);
    const q = makeMessageQueue(ws);
    queue = q;
    sendMessage(ws, makeSubscribe());
    const subAck = await q.next();
    expect(subAck.type).toBe('ack');
    return { ws, q };
  }

  it('emits channel_payload frames at the clamped poll cadence when source.tool is in the allowlist', async () => {
    let invocations = 0;
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
          args: { symbol: 'ACME' },
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke(name, input) {
          invocations += 1;
          expect(name).toBe('ticker_now');
          expect(input).toEqual({ symbol: 'ACME' });
          return { value: invocations };
        },
        // Use a tiny floor + default so the test runs quickly. Clamp
        // floor down to 50 to allow client-supplied small intervals.
        pollCadence: { floorMs: 50, ceilingMs: 60_000, defaultMs: 10_000 },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
        pollIntervalMs: 50,
      },
      requestId: 'sub-ticker',
    });

    // First emission is the eager-poll (immediate).
    const first = await q.next();
    expect(first.type).toBe('channel_payload');
    if (first.type === 'channel_payload') {
      expect(first.payload.channelName).toBe('ticker');
      expect(first.payload.renderId).toBe('page-source');
      expect(first.payload.seq).toBe(1);
      expect(first.payload.mode).toBe('replace');
      expect(first.payload.payload).toEqual({ value: 1 });
    }

    // Subsequent emission via the interval — give ourselves 1.5x the
    // 50ms poll cadence (75ms) plus event-loop scheduling slack.
    const second = await q.next();
    expect(second.type).toBe('channel_payload');
    if (second.type === 'channel_payload') {
      expect(second.payload.seq).toBe(2);
      expect(second.payload.payload).toEqual({ value: 2 });
    }

    ws.close();
  });

  it('rejects with CHANNEL_NOT_LOCAL when source.tool is not in the allowlist', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'unknown_tool',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          throw new Error('invoke should not run for disallowed tools');
        },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
      },
      requestId: 'sub-disallowed',
    });

    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('CHANNEL_NOT_LOCAL');
      expect(err.payload.channelName).toBe('ticker');
      expect(err.requestId).toBe('sub-disallowed');
    }
    ws.close();
  });

  it('rejects with CHANNEL_NOT_LOCAL when streamWebSocketLocalTools is unconfigured (OSS first-run path)', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      // NO streamWebSocketLocalTools — universal iframe-polling fallback
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
      },
      requestId: 'sub-no-allowlist',
    });

    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('CHANNEL_NOT_LOCAL');
    }
    ws.close();
  });

  it('rejects with CHANNEL_UNKNOWN when the channel is absent from streamSpec', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          return { value: 0 };
        },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'nonexistent',
      },
      requestId: 'sub-unknown',
    });

    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('CHANNEL_UNKNOWN');
      expect(err.payload.channelName).toBe('nonexistent');
    }
    ws.close();
  });

  it('rejects with STACK_ITEM_NOT_FOUND when the stack item is absent', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          return { value: 0 };
        },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-does-not-exist',
        channelName: 'ticker',
      },
      requestId: 'sub-no-stack-item',
    });

    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('STACK_ITEM_NOT_FOUND');
    }
    ws.close();
  });

  it('rejects with SUBSCRIBE_UNAUTHORIZED when payload.renderId does not match the bound subscriber session', async () => {
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          return { value: 0 };
        },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: 'sess-other',
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
      },
      requestId: 'sub-spoofed',
    });

    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('SUBSCRIBE_UNAUTHORIZED');
    }
    ws.close();
  });

  it('emits channel_error{POLL_FAILED} on tool throw but keeps the polling loop alive', async () => {
    let calls = 0;
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          calls += 1;
          if (calls === 1) throw new Error('transient outage');
          return { value: calls };
        },
        pollCadence: { floorMs: 50, ceilingMs: 60_000, defaultMs: 50 },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
        pollIntervalMs: 50,
      },
      requestId: 'sub-poll-fail',
    });

    // First emission is the failed poll → channel_error.
    const err = await q.next();
    expect(err.type).toBe('channel_error');
    if (err.type === 'channel_error') {
      expect(err.payload.code).toBe('POLL_FAILED');
      expect(err.payload.message).toContain('transient outage');
    }

    // Loop must NOT have been canceled — the next poll emits a payload.
    const ok = await q.next();
    expect(ok.type).toBe('channel_payload');
    if (ok.type === 'channel_payload') {
      expect(ok.payload.payload).toEqual({ value: 2 });
    }

    ws.close();
  });

  it('idempotent re-subscribe replaces the existing interval on the same channelKey', async () => {
    let calls = 0;
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          calls += 1;
          return { value: calls };
        },
        // High cadence so re-subscribe wins quickly without waiting an
        // interval tick from the prior subscribe.
        pollCadence: { floorMs: 50, ceilingMs: 60_000, defaultMs: 5_000 },
      },
    });

    // First subscribe — accept eager-poll #1 (seq=1).
    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
      },
      requestId: 'sub-1',
    });
    const first = await q.next();
    expect(first.type).toBe('channel_payload');
    if (first.type === 'channel_payload') {
      expect(first.payload.seq).toBe(1);
    }

    // Re-subscribe on the same key with a smaller interval — server
    // should clear the old timer and mint a fresh state (seq reset
    // to 0, then eager-poll bumps to 1).
    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
        pollIntervalMs: 50,
      },
      requestId: 'sub-2',
    });

    const second = await q.next();
    expect(second.type).toBe('channel_payload');
    if (second.type === 'channel_payload') {
      // Fresh seq counter on re-subscribe.
      expect(second.payload.seq).toBe(1);
    }
    ws.close();
  });

  it('channel_unsubscribe stops payload emission for the targeted channel', async () => {
    let calls = 0;
    const { ws, q } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          calls += 1;
          return { value: calls };
        },
        pollCadence: { floorMs: 50, ceilingMs: 60_000, defaultMs: 50 },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
        pollIntervalMs: 50,
      },
      requestId: 'sub-stop',
    });

    // Eager poll.
    const eager = await q.next();
    expect(eager.type).toBe('channel_payload');

    sendMessage(ws, {
      type: 'channel_unsubscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
      },
    });

    // Wait long enough for at least one more interval to have fired
    // had the unsubscribe not landed. Then assert no more payloads.
    await new Promise((r) => setTimeout(r, 200));
    const callsAfterUnsubscribe = calls;
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(callsAfterUnsubscribe);
    ws.close();
  });

  it('WS close tears down all channel subscriptions', async () => {
    let calls = 0;
    const { ws } = await openSubscribed({
      renderStore: makeSeededStore([
        makeSourceRender({
          channelName: 'ticker',
          toolName: 'ticker_now',
        }),
      ]),
      streamWebSocketLocalTools: {
        allowlist: ['ticker_now'],
        async invoke() {
          calls += 1;
          return { value: calls };
        },
        pollCadence: { floorMs: 50, ceilingMs: 60_000, defaultMs: 50 },
      },
    });

    sendMessage(ws, {
      type: 'channel_subscribe',
      payload: {
        renderId: TEST_SESSION_ID,
        appId: TEST_APP_ID,
        renderId: 'page-source',
        channelName: 'ticker',
        pollIntervalMs: 50,
      },
    });

    // Let one interval fire to confirm the subscription is live.
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBeGreaterThan(0);

    // Close the WS — the unregister hook should clearInterval the
    // polling loop. Subsequent invocations would be zombie-timer
    // bookkeeping we explicitly guard against.
    const callsAtClose = calls;
    ws.close();
    // Settle the close handler.
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));

    // Wait long enough that another poll would have fired had the
    // teardown failed. No new calls.
    await new Promise((r) => setTimeout(r, 250));
    // Allow for one in-flight invocation that started before close
    // (it could still complete + invoke() once). Cap at +1 over
    // callsAtClose to detect a runaway loop without flaking on the
    // race window.
    expect(calls).toBeLessThanOrEqual(callsAtClose + 1);
  });
});

// Integration 3 (canvasLoaded subscribe-flip) retired in the
// displayMode-unification slice. There is no longer a `canvasLoaded`
// signal — every subscribe is just a subscribe. The mechanism that
// gated push.ts's per-call resourceUri omission on `canvasOwnsRender`
// has been deleted; every push now stamps its resourceUri regardless
// of how the host presents the iframe.

describe('createRenderChannelServer — Integration 5 canvas_navigated', () => {
  let fix: Fixture | null = null;

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('updates activeStackItemId on canvas_navigated (forward)', async () => {
    const store = makeSeededStore([makeRender()]);
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(ws, {
      type: 'canvas_navigated',
      payload: {
        renderId: TEST_SESSION_ID,
        previousActiveItemId: null,
        activeItemId: 'page-1',
      },
    });
    // Drain a tick for the async handler to commit.
    await new Promise((r) => setTimeout(r, 50));
    const after = await store.get(TEST_SESSION_ID);
    expect(after?.activeStackItemId).toBe('page-1');
    ws.close();
  });

  it('clears activeStackItemId when navigation pops to empty', async () => {
    const store = makeSeededStore([makeRender()]);
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    // First navigate to set the active item.
    sendMessage(ws, {
      type: 'canvas_navigated',
      payload: {
        renderId: TEST_SESSION_ID,
        previousActiveItemId: null,
        activeItemId: 'page-1',
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    // Then pop to empty.
    sendMessage(ws, {
      type: 'canvas_navigated',
      payload: {
        renderId: TEST_SESSION_ID,
        previousActiveItemId: 'page-1',
        activeItemId: null,
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const after = await store.get(TEST_SESSION_ID);
    expect(after?.activeStackItemId).toBeUndefined();
    ws.close();
  });

  it('rejects cross-tenant canvas_navigated with SESSION_MISMATCH', async () => {
    const store = makeSeededStore([makeRender()]);
    fix = await boot({ renderStore: store });
    const ws = await connectAuthed(fix.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws);

    sendMessage(ws, {
      type: 'canvas_navigated',
      payload: {
        renderId: 'someone-elses-session',
        previousActiveItemId: null,
        activeItemId: 'page-1',
      },
    });
    const err = await recvMessage(ws);
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.payload.code).toBe('SESSION_MISMATCH');
    }
    ws.close();
  });
});
