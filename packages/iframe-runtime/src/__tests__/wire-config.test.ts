/**
 * Tests for the renderer's per-render `WireConfig` factory.
 *
 * Post-render-identity-collapse (2026-05-27): the per-stack-item
 * scope factory is gone. Each iframe mounts EXACTLY ONE render and
 * `buildRootWireConfig` returns a single `WireConfig` keyed by the
 * bootstrap's `sessionId`. The active render's `actionSpec` resolves
 * through the `getCurrentGguiSession` thunk on every dispatch so
 * props_update patches stay coherent without rebuilding the config.
 *
 * The audit-critical shape properties locked here:
 *   1. Action envelopes emitted by the config carry a single `sessionId`
 *      (no `stackItemId`/`stackIndex` companions) plus `clientSeq` +
 *      `schemaVersion`, and ride in a `{type:'action', payload: envelope}`
 *      WS frame. The payload is `action` + `data` ONLY — the operator-
 *      facing `tool` hint is server-derived at ledger-event build time.
 *   2. The active render's `actionSpec` resolves on every dispatch
 *      via `getCurrentGguiSession()` (validator stays coherent).
 *   3. Validation violations route through `onContractViolation` +
 *      block the outbound send.
 *   4. Stream fan-out goes through the shared StreamBus; wire's
 *      `useStream(channel)` subscribers wake up.
 *   5. Outbound emission targets `manager.send({type:'action',
 *      payload})` — no other wire frame goes out on dispatch.
 *
 * `StreamBus` itself (replay ring, channel keying, caps) is owned by
 * `@ggui-ai/wire` since the F11 collapse — its behaviour suite lives
 * in `wire/src/wire-config.test.ts`. This file pins the iframe-side
 * ADAPTER: CSP-precompiled validation, violation dual-emission, and
 * the tools/call-vs-WS transport seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted = vi.hoisted((): unknown[] => []);
vi.mock('../observability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability.js')>()),
  postObservabilityToParent: (event: unknown) => posted.push(event),
}));
import type {
  ActionEnvelope,
  ActionSpec,
  ComponentGguiSession,
  GguiSession,
} from '@ggui-ai/protocol';
import type { GguiSessionSeedInput } from '../types.js';
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
      sessionId: 'render_001',
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
    expect(env.sessionId).toBe('render_001');
    expect(env.type).toBe('data:submit');
    expect(env.clientSeq).toBe(1);
    expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    const payload = env.payload as { action: string; data: unknown };
    expect(payload.action).toBe('submit');
    expect(payload.data).toEqual({ email: 'user@example.com' });
    // No client-side `tool` hint — the agent-facing hint is derived
    // server-side from `actionSpec[name].nextStep` at event-build time.
    expect('tool' in payload).toBe(false);
  });

  it('increments clientSeq monotonically across dispatches', () => {
    const { send, messages } = makeFakeManager();
    const cfg = buildRootWireConfig({
      sessionId: 'render_001',
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
    // mid-render. The wire config MUST validate against the new spec
    // without being rebuilt.
    const { send, messages } = makeFakeManager();
    let activeRender: GguiSession = makeRender('render_001', {
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] },
        },
      },
    });
    const onContractViolation = vi.fn();
    const cfg = buildRootWireConfig({
      sessionId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => activeRender,
      manager: { send },
      streamBus: new StreamBus(),
      onContractViolation,
    });

    // Passes the v1 spec.
    cfg.dispatch('submit', { v: 1 });
    expect(messages).toHaveLength(1);
    expect(onContractViolation).not.toHaveBeenCalled();

    // Replace the render with a spec that requires a different field —
    // the SAME payload must now violate, proving per-dispatch
    // resolution through the thunk.
    activeRender = makeRender('render_001', {
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        },
      },
    });
    cfg.dispatch('submit', { v: 2 });
    expect(messages).toHaveLength(1);
    expect(onContractViolation).toHaveBeenCalledTimes(1);
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
      sessionId: 'render_001',
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
      sessionId: 'render_001',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', { email: 'a@b.com' });
    expect(messages).toHaveLength(1);
  });
});

describe('buildRootWireConfig — subscribe via StreamBus', () => {
  it('forwards StreamBus envelopes to subscribe handler with mode + complete', () => {
    const bus = new StreamBus();
    const cfg = buildRootWireConfig({
      sessionId: 'render_001',
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
});

// ggui#1178 — a card can paint and take gestures with NO action spec (a mount
// past the WS token's TTL, a host with no live channel, or an older server that
// never put the spec on the render slice). The one-shot guard then cannot know
// an action is `oneShot`, so it fails open. The runtime's obligation: name that
// once per COMPONENT render as the posted `one-shot-unenforceable` observability
// event, and let the dispatch proceed. System and mcpApps renders carry no spec
// by design and stay quiet.
describe('buildRootWireConfig — one-shot-unenforceable (ggui#1178)', () => {
  beforeEach(() => {
    posted.length = 0;
  });
  function unenforceableEvents(): unknown[] {
    return posted.filter(
      (e) => typeof e === 'object' && e !== null && 'kind' in e && e.kind === 'one-shot-unenforceable',
    );
  }

  it('a component render with no actionSpec posts one-shot-unenforceable ONCE, and every dispatch proceeds', () => {
    const { send, messages } = makeFakeManager();
    const render = makeRender('render_nospec');
    const cfg = buildRootWireConfig({
      sessionId: 'render_nospec',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', { ok: true });
    cfg.dispatch('submit', { ok: true });

    expect(messages).toHaveLength(2);
    expect(unenforceableEvents()).toEqual([
      { kind: 'one-shot-unenforceable', renderId: 'render_nospec', actionName: 'submit' },
    ]);
  });

  it('a new render is named again, once', () => {
    const { send } = makeFakeManager();
    let render = makeRender('render_a');
    const cfg = buildRootWireConfig({
      sessionId: 'render_a',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', {});
    render = makeRender('render_b');
    cfg.dispatch('submit', {});
    cfg.dispatch('submit', {});

    expect(unenforceableEvents()).toEqual([
      { kind: 'one-shot-unenforceable', renderId: 'render_a', actionName: 'submit' },
      { kind: 'one-shot-unenforceable', renderId: 'render_b', actionName: 'submit' },
    ]);
  });

  it('a component render WITH an actionSpec never names it', () => {
    const { send } = makeFakeManager();
    const render = makeRender('render_spec', { actionSpec: { submit: { label: 'Submit' } } });
    const cfg = buildRootWireConfig({
      sessionId: 'render_spec',
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', {});

    expect(unenforceableEvents()).toEqual([]);
  });

  it('a system render (no spec by design) never names it', () => {
    const { send, messages } = makeFakeManager();
    const system: GguiSessionSeedInput = { id: 'sys_1', appId: 'app_x', type: 'system', kind: 'mcp-apps-probe' };
    const cfg = buildRootWireConfig({
      sessionId: 'sys_1',
      appId: 'app_x',
      getCurrentGguiSession: () => system,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('probe', {});

    expect(messages).toHaveLength(1);
    expect(unenforceableEvents()).toEqual([]);
  });
});

// ggui#1223 — a card re-served after a reload boots a new iframe, so the wire
// guard's in-memory spent set starts empty. The render's persisted record
// (`spentOneShots: { epoch, actions }`) is what says which `oneShot` actions
// this card already spent. It counts only for the card it was written on: a
// record whose epoch is not the render's own belongs to an earlier card (a
// `ggui_update` mints a fresh one), the same gate `deriveRenderMeta` applies.
describe('buildRootWireConfig — the card’s persisted spent oneShots (ggui#1223)', () => {
  const SPEC: ActionSpec = { submit: { label: 'Submit', oneShot: true } };
  function dispatchOnce(render: GguiSession): WebSocketMessage[] {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, messages } = makeFakeManager();
    const cfg = buildRootWireConfig({
      sessionId: render.id,
      appId: 'app_x',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });
    cfg.dispatch('submit', {});
    return messages;
  }

  it('a record on the render’s own epoch spends the action: the FIRST gesture after reload is stopped', () => {
    const render = makeRender('r_spent', {
      actionSpec: SPEC,
      epoch: 2,
      spentOneShots: { epoch: 2, actions: ['submit'] },
    });
    expect(dispatchOnce(render)).toHaveLength(0);
  });

  it('a record from an EARLIER card (epoch ≠ the render’s) does not count: the fresh card fires', () => {
    const render = makeRender('r_fresh', {
      actionSpec: SPEC,
      epoch: 3,
      spentOneShots: { epoch: 2, actions: ['submit'] },
    });
    expect(dispatchOnce(render)).toHaveLength(1);
  });

  it('an absent epoch reads as 0, as everywhere else', () => {
    const render = makeRender('r_zero', {
      actionSpec: SPEC,
      spentOneShots: { epoch: 0, actions: ['submit'] },
    });
    expect(dispatchOnce(render)).toHaveLength(0);
  });
});
