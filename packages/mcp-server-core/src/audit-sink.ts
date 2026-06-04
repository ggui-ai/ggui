/**
 * AuditSink — durable change-history / security-relevant action log.
 *
 * A cross-cutting sink: server-wide instrumentation that any handler
 * may emit to.
 *
 * **Intent (what audit is for):** a tamper-visible append-only record
 * of WHO did WHAT to WHICH resource, WHEN. Consumed by security
 * reviewers, support staff chasing "who revoked my key?", and the
 * Platform workspace audit-log UI. Losing entries is a **real
 * problem** — operators are answerable for completeness in ways that
 * operational metrics don't demand.
 *
 * **Deliberately distinct from {@link TelemetrySink}.** Telemetry is
 * operational/product signals; losing an event is a metric gap, not
 * a compliance breach. Audit is the opposite: per-entry durability
 * IS the contract. Do not collapse them — the shapes and delivery
 * guarantees are different by design.
 *
 * **Boundary (what belongs in audit vs. telemetry vs. structured
 * log):**
 *
 *   - **Audit** (this sink): privileged state changes. Examples:
 *     pairing-token issued / revoked, API-key minted / revoked,
 *     admin app-transfer, admin app-archive. Requires a human
 *     actor (or explicitly-marked system actor) and a concrete
 *     resource.
 *   - **Telemetry** ({@link TelemetrySink}): aggregate counts,
 *     durations, rates. Examples: `pair.completed` counter, render
 *     duration histogram, render-channel-subscriber gauge.
 *   - **Structured log** (`Logger`): developer-facing narrative
 *     details — request ids, stack traces, verbose context. Not
 *     audit-worthy on its own; often accompanies audit entries but
 *     with different retention + access semantics.
 *
 * Edge cases get categorized by the "losing this entry is a
 * compliance problem" test. If yes, audit. If no, telemetry or log.
 *
 * **Contract (for implementations):**
 *
 *   - `record` is ASYNC — the caller awaits the entry landing in
 *     durable storage (or at least in a write-ahead queue the
 *     implementation owns). Unlike {@link TelemetrySink.emit},
 *     `record` MAY reject. Callers at ingress points SHOULD await
 *     and surface failure; fire-and-forget is a bug here.
 *   - Entries are append-only. The interface deliberately exposes
 *     NO `update` / `delete` / `redact` surface. History
 *     correction is an out-of-band concern that doesn't run through
 *     this seam.
 *   - Implementations SHOULD preserve monotonic order per-resource
 *     when possible; strict global ordering is not required.
 *
 * **OSS reference adapters (this slice):**
 *   - `NoopAuditSink` — swallows silently. Useful as an explicit
 *     test/demo override; NOT the shipped default, because silent
 *     loss of a security-relevant record is exactly the failure
 *     mode we don't want. `createGguiServer` warns when no audit
 *     sink is provided (matches the `dev_mode_auth_enabled` pattern).
 *   - `InMemoryAuditSink` — retains entries in a buffer for tests
 *     + local debugging.
 *
 * Future reference impls (NOT this slice) — DynamoDB
 * append-only-table writer, Postgres-journal adapter, Kafka-topic
 * forwarder — bind the same interface from their own packages.
 */

/**
 * The principal that performed the recorded action. `kind: 'system'`
 * is for server-initiated actions with no human trigger (e.g. a
 * token TTL sweep); other kinds MUST carry an `id`.
 */
export interface AuditActor {
  readonly kind: 'builder' | 'user' | 'system' | 'anonymous';
  /** Optional for `system`; required (conceptually) for everything
   *  else — but the type keeps it optional so implementations can
   *  accept partial context gracefully at the ingress layer. */
  readonly id?: string;
}

/**
 * The object the action was applied to. `kind` is a stable namespace
 * string (e.g. `'pairing'`, `'api-key'`, `'thread'`); `id` is the
 * primary key within that namespace.
 */
export interface AuditResource {
  readonly kind: string;
  readonly id: string;
}

/**
 * A single audit entry. `action` follows the same dotted-lowercase
 * convention as telemetry names (e.g. `'pairing.token.issued'`,
 * `'thread.message.appended'`) so a shared taxonomy can be adopted
 * without rewriting the shape.
 *
 * `metadata` accepts `null` (explicit "field was cleared") in
 * addition to the JSON-primitive set — useful for recording
 * before/after-style rename actions.
 */
export interface AuditEntry {
  readonly at: number;
  readonly action: string;
  readonly actor: AuditActor;
  readonly resource?: AuditResource;
  readonly metadata?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

/**
 * Cross-cutting audit-log sink. Bind once at `createGguiServer`
 * composition; ingress points (pairing lifecycle, api-key lifecycle,
 * admin mutations) await `record` and surface failure.
 *
 * `record` MAY throw — the whole point of this sink is that
 * durability is the contract. Callers either await and surface the
 * failure, or commit the primary action inside a transaction that
 * rolls back on audit failure. Fire-and-forget is a bug.
 */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}
