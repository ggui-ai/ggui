/**
 * Reference {@link AuditSink} implementations.
 *
 *   - `NoopAuditSink` — swallows entries silently. NOT a production
 *     default: a no-op audit sink means privileged actions leave no
 *     record, which is a compliance breach for operators who think
 *     they've enabled auditing. `createGguiServer` logs a `warn` at
 *     boot when no audit sink is bound (matching the
 *     `dev_mode_auth_enabled` pattern for missing-auth) so the gap
 *     is visible. `NoopAuditSink` is useful in tests + demos that
 *     explicitly opt out of durability.
 *
 *   - `InMemoryAuditSink` — retains entries in an array for tests +
 *     local debugging. Unbounded by default (audit entries are rare
 *     compared to telemetry, and dropping them silently is the
 *     failure mode the interface exists to avoid).
 *
 * Production bindings (DynamoDB append-only table, Postgres journal,
 * Kafka topic) live in their own packages.
 */
import type { AuditEntry, AuditSink } from '../audit-sink.js';

/**
 * No-op audit sink. Discards entries.
 *
 * **Warning:** using this in production means no durable record of
 * privileged actions (pairing / API-key / admin operations). Only
 * bind when you understand the implication — tests, demos, or a
 * transition window where you're about to swap in a real sink.
 */
export class NoopAuditSink implements AuditSink {
  async record(_entry: AuditEntry): Promise<void> {
    // Intentional no-op. Returns a resolved Promise so callers'
    // await semantics match real sinks.
  }
}

/**
 * In-memory audit sink. Entries accumulate in an array. Useful for
 * tests that need to assert audit emission, and for local
 * introspection during development.
 *
 * Unbounded by design — audit entries are security-relevant and
 * dropping them silently is the exact failure the interface exists
 * to prevent. Operators with a real volume concern bind a durable
 * production adapter, not this one.
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  /** Snapshot of all recorded entries, in record order. Returns a
   *  copy so callers can't mutate internal state. */
  snapshot(): AuditEntry[] {
    return [...this.entries];
  }

  /** Snapshot + clear. Useful for test `afterEach`. */
  drain(): AuditEntry[] {
    const out = [...this.entries];
    this.entries.length = 0;
    return out;
  }

  /** Current entry count. */
  get length(): number {
    return this.entries.length;
  }
}
