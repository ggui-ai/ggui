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
  | RelayDeadTapEvent
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
 * mirror `UiFeedbackPayload` in `@ggui-ai/mcp-apps-react` / `@ggui-ai/mcp-apps-react-native`
 * (the host-chrome twin of this affordance):
 *
 *   - `verdict` — `'up'` / `'down'` (the two thumb verdicts, #653).
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
  readonly verdict: 'up' | 'down';
  /** GguiSession id of the render the feedback is about. */
  readonly sessionId?: string;
  /** Tool that produced the render (e.g. `ggui_render`). */
  readonly toolName?: string;
}

/**
 * The evidence that latched a relay dead zone (ggui#599 cycle-2):
 * `'confirmed-refusal'` — the relay answered a declared refusal code
 * (helper-minted; outranks any positive advertisement), vs
 * `'advert-silent'` — the host never advertised `serverTools` and the
 * attempt failed relay-shaped.
 *
 * @public
 */
export type RelayLatchTrigger = 'confirmed-refusal' | 'advert-silent';

/**
 * Fired at the two transition edges of the renderer's
 * relay-incapability latch — the runtime's confirmed determination
 * that the host cannot relay `tools/call` to the MCP server:
 *
 *   - `'latched'` — a real user gesture just failed relay-shaped on a
 *     host whose captured capability handshake never advertised
 *     `serverTools`, or the relay answered a declared refusal code.
 *     The runtime now treats relay as confirmed-unavailable: it shows
 *     one persistent explanation, arms the dead-zone cue for every
 *     later gesture, and channel polls fail fast without a transport
 *     round-trip.
 *   - `'cleared'` — a later well-formed result envelope arrived
 *     (`ok:true` and `ok:false` alike — either proves the host relayed
 *     the call there and back), so the determination no longer holds.
 *     Carries the dead zone's summary: how long it stood and how many
 *     gestures were attempted inside it.
 *
 * Emitted once per edge, never per channel poll tick. Gestures
 * attempted while latched are NOT silent on this stream: each one is a
 * {@link RelayDeadTapEvent} (ggui#670 Phase 3) — one per real user
 * gesture, never per tick — so a host can count dead taps and measure
 * dead-tap-to-recovery without watching the render. A boot that finds
 * a latch standing from a prior mount closes it with a `'cleared'`
 * edge before the new session starts.
 *
 * Always emitted via the postMessage-to-parent default — the emission
 * sites live in module-level gesture-dispatch code outside the boot
 * graph, so they never flow through an injected `onObserve` sink.
 *
 * @public
 */
export type RelayIncapabilityEvent =
  | {
      readonly kind: 'relay-incapability';
      readonly state: 'latched';
      readonly trigger: RelayLatchTrigger;
      /** GguiSession id of the render, when the latching gesture carried one. */
      readonly sessionId?: string;
      /** App id of the render, when the latching gesture carried one. */
      readonly appId?: string;
    }
  | {
      readonly kind: 'relay-incapability';
      readonly state: 'cleared';
      /** How long the dead zone stood, in milliseconds. */
      readonly latchedForMs: number;
      /**
       * Gestures attempted inside the zone — equals the last
       * {@link RelayDeadTapEvent} `ordinal` this edge closes (0 when
       * none was attempted).
       */
      readonly deadTaps: number;
      readonly sessionId?: string;
      readonly appId?: string;
    };

/**
 * A user gesture attempted while the relay-incapability latch stands
 * (ggui#670 Phase 3). The runtime never suppresses the attempt — the
 * attempt is the self-heal sensor (ggui#443) — and presents it in the
 * document (pulse, spoken cue, fallback toast); this event makes the
 * attempt COUNTABLE by the host.
 *
 * Contract: exactly one per gesture whose UNDELIVERED outcome
 * (relay-shaped failure or a declared refusal) lands while the latch
 * stands — an in-flight gesture that raced the latching one counts;
 * never emitted off-latch, and never from the channel
 * router's fail-fast ticks. Counted at the outcome, not the tap: the
 * gesture that latched the zone is the `'latched'` edge and the gesture
 * that heals it is the `'cleared'` edge — neither is a dead tap.
 * `ordinal` counts from 1 within one dead zone; the `'cleared'` edge
 * reports the total as `deadTaps`. `latchAgeMs` is measured when the
 * outcome lands. Hosts MUST tolerate the event being absent (an older
 * renderer) — absence means no attempt was observed, not that none
 * happened.
 *
 * @public
 */
export interface RelayDeadTapEvent {
  readonly kind: 'relay-dead-tap';
  /** The gesture's intent — the action name the component dispatched. */
  readonly intent: string;
  /** Milliseconds since the latch set. */
  readonly latchAgeMs: number;
  /** 1-based position of this attempt within the current dead zone. */
  readonly ordinal: number;
  /** The evidence that latched the zone this attempt landed in. */
  readonly trigger: RelayLatchTrigger;
  readonly sessionId?: string;
  readonly appId?: string;
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
 * Type guard for the `ggui:observe` envelope as it arrives on a host's
 * `message` listener — narrows `event.data` to {@link ObservabilityMessage}.
 * Read fields through the per-kind guards, never through
 * `switch (event.kind)`: the union's open tail (`kind: string & {}`)
 * keeps TypeScript from using `kind` as a discriminant, so a `case`
 * body sees the whole union. Unknown kinds stay in that tail: hosts
 * MUST ignore them, never throw.
 *
 * @example
 * ```ts
 * import {
 *   isObservabilityMessage,
 *   isRelayDeadTapEvent,
 *   isRelayIncapabilityEvent,
 * } from '@ggui-ai/iframe-runtime/observability';
 *
 * window.addEventListener('message', ({ data, source }) => {
 *   if (source !== iframe.contentWindow || !isObservabilityMessage(data)) return;
 *   const { event } = data;
 *   if (isRelayDeadTapEvent(event)) count(event.intent, event.latchAgeMs);
 *   else if (isRelayIncapabilityEvent(event) && event.state === 'cleared') recovered(event.deadTaps);
 *   // any other kind: ignore
 * });
 * ```
 *
 * @public
 */
export function isObservabilityMessage(value: unknown): value is ObservabilityMessage {
  if (typeof value !== 'object' || value === null) return false;
  const probe = value as { readonly type?: unknown; readonly event?: unknown };
  if (probe.type !== MCP_APP_OBSERVE_TYPE) return false;
  if (typeof probe.event !== 'object' || probe.event === null) return false;
  return typeof (probe.event as { readonly kind?: unknown }).kind === 'string';
}

/**
 * Narrows to {@link RelayDeadTapEvent}. The union's open tail
 * (`kind: string & {}`) keeps TypeScript from using `kind` as a
 * discriminant, so `switch (event.kind)` never narrows across
 * {@link ObservabilityEvent} — hosts read fields through the per-kind
 * guards (first-consumer finding, ggui#670 Phase 3).
 *
 * @public
 */
export function isRelayDeadTapEvent(event: ObservabilityEvent): event is RelayDeadTapEvent {
  return event.kind === 'relay-dead-tap';
}

/**
 * Narrows to {@link RelayIncapabilityEvent}; inside it `state`
 * discriminates the `'latched'` / `'cleared'` edges normally.
 *
 * @public
 */
export function isRelayIncapabilityEvent(
  event: ObservabilityEvent,
): event is RelayIncapabilityEvent {
  return event.kind === 'relay-incapability';
}

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
