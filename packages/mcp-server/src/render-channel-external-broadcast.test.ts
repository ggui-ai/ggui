/**
 * Focused unit coverage for the
 * {@link RenderChannelServer.externalBroadcast} seam +
 * {@link RenderChannelOptions.onFirstSubscriber} /
 * `onLastSubscriberGone` hooks introduced for WS broadcast Phase 1A
 * (cross-pod broadcast via Redis pubsub).
 *
 * Coverage:
 *
 *   1. `externalBroadcast(renderId, frame)` fans the frame to a live
 *      subscriber bound to `renderId` AND skips replay/RenderStore
 *      lookups (the publisher already validated).
 *   2. Cross-session isolation: an `externalBroadcast` to session A
 *      MUST NOT reach a subscriber on session B.
 *   3. `externalBroadcast` is a no-op when no local subscriber matches
 *      the renderId.
 *   4. `onFirstSubscriber` fires synchronously on the 0 → 1 transition;
 *      a second subscriber for the SAME renderId does NOT re-fire.
 *   5. `onLastSubscriberGone` fires synchronously on the 1 → 0
 *      transition; a partial close (one of two subs leaving) does NOT
 *      fire.
 *
 * Test infra mirrors `session-channel-props-update.test.ts` — same
 * makeSeededStore + connectAuthed + recvMessage helpers, no
 * cross-file plumbing. Cross-pod fan-out itself (the Redis layer that
 * delivers a broadcast across pod processes) is exercised at the
 * cloud-pod adapter layer; this file is the OSS seam boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  Render,
  Session,
  SubscribePayload,
} from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  SessionEvent,
  SessionFilter,
  SessionPatch,
  RenderStore,
  ObserveOptions,
  CreateSessionInput,
} from '@ggui-ai/mcp-server-core';
import { createGguiServer, type GguiServer } from './server.js';

const TEST_APP_ID = 'test-app';
const SESSION_A = 'sess-broadcast-a';
const SESSION_B = 'sess-broadcast-b';

function makeRender(id: string = 'page-0'): Render {
  return {
    id,
    componentCode: '/* stub */',
    createdAt: new Date().toISOString(),
    subscription: {
      events: ['data:submit', 'lifecycle:session_end'],
    },
  };
}

