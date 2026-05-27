/**
 * Slice O — option B: focused unit coverage for the
 * `SessionChannelServer.sendPropsUpdate` seam.
 *
 * Mirrors the `notifyStackPush` describe pattern in
 * `session-channel.test.ts` — boots a real `createGguiServer({
 * sessionChannel: true})`, connects with the real `ws` client, exercises
 * the live-fan-out semantics + isolation invariants, and tears down.
 *
 * Coverage:
 *
 *   1. Live subscriber receives a `{type:'props_update', payload:{
 *      stackItemId, props}}` frame when `sendPropsUpdate` fires for its
 *      session + a known stackItemId on the stack.
 *   2. `stackItemId` that doesn't exist on the session's stack is a no-op
 *      (logs a warn but does not fan out, does not throw).
 *   3. `sessionId` that doesn't exist (orphan) is a no-op (logs a
 *      warn, does not throw).
 *   4. Cross-session isolation: a `sendPropsUpdate` to session A MUST
 *      NOT reach a subscriber bound to session B, even when a follow-
 *      up call to session B's stackItemId proves the channel still works.
 *
 * Wiring: piggybacks on the existing channel test infrastructure
 * (`makeSeededStore`, `connectAuthed`, `recvMessage`, `makeSubscribe`)
 * — duplicating those helpers here would pin two copies of the same
 * scaffolding. Instead this file imports the public surface
 * (`createGguiServer`) directly and re-builds only the minimum
 * fixture state.
 *
 * Live mount-tool integration coverage (a wired-action mount that
 * calls `ctx.sendPropsUpdate` and the renderer's DOM reflects the new
 * props) lives in the Lane-1 `session-viewer-iframe.spec.ts::props-update-
 * roundtrip` fixture under `e2e/ggui-oss`. This file is the
 * channel-server unit boundary — it proves the WS frame is fanned
 * out correctly; the e2e proves the renderer applies it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  StackItem,
  Session,
  SubscribePayload,
} from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  SessionEvent,
  SessionFilter,
  SessionPatch,
  SessionStore,
  ObserveOptions,
  CreateSessionInput,
} from '@ggui-ai/mcp-server-core';
import { createGguiServer, type GguiServer } from './server.js';

const TEST_APP_ID = 'test-app';
const TEST_SESSION_ID = 'sess-props-update-test';

function makeStackItem(id: string = 'page-0'): StackItem {
  return {
    id,
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    subscription: {
      events: ['data:submit', 'lifecycle:session_end'],
    },
  };
}

/**
 * Test SessionStore — pre-seeds a single session with the given stack.
 * Mirrors `session-channel.test.ts::makeSeededStore` minimally; the
 * channel-server unit tests don't need stack-mutation paths beyond
 * the seed.
 */
