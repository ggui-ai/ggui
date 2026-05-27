/**
 * Public types for `@ggui-ai/live-channel`.
 *
 * The library separates THREE concerns that used to be tangled together
 * inside the iframe-runtime:
 *
 *   1. **Transport** — how frames physically reach the client (WebSocket
 *      vs HTTP polling). Decided once at `ChannelRegistry.bind()` time
 *      based on what the bootstrap declares. WebSocket failure can
 *      transition to polling at runtime (transparent failover).
 *
 *   2. **Channel** — a logical stream of typed payloads. Each channel
 *      knows its WS frame discriminator (`'props_update'`) and OPTIONALLY
 *      a polling-fallback descriptor (URL + interval + parse).
 *
 *   3. **Handler** — what to do with a payload. The library doesn't care
 *      about business logic; handlers close over consumer state.
 *
 * This separation lets different iframe boot paths (a direct-page
 * iframe versus an MCP-Apps-nested iframe) consume the SAME channel
 * handlers — they only differ in how they MOUNT components, not in
 * how they listen for updates.
 */

/**
 * Per-channel handler — what the registry dispatches when a frame of
 * `type` arrives.
 *
 * `TPayload` is the payload shape on the wire (e.g. `DrainAckPayload`
 * for `type === 'drain_ack'`). The handler is responsible for any
 * validation of the payload shape — the gadget passes it through
 * verbatim.
 *
 * Polling is REGISTRY-LEVEL (see {@link RegistryPollingOptions}) —
 * a single HTTP fetch per tick parses a slice envelope into a map of
 * `type → frame` and the transport dispatches each frame to the
 * matching handler. R6 (2026-05-26) collapsed the per-handler
 * `polling?: ChannelPollingDescriptor` shape into this single
 * registry-level descriptor.
 */
export interface ChannelHandler<TPayload = unknown> {
  /**
   * WS frame `type` discriminator. Frames whose `type` field matches
   * this string are routed to `onMessage`. MUST be unique within a
   * `ChannelRegistry`; registering a second handler for the same type
   * throws.
   */
  readonly type: string;

  /**
   * Called with the parsed payload per matched frame. The library
   * absorbs thrown errors so one faulty handler can't break the
   * dispatch loop; failures are forwarded to the registry's logger
   * (when bound) for observability.
   */
  onMessage(payload: TPayload): void | Promise<void>;
}

/**
 * Registry-level polling descriptor (R6, 2026-05-26). One URL, one
 * tick interval, one snapshot-parsing function for the WHOLE
 * registry — replaces the per-handler `polling?: ChannelPollingDescriptor`
 * shape that existed pre-R6.
 *
 * On each tick:
 *
 *   1. `PollingTransport` fetches `url` with `Accept: application/json`.
 *   2. `parseSnapshot(body)` returns either `null` (nothing changed
 *      since the last poll — short-circuit, no dispatch) OR a
 *      `Record<type, frame>` mapping handler-type strings to
 *      synthesized frames.
 *   3. For each entry in the map, the transport looks up the handler
 *      by `type` in the registry's handler map and calls
 *      `handler.onMessage(frame.payload)`. Missing handlers are
 *      skipped silently (the snapshot may describe types this
 *      registry doesn't care about).
 *
 * Diff detection lives inside `parseSnapshot` — the consumer composes
 * the snapshot hash / last-seen-value tracking in its closure. The
 * transport itself is stateless beyond the timer.
 */
export interface RegistryPollingOptions {
  readonly url: string;
  readonly intervalMs: number;
  /**
   * Parse the response body into a map of `type → frame` to dispatch.
   * Return `null` when nothing changed since the last poll — the
   * transport skips dispatch entirely. Empty `{}` is distinct from
   * `null`: it means "snapshot parsed but no handlers matched today's
   * keys" (e.g. session-only, no stack-item slice).
   */
  parseSnapshot(body: unknown): Record<string, ChannelFrame> | null;
}

/**
 * Transport status. `'connecting'` is the initial state; on success
 * `'open'`; closes graceful or otherwise → `'closed'`; unrecoverable
 * errors → `'failed'`.
 */
export type TransportStatus = 'connecting' | 'open' | 'closed' | 'failed';

/**
 * Transport-kind discriminator. Telemetry uses this to distinguish
 * WS-vs-polling delivery in observability events.
 */
export type TransportKind = 'ws' | 'polling';

