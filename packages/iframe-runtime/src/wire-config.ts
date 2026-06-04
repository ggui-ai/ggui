/**
 * Per-render `WireConfig` factory for the renderer iframe.
 *
 * The renderer iframe mounts EXACTLY ONE {@link Render} per iframe
 * post-render-identity-collapse (2026-05-27). There is no per-item
 * scoping factory anymore — the WireConfig is built once at boot,
 * keyed by the bootstrap's `renderId`, and the active render's
 * `actionSpec` is wired in via the {@link buildRootWireConfig}'s
 * `getCurrentRender` thunk.
 *
 * Outbound dispatch uses `buildActionEnvelope` (from
 * `@ggui-ai/wire`) + `validateOutboundActionEnvelope` + a direct
 * `manager.send({type:'action', payload})`.
 *
 * The `WireConfig` shape lives in `@ggui-ai/wire`. This module
 * implements against that interface.
 */
import type {
  ActionEnvelope,
  JsonValue,
  Render,
  StreamEnvelope,
} from '@ggui-ai/protocol';
import type { RenderSeedInput } from './types.js';
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
 * 'send'>`; post-B3b the WS lives inside `@ggui-ai/live-channel`,
 * but wire-config doesn't import the gadget directly — it consumes
 * the shape via this local type so tests can stub `{send: vi.fn()}`
 * without dragging in the live-channel types.
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
 * per fragment, ~5–15 frames per render) plus several refresh cycles, and
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
 *   `subscribe()` → first `ack` → fold the render → mount
 *   `mountProvisional` → it then calls `streamBus.subscribe('_ggui:
 *   preview', …)`. Server-side replay frames for `_ggui:preview` (the
 *   provisional A2UI preamble fired during the agent's `ggui_render`
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
 *   `RenderStreamBuffer.replay(...)` walk over reserved channels at
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
  readonly renderId: string;
  readonly appId: string;
  /**
   * Read the currently-mounted {@link Render}. The config's `dispatch`
   * resolves the active render's `actionSpec` through this thunk so
   * the `tool` + outbound validator stay coherent across props_update
   * patches (which replace the render reference) without rebuilding
   * the WireConfig.
   */
  readonly getCurrentRender: () => Render | RenderSeedInput | null;
  /** Handle to the renderer's WS manager; used for outbound `action` + `feedback` frames. */
  readonly manager: RendererSendSurface;
  /** Shared bus for inbound stream deliveries. */
  readonly streamBus: StreamBus;
  /**
   * Optional sink for contract violations. Default: tagged
   * `console.warn`. Tests inject a recorder. Matches
   * `GguiRender.onError` semantics on the client-contract path.
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
   * host wrapper wires this to its `onError` prop; render-bound
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
  /**
   * Optional outbound action sink. When provided, REPLACES the
   * default WS-frame send (`manager.send({type:'action', payload})`).
   *
   * The WS live-channel exists for streamSpec subscriptions (inbound
   * `ggui_emit` fanout + `props_update` + `render` + `data` + `feedback`
   * + `drain_ack` + `channel_payload`). Outbound user actions belong
   * on a different pipe — per MCP-Apps spec §401, the iframe relays
   * `tools/call:ggui_runtime_submit_action` through the host (the
   * `_meta.ui.visibility:['app']` channel), and the server's MCP
   * handler appends to `pendingEventConsumer` so `ggui_consume`
   * wakes the agent.
   *
   * The default `manager.send({type:'action'})` path writes to the
   * render ledger only — it has no downstream consumer in OSS (no
   * `wiredActionRouter`, no bridge to `pendingEventConsumer`).
   * Production callers MUST supply this option to reach the agent.
   *
   * Called AFTER outbound validation passes. Receives the validated
   * {@link ActionEnvelope}; caller extracts payload.action +
   * payload.data + slice meta to route via the host's tools/call
   * relay (see iframe-runtime's `routeDispatch`).
   *
   * Tests omit this opt to exercise the legacy WS-frame path.
   */
  readonly onDispatchEnvelope?: (envelope: ActionEnvelope) => void;
}

