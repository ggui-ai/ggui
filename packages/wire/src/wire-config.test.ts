/**
 * Tests for the shared `WireConfig` pipeline — `buildWireConfig` (the
 * ONE envelope-build → validate → emit implementation both first-party
 * renderers compose) and `StreamBus` (the bus with the bounded
 * reserved-channel replay ring).
 *
 * The renderer-side adapters keep their own suites
 * (`@ggui-ai/iframe-runtime`'s wire-config tests pin the tools/call-vs-WS
 * transport seam; `@ggui-ai/react`'s GguiRender tests pin the
 * live-channel wiring) — this file pins the shared core's contract:
 *
 *   1. Action envelopes carry a single `sessionId` plus `clientSeq` +
 *      `schemaVersion`; the payload is `action` + `data` ONLY — the
 *      operator-facing `tool` hint is server-derived at ledger-event
 *      build time.
 *   2. The active render's `actionSpec` resolves on every dispatch via
 *      the `getActiveActionSpec` thunk (validator stays coherent).
 *   3. Validation violations route through `onViolation` + block the
 *      emit.
 *   4. Stream fan-out goes through the StreamBus; reserved (`_ggui:*`)
 *      channels replay to late subscribers from a bounded FIFO ring,
 *      agent-declared channels do not.
 *   5. `nextClientSeq` injection lets a renderer share one
 *      per-session counter across emission sites.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ActionEnvelope,
  ActionSpec,
  StreamEnvelope,
  ValidationResult,
} from '@ggui-ai/protocol';
import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import { buildWireConfig, StreamBus } from './wire-config';
import type { BuildWireConfigOptions } from './wire-config';

function makeConfig(
  overrides: Partial<BuildWireConfigOptions> = {},
): {
  emitted: ActionEnvelope[];
  violations: unknown[];
  cfg: ReturnType<typeof buildWireConfig>;
} {
  const emitted: ActionEnvelope[] = [];
  const violations: unknown[] = [];
  const cfg = buildWireConfig({
    app: { appId: 'app_x', appName: 'app_x' },
    render: { sessionId: 'render_001', isConnected: true },
    auth: { isAuthenticated: false },
    getActiveActionSpec: () => undefined,
    onViolation: (err) => violations.push(err),
    emitEnvelope: (env) => emitted.push(env),
    streamBus: new StreamBus(),
    ...overrides,
  });
  return { emitted, violations, cfg };
}

describe('buildWireConfig — envelope shape', () => {
  it('dispatch() emits a canonical data:submit ActionEnvelope', () => {
    const { emitted, cfg } = makeConfig();

    cfg.dispatch('submit', { email: 'user@example.com' });

    expect(emitted).toHaveLength(1);
    const env = emitted[0]!;
    expect(env.sessionId).toBe('render_001');
    expect(env.type).toBe('data:submit');
    expect(env.clientSeq).toBe(1);
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    const payload = env.payload as { action: string; data: unknown };
    expect(payload.action).toBe('submit');
    expect(payload.data).toEqual({ email: 'user@example.com' });
    // No client-side `tool` hint — the operator-facing hint is derived
    // server-side from `actionSpec[name].nextStep` at ingress.
    expect('tool' in payload).toBe(false);
  });

  it('increments the internal clientSeq monotonically across dispatches', () => {
    const { emitted, cfg } = makeConfig();
    cfg.dispatch('foo', 1);
    cfg.dispatch('bar', 2);
    cfg.dispatch('baz', 3);
    expect(emitted.map((e) => e.clientSeq)).toEqual([1, 2, 3]);
  });

  it('uses the injected nextClientSeq when a renderer shares its counter', () => {
    // `<GguiRender>` also emits envelopes outside the config (its
    // imperative `api.action`) — injecting the shared counter keeps
    // per-session sequencing monotonic across both emission sites.
    let seq = 41;
    const { emitted, cfg } = makeConfig({
      nextClientSeq: () => {
        seq += 1;
        return seq;
      },
    });
    cfg.dispatch('foo', 1);
    cfg.dispatch('bar', 2);
    expect(emitted.map((e) => e.clientSeq)).toEqual([42, 43]);
  });
});

describe('buildWireConfig — actionSpec resolution + validation', () => {
  const SPEC_V: ActionSpec = {
    submit: {
      label: 'Submit',
      schema: {
        type: 'object',
        properties: { v: { type: 'number' } },
        required: ['v'],
      },
    },
  };
  const SPEC_EMAIL: ActionSpec = {
    submit: {
      label: 'Submit',
      schema: {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      },
    },
  };

  it('resolves the actionSpec through the thunk on EVERY dispatch (not snapshotted)', () => {
    let activeSpec: ActionSpec = SPEC_V;
    const { emitted, violations, cfg } = makeConfig({
      getActiveActionSpec: () => activeSpec,
    });

    cfg.dispatch('submit', { v: 1 });
    expect(emitted).toHaveLength(1);
    expect(violations).toHaveLength(0);

    // Replace the spec — the SAME payload must now violate, proving
    // per-dispatch resolution through the thunk.
    activeSpec = SPEC_EMAIL;
    cfg.dispatch('submit', { v: 2 });
    expect(emitted).toHaveLength(1);
    expect(violations).toHaveLength(1);
  });

  it('blocks the emit and surfaces an outbound-action violation on schema mismatch', () => {
    const { emitted, violations, cfg } = makeConfig({
      getActiveActionSpec: () => SPEC_EMAIL,
    });

    cfg.dispatch('submit', { wrongField: 123 });

    expect(emitted).toHaveLength(0);
    expect(violations).toHaveLength(1);
    const err = violations[0] as { direction?: string };
    expect(err.direction).toBe('outbound-action');
  });

  it('uses an injected validateEnvelope seam when provided', () => {
    // The iframe runtime injects its precompiled-validator variant so
    // dispatch never trips the iframe's no-`unsafe-eval` CSP. The seam
    // contract: receives (resolved spec, built envelope), and its
    // verdict decides emit-vs-violate.
    const validateEnvelope = vi.fn(
      (
        _actionSpec: ActionSpec | undefined,
        _envelope: ActionEnvelope,
      ): ValidationResult => ({
        valid: false,
        violations: [],
      }),
    );
    const { emitted, violations, cfg } = makeConfig({
      getActiveActionSpec: () => SPEC_EMAIL,
      validateEnvelope,
    });

    cfg.dispatch('submit', { email: 'a@b.com' });

    expect(validateEnvelope).toHaveBeenCalledTimes(1);
    expect(validateEnvelope.mock.calls[0]?.[0]).toBe(SPEC_EMAIL);
    expect(emitted).toHaveLength(0);
    expect(violations).toHaveLength(1);
  });
});

describe('buildWireConfig — subscribe via StreamBus', () => {
  it('forwards StreamBus envelopes to the handler as StreamDelivery (payload/mode/complete)', () => {
    const bus = new StreamBus();
    const { cfg } = makeConfig({ streamBus: bus });

    const handler = vi.fn();
    cfg.subscribe('progress', handler);

    bus.emit({
      sessionId: 'render_001',
      channel: 'progress',
      mode: 'append',
      payload: { percent: 25 },
    });
    bus.emit({
      sessionId: 'render_001',
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

  it('unsubscribe stops deliveries', () => {
    const bus = new StreamBus();
    const { cfg } = makeConfig({ streamBus: bus });
    const handler = vi.fn();
    const unsubscribe = cfg.subscribe('progress', handler);
    unsubscribe();
    bus.emit({
      sessionId: 'render_001',
      channel: 'progress',
      mode: 'append',
      payload: 1,
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('StreamBus', () => {
  it('delivers envelopes to subscribers keyed by channel', () => {
    const bus = new StreamBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('progress', handler);

    const env: StreamEnvelope = {
      sessionId: 'render_001',
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
      sessionId: 'render_001',
      channel: 'status',
      mode: 'replace',
      payload: 'ok',
    });
    expect(progressHandler).not.toHaveBeenCalled();
  });

  it('replays buffered reserved-channel envelopes to a late subscriber (`_ggui:preview` race)', () => {
    // Mirrors the production race: replay frames for `_ggui:preview`
    // arrive BEFORE the provisional surface mounts and subscribes.
    // Without late-subscriber replay, the preview surface stays stuck
    // on the spinner and the user sees nothing.
    const bus = new StreamBus();
    const env1: StreamEnvelope = {
      sessionId: 'render_001',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { createSurface: { surfaceId: 'sx' } },
      seq: 1,
    };
    const env2: StreamEnvelope = {
      sessionId: 'render_001',
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
      sessionId: 'render_001',
      channel: '_ggui:preview',
      mode: 'append',
      payload: { deleteSurface: { surfaceId: 'sx' } },
      seq: 3,
    };
    bus.emit(env3);
    expect(late).toHaveBeenNthCalledWith(3, env3);
  });

  it('replays each new subscriber on `_ggui:preview` independently', () => {
    // Two surfaces that share the same StreamBus must each see the
    // buffered preview frames — the buffer is replayed per subscribe,
    // not consumed.
    const bus = new StreamBus();
    const env: StreamEnvelope = {
      sessionId: 'render_001',
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
      sessionId: 'render_001',
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
    for (let i = 0; i < 300; i += 1) {
      bus.emit({
        sessionId: 'render_001',
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
});