/**
 * Bootstrap shape the registry reads to pick a transport. Mirrors the
 * subset of `McpAppAiGguiRenderMeta` the transport layer needs —
 * keeping the type local lets the gadget stay protocol-version-agnostic
 * at the import boundary (consumers thread in the concrete render
 * slice). Field names line up 1:1 with the upstream slice so callers
 * can spread without an adapter.
 *
 * `wsUrl + wsToken` present (both non-empty) → WSTransport.
 * Either missing → PollingTransport.
 */
export interface ChannelClientBootstrap {
  readonly wsUrl?: string;
  readonly wsToken?: string;
  readonly renderId: string;
  readonly appId: string;
}

/**
 * Structured-event sink the registry + transports write to. Optional
 * dep; absent → no telemetry. Mirrors the `info`/`warn`/`debug`
 * surface used elsewhere in the codebase (logger pattern from
 * `mcp-server-handlers`).
 */
export interface ChannelLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
  debug?(event: string, fields: Record<string, unknown>): void;
}

/**
 * Wire-frame shape the registry's dispatch loop expects. The library
 * stays loose about the union — consumers (iframe-runtime in
 * particular) may carry richer types upstream. The registry routes by
 * `type` only.
 */
export interface ChannelFrame<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
}

/**
 * Handle returned by `ChannelRegistry.bind()`. Caller uses
 * `dispose()` to shut down the transport (on iframe re-mount, page
 * unload, etc.). `status` reflects the live transport state.
 */
export interface TransportHandle {
  readonly kind: TransportKind;
  readonly status: TransportStatus;
  dispose(): Promise<void>;
}

/**
 * WS-specific handle. `send(frame)` lives only here (not on the base
 * `TransportHandle`) because polling transports have no outbound
 * channel. Callers narrow via the `kind` discriminator on the union
 * type returned by `ChannelRegistry.bind()`.
 *
 * Protocol-aware handshakes (subscribe→ack→error) are NOT a gadget
 * concern — consumers express them by registering a handler that
 * closes over a Promise resolver. The library stays a single-dispatch
 * primitive (handlers are the only delivery shape).
 */
export interface WsTransportHandle extends TransportHandle {
  readonly kind: 'ws';
  send(frame: unknown): void;
  /**
   * (Re)start the underlying WS connection. Production consumers
   * rarely call this — `ChannelRegistry.bind()` auto-starts and the
   * transport's internal reconnect ladder + FailoverHandle swap handle
   * recovery. Exposed for tests that drive the failover state machine
   * by simulating timer-fired reconnects, and for advanced consumers
   * who need manual re-arm after `'failed'`.
   */
  start(): void;
}

/**
 * Polling-specific handle. Currently no extra surface beyond the base
 * `TransportHandle` — polling transports have no outbound channel and
 * no pause/resume primitive on the handle (consumers control polling
 * via dispose + re-bind). Exists so the discriminated union returned
 * by `ChannelRegistry.bind()` has a typed non-WS branch — callers
 * narrow on `handle.kind === 'ws'` to access WS-specific methods
 * without casts.
 */
export interface PollingTransportHandle extends TransportHandle {
  readonly kind: 'polling';
}

/**
 * Discriminated-union of every concrete transport handle the registry
 * may return. `ChannelRegistry.bind()` resolves to one of these; the
 * `kind` field is the narrowing discriminator.
 */
export type AnyTransportHandle = WsTransportHandle | PollingTransportHandle;

/**
 * Opts for `ChannelRegistry.bind()`. The bootstrap shape decides
 * transport selection; everything else is plumbing.
 */
export interface BindOptions {
  readonly bootstrap: ChannelClientBootstrap;
  readonly logger?: ChannelLogger;
  /**
   * Override the default minimum polling interval (500ms). Tests use
   * this; production should leave it alone.
   */
  readonly minPollIntervalMs?: number;
  /**
   * Fired on every transport status transition. The registry threads
   * it into whichever transport it picks; both WS + polling honor it.
   * Used by iframe-runtime to surface WS connect/disconnect/failure to
   * the renderer's status DOM + observability emitter.
   */
  readonly onStatusChange?: (status: TransportStatus) => void;
  /**
   * Registry-level polling descriptor (R6). When present, the
   * `PollingTransport` (used directly when WS is not viable, or after
   * `FailoverHandle` swap from a failed `WSTransport`) fires this URL
   * on each tick and dispatches each frame in the returned map by
   * handler `type`. Absent → no polling fallback (handlers stay inert
   * when WS is unavailable).
   */
  readonly polling?: RegistryPollingOptions;
}
