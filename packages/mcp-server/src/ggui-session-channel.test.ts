/**
 * Live-channel unit tests — server-side derivation of the agent-facing
 * `tool` hint on consume events, plus per-socket inbound ordering.
 *
 * The persisted `user.submitted` envelope IS the consume event the
 * agent drains, and `handleInboundAction`'s appendEvent call is the
 * single authoritative build site for `ActionEventValue.tool`:
 *
 *   - inbound `data:submit` with NO client `tool` + an
 *     `actionSpec[action].nextStep` declaration → the persisted
 *     payload carries the derived hint;
 *   - inbound action with neither client `tool` nor `nextStep` → the
 *     persisted payload carries NO `tool` field;
 *   - a client-populated `tool` is preserved verbatim (the derivation
 *     only fills the gap).
 *
 * The ordering suite pins the per-socket `inboundChain` (see the
 * `ws.on('message')` wiring in ggui-session-channel.ts): inbound frames
 * are processed in wire-arrival order even when several `message`
 * events fire in one macrotask, and one rejecting frame never poisons
 * processing of later frames on the same socket.
 *
 * Lane 3 (in-process): real WS round-trip against a bare node http
 * server + `createGguiSessionChannelServer`, asserting on the
 * `InMemoryGguiSessionStore` event ledger after the action ack.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type {
  ActionEnvelope,
  ActionEventValue,
  ActionSpec,
} from '@ggui-ai/protocol';
import {
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { Logger } from './logger.js';
import { createGguiSessionChannelServer } from './ggui-session-channel.js';

/**
 * Silent logger that records `logger.error` event names in call order.
 * The inboundChain's per-link catch is observable ONLY as a
 * `render_channel_message_failed` error log — the recording is how the
 * poison-resistance test proves a frame genuinely threw (vs. being
 * handled gracefully inside onMessage).
 */
function createRecordingLogger(loggedErrors: string[]): Logger {
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (event) => {
      loggedErrors.push(event);
    },
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
}

const APP_ID = 'app-channel-test';

