/**
 * `RegistryStorage` — the per-row persistence seam for the marketplace
 * registry. The interface is a three-table key-value shape
 * (artifacts + artifact-versions + author-keys) chosen so a hosted
 * database adapter can be a structural pass-through. Memory +
 * filesystem impls back the open-source server and unit tests.
 *
 * The shape follows a single-interface / multiple-impls / contract-test
 * pattern, with a Protocol & Contract Bar docstring.
 *
 * The umbrella noun is `artifact`: the registry stores BOTH gadgets
 * AND blueprints, and `kind` discriminates.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer / writer: {@link publishArtifact} — writes
 *   {@link ArtifactsMetadataRow} on every publish (upserting
 *   `latestVersion`) and writes {@link ArtifactVersionRow} once per
 *   version via {@link putArtifactVersionIfAbsent}.
 * - Reader: {@link readArtifact}, {@link searchArtifacts},
 *   {@link publishArtifact} (signature verification path).
 *
 * **Obligations:**
 * - {@link putArtifactVersionIfAbsent} MUST atomically reject when a row
 *   exists for `(artifactId, version)` — a conditional put-if-absent
 *   at the storage layer. Implementations
 *   MUST NOT overwrite on conflict — per-version immutability is a
 *   load-bearing registry invariant.
 * - {@link getArtifactMetadata} / {@link getArtifactVersion} MUST return
 *   exactly what was last written. `null` on miss; throw on transport
 *   failure (caller decides retry).
 * - {@link scanArtifacts} returns rows in arbitrary order
 *   (backing-store scan order; memory insertion order; filesystem
 *   directory order).
 *   Consumers MUST treat ordering as non-deterministic.
 *
 * **Failure mode:**
 * - Transport-level failures (store throttling, disk full) throw.
 *   {@link publishArtifact} wraps and returns 500 with `internal`
 *   error code.
 * - Missing rows return `null`; never throw.
 *
 * **Observable violation:**
 * - Contract test {@link registryStorageContract} covers:
 *   round-trip preservation, idempotent {@link putArtifactMetadata},
 *   `putArtifactVersionIfAbsent` rejects on collision, missing returns
 *   null, `listAuthorKeys` returns only keys for the queried subject.
 */
import type {
  ArtifactScanFilter,
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  AuthorKeyRow,
  CompiledBlobRow,
} from '../types.js';

/**
 * Optional flags for {@link RegistryStorage.putAuthorKey}.
 *
 * `ifNotExists` — when `true`, the write MUST be conditional on no
 * existing row for `(subject, keyId)`. On conflict (a concurrent first
 * write landed between the caller's check and this put), implementations
 * MUST throw {@link AuthorKeyAlreadyExistsError}. Used by
 * {@link registerAuthorKey} to close the TOCTOU window between its
 * idempotency read and the put.
 */
export interface PutAuthorKeyOptions {
  readonly ifNotExists?: boolean;
}

/**
 * Thrown by {@link RegistryStorage.putAuthorKey} when the caller passed
 * `ifNotExists: true` AND a row already exists for `(subject, keyId)`.
 * A hosted database adapter surfaces its conditional-write conflict
 * as this type; the in-memory impl mirrors the contract synchronously.
 *
 * Callers re-read via {@link RegistryStorage.getAuthorKey} and dispatch
 * same-publicKey → 200, different-publicKey → 409.
 */
export class AuthorKeyAlreadyExistsError extends Error {
  readonly subject: string;
  readonly keyId: string;
  constructor(subject: string, keyId: string) {
    super(
      `AuthorKey row already exists for (subject=${subject}, keyId=${keyId})`,
    );
    this.name = 'AuthorKeyAlreadyExistsError';
    this.subject = subject;
    this.keyId = keyId;
  }
}

export interface RegistryStorage {
  // ─── Artifacts metadata (one row per scope/name) ───────────────────
  getArtifactMetadata(artifactId: string): Promise<ArtifactsMetadataRow | null>;
  putArtifactMetadata(row: ArtifactsMetadataRow): Promise<void>;
  /**
   * Scan the metadata-row family with paginated cursor + post-fetch
   * filter. The filter is applied per-row; impls MAY push it down
   * (cloud GSI when available) or run it in-memory after a wide scan.
   * `limit` is treated as a per-page ceiling; consumers may iterate
   * via `nextCursor` for multi-page reads.
   */
  scanArtifacts(filter: ArtifactScanFilter): Promise<{
    readonly rows: readonly ArtifactsMetadataRow[];
    readonly nextCursor?: string;
  }>;

