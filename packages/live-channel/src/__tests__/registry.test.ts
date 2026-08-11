import { describe, expect, it, vi } from 'vitest';
import {
  ChannelRegistry,
  type ChannelHandler,
} from '../index.js';

function noopBuilder() {
  return { type: 'subscribe', payload: {} };
}

describe('ChannelRegistry — register()', () => {
  it('returns an unregister fn that removes the handler', () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    const handler: ChannelHandler = { type: 'props_update', onMessage: () => {} };
    const unregister = registry.register(handler);
    expect(registry.inspectHandlers().has('props_update')).toBe(true);
    unregister();
    expect(registry.inspectHandlers().has('props_update')).toBe(false);
  });

  it('throws on duplicate type registration', () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    registry.register({ type: 'drain_ack', onMessage: () => {} });
    expect(() =>
      registry.register({ type: 'drain_ack', onMessage: () => {} }),
    ).toThrow(/already registered/);
  });

  it('throws on register-after-bind (handler set frozen)', async () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    // Bootstrap without wsUrl → PollingTransport, no handlers to poll.
    const handle = await registry.bind({
      bootstrap: { sessionId: 's', appId: 'a' },
    });
    expect(() =>
      registry.register({ type: 'late', onMessage: () => {} }),
    ).toThrow(/after bind/);
    await handle.dispose();
  });
});

describe('ChannelRegistry — transport selection', () => {
  it('picks PollingTransport when wsUrl is absent', async () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    const handle = await registry.bind({
      bootstrap: { sessionId: 's', appId: 'a' },
    });
    expect(handle.kind).toBe('polling');
    await handle.dispose();
  });

  it('picks PollingTransport when token is missing (half-live bootstrap)', async () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    const handle = await registry.bind({
      bootstrap: { wsUrl: 'ws://localhost/ws', sessionId: 's', appId: 'a' },
    });
    expect(handle.kind).toBe('polling');
    await handle.dispose();
  });

  it('picks WSTransport when wsUrl + token both present', async () => {
    const fakeSocket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null as null | (() => void),
      onclose: null as null | (() => void),
      onerror: null as null | (() => void),
      onmessage: null as null | ((e: MessageEvent) => void),
    } as unknown as WebSocket;
    const registry = new ChannelRegistry({
      subscribeFrameBuilder: noopBuilder,
      webSocketFactory: () => fakeSocket,
    });
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://localhost/ws',
        wsToken: 'bootstrap-token',
        sessionId: 's',
        appId: 'a',
      },
    });
    expect(handle.kind).toBe('ws');
    await handle.dispose();
  });

  it('throws on double-bind', async () => {
    const registry = new ChannelRegistry({ subscribeFrameBuilder: noopBuilder });
    const handle = await registry.bind({
      bootstrap: { sessionId: 's', appId: 'a' },
    });
    await expect(
      registry.bind({ bootstrap: { sessionId: 's', appId: 'a' } }),
    ).rejects.toThrow(/already bound/);
    await handle.dispose();
  });
});

