/**
 * Tests for the renderer's per-stack-item `WireConfig` factory.
 *
 * The audit-critical shape properties we lock:
 *   1. Action envelopes emitted by the root config are byte-
 *      equivalent to those GguiSession emits today (Item 1 builders +
 *      `{type:'action', payload: envelope}` WS frame).
 *   2. Per-item scoping targets `stackItemId`/`actionSpec`/`tool` from THIS
 *      item, not the top of stack.
 *   3. Validation violations route through `onContractViolation` +
 *      block the outbound send.
 *   4. Stream fan-out goes through the in-renderer StreamBus; wire's
 *      `useStream(channel)` subscribers wake up.
 *   5. Client-tool handlers register/invoke/unregister cleanly.
 *   6. Outbound emission targets `manager.send({type:'action',
 *      payload})` — no other wire frame goes out on dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ActionEnvelope,
  ActionSpec,
  SessionStackEntry,
  StackItem,
  StreamEnvelope,
} from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
// Pre-B3b this imported `RendererWebSocketManager` for the manager
// type cast. Post-B3b the WS lives in `@ggui-ai/live-channel`; the
// renderer's wire-config exposes a `RendererSendSurface` shape
// (`{send(msg)}`) that tests stub directly without a cast.
import {
  buildRootWireConfig,
  StreamBus,
} from '../wire-config.js';

function makeStackItem(
  id: string,
  overrides: Partial<StackItem> = {},
): StackItem {
  return {
    id,
    componentCode: '/* unused */',
    description: `item ${id}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as StackItem;
}

function makeFakeManager(): {
  send: ReturnType<typeof vi.fn>;
  messages: WebSocketMessage[];
} {
  const messages: WebSocketMessage[] = [];
  const send = vi.fn((msg: WebSocketMessage) => {
    messages.push(msg);
  });
  return { send, messages };
}

describe('buildRootWireConfig — envelope shape', () => {
  it('dispatch() sends a data:submit ActionEnvelope wrapped in a WS action frame', () => {
    const { send, messages } = makeFakeManager();
    const stack: SessionStackEntry[] = [makeStackItem('top', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'submit-tool' } },
    })];
    const { config: cfg } = buildRootWireConfig({
      sessionId: 'sess_1',
      appId: 'app_x',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
    });

    cfg.dispatch('submit', { email: 'user@example.com' });

    expect(messages).toHaveLength(1);
    const frame = messages[0];
    expect(frame?.type).toBe('action');
    if (frame?.type !== 'action') throw new Error('unreachable');
    const env: ActionEnvelope = frame.payload;
    expect(env.sessionId).toBe('sess_1');
    expect(env.type).toBe('data:submit');
    expect(env.stackItemId).toBe('top');
    expect(env.stackIndex).toBe(0);
    expect(env.clientSeq).toBe(1);
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    const payload = env.payload as { action: string; data: unknown; tool?: string };
    expect(payload.action).toBe('submit');
    expect(payload.data).toEqual({ email: 'user@example.com' });
    expect(payload.tool).toBe('submit-tool');
  });

  it('increments clientSeq monotonically across dispatches', () => {
    const { send, messages } = makeFakeManager();
    const stack: SessionStackEntry[] = [makeStackItem('a')];
    const { config: cfg } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
    });

    cfg.dispatch('foo', 1);
    cfg.dispatch('bar', 2);
    cfg.dispatch('baz', 3);

    const seqs = messages
      .filter((m): m is WebSocketMessage & { type: 'action' } => m.type === 'action')
      .map((m) => m.payload.clientSeq);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('buildRootWireConfig — per-item scoping via buildScopedConfig', () => {
  it('buildScopedConfig(item).dispatch targets the supplied stackItemId + tool, not the top', () => {
    const { send, messages } = makeFakeManager();
    const older = makeStackItem('older', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'older-tool' } },
    });
    const top = makeStackItem('top', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'top-tool' } },
    });
    const stack = [older, top];
    const { buildScopedConfig } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
    });

    // Post-C7c: the `.scope(item)` method on WireConfig is retired.
    // Consumers use `buildScopedConfig(item)` returned from the
    // bundle — preserves the dispatchByItem closure but doesn't
    // expose it on the public WireConfig shape.
    const scoped = buildScopedConfig({
      stackItemId: older.id,
      actionSpec: older.actionSpec,
    });
    scoped.dispatch('submit', { v: 1 });

    expect(messages).toHaveLength(1);
    const frame = messages[0];
    if (frame?.type !== 'action') throw new Error('unreachable');
    expect(frame.payload.stackItemId).toBe('older');
    expect(frame.payload.stackIndex).toBe(0); // older is at index 0
    const payload = frame.payload.payload as { tool?: string };
    expect(payload.tool).toBe('older-tool'); // NOT top-tool
  });

  it('buildScopedConfig(item).dispatch falls through to stackIndex 0 when stackItemId is not in stack', () => {
    const { send, messages } = makeFakeManager();
    const stack: SessionStackEntry[] = [makeStackItem('top')];
    const { buildScopedConfig } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
    });

    // actionSpec undefined → permissive (matches server's "no contract
    // to enforce" posture). The ghost stackItemId doesn't exist in the
    // current stack, so stackIndex falls through to 0. No top-of-stack
    // tool is borrowed — that's the load-bearing isolation claim.
    buildScopedConfig({ stackItemId: 'ghost' }).dispatch('x', 0);

    expect(messages).toHaveLength(1);
    const frame = messages[0];
    if (frame?.type !== 'action') throw new Error('unreachable');
    expect(frame.payload.stackIndex).toBe(0);
    expect(frame.payload.stackItemId).toBe('ghost');
    expect((frame.payload.payload as { tool?: string }).tool).toBeUndefined();
  });
});

describe('buildRootWireConfig — outbound validation', () => {
  it('blocks the send when the envelope violates the actionSpec', () => {
    const { send, messages } = makeFakeManager();
    const spec: ActionSpec = {
      submit: {
        label: 'Submit',
        // Minimal schema that rejects a non-object string payload on
        // the `data` field.
        schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      },
    };
    const stack: SessionStackEntry[] = [makeStackItem('top', { actionSpec: spec })];
    const onContractViolation = vi.fn();
    const { config: cfg } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
      onContractViolation,
    });

    cfg.dispatch('submit', { wrongField: 123 });

    expect(messages).toHaveLength(0);
    expect(onContractViolation).toHaveBeenCalledTimes(1);
    const err = onContractViolation.mock.calls[0]?.[0];
    expect(err?.direction).toBe('outbound-action');
  });

  it('sends when the envelope satisfies the actionSpec', () => {
    const { send, messages } = makeFakeManager();
    const spec: ActionSpec = {
      submit: {
        label: 'Submit',
        schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      },
    };
    const stack: SessionStackEntry[] = [makeStackItem('top', { actionSpec: spec })];
    const { config: cfg } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => stack,
      manager: { send },
      streamBus: new StreamBus(),
// clientToolBus retired 2026-05-11
    });

    cfg.dispatch('submit', { email: 'a@b.com' });
    expect(messages).toHaveLength(1);
  });
});

describe('StreamBus', () => {
  it('delivers envelopes to subscribers keyed by channel', () => {
    const bus = new StreamBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('progress', handler);

    const env: StreamEnvelope = {
      sessionId: 's',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 50 },
    };
    bus.emit(env);
    expect(handler).toHaveBeenCalledWith(env);

    // Unsubscribe — no more deliveries.
    unsubscribe();
    bus.emit(env);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not deliver to subscribers on other channels', () => {
    const bus = new StreamBus();
    const progressHandler = vi.fn();
    bus.subscribe('progress', progressHandler);

    bus.emit({
      sessionId: 's',
      channel: 'status',
      mode: 'replace',
      payload: 'ok',
    });
    expect(progressHandler).not.toHaveBeenCalled();
  });

  it('replays buffered reserved-channel envelopes to a late subscriber (`_ggui:preview` race)', () => {
    // Mirrors the production race: server-side replay frames for
    // `_ggui:preview` arrive on the WS BEFORE the renderer's stack
    // dispatcher mounts `mountProvisional` and subscribes. Without
    // late-subscriber replay, the preview surface stays stuck on the
    // spinner and the user sees nothing.
    const bus = new StreamBus();
    const env1: StreamEnvelope = {
      sessionId: 's',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { createSurface: { surfaceId: 'sx' } },
      seq: 1,
    };
    const env2: StreamEnvelope = {
      sessionId: 's',
      channel: '_ggui:preview',
      mode: 'append',
      payload: {
        updateComponents: { surfaceId: 'sx', components: [] },
      },
      seq: 2,
    };

    // Emit BEFORE any subscriber attaches.
    bus.emit(env1);
    bus.emit(env2);

    const late = vi.fn();
    bus.subscribe('_ggui:preview', late);

    // Late subscriber sees both buffered envelopes synchronously,
    // in arrival order.
    expect(late).toHaveBeenNthCalledWith(1, env1);
    expect(late).toHaveBeenNthCalledWith(2, env2);
    expect(late).toHaveBeenCalledTimes(2);

    // Live frames after subscribe still flow through.
    const env3: StreamEnvelope = {
      sessionId: 's',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { deleteSurface: { surfaceId: 'sx' } },
      seq: 3,
    };
    bus.emit(env3);
    expect(late).toHaveBeenNthCalledWith(3, env3);
  });

  it('replays each new subscriber on `_ggui:preview` independently', () => {
    // Two stack items each mounting their own provisional renderer
    // share the same StreamBus. Both must see the buffered preview
    // frames — the buffer is replayed per subscribe, not consumed.
    const bus = new StreamBus();
    const env: StreamEnvelope = {
      sessionId: 's',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { createSurface: { surfaceId: 'sx' } },
      seq: 1,
    };
    bus.emit(env);

    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('_ggui:preview', a);
    bus.subscribe('_ggui:preview', b);

    expect(a).toHaveBeenCalledWith(env);
    expect(b).toHaveBeenCalledWith(env);
  });

  it('does not buffer non-reserved (agent-declared) channels for late subscribers', () => {
    // Agent-declared streamSpec channels are server-replayed via the
    // `fromSeq` reconnect handshake; doubling that at the bus layer
    // would change agent contract semantics.
    const bus = new StreamBus();
    bus.emit({
      sessionId: 's',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 50 },
    });

    const late = vi.fn();
    bus.subscribe('progress', late);
    expect(late).not.toHaveBeenCalled();
  });

  it('caps the reserved-channel replay ring (FIFO eviction past the cap)', () => {
    // Boundary check on the bounded buffer — the precise cap is an
    // implementation detail, but the `oldest evicted` invariant is
    // load-bearing for the memory contract.
    const bus = new StreamBus();
    // Push a large number of frames; the cap is 256 (tests the
    // boundary by emitting more than that and asserting the most
    // recent few survive while a very-old one is gone).
    for (let i = 0; i < 300; i += 1) {
      bus.emit({
        sessionId: 's',
        channel: '_ggui:preview',
        mode: 'append',
        payload: { i },
        seq: i,
      });
    }
    const late = vi.fn();
    bus.subscribe('_ggui:preview', late);
    // Strictly fewer than 300 replayed — cap took effect.
    expect(late.mock.calls.length).toBeLessThan(300);
    // The very-first frame (seq=0) was evicted; the most-recent
    // frame (seq=299) survived.
    const seqsReplayed = late.mock.calls.map(
      (call) => (call[0] as StreamEnvelope).seq,
    );
    expect(seqsReplayed).not.toContain(0);
    expect(seqsReplayed).toContain(299);
  });

  it('keeps the inlined reserved-channel prefix in lock-step with `@ggui-ai/protocol`', async () => {
    // The bus inlines `'_ggui:'` to keep the bundle off the protocol
    // root barrel (see provisional-renderer.ts for the same trick).
    // This test locks the constant equality so a future protocol
    // refactor that renames the prefix breaks here loudly instead of
    // silently disabling reserved-channel buffering.
    const protocol = await import('@ggui-ai/protocol');
    expect(protocol.RESERVED_CHANNEL_PREFIX).toBe('_ggui:');
  });
});

describe('buildRootWireConfig — subscribe via StreamBus', () => {
  it('forwards StreamBus envelopes to subscribe handler with mode + complete', () => {
    const bus = new StreamBus();
    const { config: cfg } = buildRootWireConfig({
      sessionId: 's',
      appId: 'a',
      getStack: () => [],
      manager: { send: vi.fn() },
      streamBus: bus,
// clientToolBus retired 2026-05-11
    });

    // Post-C7c: `subscribe<N extends string>` — handler's payload type
    // is `unknown` at the base WireConfig level (tightened fallback
    // when T = DataContract). Typed callers go through
    // `useContract(contract).useStream` for payload narrowing.
    const handler = vi.fn();
    cfg.subscribe('progress', handler);

    bus.emit({
      sessionId: 's',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 25 },
    });
    bus.emit({
      sessionId: 's',
      channel: 'progress',
      mode: 'replace',
      payload: { percent: 100 },
      complete: true,
    });

    expect(handler).toHaveBeenNthCalledWith(1, {
      payload: { percent: 25 },
      mode: 'append',
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      payload: { percent: 100 },
      mode: 'replace',
      complete: true,
    });
  });
});

// `ClientToolBus` retired 2026-05-11 with the `clientCapabilities`
// reframe — browser-capability hooks own their lifecycle on the UI
// side; no central in-renderer registry remains.
// `callWiredTool` retired 2026-05-11 with the EE+ wire-shape v2 —
// `agentTools` is now a catalog the AGENT invokes, not a component
// hook surface.
