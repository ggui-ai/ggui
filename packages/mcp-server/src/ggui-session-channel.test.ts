/**
 * Live-channel unit tests — server-side derivation of the operator-
 * facing `tool` hint on ledger events, per-socket inbound ordering,
 * and the WS-action → pending-events-pipe bridge.
 *
 * `handleInboundAction` dual-writes every accepted action: the
 * retained `user.submitted` ledger event (ack seq source, and the
 * single authoritative build site for `ActionEventValue.tool`) plus —
 * for `data:submit`, when a `pendingEventConsumer` is wired — a
 * canonical `ConsumeEventEntry` on the pipe `ggui_consume` drains.
 *
 * Tool-hint suite (ledger shape):
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
 * The bridge suite boots the REAL drain side — the same
 * `createGguiConsumeHandler` the server registers — against the same
 * `InMemoryPendingEventConsumer` instance the channel writes to, and
 * proves a WS `data:submit` action round-trips into the agent's
 * `ggui_consume` result with unchanged ack semantics.
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
  GguiConsumeOutput,
} from '@ggui-ai/protocol';
import { isRecord } from '@ggui-ai/protocol';
import {
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiConsumeHandler } from '@ggui-ai/mcp-server-handlers/renders';
import type { Logger } from './logger.js';
import { DEFAULT_BUILDER_APP_ID } from './auth.js';
import {
  createGguiSessionChannelServer,
  type GguiSessionChannelOptions,
} from './ggui-session-channel.js';

/**
 * Silent logger that records `logger.error` and `logger.warn` event
 * names in call order. The inboundChain's per-link catch is observable
 * ONLY as a `render_channel_message_failed` error log — the recording
 * is how the poison-resistance test proves a frame genuinely threw
 * (vs. being handled gracefully inside onMessage). The warn recording
 * is how the bridge suite proves a failed pipe append degraded loudly
 * (`render_channel_consume_append_failed`) instead of silently.
 */