describe('ChannelRegistry — FailoverHandle (WS → polling swap)', () => {
  /**
   * Fake socket that lets the test deterministically pump WS lifecycle
   * events. Same shape as the one in ws-transport.test.ts.
   */
  class FakeSocket {
    readyState = 0;
    sent: string[] = [];
    closeCalled = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e?: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closeCalled = true;
      this.readyState = 3;
    }
    triggerClose(code = 1006): void {
      this.readyState = 3;
      this.onclose?.({ code } as CloseEvent);
    }
  }

  it('swaps to PollingTransport after WSTransport reaches failed', async () => {
    // Setup: build a registry with a polling-capable handler. Wire a
    // fetch impl so the post-swap PollingTransport has somewhere to
    // hit. Use never-opened fail-fast (two consecutive close-without-open)
    // to drive WSTransport to status='failed' deterministically.
    const fakes: FakeSocket[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const registry = new ChannelRegistry({
      subscribeFrameBuilder: noopBuilder,
      webSocketFactory: () => {
        const f = new FakeSocket();
        fakes.push(f);
        return f as unknown as WebSocket;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // R6: polling is registry-level, supplied on BindOptions. Register
    // any handler so the registry has at least one entry (the swap
    // proves the transition; the snapshot parse is a separate concern).
    registry.register({
      type: 'props_update',
      onMessage: () => {},
    });
    const statuses: string[] = [];
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://csp-blocked',
        wsToken: 'tok',
        sessionId: 's',
        appId: 'a',
      },
      onStatusChange: (s) => statuses.push(s),
      // R6: registry-level polling. PollingTransport (post-swap) fires
      // this URL once on start() per its own currentStatus transition.
      polling: {
        url: 'http://test/r/abc',
        intervalMs: 60_000,
        parseSnapshot: () => null,
      },
    });
    // Pre-swap: WSTransport is active.
    expect(handle.kind).toBe('ws');
    if (handle.kind !== 'ws') throw new Error('unreachable: bind() returned non-ws handle for wsViable bootstrap');
    // Drive WSTransport to 'failed' via never-opened fail-fast.
    fakes[0]!.triggerClose(1006);
    // After first close, the transport schedules a reconnect — we
    // call start() to simulate the timer firing (the post-swap test
    // doesn't care about timer scheduling, only the state machine).
    // FailoverHandle proxies start() to the active transport.
    // Now the inner WSTransport's next attempt also closes without
    // opening, tripping fail-fast.
    // Note: we need to access the inner transport's reconnect via the
    // FailoverHandle. Since FailoverHandle exposes start() that drives
    // the inner, we call it.
    handle.start();
    fakes[1]!.triggerClose(1006);
    // Swap should have fired. Tag introspection on the failover handle.
    // (The discriminator stays 'ws' — see WsFailoverHandle docstring.)
    expect((handle as unknown as { hasSwapped: boolean }).hasSwapped).toBe(
      true,
    );
    // No SSE descriptor on this bind → the ladder is ws → polling
    // exactly as pre-SSE (regression guard for the rung generalization).
    expect(
      (handle as unknown as { activeKind: string }).activeKind,
    ).toBe('polling');
    // Status sequence MUST include 'failed' suppression + 'connecting'
    // re-entry on the swap. The PollingTransport then fires its own
    // 'open' on start().
    expect(statuses).not.toContain('failed');
    expect(statuses).toContain('connecting');
    // PollingTransport ticked at least once (fired immediately on start()).
    expect(fetchImpl).toHaveBeenCalledWith('http://test/r/abc', {
      headers: { accept: 'application/json' },
    });
    await handle.dispose();
  });

  it('forwards transient status changes verbatim pre-swap', async () => {
    const fake = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      onopen: null as null | (() => void),
      onclose: null as null | (() => void),
      onerror: null as null | (() => void),
      onmessage: null as null | ((e: MessageEvent) => void),
    } as unknown as WebSocket;
    const registry = new ChannelRegistry({
      subscribeFrameBuilder: noopBuilder,
      webSocketFactory: () => fake,
    });
    const statuses: string[] = [];
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://localhost/ws',
        wsToken: 'tok',
        sessionId: 's',
        appId: 'a',
      },
      onStatusChange: (s) => statuses.push(s),
    });
    // Trigger a normal open (transient connect).
    (fake as unknown as { readyState: number }).readyState = 1;
    (fake as unknown as { onopen: () => void }).onopen?.();
    expect(statuses).toContain('open');
    // No swap fired — failover state is unchanged.
    expect((handle as unknown as { hasSwapped: boolean }).hasSwapped).toBe(
      false,
    );
    await handle.dispose();
  });
});

