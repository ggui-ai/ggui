/**
 * Observability events emitted by the renderer iframe → surfaced to
 * the MCP Apps host via the `<McpAppIframe>` wrapper's `onObserve`
 * prop. Complementary to `ProtocolError`:
 *
 *   - `ProtocolError` fires on FAILURES (typed classification of a
 *     protocol violation or transport error).
 *   - `ObservabilityEvent` fires on HAPPY PATHS + failures alike
 *     (telemetry + inspection signal the host can display in a
 *     SessionInspector-style view).
 *
 * The host wrapper passes events through to `onObserve` opaquely.
 *
 * Design:
 *
 *   - Discriminated union on `kind`. Each arm carries only the fields
 *     the event semantically requires — no optional everything-bags.
 *   - Extensibly closed via the `(string & {})` tail on `kind`. Adding
 *     a new arm does NOT bump the protocol version —
 *     hosts built against older typings fall through to the unknown
 *     branch and MUST render gracefully (e.g., `JSON.stringify(event)`
 *     fallback in an inspector row).
 *   - `@ggui-ai/iframe-runtime` owns this union, NOT `@ggui-ai/protocol`.
 *     Observability events are a renderer ↔ host implementation seam,
 *     not a wire-format contract between arbitrary protocol peers, so
 *     they stay out of the protocol package.
 *
 * @public
 */
export type ObservabilityEvent =
  | WiredToolInvokedEvent
  | ContractErrorEmittedEvent
  | SchemaVersionMismatchEvent
  | SubscribeFailedEvent
  | AuthRequiredEvent
  | ChannelTransportPickedEvent
  | ChannelTransportFallbackEvent
  | ChannelTransportResubscribedEvent
  | UnknownObservabilityEvent;

/**
 * Fired when a wired action successfully dispatched to a registered
 * MCP tool. Hosts surface this as a dispatch row in SessionInspector.
 * Emitted by the server-side router (session-channel.ts) via
 * postMessage relay through the renderer.
 *
 * @public
 */
export interface WiredToolInvokedEvent {
  readonly kind: 'wired-tool-invoked';
  readonly toolName: string;
  readonly actionName?: string;
  readonly dispatchedAt: string;
  readonly latencyMs?: number;
}

/**
 * Fired when the server emits a `_ggui:contract-error` envelope on
 * the live channel. Mirrors the envelope's `code` field for host-side
 * inspection without requiring the host to parse channel frames.
 *
 * @public
 */
export interface ContractErrorEmittedEvent {
  readonly kind: 'contract-error-emitted';
  readonly code: string;
  readonly toolName: string;
  readonly actionName?: string;
}

/**
 * Fired when the protocol-version handshake rejects the connection.
 * Parallel to `UpgradeRequiredError` — the host can choose to render
 * an inline upgrade prompt instead of treating it as a terminal
 * failure.
 *
 * @public
 */
export interface SchemaVersionMismatchEvent {
  readonly kind: 'schema-version-mismatch';
  readonly observedVersion: string;
  readonly acceptedVersions: readonly string[];
  readonly observedBy: 'client' | 'server';
}

/**
 * Fired when subscribe fails for any reason the renderer classifies
 * as non-fatal to the session (e.g., transient network jitter that
 * the reconnect ladder is handling). Terminal subscribe failures
 * still route through `ProtocolError`.
 *
 * @public
 */
export interface SubscribeFailedEvent {
  readonly kind: 'subscribe-failed';
  readonly reason: string;
  readonly message?: string;
}

/**
 * Fired when the server emits a `system` frame with
 * `action: 'auth_required'` — the agent needs the end-user to authorize
 * an OAuth service (Google, Slack, etc.) before a wired tool can
 * proceed. The host listens via `<McpAppIframe onObserve>` and renders
 * a consent overlay OUTSIDE the iframe, then redirects the user to
 * `authUrl` to complete the OAuth flow.
 *
 * Observability-only — the wire signal is already fully typed on
 * `@ggui-ai/protocol`'s `SystemPayload` (live-channel.ts). This event is a
 * renderer↔host projection of that payload, not a new protocol surface,
 * matching the vendor-neutral-separation posture of every
 * other `ObservabilityEvent` kind.
 *
 * Fields map 1:1 from `SystemPayload`:
 *   - `provider` ← `serviceId` (canonical identifier the credential
 *     store keys off — e.g., `"google"`, `"slack"`).
 *   - `authUrl` ← `consentUrl` (URL the host opens in a popup / new tab
 *     to initiate the OAuth consent flow).
 *   - `displayName` / `scopes` / `message` are optional hints the host
 *     can surface in the consent overlay; absent means "render with
 *     generic copy".
 *
 * @public
 */