function makeMultiRenderStore(sessionIds: readonly string[]): RenderStore {
  const seededById = new Map<string, Session>();
  for (const id of sessionIds) {
    seededById.set(id, {
      id,
      appId: TEST_APP_ID,
      stack: [makeRender('page-0')],
      currentStackIndex: 0,
      adapterPermissions: {},
      eventSequence: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
  }

  function clone(s: Session): Session {
    return {
      ...s,
      stack: [...s.stack],
      adapterPermissions: { ...s.adapterPermissions },
    };
  }

  return {
    async get(id: string): Promise<Session | null> {
      const found = seededById.get(id);
      return found ? clone(found) : null;
    },
    async create(input: CreateSessionInput): Promise<Session> {
      const found = input.id ? seededById.get(input.id) : null;
      if (found) return clone(found);
      throw new Error(`unexpected create: ${input.id ?? '<generated>'}`);
    },
    async list(_filter: SessionFilter): Promise<Session[]> {
      return Array.from(seededById.values(), clone);
    },
    async update(id: string, patch: SessionPatch): Promise<Session> {
      const found = seededById.get(id);
      if (!found) throw new Error('unknown session');
      if (patch.lastActivityAt !== undefined) found.lastActivityAt = patch.lastActivityAt;
      if (patch.expiresAt !== undefined) found.expiresAt = patch.expiresAt;
      return clone(found);
    },
    async delete(_id: string): Promise<void> {
      /* no-op */
    },
    async commit(_id, _entry): Promise<Session> {
      throw new Error('commit is not exercised by these tests');
    },
    async popRender(): Promise<{ readonly poppedId: string | null; readonly stackSize: number }> {
      throw new Error('popRender is not exercised by these tests');
    },
    async getSessionByStackItemId(): Promise<{ readonly renderId: string; readonly appId: string } | null> {
      return null;
    },
    async appendEvent(input: AppendEventInput): Promise<number> {
      const found = seededById.get(input.renderId);
      if (!found) throw new Error('unknown session');
      found.eventSequence += 1;
      const ev: SessionEvent = {
        seq: found.eventSequence,
        type: input.type,
        timestamp: Date.now(),
        data: input.data,
      };
      // hold the reference so TS doesn't drop it
      void ev;
      return found.eventSequence;
    },
    async listEventsSince(renderId: string, _sinceSeq: number, _limit: number) {
      const found = seededById.get(renderId);
      if (!found) return null;
      return {
        events: [],
        lastSequence: found.eventSequence,
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
  onFirst: Array<string>;
  onLast: Array<string>;
}

async function boot(renderStore: RenderStore): Promise<Fixture> {
  const onFirst: Array<string> = [];
  const onLast: Array<string> = [];
  const server = createGguiServer({
    logger: silentLogger,
    sessionChannel: true,
    renderStore,
    onFirstSubscriber: (renderId) => {
      onFirst.push(renderId);
    },
    onLastSubscriberGone: (renderId) => {
      onLast.push(renderId);
    },
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  return { server, httpServer, wsUrl, onFirst, onLast };
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

function makeSubscribe(renderId: string): WebSocketMessage & { type: 'subscribe' } {
  return {
    type: 'subscribe',
    payload: {
      renderId,
      appId: TEST_APP_ID,
      role: 'user',
    } as SubscribePayload,
    requestId: `sub-${renderId}`,
  };
}

/** Wait for a WS close from the server's side (used after ws.close()). */
async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
  });
}

describe('RenderChannelServer — externalBroadcast + subscription hooks', () => {
  let fix: Fixture | null = null;

  beforeEach(async () => {
    fix = await boot(makeMultiRenderStore([SESSION_A, SESSION_B]));
  });

  afterEach(async () => {
    if (fix) {
      await fix.server.close();
      fix = null;
    }
  });

  it('fans a server frame to a live subscriber for the session', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe(SESSION_A));
    const ack = await recvMessage(ws);
    expect(ack.type).toBe('ack');

    fix!.server.sessionChannel!.externalBroadcast(SESSION_A, {
      type: 'props_update',
      payload: { renderId: 'page-0', props: { count: 42 } },
    });

    const frame = await recvMessage(ws);
    expect(frame.type).toBe('props_update');
    if (frame.type === 'props_update') {
      expect(frame.payload.renderId).toBe('page-0');
      expect(frame.payload.props).toEqual({ count: 42 });
    }
    ws.close();
    await waitForClose(ws);
  });

  it('does not deliver to subscribers on a different session', async () => {
    const ws = await connectAuthed(fix!.wsUrl);
    sendMessage(ws, makeSubscribe(SESSION_A));
    await recvMessage(ws); // ack

    // Broadcast to OTHER session — must not reach this subscriber.
    fix!.server.sessionChannel!.externalBroadcast(SESSION_B, {
      type: 'props_update',
      payload: { renderId: 'page-0', props: { count: 1 } },
    });
    // Follow-up to the bound session — that one must arrive next.
    fix!.server.sessionChannel!.externalBroadcast(SESSION_A, {
      type: 'props_update',
      payload: { renderId: 'page-0', props: { count: 2 } },
    });

    const frame = await recvMessage(ws);
    expect(frame.type).toBe('props_update');
    if (frame.type === 'props_update') {
      // Proves the cross-session frame did not slip through.
      expect(frame.payload.props).toEqual({ count: 2 });
    }
    ws.close();
    await waitForClose(ws);
  });

  it('is a no-op when no local subscriber is bound to renderId', () => {
    // No subscribers at all yet — does not throw, returns void.
    expect(() =>
      fix!.server.sessionChannel!.externalBroadcast(SESSION_A, {
        type: 'props_update',
        payload: { renderId: 'page-0', props: { count: 0 } },
      }),
    ).not.toThrow();
  });

  it('fires onFirstSubscriber on the 0 → 1 transition, suppresses on 1 → 2', async () => {
    const ws1 = await connectAuthed(fix!.wsUrl);
    sendMessage(ws1, makeSubscribe(SESSION_A));
    await recvMessage(ws1); // ack

    expect(fix!.onFirst).toEqual([SESSION_A]);

    const ws2 = await connectAuthed(fix!.wsUrl);
    sendMessage(ws2, makeSubscribe(SESSION_A));
    await recvMessage(ws2); // ack

    // 1 → 2 transition does NOT re-fire onFirstSubscriber.
    expect(fix!.onFirst).toEqual([SESSION_A]);

    ws1.close();
    ws2.close();
    await waitForClose(ws1);
    await waitForClose(ws2);
  });

  it('fires onLastSubscriberGone only on the 1 → 0 transition', async () => {
    const ws1 = await connectAuthed(fix!.wsUrl);
    sendMessage(ws1, makeSubscribe(SESSION_A));
    await recvMessage(ws1); // ack

    const ws2 = await connectAuthed(fix!.wsUrl);
    sendMessage(ws2, makeSubscribe(SESSION_A));
    await recvMessage(ws2); // ack

    // First close — count drops 2 → 1, hook MUST NOT fire.
    ws1.close();
    await waitForClose(ws1);
    // Server-side unregister is synchronous on the 'close' event, but
    // give the event loop one tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(fix!.onLast).toEqual([]);

    // Second close — count drops 1 → 0, hook MUST fire.
    ws2.close();
    await waitForClose(ws2);
    await new Promise((r) => setTimeout(r, 20));
    expect(fix!.onLast).toEqual([SESSION_A]);
  });

  it('fires hooks independently per renderId', async () => {
    const wsA = await connectAuthed(fix!.wsUrl);
    sendMessage(wsA, makeSubscribe(SESSION_A));
    await recvMessage(wsA); // ack

    const wsB = await connectAuthed(fix!.wsUrl);
    sendMessage(wsB, makeSubscribe(SESSION_B));
    await recvMessage(wsB); // ack

    expect(fix!.onFirst).toEqual([SESSION_A, SESSION_B]);

    wsA.close();
    await waitForClose(wsA);
    await new Promise((r) => setTimeout(r, 20));
    expect(fix!.onLast).toEqual([SESSION_A]);

    wsB.close();
    await waitForClose(wsB);
    await new Promise((r) => setTimeout(r, 20));
    expect(fix!.onLast).toEqual([SESSION_A, SESSION_B]);
  });
});
