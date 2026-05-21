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
        token: 'bootstrap-token',
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
    // Register a handler with a polling descriptor — only such
    // handlers exercise the polling fallback. The parse() returns null
    // so the dispatch loop is silent (we just need start() to set up
    // the poller).
    registry.register({
      type: 'props_update',
      onMessage: () => {},
      polling: {
        url: 'http://test/api/bootstrap/abc',
        intervalMs: 60_000,
        parse: () => null,
      },
    });
    const statuses: string[] = [];
    const handle = await registry.bind({
      bootstrap: {
        wsUrl: 'ws://csp-blocked',
        token: 'tok',
        sessionId: 's',
        appId: 'a',
      },
      onStatusChange: (s) => statuses.push(s),
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
    // Swap should have fired. Tag introspection on FailoverHandle.
    // (The discriminator stays 'ws' — see FailoverHandle docstring.)
    expect((handle as unknown as { hasSwapped: boolean }).hasSwapped).toBe(
      true,
    );
    // Status sequence MUST include 'failed' suppression + 'connecting'
    // re-entry on the swap. The PollingTransport then fires its own
    // 'open' on start().
    expect(statuses).not.toContain('failed');
    expect(statuses).toContain('connecting');
    // PollingTransport ticked at least once (fired immediately on start()).
    expect(fetchImpl).toHaveBeenCalledWith('http://test/api/bootstrap/abc');
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
        token: 'tok',
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
