/**
 * Per-stack-item `WireConfig` factory for the renderer iframe.
 *
 * The renderer iframe uses a standalone
 * `scopeWireConfig(root, item, internals)` function plus the
 * `RootWireConfigBundle.buildScopedConfig(item)` closure returned
 * from `buildRootWireConfig` — there is no scoping method on the
 * public `WireConfig` shape.
 *
 * Why per-item scoping:
 *   - A stacked/chat-style UI keeps older cards rendered beneath the
 *     top one. A `useAction('submit')` call inside an older card MUST
 *     emit with THAT card's `stackItemId` + `tool` + `actionSpec` — not the
 *     top-of-stack's. Without per-item scoping, contract enforcement
 *     would reject cross-stack dispatches as "wrong contract" OR the
 *     wrong tool would be invoked server-side.
 *
 * Construction: the renderer builds ONE top-level bundle at boot
 * (`buildRootWireConfig`), which returns `{config, buildScopedConfig}`.
 * The runtime's `stackCtx.getScopedWireConfig` calls
 * `buildScopedConfig(item)` per stack entry; each
 * `<GguiWireProvider>` wraps a stack item with the resulting scoped
 * config.
 *
 * Outbound dispatch uses `buildActionEnvelope` (from
 * `@ggui-ai/wire`) + `validateOutboundActionEnvelope` + a direct
 * `manager.send({type:'action', payload})`.
 *
 * The `WireConfig` shape lives in `@ggui-ai/wire`. This module
 * implements against that interface.
 */
import type {
  ActionSpec,
  ActionEnvelope,
  JsonValue,
  SessionStackEntry,
  StreamEnvelope,
} from '@ggui-ai/protocol';
import {
  ClientContractViolationError,
  buildActionEnvelope,
  type WireConfig,
} from '@ggui-ai/wire';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { validateOutboundActionEnvelope } from './validation.js';

/**
 * Outbound send surface — the minimal shape wire-config calls on the
 * WS transport. Pre-B3b this read off `Pick<RendererWebSocketManager,
 * 'send'>`; post-B3b the WS lives inside `@ggui-ai/channel-client`,
 * but wire-config doesn't import the gadget directly — it consumes
 * the shape via this local type so tests can stub `{send: vi.fn()}`
 * without dragging in the channel-client types.
 *
 * Frames sent here are always `{type: 'action', payload: ...}` or
 * `{type: 'feedback', payload: ...}` envelopes — wire-config never
 * sends transport-layer frames (`ping`, `subscribe`).
 */
export interface RendererSendSurface {
  readonly send: (message: WebSocketMessage) => void;
}
import {
  defaultProtocolErrorEmitter,
  fromClientContractViolation,
  type ProtocolErrorEmitter,
} from './protocol-error.js';
import type { ObservabilityEmitter } from './observability.js';

// =============================================================================
// StreamBus — the in-renderer bridge between inbound `data` frames
// and per-component `useStream(channel)` subscribers.
// =============================================================================

/**
 * Reserved-channel namespace prefix (mirror of
 * `@ggui-ai/protocol::RESERVED_CHANNEL_PREFIX`). Inlined to avoid
 * widening the protocol import surface here — the constant is
 * load-bearing for the late-subscriber replay rule below; equality
 * with the protocol export is locked by the StreamBus tests.
 */
const RESERVED_CHANNEL_PREFIX = '_ggui:';

/**
 * Per-channel ring cap for late-subscriber replay on reserved channels.
 * Mirrors the server-side `DEFAULT_SESSION_STREAM_BUFFER_MAX` posture:
 * bounded so a long-lived iframe can't grow memory unbounded if a
 * reserved channel emits in a hot loop.
 *
 * 256 is enough headroom for the deterministic A2UI emitter (one frame
 * per fragment, ~5–15 frames per push) plus several refresh cycles, and
 * still fits comfortably in memory.
 */
const RESERVED_CHANNEL_REPLAY_MAX = 256;

