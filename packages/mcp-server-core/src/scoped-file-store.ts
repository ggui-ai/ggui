/**
 * ScopedFileStore — prefix-mounted blob storage seam for the platform.
 *
 * A transport-agnostic seam: agents and hosted handlers consume one
 * primitive (scoped puts/gets), while file / S3 / Redis / etc. impls
 * bind it. This decouples the blob-storage concept from any single
 * set of adapters or cloud provider.
 *
 * ## Scopes
 *
 * Four orthogonal scopes are mounted by {@link ScopedFileStoreRegistry},
 * each rooted at a stable key prefix. The prefixes are part of the
 * contract: hosted impls MUST honor them so a single GDPR
 * right-to-be-forgotten delete (`prefix delete users/<userId>/`) clears
 * every byte of that user's data, regardless of which scope wrote it.
 *
 * | Scope          | Prefix                            | Lifetime               |
 * | -------------- | --------------------------------- | ---------------------- |
 * | `app`          | `apps/<appId>/`                   | App lifecycle          |
 * | `render`       | `renders/<renderId>/`             | GguiSession TTL             |
 * | `userApp`      | `users/<userId>/apps/<appId>/`    | User account / app     |
 * | `crossAppUser` | `users/<userId>/shared/`          | User account (opt-in)  |
 *
 * `userApp` is the privacy-default scope an agent sees as
 * `ctx.userStorage`: agent A's per-user data is invisible to agent B
 * for the same user. `crossAppUser` is the opt-in cross-app namespace —
 * the agent SDK exposes it as `ctx.crossAppStorage` ONLY when the
 * user has explicitly enabled cross-app data sharing in their config
 * (OSS: `~/.ggui/config.json` `allowCrossAppDataSharing: true`;
 * hosted: per-user preference flag, default false). The seam itself
 * does NOT enforce the consent gate — that is policy at the agent SDK
 * layer (server.ts builds `GguiCtx`); the registry just mounts the
 * prefix.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer / writer: `DynamoGguiSessionStore` offload (`render.componentCode`,
 *   `conversationHistory.jsonl`), agent code via `ctx.renderStorage` /
 *   `ctx.userStorage` / `ctx.appStorage` / `ctx.crossAppStorage`,
 *   blueprint asset uploaders.
 * - Consumer / reader: `render-resource/handler.ts` rendering pipeline,
 *   agent code reading back its own writes, `GguiSessionStore.observe`
 *   replay readers, future blueprint-asset CDN.
 *
 * **Obligations:**
 * - {@link ScopedFileStore.put} before {@link ScopedFileStore.get} from
 *   another reader MUST be observable, with read-after-write consistency
 *   for the SAME key from the SAME client. Cross-client / cross-region
 *   eventual consistency is acceptable as long as the same-client-same-key
 *   sequence is honored. (S3 strong read-after-write satisfies this; the
 *   contract is conservative for community impls on weaker stores.)
 * - {@link ScopedFileStore.delete} MUST tombstone immediately for the
 *   writer's subsequent reads. Concurrent observers may briefly still
 *   see the value (eventual consistency).
 * - {@link ScopedFileStore.append} atomicity is per-call only — concurrent
 *   appends from multiple writers MAY interleave at the byte level if
 *   the underlying impl can't guarantee atomic concat (S3 cannot;
 *   filesystem `O_APPEND` can). Producers that need ordered appends
 *   MUST serialize on a higher-level lock.
 * - Missing keys MUST return `null` from {@link ScopedFileStore.get} /
 *   {@link ScopedFileStore.getString} / {@link ScopedFileStore.getRange}.
 *   Throwing for missing-key is a contract violation.
 * - Underlying errors (network, IO, S3 5xx) MUST throw — callers decide
 *   retry policy. Implementations MUST NOT silently swallow.
 * - {@link ScopedFileStore.list} MUST be stable under churn: keys
 *   present at start and end of the page MUST appear; keys added
 *   mid-page MAY appear. `cursor` MUST be opaque — callers treat it as
 *   a token.
 * - Prefix isolation: each scoped instance MUST only return keys under
 *   its prefix. `list()` from `app(A)` MUST NOT leak keys from `app(B)`
 *   or any other scope.
 *
 * **Failure mode:**
 * - Backend errors throw. The producer's caller (e.g. `DynamoGguiSessionStore`)
 *   decides whether to retry, fall back, or surface to the user.
 * - Per-object size cap is impl-specific; impls SHOULD document.
 *   Buffered `put` MUST tolerate at least 5 MB; larger payloads SHOULD
 *   route through {@link ScopedFileStore.putStream}.
 *
 * **Observable violation:**
 * - Contract test `scopedFileStoreContract(impl)` covers: round-trips
 *   for string + binary; `getString` decodes UTF-8; missing-key returns
 *   `null`; `delete` returns true/false on existed/missing;
 *   `list({prefix, cursor, limit})` paginates; `append` creates +
 *   concatenates; `getRange` slices; `putStream` reassembles; prefix
 *   isolation across two distinct scope instances.
 *
 * ## Relationship to other seams
 *
 * - {@link GguiSessionStore} (`render-store.ts`) — durable per-render
 *   metadata + event log. `DynamoGguiSessionStore` offloads heavy
 *   `render.componentCode` and `conversationHistory` blobs into
 *   `ScopedFileStoreRegistry.render(renderId)` so the DDB row stays
 *   under the 400 KB limit.
 * - {@link KeyValueStore} (`kv-store.ts`) — TTL'd ephemeral kv.
 *   Orthogonal: kv is small / hot / tokenish; ScopedFileStore is for
 *   blobs (kilobytes to megabytes).
 *
 * ## OSS default + hosted binding
 *
 * - OSS default: `LocalScopedFileStoreRegistry` rooted at `~/.ggui/storage/`,
 *   ships with `@ggui-ai/server`. Each scope is one prefix-mounted
 *   instance backed by the local filesystem.
 * - In-memory variant for tests / ephemeral OSS dev runs:
 *   `InMemoryScopedFileStore` + `InMemoryScopedFileStoreRegistry`
 *   (this package, see `in-memory/scoped-file-store.ts`).
 * - Hosted: `S3ScopedFileStoreRegistry` in `@ggui-cloud/runtime`.
 *   One bucket (`ggui-agent-data-*`), four prefix-mounted scope
 *   instances sharing one S3 client. IAM
 *   conditioning at the bucket level scopes pod role to the four
 *   prefixes.
 */