function createRecordingLogger(loggedErrors: string[], loggedWarns: string[]): Logger {
  const logger: Logger = {
    info: () => undefined,
    warn: (event) => {
      loggedWarns.push(event);
    },
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
  /** `logger.warn` event names, in call order. */
  readonly loggedWarns: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

/**
 * Optional channel-composition extras a test can layer onto the
 * fixture's `createGguiSessionChannelServer` call — the auth-plane
 * seams the identity-default appId-resolution suite exercises
 * (`appIdFromIdentity` override, wsToken bootstrap plumbing, console
 * cookie plumbing). Authored as a factory over the fixture's
 * `sessionId` so credential verifiers can bind to the render the
 * fixture committed.
 */
type BootChannelExtras = Pick<
  GguiSessionChannelOptions,
  'appIdFromIdentity' | 'bootstrap' | 'cookieAuth' | 'pendingEventConsumer'
>;

/**
 * Boot a channel server over a bare http server, commit a component
 * render carrying the given actionSpec, and open (but do NOT
 * subscribe) a real WS client. Hand back frame-pump helpers. The WS
 * `open` event has fired when this resolves.
 */
async function bootChannel(
  actionSpec: ActionSpec,
  makeExtras?: (sessionId: string) => BootChannelExtras,
): Promise<Fixture> {
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
  const loggedWarns: string[] = [];
  const channel = createGguiSessionChannelServer({
    renderStore: store,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    logger: createRecordingLogger(loggedErrors, loggedWarns),
    ...(makeExtras !== undefined ? makeExtras(sessionId) : {}),
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
    const parsed: unknown = JSON.parse(String(raw));
    if (!isRecord(parsed)) {
      throw new Error(`channel frame is not a JSON object: ${String(raw)}`);
    }
    frames.push(parsed);
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
    loggedWarns,
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
async function bootSubscribed(
  actionSpec: ActionSpec,
  makeExtras?: (sessionId: string) => BootChannelExtras,
): Promise<Fixture> {
  const fx = await bootChannel(actionSpec, makeExtras);
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

describe('handleSubscribe — identity-default appId resolution (absent payload.appId, SPEC §12.2)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  const IDENTITY_DEFAULT_APP = 'app-identity-default';

  /** Wire-shaped subscribe frame WITHOUT `appId` — the resolution probe. */
  function subscribeSansAppId(sessionId: string, extra?: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'subscribe',
      payload: { sessionId, ...(extra ?? {}) },
      requestId: randomUUID(),
    });
  }

  it('absent appId + existing render bound to the identity-default → ack (no APP_MISMATCH)', async () => {
    // The fixture's render is bound to APP_ID; the deployment's
    // identity mapping resolves the same value — the resolved default
    // passes the EXISTING tenancy gate unchanged.
    fx = await bootChannel({}, () => ({ appIdFromIdentity: () => APP_ID }));
    fx.ws.send(subscribeSansAppId(fx.sessionId));
    const ack = await fx.nextFrame('ack');
    expect((ack['payload'] as { session?: { id?: string } }).session?.id).toBe(fx.sessionId);
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);
  });

  it('absent appId + no render → the provisioned row carries the RESOLVED appId (never undefined)', async () => {
    // Regression lock on the proven corrupt-row bug: absent appId +
    // in-memory store used to silently ack a provisioned row whose
    // appId was `undefined` — a tenant-less row no later subscribe
    // could legally reach.
    fx = await bootChannel({}, () => ({ appIdFromIdentity: () => IDENTITY_DEFAULT_APP }));
    const freshSessionId = randomUUID();
    fx.ws.send(subscribeSansAppId(freshSessionId));
    await fx.nextFrame('ack');
    const stored = await fx.store.get(freshSessionId);
    expect(stored).not.toBeNull();
    expect(typeof stored!.appId).toBe('string');
    expect(stored!.appId).toBe(IDENTITY_DEFAULT_APP);
  });

  it('absent appId + render bound to a DIFFERENT app → APP_MISMATCH (tenancy still enforced)', async () => {
    // Identity resolves to a default that does NOT own the render —
    // the identity-default is a resolution rule, not a tenancy bypass.
    fx = await bootChannel({}, () => ({ appIdFromIdentity: () => IDENTITY_DEFAULT_APP }));
    fx.ws.send(subscribeSansAppId(fx.sessionId));
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('APP_MISMATCH');
    expect(fx.frames.filter((f) => f['type'] === 'ack')).toEqual([]);
  });

  it('absent appId without an appIdFromIdentity override falls back to defaultAppIdFromIdentity (builder → DEFAULT_BUILDER_APP_ID)', async () => {
    // devAllowAll resolves `{kind: 'builder'}` — the OSS fallback maps
    // it to the well-known builder app, same as the `/mcp` endpoint.
    fx = await bootChannel({});
    const freshSessionId = randomUUID();
    fx.ws.send(subscribeSansAppId(freshSessionId));
    await fx.nextFrame('ack');
    const stored = await fx.store.get(freshSessionId);
    expect(stored).not.toBeNull();
    expect(stored!.appId).toBe(DEFAULT_BUILDER_APP_ID);
  });

  it('absent appId under a bound wsToken resolves to the token-bound appId — no BOOTSTRAP_APP_MISMATCH on absence', async () => {
    // The empirical probe's bifurcation: absent appId under a bound
    // token used to fail BOOTSTRAP_APP_MISMATCH with "subscribe
    // targets 'undefined'". The token binds `(sessionId, appId)` —
    // absence resolves to the binding.
    fx = await bootChannel({}, (sessionId) => ({
      bootstrap: {
        verify: (token) =>
          token === 'tok-valid'
            ? { ok: true, sessionId, appId: APP_ID }
            : { ok: false, reason: 'invalid' },
        issueSessionToken: () => 'reconnect-token-1',
        refresh: () => ({ ok: false, reason: 'invalid' }),
      },
    }));
    fx.ws.send(subscribeSansAppId(fx.sessionId, { wsToken: 'tok-valid' }));
    const ack = await fx.nextFrame('ack');
    expect((ack['payload'] as { sessionToken?: string }).sessionToken).toBe('reconnect-token-1');
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);
  });

  it('a PRESENT appId contradicting the wsToken binding still rejects BOOTSTRAP_APP_MISMATCH', async () => {
    fx = await bootChannel({}, (sessionId) => ({
      bootstrap: {
        verify: (token) =>
          token === 'tok-valid'
            ? { ok: true, sessionId, appId: APP_ID }
            : { ok: false, reason: 'invalid' },
        issueSessionToken: () => 'reconnect-token-1',
        refresh: () => ({ ok: false, reason: 'invalid' }),
      },
    }));
    fx.ws.send(
      subscribeSansAppId(fx.sessionId, { wsToken: 'tok-valid', appId: 'app-imposter' }),
    );
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('BOOTSTRAP_APP_MISMATCH');
  });

  it('absent appId under a console cookie resolves to the cookie-bound appId — no DEVTOOL_COOKIE_APP_MISMATCH on absence', async () => {
    fx = await bootChannel({}, (sessionId) => ({
      cookieAuth: {
        readCookie: () => 'cookie-value',
        verify: () => ({ sessionId, appId: APP_ID }),
      },
    }));
    fx.ws.send(subscribeSansAppId(fx.sessionId));
    const ack = await fx.nextFrame('ack');
    expect((ack['payload'] as { session?: { id?: string } }).session?.id).toBe(fx.sessionId);
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);
  });
});