/**
 * Build the per-render `WireConfig` for the iframe runtime.
 * Bootstraps the renderer's outbound emission + inbound subscription
 * seams. Returns a `WireConfig` keyed by the bootstrap's `renderId`;
 * the active render's `actionSpec` is resolved through the
 * {@link BuildRootWireConfigOptions.getCurrentRender} thunk on every
 * dispatch so props_update patches don't require rebuilding the
 * config.
 *
 * Post-render-identity-collapse (2026-05-27): no per-item scope
 * factory — each iframe mounts exactly one render. The earlier
 * `RootWireConfigBundle` / `scopeWireConfig` / `buildScopedConfig`
 * indirection collapsed to a single `WireConfig`.
 */
export function buildRootWireConfig(
  opts: BuildRootWireConfigOptions,
): WireConfig {
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
      // `GguiRender.surfaceContractViolation`'s console.warn posture.
      // eslint-disable-next-line no-console
      console.warn('[ggui:contract] ' + err.message, {
        direction: err.direction,
        violations: err.violations,
      });
    }
    emitProtocolError(fromClientContractViolation(err));
  }

  return {
    app: { appId: opts.appId, appName: opts.appId },
    render: { renderId: opts.renderId, isConnected: true },
    auth: { isAuthenticated: false },
    dispatch: (actionName, data) => {
      // Resolve the active render's actionSpec on every dispatch.
      // Per-render lifecycle: props_update patches replace the render
      // reference; reading through the thunk keeps the tool binding
      // + outbound validator coherent without rebuilding the config.
      const currentRender = opts.getCurrentRender();
      const activeActionSpec =
        currentRender !== null &&
        currentRender.type !== 'mcpApps' &&
        currentRender.type !== 'system'
          ? currentRender.actionSpec
          : undefined;
      const entry = activeActionSpec?.[actionName];
      const tool = entry?.nextStep;

      const envelope = buildActionEnvelope({
        renderId: opts.renderId,
        type: 'data:submit',
        payload: {
          action: actionName,
          data: data as JsonValue,
          ...(tool ? { tool } : {}),
        },
        clientSeq: nextSeq(),
      });
      const result = validateOutboundActionEnvelope(activeActionSpec, envelope);
      if (!result.valid) {
        surfaceViolation(
          new ClientContractViolationError('outbound-action', result.violations),
        );
        return;
      }
      if (opts.onDispatchEnvelope !== undefined) {
        // Spec-canonical path — the iframe-runtime's LIVE-mode boot
        // wires this to `routeDispatch`, which postMessages
        // `tools/call:ggui_runtime_submit_action` through the MCP-Apps
        // host relay. The default WS-frame send below is retained for
        // tests + legacy callers that don't relay tools/call.
        opts.onDispatchEnvelope(envelope);
      } else {
        sendActionEnvelope(opts.manager, envelope);
      }
      // Observability: a wired-tool dispatch is a `data:submit` whose
      // resolved action has a `tool` binding. Plain agent-routed actions
      // (no `tool` on the actionSpec) fire a `dispatch` activity row in
      // the console via the render-side ring buffer; only wired tools
      // get this observability event. The server separately emits the
      // operational telemetry variant on its TelemetrySink.
      if (tool !== undefined) {
        emitObserve({
          kind: 'wired-tool-invoked',
          toolName: tool,
          actionName,
          dispatchedAt: new Date().toISOString(),
        });
      }
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
}

// =============================================================================
// Outbound envelope emission
// =============================================================================

/**
 * Send a validated action envelope over the live channel. The WS frame shape
 * is `{type:'action', payload: envelope}` — matches today's
 * `useWebSocket.sendAction` exactly, so wire-emitted dispatches from
 * the renderer are byte-equivalent to `GguiRender`-emitted ones.
 */
function sendActionEnvelope(
  manager: RendererSendSurface,
  envelope: ActionEnvelope,
): void {
  manager.send({ type: 'action', payload: envelope });
}
