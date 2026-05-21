/**
 * Public interface surface for `@ggui-ai/host-streams`.
 *
 * Type-only exports. The runtime implementation (WS open, polling
 * fallback, postMessage routing, reconnect ladder) lives behind
 * these interfaces and is not yet shipped.
 *
 * @public
 */

import type { JsonObject, JsonValue } from '@ggui-ai/protocol';

/**
 * Host-side MCP tool invocation closure. Used for the polling-only
 * branch + as the fallback transport when WS is unavailable for a
 * given tool.
 *
 * The host owns its own MCP client; this is the seam the manager
 * uses without taking a peer dep on a specific client implementation.
 * Sample-agent's existing `/relay/tools-call` endpoint can plug in
 * via a thin closure that wraps `fetch`.
 *
 * Returns the tool's output verbatim (no envelope wrapping). On
 * tool failure SHOULD throw — the manager catches + emits a
 * `stream-error` postMessage to the affected iframe.
 */
export interface HostMcpToolCaller {
  (name: string, args: JsonObject): Promise<JsonValue>;
}

/**
 * WS endpoint configuration. Optional — hosts that don't open a WS
 * (claude.ai, simple integrations) leave this absent and run
 * polling-only.
 */
export interface HostStreamWsConfig {
  /**
   * Absolute WebSocket URL the host connects to. Path typically
   * `/ws` on the ggui server's public-base-url. Auth lives on the
   * bearer or in the URL itself per server config.
   */
  readonly url: string;
  /**
   * Bearer credential included on the `Sec-WebSocket-Protocol`
   * header or as a URL query param, depending on the server's
   * accept policy. `mintBootstrap`'s `token` is the typical
   * supplier; for host-mediated this rotates per-session in the
   * implementation phase.
   */
  readonly bearer?: string;
  /**
   * Reconnect ladder cap (ms). Exponential backoff 1s → 2s → 4s → …
   * capped here. Defaults to 60_000 (60s) to match the existing
   * `RendererWebSocketManager` cap.
   */
  readonly maxBackoffMs?: number;
}

/**
 * Per-iframe binding handle. Identifies the (session, app, stack-
 * item) tuple the bound iframe is rendering — the manager uses
 * these to scope subscriptions when an iframe announces a channel
 * (the `stream-subscribe` notification's stackItemId MUST match;
 * mismatches are silently dropped to prevent cross-stack
 * subscription leaks).
 */
export interface BindIframeOptions {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Active stack-item id. Updated by the host when a push/update
   * causes a stack rotation — call `bindIframe` again with the new
   * id; the manager unsubscribes the prior id's channels and
   * accepts the new id's subscribe announcements.
   *
   * The host can also call `manager.rebindStackItem(iframe, newId)`
   * if it prefers a thinner update path. Both paths converge on
   * the same subscription-management primitive.
   */
  readonly stackItemId: string;
  /**
   * Optional allowlist of tool names this iframe is permitted to
   * subscribe to. Default: every channel the iframe announces.
   * Hosts that want to gate iframe subscriptions to a known set
   * (e.g., per-app capability declaration) set this; the manager
   * silently drops `stream-subscribe` announcements outside the
   * allowlist + emits `stream-error code='auth_rejected'`.
   */
  readonly allowedTools?: readonly string[];
}

/**
 * Returned from `bindIframe`. Idempotent — calling more than once
 * is a no-op. Drops every subscription bound to this iframe + stops
 * listening for its postMessages.
 */
export type UnbindIframe = () => void;

/**
 * Operational events the manager surfaces for host-side telemetry.
 * Non-throwing fire-and-forget — implementations MUST NOT block on
 * sink return.
 */
export interface HostStreamObservabilityEvent {
  readonly kind:
    | 'ws-connected'
    | 'ws-disconnected'
    | 'ws-reconnect-attempt'
    | 'subscription-registered'
    | 'subscription-dropped'
    | 'transport-fallback-to-polling'
    | 'transport-restored-to-ws'
    | 'stream-error';
  readonly timestamp: string;
  readonly details?: Record<string, JsonValue>;
}

/**
 * Manager configuration. Passed to `createHostStreamManager`.
 */
export interface HostStreamManagerConfig {
  /** Optional WS endpoint config. Absent = polling-only. */
  readonly ws?: HostStreamWsConfig;
  /** Required MCP tool caller for the polling-only branch. */
  readonly callMcpTool: HostMcpToolCaller;
  /**
   * Allowlist of `tool` names the server can WS-fan-out for. Mirrors
   * `serverCapabilities.streamWebSocketLocalTools` on the handshake.
   * When absent, every channel polls regardless of WS availability.
   *
   * Resolver form (vs static) because the host may want to re-fetch
   * per-session. Returning `undefined` is treated as "I don't know"
   * — falls through to polling. Returning `[]` is "I know, none of
   * them"; same effect.
   */
  readonly streamWebSocketLocalTools?: () =>
    | readonly string[]
    | undefined;
  /**
   * Default polling interval (ms) when the channel doesn't declare
   * `streamSpec[ch].pollIntervalMs`. Mirrors iframe-runtime's
   * `DEFAULT_IFRAME_POLL_INTERVAL_MS` (10 000 ms) for parity.
   */
  readonly defaultPollIntervalMs?: number;
  /**
   * Optional observability sink. Hosts that want to wire
   * subscription / transport events into their telemetry pipeline
   * supply a closure here. Absent = silent.
   */
  readonly onObservabilityEvent?: (
    event: HostStreamObservabilityEvent,
  ) => void;
}

/**
 * Public manager surface. Hosts call `bindIframe` on every
 * `<McpAppIframe>` mount and the returned disposer on unmount.
 */
export interface HostStreamManager {
  /**
   * Start mediating stream traffic for one iframe. Idempotent:
   * binding the same iframe twice replaces the prior binding.
   *
   * The iframe element MUST have a defined `contentWindow` by the
   * time `bindIframe` is called (i.e., post-mount). Calling on a
   * detached / pre-mount element throws synchronously.
   */
  bindIframe(
    iframe: HTMLIFrameElement,
    options: BindIframeOptions,
  ): UnbindIframe;
  /**
   * Update the bound stack-item id without re-binding the iframe.
   * Drops the prior id's subscriptions, accepts the new id's
   * subscribe announcements. Used when the host's stack rotates
   * without remounting the iframe.
   */
  rebindStackItem(iframe: HTMLIFrameElement, stackItemId: string): void;
  /**
   * Tear everything down. After dispose, the manager rejects new
   * `bindIframe` calls + drops every existing binding. Mainly for
   * graceful host shutdown.
   */
  dispose(): void;
}
