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
} from '@ggui-ai/protocol';
import { isRecord } from '@ggui-ai/protocol';
import {
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
  InMemoryGguiSessionStreamBuffer,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiConsumeHandler } from '@ggui-ai/mcp-server-handlers/renders';
import { isHandlerFailure, type HandlerFailure } from '@ggui-ai/mcp-server-handlers';
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
  | 'appIdFromIdentity'
  | 'authorizeApp'
  | 'perAppOnlySources'
  | 'bootstrap'
  | 'cookieAuth'
  | 'pendingEventConsumer'
  | 'streamBuffer'
> &
  Partial<Pick<GguiSessionChannelOptions, 'logger'>>;

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

describe('handleSubscribe — a fresh subscribe replays known-reserved channels after the ack, and no agent-declared channel (SPEC §12.2.1, ggui#1521)', () => {
  let fx: Fixture | undefined;
  afterEach(async () => {
    await fx?.close();
    fx = undefined;
  });

  const subscribeFrame = (sessionId: string): string =>
    JSON.stringify({ type: 'subscribe', payload: { sessionId, appId: APP_ID }, requestId: randomUUID() });

  it('sends the retained reserved envelope after the ack at seq <= streamSeq, and replays nothing on a declared channel, even one declared replay: all', async () => {
    const streamBuffer = new InMemoryGguiSessionStreamBuffer();
    fx = await bootChannel({}, () => ({ streamBuffer }));
    const streamSpec = { feed: { mode: 'replace' as const, replay: 'all' as const, schema: { type: 'object' as const } } };
    const stored = await fx.store.get(fx.sessionId);
    if (stored === null || stored.render.type !== 'component') throw new Error('the fixture commits a component render');
    await fx.store.commit({ appId: APP_ID, render: { ...stored.render, streamSpec } });
    // Server-pushed state that landed before the viewer attached, and an
    // agent-declared update that did too.
    await streamBuffer.record({ sessionId: fx.sessionId, channel: '_ggui:preview', mode: 'replace', payload: { skeleton: true } });
    await streamBuffer.record({ sessionId: fx.sessionId, channel: 'feed', mode: 'replace', payload: { n: 1 } }, streamSpec);

    fx.ws.send(subscribeFrame(fx.sessionId));
    const ack = await fx.nextFrame('ack');
    const streamSeq = (ack['payload'] as { streamSeq: number }).streamSeq;
    expect(streamSeq).toBe(2);
    const data = await fx.nextFrame('data');
    expect(data['payload']).toMatchObject({ channel: '_ggui:preview', seq: 1, payload: { skeleton: true } });
    // At or below the ack's cursor: a client that dedupes against
    // `streamSeq` would drop it, which is what SPEC §12.2.1 now forbids.
    expect((data['payload'] as { seq: number }).seq).toBeLessThanOrEqual(streamSeq);
    // The declared channel is not replayed on a fresh subscribe.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fx.frames.filter((f) => f['type'] === 'data')).toEqual([]);

    // Control: the declared envelope WAS retained, so its absence above is
    // the fresh subscribe's policy, not a missing record. A resume from 0
    // over the render's spec returns it.
    const resumed = await streamBuffer.replay(fx.sessionId, 0, streamSpec);
    expect(resumed.envelopes.map((e) => e.channel).sort()).toEqual(['_ggui:preview', 'feed']);
  });
});

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

