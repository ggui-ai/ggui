/**
 * Outbox — durable queue for user messages sent while offline.
 *
 * Shape-only module: all queue logic is pure async on an `OutboxStorage`
 * interface. Platform-specific storage wrappers live in tiny files
 * (localStorage on web, AsyncStorage on RN) and plug in via
 * `createKvOutboxStorage(kv)`.
 *
 * Invariants:
 *   - Queue is capped at MAX entries (oldest dropped first).
 *   - Entries older than TTL_MS are filtered on every load.
 *   - `enqueue` is idempotent on `clientMessageId` — a retried send
 *     with the same id never double-queues.
 */

export interface OutboxEntry {
  threadId: string;
  /** Same id the caller will pass to useInvoke.send on replay. */
  clientMessageId: string;
  text: string;
  /** Monotonic millisecond timestamp from `Date.now()`. */
  queuedAt: number;
}

export interface OutboxStorage {
  load(): Promise<OutboxEntry[]>;
  save(entries: OutboxEntry[]): Promise<void>;
}

const MAX_ENTRIES = 50;
const TTL_MS = 24 * 60 * 60 * 1000;
const NOW = () => Date.now();

/** Drop aged entries; called on every load. */
function prune(entries: OutboxEntry[]): OutboxEntry[] {
  const now = NOW();
  return entries.filter((e) => now - e.queuedAt < TTL_MS);
}

export async function enqueueEntry(
  storage: OutboxStorage,
  entry: OutboxEntry,
): Promise<void> {
  const current = prune(await storage.load());
  if (current.some((e) => e.clientMessageId === entry.clientMessageId)) return;
  const next = [...current, entry].slice(-MAX_ENTRIES);
  await storage.save(next);
}

export async function dequeueByKey(
  storage: OutboxStorage,
  clientMessageId: string,
): Promise<void> {
  const current = prune(await storage.load());
  await storage.save(current.filter((e) => e.clientMessageId !== clientMessageId));
}

export async function listOutboxForThread(
  storage: OutboxStorage,
  threadId: string,
): Promise<OutboxEntry[]> {
  const current = prune(await storage.load());
  return current.filter((e) => e.threadId === threadId);
}

/**
 * Minimal KV shape. Matches both `localStorage` (sync) and AsyncStorage
 * (async) — we Promise.resolve sync impls on read and ignore return
 * values on write.
 */
export interface KvLikeStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

const KV_KEY = 'ggui.chat-thread.outbox';

/**
 * Wrap any string-keyed KV store into an OutboxStorage. Use this on
 * integrators' platforms — pass `localStorage` on web, an AsyncStorage
 * module on RN, or any custom KV.
 */
export function createKvOutboxStorage(kv: KvLikeStorage): OutboxStorage {
  return {
    async load() {
      try {
        const raw = await Promise.resolve(kv.getItem(KV_KEY));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed as OutboxEntry[];
      } catch {
        return [];
      }
    },
    async save(entries) {
      try {
        await Promise.resolve(kv.setItem(KV_KEY, JSON.stringify(entries)));
      } catch {
        // Storage may be disabled (private mode on Safari, disk full, …).
        // Outbox best-effort: swallow and let the send land as a normal
        // offline failure on the next attempt.
      }
    },
  };
}