/**
 * Tiny fan-out bus keyed by channel name. `subscribe.ts`'s inbound-
 * message handler pushes validated `data` envelopes here; wire's
 * `useStream(channel)` subscribes per-component via the config's
 * `subscribe()` method.
 *
 * Late-subscriber replay for reserved channels:
 *
 *   The renderer iframe boots in a strict ordering:
 *   `subscribe()` → first `ack` → render stack items → mount
 *   `mountProvisional` → it then calls `streamBus.subscribe('_ggui:
 *   preview', …)`. Server-side replay frames for `_ggui:preview` (the
 *   provisional A2UI preamble fired during the agent's `ggui_push`
 *   BEFORE the user's browser navigated to the viewer) arrive over the
 *   WS in the window between ack-resolve and the provisional mount —
 *   they hit `emit()` before any listener has subscribed. Without a
 *   bounded reserved-channel ring, those frames vanish and the preview
 *   surface stays stuck on the spinner.
 *
 *   Server-owned `_ggui:*` channels are buffered in a per-channel ring
 *   capped at {@link RESERVED_CHANNEL_REPLAY_MAX}. New subscribers
 *   receive the buffered envelopes synchronously before the unsubscribe
 *   handle returns — same mental model as the server-side
 *   `SessionStreamBuffer.replay(...)` walk over reserved channels at
 *   ack time, but mirrored at the inner bus boundary so the host
 *   transport stays portable (Claude Desktop / ChatGPT / Cursor /
 *   `<McpAppIframe>` all behave the same).
 *
 *   Agent-declared (non-reserved) channels are NOT buffered here. Their
 *   replay is the server's job — the renderer's `subscribe()` handshake
 *   pulls history per `streamSpec.replay` policy when reconnecting with
 *   `fromSeq`. Buffering them at this layer would double-count and
 *   change the semantics of agent contracts.
 *
 * No observable mutation outside the renderer boundary — the bus is
 * internal plumbing.
 */
export class StreamBus {
  private listeners = new Map<string, Set<(env: StreamEnvelope) => void>>();
  /**
   * Per-channel bounded ring of envelopes for reserved (`_ggui:*`)
   * channels only. FIFO eviction at `RESERVED_CHANNEL_REPLAY_MAX`.
   * Replayed to every new subscriber for that channel.
   */
  private reservedReplay = new Map<string, StreamEnvelope[]>();

  subscribe(channel: string, listener: (env: StreamEnvelope) => void): () => void {
    let bucket = this.listeners.get(channel);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(channel, bucket);
    }
    bucket.add(listener);
    // Replay buffered reserved-channel envelopes BEFORE returning the
    // unsubscribe handle so the new listener is fully caught up by the
    // time `subscribe()` returns. Order matches arrival order at
    // `emit()` (FIFO ring).
    if (channel.startsWith(RESERVED_CHANNEL_PREFIX)) {
      const ring = this.reservedReplay.get(channel);
      if (ring !== undefined) {
        for (const env of ring) {
          listener(env);
        }
      }
    }
    return () => {
      const current = this.listeners.get(channel);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(channel);
    };
  }

  emit(envelope: StreamEnvelope): void {
    if (envelope.channel.startsWith(RESERVED_CHANNEL_PREFIX)) {
      let ring = this.reservedReplay.get(envelope.channel);
      if (ring === undefined) {
        ring = [];
        this.reservedReplay.set(envelope.channel, ring);
      }
      ring.push(envelope);
      if (ring.length > RESERVED_CHANNEL_REPLAY_MAX) {
        // FIFO drop — keeps the most recent
        // `RESERVED_CHANNEL_REPLAY_MAX` frames. Late subscribers may
        // miss the createSurface fragment if the ring overflows (would
        // render as Spinner-stuck), but that's an upper-bound contract
        // on a bounded buffer, not a silent failure mode in practice.
        ring.shift();
      }
    }
    const bucket = this.listeners.get(envelope.channel);
    if (bucket === undefined) return;
    for (const listener of bucket) {
      listener(envelope);
    }
  }
}

