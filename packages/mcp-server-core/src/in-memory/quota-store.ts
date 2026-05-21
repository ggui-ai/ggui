/**
 * Reference {@link QuotaStore} implementation — `InMemoryQuotaStore`.
 *
 * Map-backed, process-local. Fine for dev, tests, and any single-host
 * deployment. NOT durable across restarts; NOT shared across processes.
 * Operators with multi-host or restart-tolerant needs bind a durable
 * adapter (SQLite, Redis, DynamoDB) against the same interface.
 *
 * Internal storage: composite key `{key}|{windowStart}|{durationMs}`.
 * Triple-component compounding is load-bearing — callers who change
 * `durationMs` for the same `key` get a new counter series by design,
 * per the contract (see `quota-store.ts` module comment).
 *
 * Garbage collection: stale windows (windowEnd ≤ now - gcAfterMs) are
 * lazily swept on each `read` / `increment` touching that shard. GC
 * is opportunistic — no background timer — so a long-idle store keeps
 * entries until the next hit, which is fine for a reference adapter.
 *
 * Atomicity: JS's single-thread-per-event-loop model means each
 * `increment` is trivially atomic within a Node process. Do NOT
 * generalize this guarantee to multi-process deployments; that's the
 * exact case a durable adapter is for.
 */
import type {
  QuotaIncrementInput,
  QuotaReadInput,
  QuotaReading,
  QuotaStore,
} from '../quota-store.js';

export interface InMemoryQuotaStoreOptions {
  /**
   * How long a stale window (already past its end) is retained before
   * being GC'd on next access. Defaults to `60_000` (1 minute) —
   * long enough that late reads of "the last window" still work,
   * short enough that a busy store doesn't accumulate indefinitely.
   */
  readonly gcAfterMs?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface Entry {
  used: number;
  windowStart: number;
  windowEnd: number;
}

/** Floor `at` to the containing window boundary. Extracted so tests
 *  can assert against the boundary arithmetic without boot-strapping
 *  the store. */
export function windowStartAt(at: number, durationMs: number): number {
  return Math.floor(at / durationMs) * durationMs;
}

function compositeKey(
  key: string,
  windowStart: number,
  durationMs: number,
): string {
  return `${key}|${windowStart}|${durationMs}`;
}

function validateWindow(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(
      `QuotaStore: window.durationMs must be a positive finite number, got ${durationMs}`,
    );
  }
}

function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `QuotaStore.increment: amount must be a positive finite number, got ${amount}`,
    );
  }
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly entries = new Map<string, Entry>();
  private readonly gcAfterMs: number;
  private readonly now: () => number;

  constructor(opts: InMemoryQuotaStoreOptions = {}) {
    this.gcAfterMs = opts.gcAfterMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async read(input: QuotaReadInput): Promise<QuotaReading> {
    validateWindow(input.window.durationMs);
    const at = input.at ?? this.now();
    this.gcSweep(at);
    const windowStart = windowStartAt(at, input.window.durationMs);
    const composite = compositeKey(
      input.key,
      windowStart,
      input.window.durationMs,
    );
    const entry = this.entries.get(composite);
    if (entry) {
      return {
        used: entry.used,
        windowStart: entry.windowStart,
        windowEnd: entry.windowEnd,
      };
    }
    return {
      used: 0,
      windowStart,
      windowEnd: windowStart + input.window.durationMs,
    };
  }

  async increment(input: QuotaIncrementInput): Promise<QuotaReading> {
    validateWindow(input.window.durationMs);
    const amount = input.amount ?? 1;
    validateAmount(amount);
    const at = input.at ?? this.now();
    this.gcSweep(at);
    const windowStart = windowStartAt(at, input.window.durationMs);
    const windowEnd = windowStart + input.window.durationMs;
    const composite = compositeKey(
      input.key,
      windowStart,
      input.window.durationMs,
    );
    const existing = this.entries.get(composite);
    if (existing) {
      existing.used += amount;
      return {
        used: existing.used,
        windowStart: existing.windowStart,
        windowEnd: existing.windowEnd,
      };
    }
    const fresh: Entry = { used: amount, windowStart, windowEnd };
    this.entries.set(composite, fresh);
    return { used: fresh.used, windowStart, windowEnd };
  }

  /** Current entry count. Test-only. */
  get size(): number {
    return this.entries.size;
  }

  private gcSweep(now: number): void {
    const cutoff = now - this.gcAfterMs;
    for (const [k, entry] of this.entries) {
      if (entry.windowEnd <= cutoff) this.entries.delete(k);
    }
  }
}