import type { JsonValue } from '@ggui-ai/protocol';

/**
 * Options for {@link ScopedFileStore.put} / {@link ScopedFileStore.putStream}.
 */
export interface ScopedFileStorePutOptions {
  /**
   * MIME type for the stored blob. Stored alongside the value when the
   * underlying impl supports object metadata (S3, IndexedDB). In-memory
   * and filesystem impls MAY ignore.
   */
  readonly contentType?: string;
  /**
   * Time-to-live in seconds. After expiry, reads MUST observe the key
   * as missing (`null`). Implementations MAY evict eagerly (S3 lifecycle
   * rules, Redis EXPIRE) or lazily (memory). Omit for no TTL.
   */
  readonly ttlSec?: number;
}

/**
 * Options for {@link ScopedFileStore.list}.
 */
export interface ScopedFileStoreListOptions {
  /**
   * Opaque continuation token from the previous page. Implementations
   * MUST accept any cursor they previously emitted; format is impl-private.
   */
  readonly cursor?: string;
  /**
   * Maximum keys per page. Implementations MAY return fewer (e.g. at
   * end of namespace). Default and cap are impl-specific; consumers
   * SHOULD treat the response as authoritative and re-query with
   * the returned cursor.
   */
  readonly limit?: number;
}

/**
 * One page of {@link ScopedFileStore.list} results.
 */
export interface ScopedFileStoreListResult {
  /**
   * Keys in this page. Keys are returned UNPREFIXED — a consumer that
   * called `store.list('blueprints/')` sees `['blueprints/foo', ...]`,
   * not `['apps/<appId>/blueprints/foo', ...]`. The scope prefix is
   * the implementation's concern, not the consumer's.
   */
  readonly keys: readonly string[];
  /**
   * Continuation cursor. `null` indicates this was the last page. A
   * non-null cursor means more keys exist; pass it to the next
   * `list()` call to continue.
   */
  readonly cursor: string | null;
}

/**
 * Prefix-mounted blob filesystem on a single scope. Created via
 * {@link ScopedFileStoreRegistry}; consumers do NOT construct these
 * directly except for tests.
 */
