/**
 * ggui#1496 part B (runtime, R3) — the ladder set: the view's live channel
 * handed from one credential's ladder to the next.
 *
 * Driven through the real registry, `connectViaRegistry` and credential
 * controller, over a stub WebSocket, a stub `fetch` and a stub bridge
 * relay, on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { createCredentialController } from '../credential-controller.js';
import { createSequenceCursor } from '../events-polling.js';
import { createLadderSet, type LadderSpec, type LiveChannelEnd } from '../ladders.js';
import { connectViaRegistry } from '../registry-subscribe.js';
import { createStreamSeqTracker } from '../stream-seq.js';
import type { HeldCredential } from '../types.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** When false, the socket closes without ever opening (a jailed socket). */
  static opens = true;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    const opens = FakeWebSocket.opens;
    setTimeout(() => {
      if (opens) {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      } else {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1006 });
      }
    }, 0);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const META: McpAppAiGguiRenderMeta = {
  sessionId: 's1',
  appId: 'app-1',
  runtimeUrl: 'https://runtime.example/bundle.js',
};

const ROOT: HeldCredential = {
  wsToken: 'tok-root',
  wsUrl: 'wss://ggui.example/ws',
  expiresAt: PAST,
  origin: 'root',
};

function ack(sequence = 1, streamSeq?: number): unknown {
  return { type: 'ack', payload: { sequence, timestamp: 0, ...(streamSeq !== undefined ? { streamSeq } : {}) } };
}

function eventsBody(lastSequence: number, events: unknown[] = []): unknown {
  const body = { events, lastSequence, hasMore: false };
  return { structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function refreshReply(envelope: string): unknown {
  return { structuredContent: { ok: true, envelope, expiresAt: FUTURE } };
}

interface Rig {
  readonly set: ReturnType<typeof createLadderSet>;
  readonly propsUpdates: unknown[];
  readonly statuses: string[];
  readonly acks: unknown[];
  readonly refreshCalls: string[];
  readonly bridgeCalls: ReturnType<typeof vi.fn>;
  readonly fetchCalls: string[];
  readonly cursor: ReturnType<typeof createSequenceCursor>;
  readonly streamSeq: ReturnType<typeof createStreamSeqTracker>;
  readonly ends: LiveChannelEnd[];
}

function rig(options: {
  readonly initial?: HeldCredential;
  readonly refresh?: (envelope: string) => unknown;
  readonly bridgeBody?: () => unknown;
  /** Replaces `bridgeBody`: the relay's whole answer, a result or a rejection. */
  readonly bridgeAnswer?: () => Promise<unknown>;
  readonly fetchResponse?: (url: string) => Response;
} = {}): Rig {
  const propsUpdates: unknown[] = [];
  const statuses: string[] = [];
  const acks: unknown[] = [];
  const refreshCalls: string[] = [];
  const fetchCalls: string[] = [];
  const handlers: ChannelHandler[] = [
    { type: 'props_update', onMessage: (p) => void propsUpdates.push(p) },
  ];
  const controller = createCredentialController({
    initial: options.initial ?? ROOT,
    callTool: async (_name, args) => {
      refreshCalls.push(args.envelope);
      return (options.refresh ?? (() => refreshReply('tok-new')))(args.envelope);
    },
    sleep: async () => undefined,
    random: () => 0,
  });
  const bridgeCalls = vi.fn(
    options.bridgeAnswer ?? (async (): Promise<unknown> => (options.bridgeBody ?? (() => eventsBody(0)))()),
  );
  const ends: LiveChannelEnd[] = [];
  const cursor = createSequenceCursor(0);
  const streamSeq = createStreamSeqTracker();
  const set = createLadderSet({
    meta: META,
    handlers,
    cursor,
    streamSeq,
    controller,
    connectFn: connectViaRegistry,
    bridgeCallTool: bridgeCalls,
    onStatus: (s) => void statuses.push(s),
    onAck: (a) => void acks.push(a),
    isConfirmedRelayRefusalCode: (code) => code === -32601,
    onEnded: (end) => void ends.push(end),
    fetchImpl: async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      return (options.fetchResponse ?? (() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))(url);
    },
    now: () => Date.parse('2026-09-28T12:00:00.000Z'),
  });
  return { set, propsUpdates, statuses, acks, refreshCalls, bridgeCalls, fetchCalls, cursor, streamSeq, ends };
}

const WS_ONLY: LadderSpec = { credential: ROOT, sseUrl: undefined, pollingUrl: undefined };

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakeWebSocket.opens = true;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

/** Boot on WS, acked; returns the rig and the boot socket. */
async function bootedOnWs(r: Rig): Promise<FakeWebSocket> {
  const booting = r.set.connectBoot(WS_ONLY);
  await vi.advanceTimersByTimeAsync(1);
  const ws = FakeWebSocket.instances[0];
  if (ws === undefined) throw new Error('no boot socket');
  ws.emit(ack());
  await booting;
  return ws;
}

describe('ladder set: a WS BOOTSTRAP_EXPIRED refreshes the credential and rebinds (R1, R3)', () => {
  it('the new ladder subscribes with the adopted token and resumes the stream from the view cursor', async () => {
    const r = rig();
    const boot = await bootedOnWs(r);
    expect(boot.url).toContain('wsToken=tok-root');
    r.streamSeq.admit(7);
    boot.emit({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(r.refreshCalls).toEqual(['tok-root']);
    const next = FakeWebSocket.instances[1];
    if (next === undefined) throw new Error('no rebind socket');
    expect(next.url).toContain('wsToken=tok-new');
    expect(next.sent[0]).toMatchObject({ type: 'subscribe', payload: { sessionId: 's1', wsToken: 'tok-new', fromSeq: 7 } });
  });

  it('on the new ladder’s ack: the old ladder is disposed, status and send follow the new one, and the ack is applied', async () => {
    const r = rig();
    const boot = await bootedOnWs(r);
    boot.emit({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } });
    await vi.advanceTimersByTimeAsync(1);
    const next = FakeWebSocket.instances[1];
    if (next === undefined) throw new Error('no rebind socket');
    next.emit(ack(4));
    await vi.advanceTimersByTimeAsync(1);
    expect(r.acks).toEqual([{ sequence: 4, timestamp: 0 }]);
    expect(r.statuses.at(-1)).toBe('connected');
    r.set.send({ type: 'action', payload: {} } as Parameters<typeof r.set.send>[0]);
    expect(next.sent.at(-1)).toMatchObject({ type: 'action' });
    // The old ladder's bridge loop is gone with it.
    const pullsAtSwitch = r.bridgeCalls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.bridgeCalls.mock.calls.length).toBe(pullsAtSwitch);
  });

  it('once the new ladder holds the data, the old ladder’s deliveries drop and cannot move the ledger cursor (rev 2.1)', async () => {
    let release = false;
    let released = false;
    const r = rig({
      bridgeBody: () => {
        if (!release || released) return eventsBody(0);
        released = true;
        return eventsBody(9, [
          { seq: 9, timestamp: '2026-09-28T12:00:00.000Z', type: 'ui.updated', data: { sessionId: 's1', props: { n: 9 } } },
        ]);
      },
    });
    const boot = await bootedOnWs(r);
    boot.emit({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } });
    await vi.advanceTimersByTimeAsync(1);
    const next = FakeWebSocket.instances[1];
    if (next === undefined) throw new Error('no rebind socket');
    // The new ladder has sent its subscribe: it holds the data from here.
    expect(next.sent[0]).toMatchObject({ type: 'subscribe' });
    const cursorAtSwitch = r.cursor.get();
    // The old ladder, refused, demoted to its bridge; its next pull carries event 9.
    release = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(released).toBe(true);
    expect(r.propsUpdates).toEqual([]);
    expect(r.cursor.get()).toBe(cursorAtSwitch);
  });
});