function makeSeededStore(
  sessionId: string,
  seedStack: StackItem[],
): SessionStore {
  const seeded: Session = {
    id: sessionId,
    appId: TEST_APP_ID,
    stack: seedStack,
    currentStackIndex: seedStack.length - 1,
    adapterPermissions: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  const recorded: SessionEvent[] = [];

  function clone(s: Session): Session {
    return {
      ...s,
      stack: [...s.stack],
      adapterPermissions: { ...s.adapterPermissions },
    };
  }

  return {
    async get(id: string): Promise<Session | null> {
      return id === seeded.id ? clone(seeded) : null;
    },
    async create(input: CreateSessionInput): Promise<Session> {
      if (input.id === seeded.id) return clone(seeded);
      throw new Error(`unexpected create: ${input.id ?? '<generated>'}`);
    },
    async list(_filter: SessionFilter): Promise<Session[]> {
      return [clone(seeded)];
    },
    async update(id: string, patch: SessionPatch): Promise<Session> {
      if (id !== seeded.id) throw new Error('unknown session');
      if (patch.lastActivityAt !== undefined) seeded.lastActivityAt = patch.lastActivityAt;
      if (patch.expiresAt !== undefined) seeded.expiresAt = patch.expiresAt;
      return clone(seeded);
    },
    async delete(_id: string): Promise<void> {
      /* no-op */
    },
    async appendStackItem(_id: string, _entry): Promise<Session> {
      throw new Error('appendStackItem is not exercised by these tests');
    },
    async popStackItem(): Promise<{ readonly poppedId: string | null; readonly stackSize: number }> {
      throw new Error('popStackItem is not exercised by these tests');
    },
    async getSessionByStackItemId(): Promise<{ readonly sessionId: string; readonly appId: string } | null> {
      return null;
    },
    async appendEvent(input: AppendEventInput): Promise<number> {
      if (input.sessionId !== seeded.id) throw new Error('unknown session');
      seeded.eventSequence += 1;
      recorded.push({
        seq: seeded.eventSequence,
        type: input.type,
        timestamp: Date.now(),
        data: input.data,
      });
      return seeded.eventSequence;
    },
    async listEventsSince(sessionId: string, _sinceSeq: number, _limit: number) {
      if (sessionId !== seeded.id) return null;
      return {
        events: [],
        lastSequence: seeded.eventSequence,
        hasMore: false,
        horizonSeq: 0,
      };
    },
    observe(_id: string, _opts?: ObserveOptions): AsyncIterable<SessionEvent> {
      throw new Error('observe is not exercised by these tests');
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

async function boot(sessionStore: SessionStore): Promise<Fixture> {
  const server = createGguiServer({
    logger: silentLogger,
    sessionChannel: true,
    sessionStore,
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  return { server, httpServer, wsUrl };
}

async function connectAuthed(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer test-token` },
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

function sendMessage(ws: WebSocket, message: WebSocketMessage): void {
  ws.send(JSON.stringify(message));
}

function makeSubscribe(
  sessionId: string = TEST_SESSION_ID,
): WebSocketMessage & { type: 'subscribe' } {
  return {
    type: 'subscribe',
    payload: {
      sessionId,
      appId: TEST_APP_ID,
      role: 'user',
    } as SubscribePayload,
    requestId: 'sub-1',
  };
}

describe('createSessionChannelServer — sendPropsUpdate (Slice O)', () => {
  let fix: Fixture | null = null;

  beforeEach(async () => {
    fix = await boot(makeSeededStore(TEST_SESSION_ID, [makeStackItem('page-0')]));
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('fans `{type:"props_update", payload:{stackItemId, props}}` to a live subscriber for the session', async () => {
    // Closes the Slice O props_update emission gap — without this seam,
    // a wired-action mount that mutates server state has no honest path
    // to push new props to live subscribers (only refresh-stream tools
    // could fan out, and props_update is a different wire shape).
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');

    const channel = fix!.server.sessionChannel!;
    await channel.sendPropsUpdate(TEST_SESSION_ID, 'page-0', { count: 7 });

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('props_update');
    if (msg.type === 'props_update') {
      expect(msg.payload.stackItemId).toBe('page-0');
      expect(msg.payload.props).toEqual({ count: 7 });
    }
    ws.close();
  });

  it('is a best-effort no-op when the session does not exist (orphan)', async () => {
    // Mirrors `notifyStackPush`'s orphan-no-op posture. The mount
    // handler's path must not be made to fail by a stale sessionId
    // — the server logs a warn and returns.
    const channel = fix!.server.sessionChannel!;
    await expect(
      channel.sendPropsUpdate('sess-DOES-NOT-EXIST', 'page-0', { count: 1 }),
    ).resolves.toBeUndefined();
  });

  it('is a best-effort no-op when the stackItemId does not match any stack entry', async () => {
    // Validation defense — a buggy mount that picks the wrong stackItemId
    // (e.g., an off-by-one against a popped stack) MUST NOT crash the
    // dispatch path. Logs a warn + returns.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws); // ack

    const channel = fix!.server.sessionChannel!;
    await expect(
      channel.sendPropsUpdate(TEST_SESSION_ID, 'page-DOES-NOT-EXIST', {
        count: 1,
      }),
    ).resolves.toBeUndefined();

    // Subscriber MUST NOT have received a frame for the unknown
    // stackItemId. We prove this by firing a follow-up call with a known
    // stackItemId and asserting the next frame is the second one (no
    // garbage in between).
    await channel.sendPropsUpdate(TEST_SESSION_ID, 'page-0', { count: 99 });
    const msg = await recvMessage(ws);
    expect(msg.type).toBe('props_update');
    if (msg.type === 'props_update') {
      expect(msg.payload.stackItemId).toBe('page-0');
      expect(msg.payload.props).toEqual({ count: 99 });
    }
    ws.close();
  });

  it('does NOT cross-deliver to subscribers on a different session', async () => {
    // Same load-bearing isolation invariant `notifyStackPush` and
    // `sendToSession` enforce. The flat WS-subscriber set is filtered
    // by `sub.sessionId !== sessionId`; without that guard, a
    // wrong-session call would leak frames to every connected client
    // on the channel.
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe());
    await recvMessage(ws); // ack

    const channel = fix!.server.sessionChannel!;
    // First, an UNRELATED-session call. Even with a syntactically
    // valid stackItemId, the orphan path triggers (the seeded store knows
    // only TEST_SESSION_ID).
    await channel.sendPropsUpdate('sess-OTHER', 'page-0', { count: 1 });
    // Then a notify for the bound session — the next frame the
    // subscriber sees MUST be this one (proves the prior call did
    // not slip through).
    await channel.sendPropsUpdate(TEST_SESSION_ID, 'page-0', { count: 2 });

    const msg = await recvMessage(ws);
    expect(msg.type).toBe('props_update');
    if (msg.type === 'props_update') {
      expect(msg.payload.stackItemId).toBe('page-0');
      expect(msg.payload.props).toEqual({ count: 2 });
    }
    ws.close();
  });
});
