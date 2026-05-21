/**
 * InMemoryScopedFileStore — reference {@link ScopedFileStore} for tests
 * and ephemeral OSS dev runs. One process, one shared `Map`-backed
 * underlying store, prefix-mounted scope instances.
 *
 * Production OSS binding (filesystem under `~/.ggui/storage/`) lives in
 * `@ggui-ai/server`. The hosted binding (S3) lives in
 * `@ggui-cloud/runtime`. Any binding MUST pass
 * `scopedFileStoreContract` from `../contract-tests/scoped-file-store.js`.
 *
 * TTL is enforced lazily at read time (no timers, so no dangling handles
 * after tests tear down). Not a production backend.
 */
import type {
  ScopedFileStore,
  ScopedFileStoreListOptions,
  ScopedFileStoreListResult,
  ScopedFileStorePutOptions,
  ScopedFileStoreRegistry,
} from '../scoped-file-store.js';

interface Entry {
  value: Uint8Array;
  contentType?: string;
  /** Epoch millis when this entry expires; `null` = no TTL. */
  expiresAt: number | null;
}

const utf8encoder = new TextEncoder();
const utf8decoder = new TextDecoder('utf-8');

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? utf8encoder.encode(value) : value;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Underlying flat-namespace key/value store shared across all scope
 * instances of one registry. Holding it on the registry (not on each
 * `ScopedFileStore`) is what lets `app(A)`-then-`app(A)` return distinct
 * instances that nonetheless see each other's writes — the prefix is
 * the namespace; the storage is shared.
 */
class InMemoryStorage {
  readonly entries = new Map<string, Entry>();
  constructor(readonly now: () => number = Date.now) {}

  isAlive(entry: Entry): boolean {
    return entry.expiresAt === null || entry.expiresAt > this.now();
  }

  readLive(fullKey: string): Entry | null {
    const entry = this.entries.get(fullKey);
    if (!entry) return null;
    if (!this.isAlive(entry)) {
      this.entries.delete(fullKey);
      return null;
    }
    return entry;
  }
}

class InMemoryScopedFileStoreImpl implements ScopedFileStore {
  constructor(
    private readonly storage: InMemoryStorage,
    private readonly prefix: string,
  ) {}

  private fullKey(key: string): string {
    return this.prefix + key;
  }