interface Fixture {
  readonly httpServer: HttpServer;
  readonly store: InMemoryGguiSessionStore;
  readonly sessionId: string;
  readonly ws: WebSocket;
  /** Resolves with the next frame whose `type` matches. */
  readonly nextFrame: (type: string) => Promise<Record<string, unknown>>;
  /** Frames received but not yet consumed by {@link nextFrame}, in arrival order. */
  readonly frames: ReadonlyArray<Record<string, unknown>>;
  /** `logger.error` event names, in call order. */
  readonly loggedErrors: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

/**
 * Boot a channel server over a bare http server, commit a component
 * render carrying the given actionSpec, and open (but do NOT
 * subscribe) a real WS client. Hand back frame-pump helpers. The WS
 * `open` event has fired when this resolves.
 */
async function bootChannel(actionSpec: ActionSpec): Promise<Fixture> {
  const store = new InMemoryGguiSessionStore();
  const sessionId = randomUUID();
  const now = Date.now();
  await store.commit({
    appId: APP_ID,
    render: {
      id: sessionId,
      appId: APP_ID,
      type: 'component',
      componentCode: 'export default function C() { return null; }',
      eventSequence: 0,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      actionSpec,
    },
  });

  const loggedErrors: string[] = [];
  const channel = createGguiSessionChannelServer({
    renderStore: store,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    logger: createRecordingLogger(loggedErrors),
  });

  const httpServer = createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    channel.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('httpServer.address() did not return AddressInfo');
  }

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${channel.path}`, {
    headers: { authorization: 'Bearer channel-test-token' },
  });
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  const nextFrame = async (type: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const idx = frames.findIndex((f) => f['type'] === type);
      if (idx >= 0) return frames.splice(idx, 1)[0]!;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for '${type}' frame`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    httpServer,
    store,
    sessionId,
    ws,
    nextFrame,
    frames,
    loggedErrors,
    close: async () => {
      ws.close();
      await channel.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/**
 * {@link bootChannel} + subscribe. Subscribe ack is already consumed
 * when this resolves.
 */
async function bootSubscribed(actionSpec: ActionSpec): Promise<Fixture> {
  const fx = await bootChannel(actionSpec);
  fx.ws.send(
    JSON.stringify({
      type: 'subscribe',
      payload: { sessionId: fx.sessionId, appId: APP_ID },
      requestId: randomUUID(),
    }),
  );
  await fx.nextFrame('ack');
  return fx;
}

/** Send a `data:submit` action frame and await its ack. */
async function submitAction(
  fx: Fixture,
  payload: ActionEventValue,
): Promise<void> {
  fx.ws.send(
    JSON.stringify({
      type: 'action',
      payload: {
        sessionId: fx.sessionId,
        type: 'data:submit',
        payload,
      },
      requestId: randomUUID(),
    }),
  );
  const ack = await fx.nextFrame('ack');
  expect((ack['payload'] as { sequence: number }).sequence).toBeGreaterThan(0);
}

/** Read the single persisted consume event's ActionEventValue payload. */
async function persistedPayload(fx: Fixture): Promise<ActionEventValue> {
  const page = await fx.store.listEventsSince(fx.sessionId, 0, 10);
  expect(page).not.toBeNull();
  expect(page!.events).toHaveLength(1);
  expect(page!.events[0]!.type).toBe('user.submitted');
  const envelope = page!.events[0]!.data as ActionEnvelope<ActionEventValue>;
  expect(envelope.type).toBe('data:submit');
  return envelope.payload as ActionEventValue;
}

describe('handleInboundAction — server-side tool-hint derivation (consume-event build site)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it('stamps actionSpec[action].nextStep onto the persisted event when the client sends no tool', async () => {
    fx = await bootSubscribed({
      archive: {
        label: 'Archive',
        nextStep: 'todo_archive',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    await submitAction(fx, { action: 'archive', data: { id: 't1' } });
    const payload = await persistedPayload(fx);
    expect(payload.tool).toBe('todo_archive');
    // The derivation builds a fresh payload — the rest passes through.
    expect(payload.action).toBe('archive');
    expect(payload.data).toEqual({ id: 't1' });
  });

  it('persists no tool field when the action declares no nextStep and the client sends none', async () => {
    fx = await bootSubscribed({
      ping: { label: 'Ping' },
    });
    await submitAction(fx, { action: 'ping', data: null });
    const payload = await persistedPayload(fx);
    expect('tool' in payload).toBe(false);
  });

  it('preserves a client-populated tool verbatim (derivation only fills the gap)', async () => {
    fx = await bootSubscribed({
      archive: {
        label: 'Archive',
        nextStep: 'todo_archive',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    await submitAction(fx, {
      action: 'archive',
      data: { id: 't2' },
      tool: 'client_supplied_tool',
    });
    const payload = await persistedPayload(fx);
    expect(payload.tool).toBe('client_supplied_tool');
  });
});

describe('per-socket inbound ordering — inboundChain serializes async frame handling', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  const ARCHIVE_SPEC: ActionSpec = {
    archive: {
      label: 'Archive',
      nextStep: 'todo_archive',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  };

  /** Wire-shaped subscribe frame for the fixture's render. */
  function subscribeFrame(fixture: Fixture, requestId: string): string {
    return JSON.stringify({
      type: 'subscribe',
      payload: { sessionId: fixture.sessionId, appId: APP_ID },
      requestId,
    });
  }

  /** Wire-shaped `data:submit` action frame for the `archive` action. */
  function archiveActionFrame(fixture: Fixture, requestId: string): string {
    return JSON.stringify({
      type: 'action',
      payload: {
        sessionId: fixture.sessionId,
        type: 'data:submit',
        payload: { action: 'archive', data: { id: 't1' } },
      },
      requestId,
    });
  }

  it('pipelined subscribe + action (no await between sends) acks the subscribe first and accepts the action — never NOT_SUBSCRIBED', async () => {
    fx = await bootChannel(ARCHIVE_SPEC);
    const subscribeRequestId = randomUUID();
    const actionRequestId = randomUUID();

    // Back-to-back synchronous sends: both frames typically land in
    // one TCP segment, so both ws 'message' events fire in the SAME
    // macrotask. Without the per-socket inboundChain the action frame
    // would be handled while handleSubscribe is parked at its first
    // await (renderStore.get) — no subscriber bound yet — and the
    // correctly-ordered client would be rejected with NOT_SUBSCRIBED.
    fx.ws.send(subscribeFrame(fx, subscribeRequestId));
    fx.ws.send(archiveActionFrame(fx, actionRequestId));

    // Arrival order is pinned: the FIRST ack answers the subscribe,
    // the second answers the action (with the appended ledger seq).
    const subscribeAck = await fx.nextFrame('ack');
    expect(subscribeAck['requestId']).toBe(subscribeRequestId);
    const actionAck = await fx.nextFrame('ack');
    expect(actionAck['requestId']).toBe(actionRequestId);
    expect(
      (actionAck['payload'] as { sequence: number }).sequence,
    ).toBeGreaterThan(0);

    // No error frame (NOT_SUBSCRIBED or otherwise) ever hit the wire.
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);

    // The action round-tripped to the ledger — accepted, not just acked.
    const payload = await persistedPayload(fx);
    expect(payload.action).toBe('archive');
  });

  it('a frame whose handler throws does not poison the chain — later frames on the same socket still process', async () => {
    fx = await bootChannel(ARCHIVE_SPEC);
    const subscribeRequestId = randomUUID();
    const actionRequestId = randomUUID();

    // All four frames sent synchronously — one macrotask burst.
    //
    // Frame 1 — malformed JSON. Handled INSIDE onMessage (the parse
    // try/catch answers with an INVALID_JSON error frame; onMessage
    // itself resolves). Graceful-rejection path.
    fx.ws.send('{ this is not json');
    // Frame 2 — a frame that makes onMessage genuinely REJECT: a
    // `subscribe` with a null payload throws a TypeError inside
    // handleSubscribe (`payload.supportedVersions` on null). The
    // chain's per-link catch must absorb it (error-logged as
    // render_channel_message_failed, no response frame) instead of
    // leaving the chain a rejected promise that drops every later
    // frame on this socket.
    fx.ws.send(
      JSON.stringify({ type: 'subscribe', payload: null, requestId: randomUUID() }),
    );
    // Frames 3 + 4 — a valid subscribe + action MUST still process.
    fx.ws.send(subscribeFrame(fx, subscribeRequestId));
    fx.ws.send(archiveActionFrame(fx, actionRequestId));

    const errorFrame = await fx.nextFrame('error');
    expect((errorFrame['payload'] as { code: string }).code).toBe('INVALID_JSON');

    const subscribeAck = await fx.nextFrame('ack');
    expect(subscribeAck['requestId']).toBe(subscribeRequestId);
    const actionAck = await fx.nextFrame('ack');
    expect(actionAck['requestId']).toBe(actionRequestId);
    expect(
      (actionAck['payload'] as { sequence: number }).sequence,
    ).toBeGreaterThan(0);

    // Frame 2 took the chain's catch path: it genuinely threw (the
    // exact-array pin fails loudly if handleSubscribe later gains
    // payload validation — re-pick the poison frame then) ...
    expect(fx.loggedErrors).toEqual(['render_channel_message_failed']);
    // ... and produced no error frame of its own (INVALID_JSON above
    // was frame 1's; nothing else reached the wire).
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);

    // End-to-end proof the post-poison action was accepted.
    const payload = await persistedPayload(fx);
    expect(payload.action).toBe('archive');
  });
});
