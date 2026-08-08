/**
 * `externalBroadcast` replay-dedupe guard (#435 half 2).
 *
 * The in-process pump (`subscriber-lifecycle.ts:pumpSubscriber`) skips
 * any live envelope whose `seq <= sub.replayCompletedSeq` — those were
 * (or will be) delivered via the subscribe-time replay, so re-sending
 * them live would double-deliver. `externalBroadcast` is the OTHER
 * delivery leg for the same live frames — the cross-pod Redis-broadcast
 * path a multi-process deployment's pubsub on-message handler calls —
 * and until this guard it sent unconditionally, reopening the same
 * duplicate-delivery window the pump already closed for the in-process
 * case.
 *
 * These tests exercise `createOutbound` directly (not the full channel
 * server): a fake `wsSubscribers` set built from real `ws` sockets (so
 * `send`'s `readyState` check is genuine, not stubbed) with controlled
 * `replayCompletedSeq` values, spying on each socket's `send` to observe
 * delivery without needing a live client-side reader.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthResult, BufferedStreamEnvelope } from '@ggui-ai/mcp-server-core';
import {
  InMemoryGguiSessionStore,
  InMemoryGguiSessionStreamBuffer,
  InProcessStreamFanout,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { Logger } from '../logger.js';
import { createOutbound, type Outbound } from './outbound.js';
import type { Subscriber } from './internal-types.js';

/** Silent logger — these tests don't assert on log output. */
const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
};

const IDENTITY: AuthResult = { identity: { kind: 'builder' }, source: 'dev' };

/** Never-yields fanout iterator — `externalBroadcast` never touches it. */
function idleIter(): AsyncIterator<BufferedStreamEnvelope> {
  return { next: async () => ({ done: true, value: undefined }) };
}

/**
 * Open one real client/server `ws` socket pair against `wss`. The
 * server-side socket is what `Subscriber.ws` is built from — genuine
 * `readyState`/`send()` behavior, no hand-rolled fake satisfying the
 * `ws` `WebSocket` surface.
 */
async function openSocketPair(
  wss: WebSocketServer,
  url: string,
): Promise<{ client: WebSocket; serverWs: WebSocket }> {
  const client = new WebSocket(url);
  const [serverWs] = await Promise.all([
    new Promise<WebSocket>((resolve) => wss.once('connection', resolve)),
    new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    }),
  ]);
  return { client, serverWs };
}