  async put(
    key: string,
    value: string | Uint8Array,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void> {
    const expiresAt = opts?.ttlSec
      ? this.storage.now() + opts.ttlSec * 1000
      : null;
    this.storage.entries.set(this.fullKey(key), {
      value: toBytes(value),
      contentType: opts?.contentType,
      expiresAt,
    });
  }

  async putStream(
    key: string,
    source: ReadableStream<Uint8Array>,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void> {
    const reader = source.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.length;
    }
    await this.put(key, buf, opts);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.storage.readLive(this.fullKey(key));
    if (!entry) return null;
    // Return a copy — preserves the "stored bytes are immutable" contract
    // even if the caller mutates the returned buffer.
    return new Uint8Array(entry.value);
  }

  async getString(key: string): Promise<string | null> {
    const bytes = await this.get(key);
    return bytes === null ? null : utf8decoder.decode(bytes);
  }

  async list(
    prefix?: string,
    opts?: ScopedFileStoreListOptions,
  ): Promise<ScopedFileStoreListResult> {
    const scopePrefix = this.prefix;
    const filterPrefix = prefix ?? '';
    const fullFilterPrefix = scopePrefix + filterPrefix;

    // Collect alive keys under the scope's prefix matching the optional
    // sub-prefix. Sort for deterministic pagination.
    const allKeys: string[] = [];
    for (const [fullKey, entry] of this.storage.entries) {
      if (!fullKey.startsWith(fullFilterPrefix)) continue;
      if (!this.storage.isAlive(entry)) continue;
      // Strip the scope prefix; consumer sees scope-relative keys.
      allKeys.push(fullKey.substring(scopePrefix.length));
    }
    allKeys.sort();

    // Paginate. Cursor is the last-yielded key from the previous page;
    // start AFTER it. Limit defaults to all (no cap for in-memory).
    const cursor = opts?.cursor;
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    let startIdx = 0;
    if (cursor !== undefined) {
      // Find first key strictly greater than the cursor.
      while (startIdx < allKeys.length && allKeys[startIdx]! <= cursor) {
        startIdx++;
      }
    }
    const endIdx = Math.min(startIdx + limit, allKeys.length);
    const pageKeys = allKeys.slice(startIdx, endIdx);
    const nextCursor =
      endIdx < allKeys.length && pageKeys.length > 0
        ? pageKeys[pageKeys.length - 1]!
        : null;

    return { keys: pageKeys, cursor: nextCursor };
  }

  async delete(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const entry = this.storage.entries.get(fullKey);
    if (!entry) return false;
    const wasAlive = this.storage.isAlive(entry);
    this.storage.entries.delete(fullKey);
    return wasAlive;
  }

  async append(key: string, value: string | Uint8Array): Promise<void> {
    const fullKey = this.fullKey(key);
    const existing = this.storage.readLive(fullKey);
    const incoming = toBytes(value);
    const next = existing
      ? concatBytes(existing.value, incoming)
      : incoming;
    this.storage.entries.set(fullKey, {
      value: next,
      contentType: existing?.contentType,
      expiresAt: existing?.expiresAt ?? null,
    });
  }

  async getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<Uint8Array | null> {
    const entry = this.storage.readLive(this.fullKey(key));
    if (!entry) return null;
    const len = entry.value.length;
    if (start >= len) return new Uint8Array(0);
    const lo = Math.max(0, start);
    // `end` is inclusive per contract; slice end is exclusive, so +1.
    const hi = Math.min(len, end + 1);
    if (hi <= lo) return new Uint8Array(0);
    return new Uint8Array(entry.value.subarray(lo, hi));
  }
}

/**
 * In-memory {@link ScopedFileStoreRegistry} for tests / OSS ephemeral
 * dev. Backed by a single shared `Map`; scope instances are thin prefix
 * wrappers. Reusing the same scope arguments returns DISTINCT
 * `ScopedFileStore` instances, but they observe the same storage —
 * this matches production impls (S3 / filesystem), where two prefix
 * mount points on the same bucket / root are independent objects but
 * see each other's writes.
 */
export class InMemoryScopedFileStoreRegistry
  implements ScopedFileStoreRegistry
{
  private readonly storage: InMemoryStorage;

  /**
   * @param now Clock injectable for deterministic TTL tests. Defaults
   *   to `Date.now`. The registry shares one clock across all four
   *   scopes — TTL is observed consistently.
   */
  constructor(now: () => number = Date.now) {
    this.storage = new InMemoryStorage(now);
  }

  app(appId: string): ScopedFileStore {
    return new InMemoryScopedFileStoreImpl(this.storage, `apps/${appId}/`);
  }

  session(sessionId: string): ScopedFileStore {
    return new InMemoryScopedFileStoreImpl(
      this.storage,
      `sessions/${sessionId}/`,
    );
  }

  userApp(userId: string, appId: string): ScopedFileStore {
    return new InMemoryScopedFileStoreImpl(
      this.storage,
      `users/${userId}/apps/${appId}/`,
    );
  }

  crossAppUser(userId: string): ScopedFileStore {
    return new InMemoryScopedFileStoreImpl(
      this.storage,
      `users/${userId}/shared/`,
    );
  }

  /**
   * Test / debug accessor — count of all live entries across all scopes.
   * Production impls do NOT need an equivalent; this exists so
   * impl-specific tests can assert on storage residue.
   */
  liveEntryCount(): number {
    let n = 0;
    for (const entry of this.storage.entries.values()) {
      if (this.storage.isAlive(entry)) n++;
    }
    return n;
  }
}

/**
 * Standalone {@link ScopedFileStore} backed by a fresh in-memory
 * storage — useful when tests want a single scope without a full
 * registry. Production code SHOULD prefer the registry.
 */
export class InMemoryScopedFileStore implements ScopedFileStore {
  private readonly inner: InMemoryScopedFileStoreImpl;

  constructor(prefix = '', now: () => number = Date.now) {
    this.inner = new InMemoryScopedFileStoreImpl(
      new InMemoryStorage(now),
      prefix,
    );
  }

  put(
    key: string,
    value: string | Uint8Array,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void> {
    return this.inner.put(key, value, opts);
  }
  putStream(
    key: string,
    source: ReadableStream<Uint8Array>,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void> {
    return this.inner.putStream(key, source, opts);
  }
  get(key: string): Promise<Uint8Array | null> {
    return this.inner.get(key);
  }
  getString(key: string): Promise<string | null> {
    return this.inner.getString(key);
  }
  list(
    prefix?: string,
    opts?: ScopedFileStoreListOptions,
  ): Promise<ScopedFileStoreListResult> {
    return this.inner.list(prefix, opts);
  }
  delete(key: string): Promise<boolean> {
    return this.inner.delete(key);
  }
  append(key: string, value: string | Uint8Array): Promise<void> {
    return this.inner.append(key, value);
  }
  getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<Uint8Array | null> {
    return this.inner.getRange(key, start, end);
  }
}
