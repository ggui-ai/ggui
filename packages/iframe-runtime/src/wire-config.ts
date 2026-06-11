/**
 * Per-render `WireConfig` factory for the renderer iframe.
 *
 * The renderer iframe mounts EXACTLY ONE {@link GguiSession} per iframe
 * post-render-identity-collapse (2026-05-27). There is no per-item
 * scoping factory anymore — the WireConfig is built once at boot,
 * keyed by the bootstrap's `sessionId`, and the active render's
 * `actionSpec` is wired in via the {@link buildRootWireConfig}'s
 * `getCurrentGguiSession` thunk.
 *
 * The envelope-build → validate → emit pipeline and the bus-backed
 * subscribe seam live in `@ggui-ai/wire`'s shared `buildWireConfig`
 * (one implementation for every first-party renderer — see the MCP
 * Apps Compliance principle). This module is the iframe-side adapter:
 * it injects the CSP-safe precompiled outbound validator, the
 * ProtocolError dual-emission policy, and the tools/call-vs-WS
 * dispatch transport.
 */
import type { ActionEnvelope, GguiSession } from '@ggui-ai/protocol';
import type { GguiSessionSeedInput } from './types.js';
import {
  ClientContractViolationError,
  buildWireConfig,
  StreamBus,
  type WireConfig,
} from '@ggui-ai/wire';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { validateOutboundActionEnvelope } from './validation.js';

/**
 * Outbound send surface — the minimal shape wire-config calls on the
 * WS transport. Pre-B3b this read off `Pick<RendererWebSocketManager,
 * 'send'>`; post-B3b the WS lives inside `@ggui-ai/live-channel`,
 * but wire-config doesn't import the library directly — it consumes
 * the shape via this local type so tests can stub `{send: vi.fn()}`
 * without dragging in the live-channel types.
 *
 * Frames sent here are always `{type: 'action', payload: ...}`
 * envelopes — wire-config never sends transport-layer frames
 * (`ping`, `subscribe`).
 */
export interface RendererSendSurface {
  readonly send: (message: WebSocketMessage) => void;
}
import {
  defaultProtocolErrorEmitter,
  fromClientContractViolation,
  type ProtocolErrorEmitter,
} from './protocol-error.js';

// `StreamBus` (and its bounded reserved-channel replay ring) was
// hoisted into `@ggui-ai/wire` so `<GguiRender>` and this runtime share
// one implementation. Re-exported for the runtime's internal modules.
export { StreamBus };

// =============================================================================
// Root WireConfig construction
// =============================================================================

export interface BuildRootWireConfigOptions {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Read the currently-mounted {@link GguiSession}. The config's `dispatch`
   * resolves the active render's `actionSpec` through this thunk so
   * the outbound validator stays coherent across props_update patches
   * (which replace the render reference) without rebuilding the
   * WireConfig.
   */
  readonly getCurrentGguiSession: () => GguiSession | GguiSessionSeedInput | null;
  /** Handle to the renderer's WS manager; used for outbound `action` frames. */
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
   * the renderer classifies (transport, auth, protocol,
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
   * host wrapper wires this to its `onError` prop.
   *
   * The emitter fires for CLIENT-side contract violations (via
   * `fromClientContractViolation`). Other sites (subscribe failures,
   * upgrade-required, transport errors) plumb through the same
   * emitter without a shape change.
   */
  readonly onProtocolError?: ProtocolErrorEmitter;
  /**
   * Optional outbound action sink. When provided, REPLACES the
   * default WS-frame send (`manager.send({type:'action', payload})`).
   *
   * The WS live-channel exists for streamSpec subscriptions (inbound
   * `ggui_emit` fanout + `props_update` + `render` + `data`
   * + `drain_ack` + `channel_payload`). For an MCP-Apps embed, user
   * actions belong on the host relay: per spec §401 the iframe relays
   * `tools/call:ggui_runtime_submit_action` through the host (the
   * `_meta.ui.visibility:['app']` channel), and the server's MCP
   * handler appends to `pendingEventConsumer` so `ggui_consume`
   * wakes the agent. A cross-host iframe cannot assume a reachable
   * WS endpoint at all, so production MCP-Apps callers MUST supply
   * this option.
   *
   * The default WS-frame send reaches the agent only on servers whose
   * live channel bridges WS `data:submit` actions onto the same
   * pending-events pipe (first-party `createGguiServer` does — see
   * `GguiSessionChannelOptions.pendingEventConsumer`); it remains the
   * seam tests and direct-WS callers exercise.
   *
   * Called AFTER outbound validation passes. Receives the validated
   * {@link ActionEnvelope}; caller extracts payload.action +
   * payload.data + slice meta to route via the host's tools/call
   * relay (see iframe-runtime's `routeDispatch`).
   */
  readonly onDispatchEnvelope?: (envelope: ActionEnvelope) => void;
}

/**
 * Build the per-render `WireConfig` for the iframe runtime.
 * Bootstraps the renderer's outbound emission + inbound subscription
 * seams. Returns a `WireConfig` keyed by the bootstrap's `sessionId`;
 * the active render's `actionSpec` is resolved through the
 * {@link BuildRootWireConfigOptions.getCurrentGguiSession} thunk on every
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
  const emitProtocolError: ProtocolErrorEmitter =
    opts.onProtocolError ?? defaultProtocolErrorEmitter;

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

  return buildWireConfig({
    app: { appId: opts.appId, appName: opts.appId },
    render: { sessionId: opts.sessionId, isConnected: true },
    auth: { isAuthenticated: false },
    // Resolve the active render's actionSpec on every dispatch.
    // Per-render lifecycle: props_update patches replace the render
    // reference; reading through the thunk keeps the outbound
    // validator coherent without rebuilding the config.
    getActiveActionSpec: () => {
      const currentRender = opts.getCurrentGguiSession();
      return currentRender !== null &&
        currentRender.type !== 'mcpApps' &&
        currentRender.type !== 'system'
        ? currentRender.actionSpec
        : undefined;
    },
    // The iframe's precompiled-validator variant — the dispatch never
    // trips the iframe's no-`unsafe-eval` CSP.
    validateEnvelope: validateOutboundActionEnvelope,
    onViolation: surfaceViolation,
    emitEnvelope: (envelope) => {
      if (opts.onDispatchEnvelope !== undefined) {
        // Spec-canonical path — the iframe-runtime's LIVE-mode boot
        // wires this to `routeDispatch`, which postMessages
        // `tools/call:ggui_runtime_submit_action` through the MCP-Apps
        // host relay. The default WS-frame send below is retained for
        // tests + direct-WS callers that don't relay tools/call.
        opts.onDispatchEnvelope(envelope);
      } else {
        sendActionEnvelope(opts.manager, envelope);
      }
    },
    streamBus: opts.streamBus,
  });
}

// =============================================================================
// Outbound envelope emission
// =============================================================================

/**
 * Send a validated action envelope over the live channel. The WS frame shape
 * is `{type:'action', payload: envelope}` — matches `useWebSocket.sendAction`
 * exactly, so wire-emitted dispatches from the renderer are
 * byte-equivalent to `GguiRender`-emitted ones.
 */
function sendActionEnvelope(
  manager: RendererSendSurface,
  envelope: ActionEnvelope,
): void {
  manager.send({ type: 'action', payload: envelope });
}