interface Fixture {
  readonly outbound: Outbound;
  /** Bound to `sessionId`, replayCompletedSeq 5 — replay already covered seq<=5. */
  readonly sendA: MockInstance;
  /** Bound to `sessionId`, replayCompletedSeq 0 — replay covered nothing. */
  readonly sendB: MockInstance;
  /** Bound to a DIFFERENT sessionId — cross-session non-interference control. */
  readonly sendOther: MockInstance;
  readonly sessionId: string;
  readonly otherSessionId: string;
  readonly close: () => Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const addr = wss.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('wss.address() did not return AddressInfo');
  }
  const url = `ws://127.0.0.1:${addr.port}`;

  const { client: clientA, serverWs: wsA } = await openSocketPair(wss, url);
  const { client: clientB, serverWs: wsB } = await openSocketPair(wss, url);
  const { client: clientOther, serverWs: wsOther } = await openSocketPair(wss, url);

  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const connectedAt = Date.now();

  const subA: Subscriber = {
    ws: wsA,
    sessionId,
    appId: 'app-test',
    identity: IDENTITY,
    connectedAt,
    replayCompletedSeq: 5,
    iter: idleIter(),
    channelSubs: new Map(),
  };
  const subB: Subscriber = {
    ws: wsB,
    sessionId,
    appId: 'app-test',
    identity: IDENTITY,
    connectedAt,
    replayCompletedSeq: 0,
    iter: idleIter(),
    channelSubs: new Map(),
  };
  const subOther: Subscriber = {
    ws: wsOther,
    sessionId: otherSessionId,
    appId: 'app-test',
    identity: IDENTITY,
    connectedAt,
    replayCompletedSeq: 0,
    iter: idleIter(),
    channelSubs: new Map(),
  };

  const sendA = vi.spyOn(wsA, 'send');
  const sendB = vi.spyOn(wsB, 'send');
  const sendOther = vi.spyOn(wsOther, 'send');

  const outbound = createOutbound({
    logger,
    renderStore: new InMemoryGguiSessionStore(),
    streamBuffer: new InMemoryGguiSessionStreamBuffer(),
    streamFanout: new InProcessStreamFanout(),
    wsSubscribers: new Set([subA, subB, subOther]),
  });

  return {
    outbound,
    sendA,
    sendB,
    sendOther,
    sessionId,
    otherSessionId,
    close: async () => {
      clientA.close();
      clientB.close();
      clientOther.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** A `data` frame carrying the given per-session seq. */
function dataFrame(sessionId: string, seq: number): WebSocketMessage {
  return {
    type: 'data',
    payload: { sessionId, channel: 'test-channel', mode: 'append', payload: {}, seq },
  };
}

/** A `data` frame with no `seq` — never buffered, so replay can't duplicate it. */
function unstampedDataFrame(sessionId: string): WebSocketMessage {
  return {
    type: 'data',
    payload: { sessionId, channel: 'test-channel', mode: 'append', payload: {} },
  };
}

/** A `props_update` frame — carries no seq semantics at all. */
function propsUpdateFrame(sessionId: string): WebSocketMessage {
  return { type: 'props_update', payload: { sessionId, props: {} } };
}

describe('externalBroadcast — replay-dedupe guard mirrors the in-process pump', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it('a data frame at seq=3 is suppressed for the subscriber whose replay already covered it (replayCompletedSeq=5), delivered to the one it did not (replayCompletedSeq=0)', async () => {
    fx = await buildFixture();
    fx.outbound.externalBroadcast(fx.sessionId, dataFrame(fx.sessionId, 3));

    expect(fx.sendA).not.toHaveBeenCalled();
    expect(fx.sendB).toHaveBeenCalledTimes(1);
    expect(fx.sendOther).not.toHaveBeenCalled();
  });

  it('a data frame at seq=9 (past both replay snapshots) is delivered to both subscribers', async () => {
    fx = await buildFixture();
    fx.outbound.externalBroadcast(fx.sessionId, dataFrame(fx.sessionId, 9));

    expect(fx.sendA).toHaveBeenCalledTimes(1);
    expect(fx.sendB).toHaveBeenCalledTimes(1);
    expect(fx.sendOther).not.toHaveBeenCalled();
  });

  it('an unstamped data frame (no seq) is delivered to both subscribers — never buffered, so replay cannot have duplicated it', async () => {
    fx = await buildFixture();
    fx.outbound.externalBroadcast(fx.sessionId, unstampedDataFrame(fx.sessionId));

    expect(fx.sendA).toHaveBeenCalledTimes(1);
    expect(fx.sendB).toHaveBeenCalledTimes(1);
  });

  it('a props_update frame is delivered to both subscribers regardless of replayCompletedSeq — no seq semantics apply', async () => {
    fx = await buildFixture();
    fx.outbound.externalBroadcast(fx.sessionId, propsUpdateFrame(fx.sessionId));

    expect(fx.sendA).toHaveBeenCalledTimes(1);
    expect(fx.sendB).toHaveBeenCalledTimes(1);
  });

  it('a broadcast for a different sessionId is delivered to neither subscriber (existing per-session filter, pinned)', async () => {
    fx = await buildFixture();
    const unrelatedSessionId = randomUUID();
    fx.outbound.externalBroadcast(unrelatedSessionId, dataFrame(unrelatedSessionId, 1));

    expect(fx.sendA).not.toHaveBeenCalled();
    expect(fx.sendB).not.toHaveBeenCalled();
    expect(fx.sendOther).not.toHaveBeenCalled();
  });
});