// =============================================================================
// Root WireConfig construction
// =============================================================================

export interface BuildRootWireConfigOptions {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Stack snapshot reader. The config's default (unscoped) `dispatch`
   * reads the top of stack; callers route most dispatches through
   * `scopeWireConfig(root, item)` for per-item targeting, but the
   * default is kept for standalone-render paths.
   */
  readonly getStack: () => readonly SessionStackEntry[];
  /** Handle to the renderer's WS manager; used for outbound `action` + `feedback` frames. */
  readonly manager: RendererSendSurface;
  /** Shared bus for inbound stream deliveries. */
  readonly streamBus: StreamBus;
  /**
   * Optional sink for contract violations. Default: tagged
   * `console.warn`. Tests inject a recorder. Matches
   * `GguiSession.onError` semantics on the client-contract path.
   *
   * Prefer {@link onProtocolError} for new integrations — it receives
   * the widened {@link ProtocolError} union that covers every error
   * the renderer classifies (transport, auth, protocol, contract,
   * bootstrap, version, unknown). The narrow `onContractViolation`
   * sink stays for in-renderer tests that assert the raw class shape;
   * every violation is ALSO forwarded through `onProtocolError` so
   * external consumers can observe one seam.
   */
  readonly onContractViolation?: (err: ClientContractViolationError) => void;
  /**
   * Optional sink for every typed {@link ProtocolError} the renderer
   * classifies. Default: {@link defaultProtocolErrorEmitter}
   * (`console.warn` with a grep-friendly tag). The `<McpAppIframe>`
   * host wrapper wires this to its `onError` prop; session-bound
   * variants are ALSO mirrored to the `_ggui:contract-error` WS
   * envelope.
   *
   * The emitter fires for CLIENT-side contract violations (via
   * `fromClientContractViolation`). Other sites (subscribe failures,
   * upgrade-required, transport errors, server-emitted
   * contract-error envelopes) plumb through the same emitter without
   * a shape change.
   */
  readonly onProtocolError?: ProtocolErrorEmitter;
  /**
   * Optional {@link ObservabilityEmitter} sink. Fires a
   * `wired-tool-invoked` event every time {@link dispatchByItem}
   * successfully sends a wired-action envelope (i.e. the ctx's
   * resolved `tool` is populated AND outbound validation passed).
   *
   * The event is client-side — `dispatchedAt` records when the
   * envelope left the renderer, NOT when the server's router
   * completed the tool. The SERVER independently emits a
   * `wired-tool.invoked` telemetry event on its own sink for
   * operational metrics; the two surfaces are deliberately separate
   * (host inspector vs operator telemetry).
   */
  readonly onObserve?: ObservabilityEmitter;
}

/**
 * Paired root config + scope factory returned by `buildRootWireConfig`.
 *
 * {@link WireConfig} itself carries no `scope(item)` method — the
 * interface is the minimum contract generated code needs, and
 * per-item scoping is a RENDERER concern. Callers that need
 * per-item scoping — currently only the renderer's `bootProduction`
 * via `stackCtx.getScopedWireConfig` — use `buildScopedConfig(item)`
 * on the returned `RootWireConfigBundle`.
 *
 * The scope-factory is PAIRED with the root construction so the
 * `dispatchByItem` / `getStack` internals stay encapsulated — they
 * aren't exported from this module and never leak into the public
 * WireConfig shape.
 */
export interface RootWireConfigBundle {
  readonly config: WireConfig;
  /**
   * Build a per-stack-item scoped `WireConfig`. Only `dispatch` is
   * overridden — every other seam (subscribe, app/session/auth) stays
   * shared via spread from the root.
   */
  readonly buildScopedConfig: (item: {
    readonly stackItemId?: string;
    readonly contractHash?: string;
    readonly actionSpec?: ActionSpec;
  }) => WireConfig;
}

