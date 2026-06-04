/**
 * TelemetrySink — operational/product signals from the OSS server.
 *
 * A cross-cutting sink: server-wide instrumentation that any handler
 * may emit to.
 *
 * **Intent (what telemetry is for):** counts, durations, categorical
 * rates — the kind of thing that flows into a metrics/time-series
 * system (OTLP, CloudWatch, Prometheus, Datadog). Telemetry is
 * **operational signal**: "request arrived", "pairing completed",
 * "render queued" — lossy delivery is acceptable; sampling is
 * acceptable; per-event durability is NOT the contract.
 *
 * **Deliberately distinct from {@link AuditSink}.** Audit entries are
 * durable change-history records of privileged actions — losing a
 * pairing-token-issued entry is a security problem. Losing a
 * `pair.completed` telemetry event is a noisy metric. The interfaces
 * stay separate on purpose; do not collapse them into a single
 * generic "event sink". Operators with a durable audit requirement
 * bind an {@link AuditSink} and accept its stricter contract; those
 * who only want aggregate counts bind a {@link TelemetrySink} and
 * get cheap best-effort delivery.
 *
 * **Contract (for implementations):**
 *
 *   - `emit` is SYNCHRONOUS and MUST NOT throw. Any backend failure
 *     (network error, queue full, bad config) is swallowed inside
 *     the implementation. Callers are fire-and-forget.
 *   - Implementations MAY drop events under backpressure. Operators
 *     who need guaranteed delivery layer their own buffering
 *     adapter.
 *   - Implementations SHOULD be safe to call from hot paths (request
 *     handlers, stream pumps). Any non-trivial IO SHOULD be deferred
 *     to an async worker.
 *
 * **OSS reference adapters (this slice):**
 *   - `NoopTelemetrySink` — swallows silently. The shipped default
 *     for every surface that doesn't pass a real sink. Explicit
 *     no-op — not a mistake, not a TODO.
 *   - `InMemoryTelemetrySink` — retains events in a buffer for
 *     tests + local debugging. Bounded capacity; oldest-drop
 *     behavior makes the lossy contract observable in tests.
 *
 * Future reference impls (explicitly NOT this slice) — OTLP exporter,
 * Datadog agent forwarder, CloudWatch EMF writer — live in their own
 * tiny adapter packages so the core stays dep-free.
 */

/**
 * A single telemetry event. Attribute values are restricted to the
 * JSON-primitive subset every metrics system can represent natively —
 * strings (for categoricals), numbers (for counts/durations), booleans
 * (for flags). Nested objects and arrays are intentionally NOT allowed
 * — those belong in structured logs or {@link AuditSink} entries.
 */
export interface TelemetryEvent {
  /**
   * Dotted, lowercase, versionless event name — e.g. `'pair.completed'`,
   * `'thread.created'`, `'render.requested'`. The namespace convention
   * is `<subsystem>.<action>`; values flowing up to a metrics system
   * typically map to metric names 1:1.
   */
  readonly name: string;
  /** Epoch ms at emit time. Implementations MAY rewrite this on
   *  write (e.g. a buffering adapter that flushes later) but the
   *  caller's timestamp is authoritative for ordering decisions. */
  readonly at: number;
  /** Optional flat attribute map. Values are primitives only. */
  readonly attributes?: Readonly<
    Record<string, string | number | boolean>
  >;
}

/**
 * Cross-cutting operational-signal sink. Bind once at
 * `createGguiServer` composition; handlers + transports call `emit`
 * wherever they want to surface a named signal.
 *
 * MUST NOT throw. SHOULD NOT block. Callers are fire-and-forget;
 * losing events is a tolerated failure mode for this sink.
 */
export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}