export interface AuthRequiredEvent {
  readonly kind: 'auth-required';
  /**
   * Canonical identifier of the service needing authorization (e.g.
   * `"google"`, `"slack"`). Maps to `SystemPayload.serviceId`.
   */
  readonly provider: string;
  /**
   * URL the host opens in a popup / new tab to initiate the OAuth
   * consent flow. Maps to `SystemPayload.consentUrl`.
   */
  readonly authUrl: string;
  /**
   * Human-readable service name (e.g. `"Google"`, `"Slack"`). Optional
   * — absent when the server doesn't supply one.
   */
  readonly displayName?: string;
  /**
   * OAuth scopes the agent is requesting. Optional.
   */
  readonly scopes?: readonly string[];
  /**
   * Human-readable message explaining why access is needed. Optional.
   */
  readonly message?: string;
}

/**
 * Fired by the channel-transport router when it picks a transport
 * for a `streamSpec[ch].source.tool` channel. Hosts can inspect the
 * WS-vs-poll decision per channel in the SessionInspector activity
 * feed.
 *
 * @public
 */
export interface ChannelTransportPickedEvent {
  readonly kind: 'channel-transport-picked';
  readonly renderId: string;
  readonly channelName: string;
  readonly transport: 'ws' | 'poll';
}

/**
 * Fired by the channel-transport router when a WS-bound channel
 * falls back to iframe polling. `'ws-disconnect'`
 * = WS dropped, transient. `'channel-not-local'` = server explicitly
 * said it can't subscribe-for this tool (sticky for the channel's
 * lifetime).
 *
 * @public
 */
export interface ChannelTransportFallbackEvent {
  readonly kind: 'channel-transport-fallback';
  readonly renderId: string;
  readonly channelName: string;
  readonly reason: 'ws-disconnect' | 'channel-not-local';
}

/**
 * Fired by the channel-transport router when it re-sends
 * `channel_subscribe` for a channel after the WS reconnects.
 *
 * @public
 */
export interface ChannelTransportResubscribedEvent {
  readonly kind: 'channel-transport-resubscribed';
  readonly renderId: string;
  readonly channelName: string;
}

/**
 * Catch-all branch for event kinds the host's typings don't recognize.
 * Lets the union stay extensible without forcing protocol-version
 * bumps when new kinds are added. Hosts MUST render unknown events
 * gracefully — default: show as raw JSON in the inspector.
 *
 * @public
 */
export interface UnknownObservabilityEvent {
  readonly kind: string & {};
  readonly [field: string]: unknown;
}

/**
 * Shape of the postMessage envelope the renderer emits to its parent
 * when an observability event fires. `<McpAppIframe>` listens for this
 * and forwards the `event` field to `onObserve`.
 *
 * @public
 */
export interface ObservabilityMessage {
  readonly type: 'ggui:observe';
  readonly event: ObservabilityEvent;
}

// =============================================================================
// Emitter seam
// =============================================================================

/**
 * Caller sink for every {@link ObservabilityEvent} the renderer
 * classifies. Mirrors the {@link import('./protocol-error.js').ProtocolErrorEmitter}
 * posture — injection slot so tests can record, production binds a
 * postMessage-to-parent default.
 *
 * Handlers MUST NOT throw. Observability is fire-and-forget — the
 * renderer has already completed the observed side-effect by the time
 * the emitter runs; a throwing handler would mask the real signal.
 *
 * @public
 */
export type ObservabilityEmitter = (event: ObservabilityEvent) => void;

/**
 * Default emitter — posts an {@link ObservabilityMessage} to
 * `window.parent`. Mirrors `postBootFailure` / `postRendererReady`
 * posture in `runtime.ts`: swallows postMessage failure so a detached
 * parent doesn't crash the iframe.
 *
 * Lives here (not in `runtime.ts`) so tests exercising individual
 * emission sites can import the same default without dragging in the
 * runtime's module side-effects.
 *
 * @public
 */
export function postObservabilityToParent(event: ObservabilityEvent): void {
  // A non-browser import graph (vitest + jsdom before a window is
  // mocked in) has no `window.parent` — guard for that environment
  // so tests importing this helper never throw before their mocks
  // install.
  if (typeof window === 'undefined' || window.parent === null) return;
  const message: ObservabilityMessage = { type: 'ggui:observe', event };
  try {
    window.parent.postMessage(message, '*');
  } catch {
    // Parent unreachable (detached window). Best-effort fire-and-
    // forget — matches postBootFailure's swallow posture.
  }
}