describe('ChannelRegistry — transport ladder (ws → sse → polling)', () => {
  /** Same FakeSocket shape as the failover describe above. */
  class FakeSocket {
    readyState = 0;
    sent: string[] = [];
    closeCalled = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e?: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closeCalled = true;
      this.readyState = 3;
    }
    triggerClose(code = 1006): void {
      this.readyState = 3;
      this.onclose?.({ code } as CloseEvent);
    }
  }

  /**
   * Fake EventSource mirroring the FakeSocket fixture —
   * readyState 0=CONNECTING, 1=OPEN, 2=CLOSED. See
   * sse-transport.test.ts for the transport-level cases; here the
   * fakes only drive ladder demotions.
   */
  class FakeEventSource {
    readyState = 0;
    closeCalled = false;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(readonly url: string) {}
    close(): void {
      this.closeCalled = true;
      this.readyState = 2;
    }
    triggerOpen(): void {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }
    triggerMessage(frame: object, lastEventId = ''): void {
      this.onmessage?.({
        data: JSON.stringify(frame),
        lastEventId,
      } as MessageEvent);
    }
    triggerError(readyState: 0 | 2): void {
      this.readyState = readyState;
      this.onerror?.(new Event('error'));
    }
  }

  function jsonOk(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const SSE_URL = 'http://test/api/sessions/s/stream?wsToken=tok';
  const POLL_URL = 'http://test/r/abc';

  function buildLadderRegistry() {
    const fakes: FakeSocket[] = [];
    const sources: FakeEventSource[] = [];
    const fetchImpl = vi.fn(async () => jsonOk());
    const registry = new ChannelRegistry({
      subscribeFrameBuilder: noopBuilder,
      webSocketFactory: () => {
        const f = new FakeSocket();
        fakes.push(f);
        return f as unknown as WebSocket;
      },
      eventSourceFactory: (url) => {
        const s = new FakeEventSource(url);
        sources.push(s);
        return s as unknown as EventSource;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { registry, fakes, sources, fetchImpl };
  }

  it('demotes ws → sse → polling down the full ladder, never surfacing failed', async () => {
    const { registry, fakes, sources, fetchImpl } = buildLadderRegistry();
    const propsHandler = vi.fn();
    registry.register({ type: 'props_update', onMessage: propsHandler });
    const statuses: string[] = [];
    const debugLog = vi.fn();
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://csp-blocked',
        wsToken: 'tok',
        sessionId: 's',
        appId: 'a',
      },
      logger: { debug: debugLog },
      onStatusChange: (s) => statuses.push(s),
      sse: { url: SSE_URL },
      polling: {
        url: POLL_URL,
        intervalMs: 60_000,
        parseSnapshot: () => null,
      },
    });
    // Facade: the handle keeps kind 'ws' throughout the ladder.
    expect(handle.kind).toBe('ws');
    if (handle.kind !== 'ws') throw new Error('unreachable: wsViable bootstrap must yield a ws handle');
    const seam = handle as unknown as {
      hasSwapped: boolean;
      activeKind: string;
    };
    expect(seam.activeKind).toBe('ws');

    // Rung 1 fails: two consecutive never-opened closes → WS fail-fast.
    fakes[0]!.triggerClose(1006);
    handle.start();
    fakes[1]!.triggerClose(1006);

    // Demotion 1: ws → sse. SSE rung built + started; polling untouched.
    expect(seam.hasSwapped).toBe(true);
    expect(seam.activeKind).toBe('sse');
    expect(handle.kind).toBe('ws');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe(SSE_URL);
    expect(fetchImpl).not.toHaveBeenCalled();

    // SSE rung delivers frames through the same handler map.
    sources[0]!.triggerOpen();
    sources[0]!.triggerMessage({ type: 'props_update', payload: { n: 1 } });
    expect(propsHandler).toHaveBeenCalledWith({ n: 1 });

    // send() post-demotion: logged + dropped, never throws (neither
    // SSE nor polling has an outbound channel).
    expect(() => handle.send({ type: 'action', payload: {} })).not.toThrow();
    expect(debugLog).toHaveBeenCalledWith(
      'channel_failover_send_dropped_post_swap',
      expect.any(Object),
    );

    // Rung 2 fails: terminal-close 2-strike (no intervening open on
    // the recreated instance). start() bypasses the recreate timer —
    // same pattern as the WS reconnect tests.
    sources[0]!.triggerError(2);
    handle.start();
    expect(sources).toHaveLength(2);
    sources[1]!.triggerError(2);

    // Demotion 2: sse → polling. Terminal rung ticks immediately.
    expect(seam.activeKind).toBe('polling');
    expect(fetchImpl).toHaveBeenCalledWith(POLL_URL, {
      headers: { accept: 'application/json' },
    });

    // The consumer never saw a terminal 'failed' — each demotion is a
    // synthetic 'connecting' re-entry.
    expect(statuses).not.toContain('failed');
    expect(statuses).toContain('connecting');
    await handle.dispose();
  });

  it('binds SSE-primary (kind sse) when WS is not viable and demotes to polling', async () => {
    const { registry, sources, fetchImpl } = buildLadderRegistry();
    const propsHandler = vi.fn();
    const onSequence = vi.fn();
    registry.register({ type: 'props_update', onMessage: propsHandler });
    const statuses: string[] = [];
    const handle = await registry.bind({
      bootstrap: { sessionId: 's', appId: 'a' },
      onStatusChange: (s) => statuses.push(s),
      sse: { url: SSE_URL, initialSinceSequence: 12, onSequence },
      polling: {
        url: POLL_URL,
        intervalMs: 60_000,
        parseSnapshot: () => null,
      },
    });
    expect(handle.kind).toBe('sse');
    if (handle.kind !== 'sse') throw new Error('unreachable: sse descriptor without wsUrl must yield an sse handle');
    // First connect seeds the replay cursor from initialSinceSequence.
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe(`${SSE_URL}&sinceSequence=12`);

    // Frames + sequence bridge flow through the registry wiring.
    sources[0]!.triggerOpen();
    expect(statuses).toContain('open');
    sources[0]!.triggerMessage({ type: 'props_update', payload: { n: 2 } }, '13');
    expect(propsHandler).toHaveBeenCalledWith({ n: 2 });
    expect(onSequence).toHaveBeenCalledWith(13);

    // Terminal-close 2-strike → demote to polling.
    sources[0]!.triggerError(2);
    handle.start();
    sources[1]!.triggerError(2);
    const seam = handle as unknown as {
      hasSwapped: boolean;
      activeKind: string;
    };
    expect(seam.hasSwapped).toBe(true);
    expect(seam.activeKind).toBe('polling');
    expect(handle.kind).toBe('sse');
    expect(fetchImpl).toHaveBeenCalledWith(POLL_URL, {
      headers: { accept: 'application/json' },
    });
    expect(statuses).not.toContain('failed');
    await handle.dispose();
  });

  it('dispose() mid-ladder cancels demotion (no polling fetch ever fires)', async () => {
    const { registry, fakes, sources, fetchImpl } = buildLadderRegistry();
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://csp-blocked',
        wsToken: 'tok',
        sessionId: 's',
        appId: 'a',
      },
      sse: { url: SSE_URL },
      polling: {
        url: POLL_URL,
        intervalMs: 60_000,
        parseSnapshot: () => null,
      },
    });
    if (handle.kind !== 'ws') throw new Error('unreachable: wsViable bootstrap must yield a ws handle');
    const seam = handle as unknown as { activeKind: string };
    // Demote ws → sse, then tear the whole ladder down.
    fakes[0]!.triggerClose(1006);
    handle.start();
    fakes[1]!.triggerClose(1006);
    expect(seam.activeKind).toBe('sse');
    await handle.dispose();
    // A zombie SSE fake can no longer demote the disposed ladder.
    sources[0]!.triggerError(2);
    sources[0]!.triggerError(2);
    expect(seam.activeKind).toBe('sse');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