  // ─── Artifact versions (one row per scope/name/version) ────────────
  getArtifactVersion(
    artifactId: string,
    version: string,
  ): Promise<ArtifactVersionRow | null>;
  /**
   * List every version row for `artifactId`. Returns in arbitrary order
   * (backing-store query order; memory map
   * insertion order; filesystem directory order). Callers MUST sort
   * by semver themselves if they need ordering.
   *
   * Backs the `GET /pkg/:scope/:name` list-versions route.
   *
   * **Cost note.** A key-value impl can serve this as a single
   * partition query keyed by artifactId — the cheapest possible
   * per-artifact lookup. Memory + filesystem impls do a full table
   * walk filtered by artifactId — adequate for bounded row counts.
   *
   * **Returns:** empty array when no versions exist (NOT null) — the
   * "metadata-row present but no version rows" state should never
   * happen post-publish but is technically representable; the empty
   * array keeps the type narrow.
   */
  listArtifactVersions(
    artifactId: string,
  ): Promise<readonly ArtifactVersionRow[]>;
  /**
   * Atomically conditional put — succeeds only when no row exists for
   * `(artifactId, version)`. The single load-bearing concurrency primitive
   * in the registry; consumers MUST NOT pre-check with
   * {@link getArtifactVersion} + put (race-prone).
   */
  putArtifactVersionIfAbsent(
    row: ArtifactVersionRow,
  ): Promise<{ ok: true } | { ok: false; reason: 'version_exists' }>;
  yankArtifactVersion(artifactId: string, version: string): Promise<void>;

  // ─── Compiled blobs (one row per content-addressed digest) ──────────────
  /**
   * Fetch the compiled-bytes row for `compiledDigest`. Returns `null` on miss.
   *
   * Used by:
   *   - Read op — projecting `compiledBytes` into
   *     {@link ReadPkgResponse} alongside the version row.
   *   - Install path — two-layer resolution of
   *     `ArtifactVersionRow.compiledDigest` → `CompiledBlobRow`.
   *     A missing blob when the version row's pointer is set is a
   *     CRITICAL inconsistency the caller surfaces, not silently
   *     fallback.
   *   - Tests / fixtures that pre-seed blob rows without a paired
   *     publish.
   */
  getCompiledBlob(compiledDigest: string): Promise<CompiledBlobRow | null>;

  /**
   * Atomically commit BOTH the version row AND the compiled-blob row
   * under a single logical transaction. A single transaction avoids
   * the "dangling pointer" failure mode where a blob write fails
   * after the version row is already durable.
   *
   * **Two paths**, dispatched by the storage impl:
   *
   *   - **New-blob path** — `blobRow.compiledDigest` is not yet present.
   *     Both rows are PUT-INSERTed under one transaction with
   *     `attribute_not_exists` conditions on each. Returns
   *     `{ ok: true, mode: 'new-blob' }`.
   *   - **Dedup path** — `blobRow.compiledDigest` already has a row.
   *     The version row is PUT-INSERTed AND the existing blob row's
   *     `refCount` is incremented under one transaction. Returns
   *     `{ ok: true, mode: 'dedup' }`.
   *
   * **Failure mode:**
   *
   *   - Version-row conflict — `(artifactId, version)` already exists.
   *     NEITHER row mutates. Returns `{ ok: false, reason: 'version_exists' }`.
   *     The publisher's idempotent-retry path.
   *   - Transport-level failures (store throttling, disk full,
   *     transaction conflict not attributable to either conditional)
   *     throw —
   *     {@link publishArtifact} wraps and returns 500.
   *
   * **Atomicity guarantee:**
   *
   *   - Memory + filesystem impls: single-threaded JS event loop —
   *     the function awaits both writes before returning, no other
   *     awaitable interleaves.
   *   - A hosted database impl uses its store's all-or-nothing
   *     multi-row transaction. The new-blob path issues one
   *     transaction; the dedup path may retry once if the optimistic
   *     new-blob path fails because the digest landed between
   *     read-and-write.
   *
   * **Why a single transaction matters (refCount double-increment on
   * retry)**: a sequenced write path could increment refCount, then
   * crash before persisting the version row, then on retry increment
   * again. With TransactWriteItems both mutations either land together
   * or not at all — refCount can only grow when a version row also
   * lands.
   *
   * **Invariant preserved:** once a version row is durable, the
   * `(artifactId, version)` tuple cannot be re-used — semver
   * immutability holds.
   */
  commitVersionAndBlob(
    versionRow: ArtifactVersionRow,
    blobRow: CompiledBlobRow,
  ): Promise<
    | { ok: true; mode: 'new-blob' | 'dedup' }
    | { ok: false; reason: 'version_exists' }
  >;

  // ─── Author keys (one row per subject/keyId) ───────────────────────
  getAuthorKey(subject: string, keyId: string): Promise<AuthorKeyRow | null>;
  /**
   * Write an AuthorKey row. With `options.ifNotExists === true`, the
   * write is conditional on no existing row for `(subject, keyId)`;
   * on conflict, implementations MUST throw
   * {@link AuthorKeyAlreadyExistsError}. Default (no options) is an
   * unconditional upsert.
   */
  putAuthorKey(
    row: AuthorKeyRow,
    options?: PutAuthorKeyOptions,
  ): Promise<void>;
  listAuthorKeys(subject: string): Promise<readonly AuthorKeyRow[]>;
}