describe('handleInboundAction — WS action → pending-events pipe bridge (ggui_consume drains)', () => {
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

  /**
   * Boot the REAL pieces end-to-end: the channel server with a
   * `pendingEventConsumer` wired (as `createGguiServer` composes it),
   * the pipe opened at render time (as `ggui_render`'s `markCreated`
   * call does), and the REAL `createGguiConsumeHandler` draining the
   * SAME consumer instance — the agent's side of the loop.
   */
  async function bootBridged(): Promise<{
    fixture: Fixture;
    consumer: InMemoryPendingEventConsumer;
    drain: () => Promise<GguiConsumeOutput>;
  }> {
    const consumer = new InMemoryPendingEventConsumer();
    const fixture = await bootSubscribed(ARCHIVE_SPEC, () => ({
      pendingEventConsumer: consumer,
    }));
    consumer.markCreated(fixture.sessionId);
    const consumeHandler = createGguiConsumeHandler({
      pendingEventConsumer: consumer,
      renderStore: fixture.store,
    });
    return {
      fixture,
      consumer,
      drain: async () => {
        const out = await consumeHandler.handler(
          { sessionId: fixture.sessionId, timeout: 0 },
          { appId: APP_ID, requestId: 'bridge-drain' },
        );
        return out as GguiConsumeOutput;
      },
    };
  }

  it('a WS data:submit action lands on the pipe and ggui_consume drains the canonical ConsumeEventEntry', async () => {
    const { fixture, drain } = await bootBridged();
    fx = fixture;

    await submitAction(fx, { action: 'archive', data: { id: 't1' } });

    const out = await drain();
    expect(out.status).toBe('active');
    expect(out.events).toHaveLength(1);
    const entry = out.events[0]!;
    expect(entry.type).toBe('action');
    expect(entry.sessionId).toBe(fx.sessionId);
    expect(entry.intent).toBe('archive');
    expect(entry.actionData).toEqual({ id: 't1' });
    // WS clients mirror no contextSpec snapshot — canonical empty object.
    expect(entry.uiContext).toEqual({});
    // Server-minted 8-hex correlation id + ISO firedAt (server clock).
    expect(entry.actionId).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.isFinite(Date.parse(entry.firedAt))).toBe(true);
    // The pipe entry is the relay-identical consume shape — the
    // operator-facing `tool` hint lives ONLY on the retained ledger
    // copy (see the tool-hint suite above).
    expect('tool' in entry).toBe(false);

    // Dual-write: the ledger copy is still there, with the hint.
    const ledger = await persistedPayload(fx);
    expect(ledger.action).toBe('archive');
    expect(ledger.tool).toBe('todo_archive');

    // Queue semantics: the drain cleared the pipe.
    const second = await drain();
    expect(second.events).toHaveLength(0);
  });

  it('ack semantics are unchanged by the bridge: sequence still comes from the ledger and increments per action', async () => {
    const { fixture, drain } = await bootBridged();
    fx = fixture;

    const sequences: number[] = [];
    for (const id of ['a1', 'a2']) {
      fx.ws.send(
        JSON.stringify({
          type: 'action',
          payload: {
            sessionId: fx.sessionId,
            type: 'data:submit',
            payload: { action: 'archive', data: { id } },
          },
          requestId: randomUUID(),
        }),
      );
      const ack = await fx.nextFrame('ack');
      sequences.push((ack['payload'] as { sequence: number }).sequence);
    }
    expect(sequences[1]!).toBeGreaterThan(sequences[0]!);

    const out = await drain();
    expect(out.events.map((e) => e.actionData)).toEqual([{ id: 'a1' }, { id: 'a2' }]);
  });

  it('a missing pipe degrades to ledger-only with a warn — the ack is unaffected', async () => {
    // Consumer wired but the pipe never opened (the render did not come
    // from ggui_render) — append throws PendingPipeNotFoundError.
    const consumer = new InMemoryPendingEventConsumer();
    fx = await bootSubscribed(ARCHIVE_SPEC, () => ({
      pendingEventConsumer: consumer,
    }));

    await submitAction(fx, { action: 'archive', data: { id: 't9' } });

    expect(fx.loggedWarns).toContain('render_channel_consume_append_failed');
    // Ledger write + ack happened regardless (submitAction asserted the
    // ack); the retained event is intact.
    const ledger = await persistedPayload(fx);
    expect(ledger.data).toEqual({ id: 't9' });
  });

  it('non-data:submit envelopes stay ledger-only — the pipe never sees them', async () => {
    const { fixture, drain } = await bootBridged();
    fx = fixture;

    fx.ws.send(
      JSON.stringify({
        type: 'action',
        payload: {
          sessionId: fx.sessionId,
          type: 'lifecycle:focus',
          payload: { focused: true },
        },
        requestId: randomUUID(),
      }),
    );
    const ack = await fx.nextFrame('ack');
    expect((ack['payload'] as { sequence: number }).sequence).toBeGreaterThan(0);

    const out = await drain();
    expect(out.events).toHaveLength(0);
  });
});