// ggui#1223 / #1305 — a committed `oneShot` spends its card durably BEFORE
// the ack, so a client holding the ack can reload and find the card spent.
describe('handleInboundAction — the committed oneShot spend (#1305)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  async function spent(f: Fixture): Promise<unknown> {
    const got = await f.store.get(f.sessionId);
    return got?.render.type === 'component' ? got.render.spentOneShots : undefined;
  }

  it('a data:submit of a oneShot action is recorded on the card by the time the ack arrives', async () => {
    fx = await bootSubscribed({
      confirm: { label: 'Confirm', oneShot: true },
      ping: { label: 'Ping' },
    });
    await submitAction(fx, { action: 'confirm', data: null });
    expect(await spent(fx)).toEqual({ epoch: 0, actions: ['confirm'] });
  });

  it('an action the card does not declare oneShot leaves no record', async () => {
    fx = await bootSubscribed({
      confirm: { label: 'Confirm', oneShot: true },
      ping: { label: 'Ping' },
    });
    await submitAction(fx, { action: 'ping', data: null });
    expect(await spent(fx)).toBeUndefined();
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
      },
    }));
    fx.ws.send(subscribeSansAppId(fx.sessionId, { wsToken: 'tok-valid' }));
    const ack = await fx.nextFrame('ack');
    // ggui#1488: the ack mints no reconnect credential; nothing verified one.
    expect(ack['payload']).not.toHaveProperty('sessionToken');
    expect(fx.frames.filter((f) => f['type'] === 'error')).toEqual([]);
  });

  it('logs render_channel_subscribed with the credential it came on: a wsToken subscribe {bootstrap: true, source: ws_token}, a bearer one {bootstrap: false, source: its auth source}, a console-cookie one {bootstrap: false, source: console_cookie} (ggui#1488)', async () => {
    const subscribedOf = async (
      subscribe: (sessionId: string) => string,
      extras: (sessionId: string) => BootChannelExtras,
    ): Promise<Array<{ bootstrap: unknown; source: unknown }>> => {
      const infos: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const logger: Logger = {
        info: (event, fields) => {
          infos.push({ event, fields: fields ?? {} });
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child: () => logger,
      };
      fx = await bootChannel({}, (sessionId) => ({ ...extras(sessionId), logger }));
      fx.ws.send(subscribe(fx.sessionId));
      await fx.nextFrame('ack');
      await fx.close();
      fx = null;
      return infos
        .filter((l) => l.event === 'render_channel_subscribed')
        .map((l) => ({ bootstrap: l.fields['bootstrap'], source: l.fields['source'] }));
    };
    const viaToken = await subscribedOf(
      (sessionId) => subscribeSansAppId(sessionId, { wsToken: 'tok-valid' }),
      (sessionId) => ({
        bootstrap: {
          verify: (token) =>
            token === 'tok-valid' ? { ok: true, sessionId, appId: APP_ID } : { ok: false, reason: 'invalid' },
        },
      }),
    );
    expect(viaToken).toEqual([{ bootstrap: true, source: 'ws_token' }]);
    const viaBearer = await subscribedOf(
      (sessionId) => subscribeSansAppId(sessionId),
      () => ({ appIdFromIdentity: () => APP_ID }),
    );
    expect(viaBearer).toEqual([{ bootstrap: false, source: 'dev' }]);
    const viaCookie = await subscribedOf(
      (sessionId) => subscribeSansAppId(sessionId),
      (sessionId) => ({
        cookieAuth: {
          readCookie: () => 'cookie-value',
          verify: () => ({ sessionId, appId: APP_ID }),
        },
      }),
    );
    expect(viaCookie).toEqual([{ bootstrap: false, source: 'console_cookie' }]);
  });

  it('a PRESENT appId contradicting the wsToken binding still rejects BOOTSTRAP_APP_MISMATCH', async () => {
    fx = await bootChannel({}, (sessionId) => ({
      bootstrap: {
        verify: (token) =>
          token === 'tok-valid'
            ? { ok: true, sessionId, appId: APP_ID }
            : { ok: false, reason: 'invalid' },
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

// ggui#1480 — on the bearer path a DECLARED appId other than the proved
// identity's own app must pass the deployment's per-app authorization (the
// same check the MCP endpoint runs on a URL appId) before it decides the
// app-scope gate or names a provisioned row's app.
describe('handleSubscribe — a declared appId must be one the identity may act on (ggui#1480)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  const CALLER_APP = 'app-caller-own';
  const GO_SPEC: ActionSpec = {
    go: {
      label: 'Go',
      nextStep: 'go_next',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  };

  function goFrame(sessionId: string): string {
    return JSON.stringify({
      type: 'action',
      payload: { sessionId, type: 'data:submit', payload: { action: 'go', data: { id: 'x1' } } },
      requestId: randomUUID(),
    });
  }

  function subscribeAs(sessionId: string, appId: string): string {
    return JSON.stringify({ type: 'subscribe', payload: { sessionId, appId }, requestId: randomUUID() });
  }

  it("refuses a declared app the deployment does not authorize for this identity — APP_MISMATCH, no ack", async () => {
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => CALLER_APP,
      authorizeApp: async () => {
        throw new Error('not an app this identity may act on');
      },
    }));
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('APP_MISMATCH');
    expect(fx.frames.filter((f) => f['type'] === 'ack')).toEqual([]);
    expect(fx.loggedWarns).toContain('render_channel_app_refused');
  });

  it('lets no action frame reach the refused session — the socket never became its subscriber', async () => {
    fx = await bootChannel(GO_SPEC, () => ({
      appIdFromIdentity: () => CALLER_APP,
      authorizeApp: async () => {
        throw new Error('not an app this identity may act on');
      },
    }));
    const before = await fx.store.listEventsSince(fx.sessionId, 0, 50);
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    await fx.nextFrame('error');
    fx.ws.send(goFrame(fx.sessionId));
    await fx.nextFrame('error');
    expect(fx.frames.filter((f) => f['type'] === 'ack')).toEqual([]);
    const after = await fx.store.listEventsSince(fx.sessionId, 0, 50);
    expect(after?.events.length).toBe(before?.events.length);
  });

  it('the same action frame lands once the declared app is authorized — control for the instrument above', async () => {
    fx = await bootChannel(GO_SPEC, () => ({
      appIdFromIdentity: () => CALLER_APP,
      authorizeApp: async () => {},
    }));
    const before = await fx.store.listEventsSince(fx.sessionId, 0, 50);
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    await fx.nextFrame('ack');
    fx.ws.send(goFrame(fx.sessionId));
    await fx.nextFrame('ack');
    const after = await fx.store.listEventsSince(fx.sessionId, 0, 50);
    expect(after?.events.length).toBe((before?.events.length ?? 0) + 1);
  });

  it('creates no row under an unauthorized declared app for an unknown session id', async () => {
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => CALLER_APP,
      authorizeApp: async () => {
        throw new Error('not an app this identity may act on');
      },
    }));
    const fresh = randomUUID();
    fx.ws.send(subscribeAs(fresh, 'app-someone-else'));
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('APP_MISMATCH');
    expect(await fx.store.get(fresh)).toBeNull();
  });

  it('sends the declared app to the deployment\'s authorization and subscribes when it passes (a key that owns several apps)', async () => {
    const seen: string[] = [];
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => CALLER_APP,
      authorizeApp: async (appId: string) => {
        seen.push(appId);
      },
    }));
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    const ack = await fx.nextFrame('ack');
    expect((ack['payload'] as { session?: { id?: string } }).session?.id).toBe(fx.sessionId);
    expect(seen).toEqual([APP_ID]);
  });

  it("does not consult the authorization when the declared app is the identity's own — control", async () => {
    const seen: string[] = [];
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => APP_ID,
      authorizeApp: async (appId: string) => {
        seen.push(appId);
      },
    }));
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    await fx.nextFrame('ack');
    expect(seen).toEqual([]);
  });

  it('keeps today\'s behaviour when the deployment wires no per-app authorization, as the MCP endpoint does — control', async () => {
    fx = await bootChannel({}, () => ({ appIdFromIdentity: () => CALLER_APP }));
    fx.ws.send(subscribeAs(fx.sessionId, APP_ID));
    await fx.nextFrame('ack');
  });
});

