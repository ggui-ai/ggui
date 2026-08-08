import { MCP_APP_OBSERVE_TYPE } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Observability events emitted by the renderer iframe → surfaced to
 * the MCP Apps host via the `<McpAppIframe>` wrapper's `onObserve`
 * prop. Complementary to `ProtocolError`:
 *
 *   - `ProtocolError` fires on FAILURES (typed classification of a
 *     protocol violation or transport error).
 *   - `ObservabilityEvent` fires on HAPPY PATHS + failures alike
 *     (telemetry + inspection signal the host can display in a
 *     RenderInspector-style view).
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
 *     they stay out of the protocol package. The ENVELOPE TAG
 *     (`ggui:observe`) IS protocol-owned, though — it belongs to the
 *     renderer → host postMessage envelope family
 *     (`MCP_APP_OBSERVE_TYPE` in
 *     `@ggui-ai/protocol/integrations/mcp-apps`), so hosts on every
 *     platform classify it from one vocabulary.
 *
 * @public
 */
export type ObservabilityEvent =
  | SchemaVersionMismatchEvent
  | SubscribeFailedEvent
  | ChannelTransportPickedEvent
  | ChannelTransportFallbackEvent
  | ChannelTransportResubscribedEvent
  | ChannelPollDegradedEvent
  | ChannelPollRecoveredEvent
  | UiFeedbackEvent
  | RelayIncapabilityEvent
  | UnknownObservabilityEvent;

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
 * as non-fatal to the render (e.g., transient network jitter that
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
 * Fired by the channel-transport router when it picks a transport
 * for a `streamSpec[ch].source.tool` channel. Hosts can inspect the
 * WS-vs-poll decision per channel in the RenderInspector activity
 * feed.
 *
 * @public
 */
export interface ChannelTransportPickedEvent {
  readonly kind: 'channel-transport-picked';
  readonly sessionId: string;
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
  readonly sessionId: string;
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
  readonly sessionId: string;
  readonly channelName: string;
}

/**
 * Fired by the channel-transport router when a polling channel's
 * `tools/call` fails for a reason the router classifies as STRUCTURAL
 * — the failure will repeat identically until the underlying
 * condition changes, so spending a full-cadence poll on it is waste.
 *
 * The channel drops to a slower probe cadence; it never stops. That
 * distinction is the fail-safe: recovery is a property of the running
 * loop, not of an external nudge, so a host that regains the missing
 * capability sees its channels come back on their own.
 *
 * Emitted ONCE per healthy→degraded transition, never per probe tick
 * — a channel degraded for an hour emits one event, not 120.
 *
 * @public
 */
export interface ChannelPollDegradedEvent {
  readonly kind: 'channel-poll-degraded';
  readonly sessionId: string;
  readonly channelName: string;
  /**
   * What the router classified. `'relay-incapable'` = the runtime has
   * confirmed this host cannot relay `tools/call` to the MCP server
   * (see `RelayIncapableError`), so every poll fails before reaching
   * the transport.
   */
  readonly reason: 'relay-incapable';
  /** Cadence (ms) the channel probes at while degraded. */
  readonly probeIntervalMs: number;
}

/**
 * Fired by the channel-transport router when a previously-degraded
 * channel's `tools/call` succeeds again. The channel returns to its
 * normal cadence. Emitted once per degraded→healthy transition.
 *
 * @public
 */
export interface ChannelPollRecoveredEvent {
  readonly kind: 'channel-poll-recovered';
  readonly sessionId: string;
  readonly channelName: string;
  /** Cadence (ms) the channel returns to. */
  readonly pollIntervalMs: number;
}

/**
 * Fired when the end user submits the runtime's in-iframe UI-feedback
 * affordance ("did this generated UI work for you?"). Field semantics
 * mirror `UiFeedbackPayload` in `@ggui-ai/react` / `@ggui-ai/react-native`
 * (the host-chrome twin of this affordance):
 *
 *   - `verdict` — `'love'` / `'dislike'`, or `'other'` for the
 *     free-text flow.
 *   - `comment` — present only for `verdict: 'other'` with a non-empty
 *     trimmed comment.
 *   - `sessionId` / `toolName` — present exactly when the runtime knew
 *     them at mount time.
 *
 * Observability-only — feedback is host-app chrome with ZERO wire
 * surface: the agent cannot observe it (it is neither an action nor
 * context), so it rides this renderer ↔ host seam instead of the
 * agent ↔ UI contract.
 *
 * The affordance mounts only when the runtime document has a parent
 * window (`window.parent !== window`) — a top-level tab has no
 * `ggui:observe` egress, and a dead affordance must never render.
 * Hosts that also own DOM chrome around the iframe MUST wire exactly
 * ONE feedback surface: either their own chrome (the `onUiFeedback`
 * host-callback component) or this event arm — never both, or the
 * user sees two affordances for one render.
 *
 * @public
 */
export interface UiFeedbackEvent {
  readonly kind: 'ui-feedback';
  readonly verdict: 'love' | 'dislike' | 'other';
  /** Trimmed free-text comment; only on `verdict: 'other'`, never empty. */
  readonly comment?: string;
  /** GguiSession id of the render the feedback is about. */
  readonly sessionId?: string;
  /** Tool that produced the render (e.g. `ggui_render`). */
  readonly toolName?: string;
}

/**
 * Fired at the two transition edges of the renderer's
 * relay-incapability latch — the runtime's confirmed determination
 * that the host cannot relay `tools/call` to the MCP server:
 *
 *   - `'latched'` — a real user gesture just failed relay-shaped (no
 *     well-formed result envelope came back at all) on a host whose
 *     captured capability handshake never advertised `serverTools`.
 *     The runtime now treats relay as confirmed-unavailable: it shows
 *     one persistent explanation instead of a per-gesture error toast,
 *     and channel polls fail fast without a transport round-trip.
 *   - `'cleared'` — a later well-formed result envelope arrived
 *     (`ok:true` and `ok:false` alike — either proves the host relayed
 *     the call there and back), so the determination no longer holds;
 *     per-gesture feedback and channel transport attempts resume.
 *
 * Emitted once per edge, never per channel poll tick: repeated failing
 * gestures while latched emit nothing further, and the router's
 * fail-fast ticks emit nothing at all — the edges carry the full
 * information.
 *
 * Always emitted via the postMessage-to-parent default — the emission
 * sites live in module-level gesture-dispatch code outside the boot
 * graph, so they never flow through an injected `onObserve` sink.
 *
 * @public
 */
export interface RelayIncapabilityEvent {
  readonly kind: 'relay-incapability';
  readonly state: 'latched' | 'cleared';
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
  readonly type: typeof MCP_APP_OBSERVE_TYPE;
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
  const message: ObservabilityMessage = { type: MCP_APP_OBSERVE_TYPE, event };
  try {
    window.parent.postMessage(message, '*');
  } catch {
    // Parent unreachable (detached window). Best-effort fire-and-
    // forget — matches postBootFailure's swallow posture.
  }
}