/**
 * Build the unscoped root `WireConfig` + its scope-factory closure.
 * Bootstraps the renderer's outbound emission + inbound subscription
 * seams.
 *
 * Returns a {@link RootWireConfigBundle} rather than a bare
 * `WireConfig` — the scope factory is paired with the root so
 * `dispatchByItem` internals don't leak onto the public WireConfig
 * shape. `scopeWireConfig` (the exported standalone) is the low-level
 * primitive; `buildScopedConfig` is the pre-bound convenience.
 */
export function buildRootWireConfig(
  opts: BuildRootWireConfigOptions,
): RootWireConfigBundle {
  const clientSeqBox = { current: 0 };

  function nextSeq(): number {
    clientSeqBox.current += 1;
    return clientSeqBox.current;
  }

  const emitProtocolError: ProtocolErrorEmitter =
    opts.onProtocolError ?? defaultProtocolErrorEmitter;
  const emitObserve: ObservabilityEmitter = opts.onObserve ?? (() => {});

  function surfaceViolation(err: ClientContractViolationError): void {
    // Dual emission — the narrow `onContractViolation` sink stays
    // for in-renderer tests that assert the raw class shape; the
    // typed `onProtocolError` sink receives the widened
    // ProtocolError ('kind: protocol' / code: CLIENT_CONTRACT_VIOLATION)
    // that the `<McpAppIframe>` host wrapper surfaces via `onError`.
    if (opts.onContractViolation) {
      opts.onContractViolation(err);
    } else if (opts.onProtocolError === undefined) {
      // No caller-supplied sink at all → operator-visible fallback so
      // dev consoles see the violation. Matches
      // `GguiSession.surfaceContractViolation`'s console.warn posture.
      // eslint-disable-next-line no-console
      console.warn('[ggui:contract] ' + err.message, {
        direction: err.direction,
        violations: err.violations,
      });
    }
    emitProtocolError(fromClientContractViolation(err));
  }

  function dispatchByItem(
    actionName: string,
    data: unknown,
    ctx: {
      stackItemId?: string;
      stackIndex: number;
      tool?: string;
      actionSpec?: ActionSpec;
    },
  ): void {
    const envelope = buildActionEnvelope({
      sessionId: opts.sessionId,
      type: 'data:submit',
      payload: {
        action: actionName,
        data: data as JsonValue,
        ...(ctx.tool ? { tool: ctx.tool } : {}),
      },
      stackIndex: ctx.stackIndex,
      ...(ctx.stackItemId ? { stackItemId: ctx.stackItemId } : {}),
      clientSeq: nextSeq(),
    });
    const result = validateOutboundActionEnvelope(ctx.actionSpec, envelope);
    if (!result.valid) {
      surfaceViolation(
        new ClientContractViolationError('outbound-action', result.violations),
      );
      return;
    }
    sendActionEnvelope(opts.manager, envelope);
    // Observability: a wired-tool dispatch is a `data:submit` whose
    // resolved action has a `tool` binding. Plain agent-routed actions
    // (no `tool` on the actionSpec) fire a `dispatch` activity row in
    // the console via the session-side ring buffer; only wired tools
    // get this observability event. The server separately emits the
    // operational telemetry variant on its TelemetrySink.
    if (ctx.tool !== undefined) {
      emitObserve({
        kind: 'wired-tool-invoked',
        toolName: ctx.tool,
        actionName,
        dispatchedAt: new Date().toISOString(),
      });
    }
  }

  const root: WireConfig = {
    app: { appId: opts.appId, appName: opts.appId },
    session: { sessionId: opts.sessionId, isConnected: true },
    auth: { isAuthenticated: false },
    dispatch: (actionName, data) => {
      // Unscoped fallback — resolve from top of stack. Matches
      // `GguiSession.wireConfig.dispatch` (the non-scoped path).
      const stack = opts.getStack();
      const activeItem = stack[stack.length - 1];
      const activeIndex = stack.length > 0 ? stack.length - 1 : 0;
      // McpApps + system items never carry `actionSpec` (their wire is
      // owned by their own host) — narrow before reading.
      const activeActionSpec =
        activeItem !== undefined &&
        activeItem.type !== 'mcpApps' &&
        activeItem.type !== 'system'
          ? activeItem.actionSpec
          : undefined;
      const entry = activeActionSpec?.[actionName];
      const tool = entry?.nextStep;
      dispatchByItem(actionName, data, {
        stackItemId: activeItem?.id,
        stackIndex: activeIndex,
        ...(tool !== undefined ? { tool } : {}),
        ...(activeActionSpec !== undefined
          ? { actionSpec: activeActionSpec }
          : {}),
      });
    },
    subscribe: (channelName, handler) => {
      return opts.streamBus.subscribe(channelName, (env) => {
        // `WireConfig<DataContract>.subscribe`'s handler expects a
        // `StreamDelivery<unknown>`; the bus ships the raw envelope
        // payload unmodified. The type-level `unknown` narrowing
        // lives on the caller's generic boundary (useStream /
        // useContract).
        handler({
          payload: env.payload,
          mode: env.mode,
          ...(env.complete !== undefined ? { complete: env.complete } : {}),
        });
      });
    },
    // `callWiredTool` is retired — `agentTools` is now a catalog the
    // AGENT invokes; the component never reaches the underlying tool
    // from inside the renderer. Cross-refs surface via
    // `actionSpec[*].nextStep` (event metadata) and
    // `streamSpec[*].source.tool` (channel data source).
  };

  // `WireConfig` carries no `scope(item)` method.
  // Callers that want a per-item config use `buildScopedConfig(item)`
  // on the returned bundle, which bakes in the `dispatchByItem` +
  // `getStack` internals so they never leak onto the public
  // WireConfig shape.
  const buildScopedConfig: RootWireConfigBundle['buildScopedConfig'] =
    (item) =>
      scopeWireConfig(root, item, {
        getStack: opts.getStack,
        dispatchByItem,
      });

  return { config: root, buildScopedConfig };
}

