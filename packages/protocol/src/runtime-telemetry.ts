/**
 * ggui#1381 — the vocabulary of `ggui_runtime_telemetry`: every kind a card's runtime emits, which of the two batches
 * it rides, and the one `detail` shape each kind admits. The emitter (the iframe runtime) and a host's door (one that
 * admits only a closed set of kinds) import the same names from here, so renaming or adding a kind is a change both
 * sides see, not a free string only one of them knows.
 *
 * The server stays TOLERANT of it: `ggui_runtime_telemetry`'s own input takes `kind` as a bounded string, logs a kind
 * this list does not name, and never refuses one. A strict server would reject kinds an earlier runtime release still
 * sends, which is the N−1 rule's exact case (VERSION-POLICY §3.6). The closed set is for a door that chooses it.
 *
 * Two batches, never mixed in one call:
 *   - `health` — which rung a card booted on, its connection status, whether its doorbell rang, which transport
 *     failed. Event names and the card's own ids only: each health kind admits one `detail` shape (`none`, `id`, or
 *     `booleans`), and a detail outside it is left off the event.
 *   - `diagnostic` — everything else the runtime reports (credential refreshes, gesture dispatch and result, stream
 *     restarts), whose `detail` carries `fields` (codes, enums, numbers, ids; never free text).
 *
 * PURE-CONST by contract: this module has no runtime imports (type-only imports are erased), so a package that
 * imports `@ggui-ai/protocol/runtime-telemetry` takes none of the protocol package's runtime dependencies into its
 * bundle. A test pins that.
 */
import type { ConnectionStatus } from './transport/websocket';

/**
 * Every event the live-channel transports log (ggui#1383). One list, so a renamed or new event is a changed list
 * rather than a new free string: the transports' logger takes this list's union, and the live-channel package pins
 * that the list is exactly what its transports log. Each name rides the health batch with no detail: the name is the
 * signal (which transport failed).
 */
export const CHANNEL_LOG_EVENTS = [
  'channel_failover_send_dropped_post_swap',
  'channel_failover_swap',
  'channel_handler_throw',
  'channel_polling_budget_exhausted',
  'channel_polling_fetch_failed',
  'channel_polling_invalid_carrier',
  'channel_polling_no_fetch',
  'channel_polling_no_handler',
  'channel_polling_non_ok',
  'channel_polling_parse_failed',
  'channel_sse_construct_failed',
  'channel_sse_fail_fast',
  'channel_sse_watchdog_expired',
  'channel_status_listener_throw',
  'channel_ws_construct_failed',
  'channel_ws_fail_fast',
  'channel_ws_refused_terminal',
  'channel_ws_send_failed',
  'channel_ws_subscribe_send_failed',
] as const;

/** One of the live-channel transports' log events. */
export type ChannelLogEvent = (typeof CHANNEL_LOG_EVENTS)[number];

/** The four connection statuses as values, the twin of {@link ConnectionStatus}. */
export const CONNECTION_STATUSES = ['connecting', 'connected', 'disconnected', 'reconnecting'] as const;
type SameMembers<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// A compile-time check, both directions: a status added to `ConnectionStatus` and not here (or the reverse) fails to
// compile, so the status kinds below can never name a status the transport does not have.
const connectionStatusesExact: SameMembers<(typeof CONNECTION_STATUSES)[number], ConnectionStatus> = true;
void connectionStatusesExact;

/** Which of the two telemetry calls a kind rides. */
export type TelemetryBatch = 'health' | 'diagnostic';
/** The one `detail` shape a kind admits. */
export type TelemetryDetailShape = 'none' | 'id' | 'booleans' | 'fields';

/** A kind on the health batch. */
export type HealthKind =
  | 'boot.path'
  | 'boot.static_only_no_bridge'
  | `status.${ConnectionStatus}`
  | 'subscribe.resolved'
  | 'doorbell.ring'
  | ChannelLogEvent;

/** A kind on the diagnostic batch. */
export type DiagnosticKind =
  | 'boot.credential_refresh'
  | 'credential.refresh'
  | 'stream.counter_restart'
  | 'live.ended'
  | 'doorbell.refused'
  | 'gesture.dropped_superseded'
  | 'gesture.dispatch'
  | 'gesture.result'
  | 'gesture.dom_click'
  | 'gesture.envelope'
  | 'epoch.frozen';

/** Every kind a card's runtime emits. */
export type RuntimeTelemetryKind = HealthKind | DiagnosticKind;

/** One kind, its batch, and the detail shape it admits. */
export type RuntimeTelemetryKindSpec =
  | { readonly kind: HealthKind; readonly batch: 'health'; readonly detail: 'none' | 'id' | 'booleans' }
  | { readonly kind: DiagnosticKind; readonly batch: 'diagnostic'; readonly detail: 'none' | 'fields' };

/** The whole vocabulary: every kind the runtime emits, once. */
export const RUNTIME_TELEMETRY_KINDS: readonly RuntimeTelemetryKindSpec[] = [
  { kind: 'boot.path', batch: 'health', detail: 'booleans' },
  { kind: 'boot.static_only_no_bridge', batch: 'health', detail: 'none' },
  ...CONNECTION_STATUSES.map((s) => ({ kind: `status.${s}` as const, batch: 'health' as const, detail: 'none' as const })),
  { kind: 'subscribe.resolved', batch: 'health', detail: 'booleans' },
  { kind: 'doorbell.ring', batch: 'health', detail: 'id' },
  ...CHANNEL_LOG_EVENTS.map((e) => ({ kind: e, batch: 'health' as const, detail: 'none' as const })),
  { kind: 'boot.credential_refresh', batch: 'diagnostic', detail: 'fields' },
  { kind: 'credential.refresh', batch: 'diagnostic', detail: 'fields' },
  { kind: 'stream.counter_restart', batch: 'diagnostic', detail: 'fields' },
  { kind: 'live.ended', batch: 'diagnostic', detail: 'fields' },
  { kind: 'doorbell.refused', batch: 'diagnostic', detail: 'fields' },
  { kind: 'gesture.dropped_superseded', batch: 'diagnostic', detail: 'none' },
  { kind: 'gesture.dispatch', batch: 'diagnostic', detail: 'fields' },
  { kind: 'gesture.result', batch: 'diagnostic', detail: 'fields' },
  { kind: 'gesture.dom_click', batch: 'diagnostic', detail: 'fields' },
  { kind: 'gesture.envelope', batch: 'diagnostic', detail: 'fields' },
  { kind: 'epoch.frozen', batch: 'diagnostic', detail: 'fields' },
];