// ggui#1482 — a credential source the deployment lists as per-app-only
// passes the per-app authorization on EVERY bearer subscribe, its
// identity-default app included, so the checks that authorization runs
// cannot be skipped by omitting `appId` or declaring the identity's own.
describe('handleSubscribe — a per-app-only source is authorized on every subscribe (ggui#1482)', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  function subscribeFrame(sessionId: string, appId?: string): string {
    return JSON.stringify({
      type: 'subscribe',
      payload: { sessionId, ...(appId !== undefined ? { appId } : {}) },
      requestId: randomUUID(),
    });
  }

  // `bootChannel`'s adapter is `devAllowAll`, so every socket's source is 'dev'.
  it('refuses a listed source that omits appId when the authorization refuses its identity-default app', async () => {
    const seen: string[] = [];
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => APP_ID,
      perAppOnlySources: ['dev'],
      authorizeApp: async (appId: string) => {
        seen.push(appId);
        throw new Error('denied');
      },
    }));
    fx.ws.send(subscribeFrame(fx.sessionId));
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('APP_MISMATCH');
    expect(fx.frames.filter((f) => f['type'] === 'ack')).toEqual([]);
    expect(seen).toEqual([APP_ID]);
  });

  it("refuses a listed source that declares the identity's own app when the authorization refuses it", async () => {
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => APP_ID,
      perAppOnlySources: ['dev'],
      authorizeApp: async () => {
        throw new Error('denied');
      },
    }));
    fx.ws.send(subscribeFrame(fx.sessionId, APP_ID));
    const err = await fx.nextFrame('error');
    expect((err['payload'] as { code: string }).code).toBe('APP_MISMATCH');
  });

  it('subscribes a listed source the authorization passes — control', async () => {
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => APP_ID,
      perAppOnlySources: ['dev'],
      authorizeApp: async () => {},
    }));
    fx.ws.send(subscribeFrame(fx.sessionId));
    await fx.nextFrame('ack');
  });

  it('an unlisted source that omits appId is not sent to authorization — control', async () => {
    const seen: string[] = [];
    fx = await bootChannel({}, () => ({
      appIdFromIdentity: () => APP_ID,
      perAppOnlySources: ['oidc'],
      authorizeApp: async (appId: string) => {
        seen.push(appId);
      },
    }));
    fx.ws.send(subscribeFrame(fx.sessionId));
    await fx.nextFrame('ack');
    expect(seen).toEqual([]);
  });

  it('listing a source without an authorizeApp refuses to construct the channel', () => {
    expect(() =>
      createGguiSessionChannelServer({
        renderStore: new InMemoryGguiSessionStore(),
        auth: new InMemoryAuthAdapter({ devAllowAll: true }),
        logger: createRecordingLogger([], []),
        perAppOnlySources: ['dev'],
      }),
    ).toThrow(/perAppOnlySources/);
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
  /** What `ggui_consume` puts on the wire on success — the real handler's own output type (#817); a HandlerFailure (ggui#839) is the test's failure. */
  type ConsumeWire = Exclude<
    Awaited<ReturnType<ReturnType<typeof createGguiConsumeHandler>['handler']>>,
    HandlerFailure<unknown>
  >;

  async function bootBridged(): Promise<{
    fixture: Fixture;
    consumer: InMemoryPendingEventConsumer;
    drain: () => Promise<ConsumeWire>;
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
        if (isHandlerFailure(out)) throw new Error(`unexpected HandlerFailure: ${out.errorText}`);
        return out;
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
    expect(typeof entry.firedAt).toBe('string');
    expect(Number.isFinite(Date.parse(String(entry.firedAt)))).toBe(true);
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
    // `EventType` has exactly one member ('data:submit') since
    // draft-2026-06-12 — this frame impersonates a ROGUE client sending
    // a retired/unknown type string. The wire-trust posture: ledger-
    // append + ack, but the agent-facing consume pipe never sees it.
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
