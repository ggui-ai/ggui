/**
 * Tests for the renderer's per-render `WireConfig` factory.
 *
 * Post-render-identity-collapse (2026-05-27): the per-stack-item
 * scope factory is gone. Each iframe mounts EXACTLY ONE render and
 * `buildRootWireConfig` returns a single `WireConfig` keyed by the
 * bootstrap's `renderId`. The active render's `actionSpec` resolves
 * through the `getCurrentGguiSession` thunk on every dispatch so
 * props_update patches stay coherent without rebuilding the config.
 *
 * The audit-critical shape properties locked here:
 *   1. Action envelopes emitted by the config carry `renderId` (not
 *      `sessionId`/`stackItemId`/`stackIndex`) plus `clientSeq` +
 *      `schemaVersion`, and ride in a `{type:'action', payload: envelope}`
 *      WS frame.
 *   2. The active render's `actionSpec[name].nextStep` resolves on
 *      every dispatch via `getCurrentGguiSession()`.
 *   3. Validation violations route through `onContractViolation` +
 *      block the outbound send.
 *   4. Stream fan-out goes through the in-renderer StreamBus; wire's
 *      `useStream(channel)` subscribers wake up.
 *   5. Outbound emission targets `manager.send({type:'action',
 *      payload})` — no other wire frame goes out on dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ActionEnvelope,
  ActionSpec,
  ComponentGguiSession,
  GguiSession,
  StreamEnvelope,
} from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import {
  buildRootWireConfig,
  StreamBus,
} from '../wire-config.js';

function makeRender(
  id: string,
  overrides: Partial<ComponentGguiSession> = {},
): GguiSession {
  return {
    id,
    appId: 'app_x',
    componentCode: '/* unused */',
    description: `render ${id}`,
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
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
    const render = makeRender('render_001', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'submit-tool' } },
    });
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', { email: 'user@example.com' });

    expect(messages).toHaveLength(1);
    const frame = messages[0];
    expect(frame?.type).toBe('action');
    if (frame?.type !== 'action') throw new Error('unreachable');
    const env: ActionEnvelope = frame.payload;
    expect(env.renderId).toBe('render_001');
    expect(env.type).toBe('data:submit');
    expect(env.clientSeq).toBe(1);
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    const payload = env.payload as { action: string; data: unknown; tool?: string };
    expect(payload.action).toBe('submit');
    expect(payload.data).toEqual({ email: 'user@example.com' });
    expect(payload.tool).toBe('submit-tool');
  });

  it('increments clientSeq monotonically across dispatches', () => {
    const { send, messages } = makeFakeManager();
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => makeRender('render_001'),
      manager: { send },
      streamBus: new StreamBus(),
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

describe('buildRootWireConfig — active actionSpec resolution', () => {
  it('reads the active render\'s actionSpec on every dispatch (not snapshotted)', () => {
    // Mutate the render reference returned by `getCurrentGguiSession` to
    // simulate a props_update / re-mount that replaces actionSpec
    // mid-render. The wire config MUST see the new spec without
    // being rebuilt.
    const { send, messages } = makeFakeManager();
    let activeRender: GguiSession = makeRender('render_001', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'tool-v1' } },
    });
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => activeRender,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', { v: 1 });
    activeRender = makeRender('render_001', {
      actionSpec: { submit: { label: 'Submit', nextStep: 'tool-v2' } },
    });
    cfg.dispatch('submit', { v: 2 });

    const tools = messages
      .filter((m): m is WebSocketMessage & { type: 'action' } => m.type === 'action')
      .map((m) => {
        const p = m.payload.payload as { tool?: string };
        return p.tool;
      });
    expect(tools).toEqual(['tool-v1', 'tool-v2']);
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
    const render = makeRender('render_001', { actionSpec: spec });
    const onContractViolation = vi.fn();
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
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
    const render = makeRender('render_001', { actionSpec: spec });
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
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
      renderId: 'render_001',
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
      renderId: 'render_001',
      channel: 'status',
      mode: 'replace',
      payload: 'ok',
    });
    expect(progressHandler).not.toHaveBeenCalled();
  });

  it('replays buffered reserved-channel envelopes to a late subscriber (`_ggui:preview` race)', () => {
    // Mirrors the production race: server-side replay frames for
    // `_ggui:preview` arrive on the WS BEFORE the renderer's dispatcher
    // mounts `mountProvisional` and subscribes. Without
    // late-subscriber replay, the preview surface stays stuck on the
    // spinner and the user sees nothing.
    const bus = new StreamBus();
    const env1: StreamEnvelope = {
      renderId: 'render_001',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { createSurface: { surfaceId: 'sx' } },
      seq: 1,
    };
    const env2: StreamEnvelope = {
      renderId: 'render_001',
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
      renderId: 'render_001',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { deleteSurface: { surfaceId: 'sx' } },
      seq: 3,
    };
    bus.emit(env3);
    expect(late).toHaveBeenNthCalledWith(3, env3);
  });

  it('replays each new subscriber on `_ggui:preview` independently', () => {
    // Two iframes that share the same StreamBus must each see the
    // buffered preview frames — the buffer is replayed per subscribe,
    // not consumed.
    const bus = new StreamBus();
    const env: StreamEnvelope = {
      renderId: 'render_001',
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
      renderId: 'render_001',
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
        renderId: 'render_001',
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
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => null,
      manager: { send: vi.fn() },
      streamBus: bus,
    });

    // Handler's payload type is `unknown` at the base WireConfig
    // level (tightened fallback when T = DataContract). Typed callers
    // go through `useContract(contract).useStream` for payload
    // narrowing.
    const handler = vi.fn();
    cfg.subscribe('progress', handler);

    bus.emit({
      renderId: 'render_001',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 25 },
    });
    bus.emit({
      renderId: 'render_001',
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