describe('ladder set: a new ladder refused before acceptance (R3 case (c))', () => {
  it('demotes to its own bridge, takes over there, and its credential is never refreshed again (the loop guard)', async () => {
    const r = rig();
    const boot = await bootedOnWs(r);
    boot.emit({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } });
    await vi.advanceTimersByTimeAsync(1);
    const next = FakeWebSocket.instances[1];
    if (next === undefined) throw new Error('no rebind socket');
    next.emit({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired again' } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.refreshCalls).toEqual(['tok-root']);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Exactly one bridge loop: the new ladder's. The boot ladder is disposed.
    expect(r.bridgeCalls).toHaveBeenCalled();
    expect(boot.closed || boot.readyState === FakeWebSocket.CLOSED).toBe(true);
  });
});

describe('ladder set: the polling 410 (F4)', () => {
  const LIVE: HeldCredential = {
    ...ROOT,
    expiresAt: FUTURE,
    pollingUrl: 'https://ggui.example/api/sessions/s1/events?wsToken=tok-root',
  };
  const POLLING: LadderSpec = { credential: LIVE, sseUrl: undefined, pollingUrl: LIVE.pollingUrl };

  it('a 410 that is not a replay horizon refreshes, and the new ladder omits the WS that never opened', async () => {
    FakeWebSocket.opens = false;
    const r = rig({
      initial: LIVE,
      fetchResponse: (url) =>
        url.includes('tok-root')
          ? new Response('wsToken expired', { status: 410, headers: { 'content-type': 'text/plain' } })
          : new Response(JSON.stringify({ events: [], lastSequence: 0, hasMore: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
    });
    void r.set.connectBoot(POLLING);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.refreshCalls).toEqual(['tok-root']);
    await vi.advanceTimersByTimeAsync(10_000);
    // The new ladder polls with the new token and never opens a socket.
    expect(r.fetchCalls.some((u) => u.includes('tok-new'))).toBe(true);
    expect(FakeWebSocket.instances.some((ws) => ws.url.includes('tok-new'))).toBe(false);
  });

  it('a 410 replay horizon does not refresh', async () => {
    FakeWebSocket.opens = false;
    const r = rig({
      initial: LIVE,
      fetchResponse: () =>
        new Response(JSON.stringify({ reason: 'REPLAY_HORIZON_PASSED', currentSequence: 3 }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
    });
    void r.set.connectBoot(POLLING);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.refreshCalls).toEqual([]);
  });
});

describe('ladder set: entering the bridge past expiresAt (fact 8)', () => {
  it('refreshes an expired credential when its ladder reaches the bridge, and the new ladder takes over there', async () => {
    FakeWebSocket.opens = false;
    const r = rig();
    void r.set.connectBoot(WS_ONLY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.refreshCalls).toEqual(['tok-root']);
  });

  it('does not refresh a credential that has not expired', async () => {
    FakeWebSocket.opens = false;
    const fresh: HeldCredential = { ...ROOT, expiresAt: FUTURE };
    const r = rig({ initial: fresh });
    void r.set.connectBoot({ ...WS_ONLY, credential: fresh });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.bridgeCalls).toHaveBeenCalled();
    expect(r.refreshCalls).toEqual([]);
  });
});

describe('ladder set: an honest end (R4) — fed by the bridge pulls only', () => {
  const FRESH: HeldCredential = { ...ROOT, expiresAt: FUTURE };
  const notFound = (): unknown => ({
    isError: true,
    content: [{ type: 'text', text: 'session_not_found: no live session s1 for this caller' }],
  });

  async function onBridge(answers: ReadonlyArray<() => Promise<unknown>>): Promise<Rig> {
    FakeWebSocket.opens = false;
    let i = 0;
    const r = rig({
      initial: FRESH,
      bridgeAnswer: () => (answers[Math.min(i++, answers.length - 1)] ?? (async () => eventsBody(0)))(),
    });
    void r.set.connectBoot({ ...WS_ONLY, credential: FRESH });
    await vi.advanceTimersByTimeAsync(60_000);
    return r;
  }

  it('a confirmed relay refusal (-32601) ends the live channel, and the bridge loop stops', async () => {
    const r = await onBridge([
      async () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
    ]);
    expect(r.ends).toEqual([{ confirmation: 'relay-refusal', code: -32601 }]);
    expect(r.bridgeCalls).toHaveBeenCalledTimes(1);
  });

  it('a not-found after a successful pull ends it at once', async () => {
    const r = await onBridge([async () => eventsBody(0), async () => notFound()]);
    expect(r.ends).toEqual([{ confirmation: 'session-not-found', after: 'a-successful-pull' }]);
    expect(r.bridgeCalls).toHaveBeenCalledTimes(2);
  });

  it('a first not-found is not enough on its own; a second one in a row ends it', async () => {
    const r = await onBridge([async () => notFound(), async () => notFound()]);
    expect(r.ends).toEqual([{ confirmation: 'session-not-found', after: 'a-second-not-found' }]);
    expect(r.bridgeCalls).toHaveBeenCalledTimes(2);
  });

  it('anything else keeps its backoff: an unconfirmed relay error and an unrecognised error result end nothing', async () => {
    const r = await onBridge([
      async () => {
        throw Object.assign(new Error('internal'), { code: -32603 });
      },
      async () => ({ isError: true, content: [{ type: 'text', text: 'store read failed' }] }),
      async () => eventsBody(0),
    ]);
    expect(r.ends).toEqual([]);
    expect(r.bridgeCalls.mock.calls.length).toBeGreaterThan(3);
  });
});

describe('ladder set: a restarted server stream counter (the ack reveals it)', () => {
  it('an ack whose streamSeq is below the view cursor resets it, so the next seq 1 is applied', async () => {
    const r = rig();
    const boot = await bootedOnWs(r);
    r.streamSeq.admit(9);
    // The WS reconnects; the server's counter restarted and now reads 2.
    boot.emit(ack(2, 2));
    await vi.advanceTimersByTimeAsync(1);
    expect(r.streamSeq.last()).toBeUndefined();
    expect(r.streamSeq.admit(1)).toBe(true);
  });

  it('an ack at or above the view cursor leaves it alone', async () => {
    const r = rig();
    const boot = await bootedOnWs(r);
    r.streamSeq.admit(9);
    boot.emit(ack(2, 9));
    boot.emit(ack(3, 12));
    await vi.advanceTimersByTimeAsync(1);
    expect(r.streamSeq.last()).toBe(9);
    expect(r.streamSeq.admit(9)).toBe(false);
  });

  it('the first ack of a ladder is read the same way', async () => {
    const r = rig();
    r.streamSeq.admit(9);
    const booting = r.set.connectBoot(WS_ONLY);
    await vi.advanceTimersByTimeAsync(1);
    FakeWebSocket.instances[0]?.emit(ack(1, 0));
    await booting;
    expect(r.streamSeq.last()).toBeUndefined();
  });
});