export interface ScopedFileStore {
  /**
   * Write `value` at `key`, replacing any existing value. Buffered:
   * implementations MAY load the entire value into memory. Use
   * {@link ScopedFileStore.putStream} for large payloads.
   */
  put(
    key: string,
    value: string | Uint8Array,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void>;

  /**
   * Streamed write at `key`. Source is consumed once. The promise
   * resolves AFTER the upload has been committed (S3 multipart complete,
   * filesystem fsync, etc.). Failure during streaming MUST throw — partial
   * writes MUST NOT be observable to readers (atomic-or-throw).
   */
  putStream(
    key: string,
    source: ReadableStream<Uint8Array>,
    opts?: ScopedFileStorePutOptions,
  ): Promise<void>;

  /**
   * Read raw bytes at `key`. Returns `null` if the key is missing or
   * expired. MUST treat expired keys as missing (lazy or eager
   * eviction is impl-specific).
   */
  get(key: string): Promise<Uint8Array | null>;

  /**
   * Read `key` as UTF-8 string. Convenience for the common JSON / text
   * case; equivalent to `get(key)` + `TextDecoder.decode()`.
   */
  getString(key: string): Promise<string | null>;

  /**
   * List keys, optionally filtered by `prefix` (within the scope).
   * Paginates via `cursor` / `limit`. See {@link ScopedFileStoreListResult}.
   */
  list(
    prefix?: string,
    opts?: ScopedFileStoreListOptions,
  ): Promise<ScopedFileStoreListResult>;

  /**
   * Delete `key`. Returns `true` if the key existed and was removed,
   * `false` if it was already missing. Implementations MUST be
   * idempotent — calling delete on a missing key MUST NOT throw.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Append `value` to the end of `key`'s current contents. If the key
   * does not exist, MUST create it with `value` as the initial contents.
   *
   * Atomicity is per-call only. Concurrent appends from multiple
   * writers MAY interleave at the byte level on backends that lack
   * atomic concat (S3). Producers that need ordering MUST serialize
   * externally (e.g. render-scoped lock).
   */
  append(key: string, value: string | Uint8Array): Promise<void>;

  /**
   * Read a byte range [start, end] (both inclusive) of `key`. Returns
   * `null` if the key is missing. If the range exceeds the value, MUST
   * clamp to the actual size; if `start` is past the end, MUST return
   * an empty `Uint8Array` (not `null`).
   */
  getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<Uint8Array | null>;
}

/**
 * Mount-point factory for the four canonical scopes. One registry
 * instance binds one underlying store; the registry itself is cheap
 * to construct (the scope instances are usually thin prefix wrappers).
 *
 * The registry MUST NOT enforce per-user opt-in for `crossAppUser` —
 * it just mounts the prefix. Consent is policy at the agent SDK layer.
 */
export interface ScopedFileStoreRegistry {
  /** App scope: `apps/<appId>/`. App lifecycle, no user identity. */
  app(appId: string): ScopedFileStore;

  /** GguiSession scope: `renders/<renderId>/`. GguiSession TTL. */
  render(renderId: string): ScopedFileStore;

  /**
   * Per-user-per-app scope: `users/<userId>/apps/<appId>/`. The
   * privacy-default agent-facing scope (`ctx.userStorage`). Agent A's
   * per-user data is invisible to agent B for the same user.
   */
  userApp(userId: string, appId: string): ScopedFileStore;

  /**
   * Cross-app per-user scope: `users/<userId>/shared/`. Available to
   * agents only when the user has explicitly opted into cross-app
   * data sharing. The seam mounts the prefix unconditionally; the
   * agent SDK's `GguiCtx` builder is responsible for refusing to
   * expose `ctx.crossAppStorage` when the user has not opted in.
   */
  crossAppUser(userId: string): ScopedFileStore;
}

/**
 * Convenience: read `key` and parse as JSON. Returns `null` if the key
 * is missing. Throws on parse failure.
 *
 * Free function (rather than a method on {@link ScopedFileStore}) to
 * keep the seam minimal — every adapter implements only the byte-level
 * primitives, and JSON is a thin layer on top.
 */
export async function readScopedJson<T = JsonValue>(
  store: ScopedFileStore,
  key: string,
): Promise<T | null> {
  const raw = await store.getString(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

/**
 * Convenience: stringify `value` and write at `key`. Sets `contentType`
 * to `application/json` by default; callers may override via `opts`.
 */
export async function writeScopedJson(
  store: ScopedFileStore,
  key: string,
  value: JsonValue,
  opts?: ScopedFileStorePutOptions,
): Promise<void> {
  await store.put(key, JSON.stringify(value), {
    contentType: 'application/json',
    ...opts,
  });
}