/**
 * Produce a per-item scoped `WireConfig`. The only override is
 * `dispatch` — every other seam (subscribe) stays shared.
 */
export function scopeWireConfig(
  root: WireConfig,
  item: {
    stackItemId?: string;
    contractHash?: string;
    actionSpec?: ActionSpec;
  },
  internals: {
    getStack: () => readonly SessionStackEntry[];
    dispatchByItem: (
      actionName: string,
      data: unknown,
      ctx: { stackItemId?: string; stackIndex: number; tool?: string; actionSpec?: ActionSpec },
    ) => void;
  },
): WireConfig {
  return {
    ...root,
    dispatch: (actionName, data) => {
      const entry = item.actionSpec?.[actionName];
      const tool = entry?.nextStep;
      const stack = internals.getStack();
      const idx = stack.findIndex((s) => s.id === item.stackItemId);
      internals.dispatchByItem(actionName, data, {
        ...(item.stackItemId !== undefined ? { stackItemId: item.stackItemId } : {}),
        stackIndex: idx >= 0 ? idx : 0,
        ...(tool !== undefined ? { tool } : {}),
        ...(item.actionSpec !== undefined ? { actionSpec: item.actionSpec } : {}),
      });
    },
  };
}

// =============================================================================
// Outbound envelope emission
// =============================================================================

/**
 * Send a validated action envelope over the live channel. The WS frame shape
 * is `{type:'action', payload: envelope}` — matches today's
 * `useWebSocket.sendAction` exactly, so wire-emitted dispatches from
 * the renderer are byte-equivalent to `GguiSession`-emitted ones.
 */
function sendActionEnvelope(
  manager: RendererSendSurface,
  envelope: ActionEnvelope,
): void {
  manager.send({ type: 'action', payload: envelope });
}
