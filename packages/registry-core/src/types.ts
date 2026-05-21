/**
 * Row + wire shapes for the ggui marketplace registry. The same
 * shapes back both this open-source server and the hosted registry,
 * so they project against one definition.
 *
 * Rows are the storage-layer projection — what {@link RegistryStorage}
 * implementations read/write. Wire shapes are the public HTTP response
 * surface — what the registry exposes to CLI clients. The two are
 * deliberately separate: the row carries fields the wire never emits
 * (`yanked`, `sk`) and the wire flattens fields the row stores nested.
 *
 * The umbrella noun is `artifact` — the registry stores BOTH gadgets
 * AND blueprints under one row family, with `kind: 'gadget' |
 * 'blueprint'` as the discriminator. The field name `artifactId`
 * matches what the field actually contains.
 */
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import type { GadgetSignature } from '@ggui-ai/gadget-signing';
import type { ConformanceFailureCode } from './ops/conformance.js';

/**
 * SK literal for the per-artifactId metadata row on the cloud's
 * Artifacts table. Pinned as a constant so cloud + OSS impls agree
 * on the SK.
 *
 * OSS impls (filesystem / memory) MAY ignore this — they have one row
 * per artifactId so no SK is needed. Cloud DDB impls MUST honor it.
 */
export const ARTIFACTS_METADATA_SK = 'metadata#' as const;

/**
 * Visibility — public artifacts are sigstore-signed + listable; private
 * artifacts are Ed25519-signed + scoped to the publisher org. Matches
 * `ArtifactVisibilitySchema` in `@ggui-ai/artifact-manifest`.
 */
export type Visibility = 'public' | 'private';

/**
 * Artifact discriminator. Matches `kind` on every artifact manifest.
 */
export type ArtifactKind = 'gadget' | 'blueprint';

/**
 * Per-artifactId metadata row. One row per `<scope>/<name>`, regardless
 * of how many versions exist. Updated on every publish to point at the
 * new latest. `/search` scans only this row family — versions-table
 * scans would explode the search domain.
 *
 * `artifactId` is the umbrella noun: the registry stores gadgets +
 * blueprints under one row family, and `kind` distinguishes them.
 */
export interface ArtifactsMetadataRow {
  readonly artifactId: string;
  readonly sk: typeof ARTIFACTS_METADATA_SK;
  readonly kind: ArtifactKind;
  readonly latestVersion: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly visibility: Visibility;
  readonly hook?: string;
  readonly authorName?: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
}

/**
 * Per-version row. One row per published version. The manifest is
 * stored verbatim (post-parse) plus the fetchable URLs + signing
 * metadata. Yanks set `yanked: true` — the row stays so the URL keeps
 * resolving with a 410 for audit. Hard-delete is intentionally NOT
 * supported at MVP.
 *
 * Blueprint versions point at a {@link CompiledBlobRow} via
 * `compiledDigest`. The blob row carries the compiled JS bytes
 * (esbuild output) keyed by `sha256(compiledBytes)`. Raw TSX is
 * preserved on `manifest.source` for audit / future-recompile;
 * compiled JS lives only in the blob layer. Two-layer storage gives
 * dedup (same TSX → same digest → single blob row) and federation-
 * ready content-addressable identity.
 */
export interface ArtifactVersionRow {
  readonly artifactId: string;
  readonly version: string;
  readonly manifest: ArtifactManifest;
  readonly kind: ArtifactKind;
  readonly visibility: Visibility;
  readonly bundleUrl?: string;
  readonly bundleSri?: string;
  readonly signatureUrl?: string;
  /**
   * Pointer into the {@link CompiledBlobRow} table. Set on blueprint
   * publish; absent on gadget rows (gadgets ship via `bundleUrl`).
   * Hex-encoded SHA-256 of the compiled JS bytes.
   *
   * Resolution invariant: a non-null `compiledDigest` on a published
   * blueprint row MUST resolve to a {@link CompiledBlobRow} via
   * {@link RegistryStorage.getCompiledBlob}. A missing blob row when
   * the pointer is set is a CRITICAL storage-layer inconsistency —
   * `fetchAndVerifyBlueprint` (cloud) and `runArtifactInstall` (OSS)
   * raise immediately rather than fall back.
   */
  readonly compiledDigest?: string;
  /**
   * Base64-encoded raw Ed25519 public key bytes (32 bytes). Pinned at
   * publish time so a subsequent key rotation in {@link AuthorKeyRow}
   * does NOT invalidate historical versions.
   */
  readonly authorPublicKey?: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly yanked?: boolean;
}

/**
 * Content-addressed compiled-bytes row — the storage layer for a
 * blueprint's compiled JS (esbuild output of its TSX source).
 *
 * Stored in a separate table keyed by `compiledDigest = sha256(bytes)`.
 * Multiple {@link ArtifactVersionRow} entries can point at the SAME
 * `compiledDigest` — two publishes of byte-identical compiled output
 * dedup to one blob row with `refCount` tracking pointer count. The
 * deterministic-compile contract (`compile(source) → sha256(bytes)`
 * is a pure function pinned to a frozen esbuild config) makes dedup
 * load-bearing: federation-ready, cross-app cache sharing, and
 * sigstore signing all key off `compiledDigest`.
 *
 * **Storage choice — inline base64 vs S3 pointer.** The compiled
 * bytes are inlined as a base64-encoded string column. Rationale:
 * blueprints today ship raw TSX inline on `manifest.source` (capped
 * at 5 MiB by `MAX_BLUEPRINT_SOURCE_BYTES`); compiled JS is typically
 * 1.5–3× the TSX size. DynamoDB's 400-KiB item ceiling caps practical
 * inline storage around ~300 KiB compiled (~200 KiB TSX), which
 * accommodates every realistic blueprint observed so far. Larger
 * blueprints (and gadgets, which always exceed this) will need an
 * S3-pointer variant as a future enhancement. Inline storage keeps
 * the two-layer write/read contract simple, without the bucket-
 * lifecycle and IAM-grant overhead of S3.
 *
 * **GC.** `refCount` is maintained on publish (+1) and yank (no
 * decrement — yanked versions retain their pointer for audit;
 * permanent delete would decrement). A dedicated reaper is a future
 * enhancement; the column is reserved so it can land later without a
 * row migration. Today no row ever drops to `refCount=0`, so the
 * absence of a reaper is observable only via storage growth.
 *
 * **Signatures.** `manifestSig` is the publisher's signature
 * (Ed25519 for private artifacts, sigstore-cosign for public) over
 * the manifest's canonical-JSON projection — read by the hosted
 * install path for defense-in-depth re-verification. Stored as a
 * JSON-encoded `GadgetSignature` discriminated union. `compiledSig`
 * (a registry-rooted sigstore signature over `compiledBytes`) is
 * reserved for a future enhancement.
 */
export interface CompiledBlobRow {
  /** PK. Lowercase hex SHA-256 of `compiledBytes` (64 chars). */
  readonly compiledDigest: string;
  /** Base64-encoded compiled JS bytes (esbuild output). */
  readonly compiledBytes: string;
  /** Decoded byte length — convenience for size checks without re-decoding. */
  readonly compiledSize: number;
  /**
   * Pointer count from {@link ArtifactVersionRow.compiledDigest}.
   * Maintained on publish; reserved for a future GC reaper.
   */
  readonly refCount: number;
  /**
   * Publisher's signature envelope, JSON-encoded `GadgetSignature`
   * discriminated union (Ed25519 for private, sigstore-cosign for
   * public). Read by the hosted install path for defense-in-depth
   * re-verification before persisting an installed blueprint. May be
   * absent on rows published before signature persistence existed;
   * the install path hard-fails such rows with a clear error pointing
   * at this column.
   */
  readonly manifestSig?: string;
  /**
   * Reserved — a registry-rooted sigstore signature over
   * `compiledBytes`, planned for a future enhancement. When shipped,
   * the install-time verifier's full anchor is:
   * `verify(manifestSig, manifest) AND verify(compiledSig, bytes) AND
   * sha256(bytes) === compiledDigest`.
   */
  readonly compiledSig?: string;
  /** ISO timestamp set on first-write of the blob row. */
  readonly createdAt: string;
}

/**
 * Author signing-key row. One per `(subject, keyId)` pair. The key is
 * stored base64 — verification re-decodes + invokes
 * {@link verifyBundleEd25519}.
 */
export interface AuthorKeyRow {
  readonly subject: string;
  readonly keyId: string;
  readonly publicKeyBase64: string;
}

// ─── Wire shapes (locked) ─────────────────────────────────────────────

/**
 * `GET /pkg/{scope}/{name}/{version}` body.
 *
 * `manifest` is always present (even on 410 Gone — yanked versions
 * still return the manifest for audit). `bundleUrl` / `bundleSri` /
 * `signatureUrl` are gadget-only.
 *
 * Blueprints expose their canonical compiled JS bytes via
 * `compiledBytes` (base64) + `compiledDigest` (hex SHA-256). The raw
 * TSX is on `manifest.source` for audit / recompile; install paths
 * MUST use `compiledBytes` — the registry is the trust boundary for
 * the compile step. `compiledDigest` doubles as the cache key for
 * cross-app sharing and federation.
 */
export interface ReadPkgResponse {
  readonly manifest: ArtifactManifest;
  readonly bundleUrl?: string;
  readonly bundleSri?: string;
  readonly signatureUrl?: string;
  /** Hex SHA-256 of the compiled bytes — present on blueprint reads. */
  readonly compiledDigest?: string;
  /** Base64 compiled JS bytes — present on blueprint reads. */
  readonly compiledBytes?: string;
  readonly authorPublicKey?: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
}

/**
 * One row of `GET /search?…` results — a lightweight per-artifactId
 * summary intentionally narrower than the full read response so the
 * CLI list view stays cheap.
 */
export interface SearchResultEntry {
  readonly artifactId: string;
  readonly latestVersion: string;
  readonly kind: ArtifactKind;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly publishedAt: string;
}

/**
 * `GET /search?…` body. `nextCursor` is opaque (impl-defined: cloud
 * uses base64-encoded DDB LastEvaluatedKey; OSS uses an offset). Clients
 * roundtrip it verbatim on the next call.
 */
export interface SearchResponse {
  readonly results: readonly SearchResultEntry[];
  readonly nextCursor?: string;
}

/**
 * `GET /search` sort options. Supports a registry-web "Recent" view
 * that needs `publishedAt`-DESC ordering.
 *
 *   - `recent` — order by {@link ArtifactsMetadataRow.publishedAt} DESC.
 *
 * Default (sort omitted) is impl-defined ordering: memory uses insertion
 * order, filesystem uses directory order, DDB uses Scan order. Callers
 * MUST opt in to a deterministic order via this field.
 *
 * **Scale ceiling.** The `recent` sort is implemented as an in-memory
 * pass on the page returned by {@link RegistryStorage.scanArtifacts}.
 * For pre-launch row counts (< ~1k artifacts, single-page scans with
 * `limit=200`) this gives a globally-correct order. Once the artifact
 * table grows past one Scan page (~1 MiB of items), the order is only
 * page-local — clients paginating with `cursor` see per-page recency,
 * not global. A DDB GSI on `publishedAt` is the proper fix and is
 * planned as a follow-up.
 */
export const SEARCH_SORT_OPTIONS = ['recent'] as const;
export type SearchSort = (typeof SEARCH_SORT_OPTIONS)[number];

/**
 * One row of `GET /pkg/{scope}/{name}` list-versions results — backs
 * a package detail page's version timeline. Lightweight by design:
 * drops manifest, compiledDigest, manifestSig, etc. — clients hit
 * `/pkg/.../:version` for the full row.
 *
 *   - `version`     — the semver string. UNIQUE per (artifactId, version).
 *   - `publishedAt` — ISO timestamp of the original publish.
 *   - `yanked`      — true ⇔ the version row carries `yanked: true`. UI
 *                     should render yanked rows with a strikethrough +
 *                     warning rather than hide them.
 *   - `kind`        — gadget | blueprint (matches the metadata row's
 *                     kind; carried per-version so cross-version kind
 *                     drift would surface in the UI).
 *   - `visibility`  — public | private. Private rows are filtered out
 *                     for unauthenticated callers at the op layer.
 */
export interface VersionListEntry {
  readonly version: string;
  readonly publishedAt: string;
  readonly yanked: boolean;
  readonly kind: ArtifactKind;
  readonly visibility: Visibility;
}

/**
 * `GET /pkg/{scope}/{name}` body.
 *
 *   - `artifactId` — echoed so a single-row consumer doesn't have to
 *                    reconstruct from URL params.
 *   - `versions`   — semver-DESC list of {@link VersionListEntry}.
 *                    Latest first.
 *
 * No pagination cursor — registry artifact version counts are
 * inherently bounded (typical: < 50 versions per artifact, hard ceiling
 * around ~1k for the lifetime of an artifact). If a single artifact ever
 * crosses the 1 MiB DDB Query page, we'll add a cursor — but for now the
 * round-trip cost of paginating versions is greater than the cost of
 * returning them all.
 */
export interface ListVersionsResponse {
  readonly artifactId: string;
  readonly versions: readonly VersionListEntry[];
}

/**
 * `POST /publish` request body.
 */
export interface PublishRequestBody {
  readonly manifest: unknown;
  readonly bundle?: string;
  readonly bundleSha384?: string;
  readonly signature: GadgetSignature;
}

/**
 * 201 response on a successful publish. `installCommand` is the exact
 * shell command to install the artifact — the registry hostname is
 * threaded through {@link PublishArtifactDeps.registryHostname}
 * so each deployment issues an environment-appropriate command.
 */
export interface PublishResponseBody {
  readonly artifactId: string;
  readonly version: string;
  readonly manifestUrl: string;
  readonly bundleUrl?: string;
  readonly signatureUrl?: string;
  readonly installCommand: string;
}

/**
 * Locked publish error codes. Strings are the wire contract — the
 * publish CLI matches on these for human-readable rendering. The
 * `as const` tuple is the value-level source of truth; the
 * {@link PublishErrorCode} type is derived from it so a single edit
 * propagates to both the wire and the runtime membership check used
 * by downstream guards.
 */
export const PUBLISH_ERROR_CODES = [
  'unauthorized',
  'manifest_invalid',
  'bundle_required',
  'bundle_too_large',
  'conformance_failed',
  'bundle_hash_mismatch',
  'unknown_key',
  'signature_invalid',
  'version_exists',
  'internal',
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/**
 * Closed enum for `GET /pkg/:scope/:name[/version]` read responses.
 *
 * `yanked` is the 410-Gone path — the version exists in metadata but
 * the publisher revoked it. Clients SHOULD treat this as a hard
 * failure (don't fall back to a different version automatically).
 */
export const READ_ERROR_CODES = [
  'not_found',
  'forbidden',
  'invalid_request',
  'yanked',
  'server_error',
] as const;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];

/**
 * Closed enum for `GET /search` responses. Same posture as
 * {@link ReadErrorCode} minus the `yanked` path (search filters
 * yanked rows out of the result set; it never surfaces as a top-level
 * error).
 */
export const SEARCH_ERROR_CODES = [
  'forbidden',
  'invalid_request',
  'server_error',
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/**
 * Closed enum for `POST /author-keys` register responses. An operator
 * registers a per-scope Ed25519 public key with the registry so
 * future `POST /publish` calls signed by the matching private key
 * validate against an `AuthorKeyRow`.
 *
 *   - `unauthorized`     — missing or invalid caller credentials.
 *   - `invalid_request`  — body missing `publicKeyBase64`, malformed
 *                          base64, or wrong byte length.
 *   - `key_conflict`     — a row already exists for `(subject, keyId)`
 *                          with a different `publicKeyBase64`. Same
 *                          publicKey is treated as idempotent → 200.
 *   - `server_error`     — unexpected adapter failure.
 */
export const REGISTER_AUTHOR_KEY_ERROR_CODES = [
  'unauthorized',
  'invalid_request',
  'key_conflict',
  'server_error',
] as const;
export type RegisterAuthorKeyErrorCode =
  (typeof REGISTER_AUTHOR_KEY_ERROR_CODES)[number];

/**
 * `POST /author-keys` request body. The subject is derived from the
 * verified caller credentials (not the body) — the operator can only
 * register keys under their own identity. `keyId` is derived
 * deterministically from
 * the public key bytes via `derivePublicKeyId` (gadget-signing) — not
 * caller-supplied — so two clients registering the same public key
 * produce the same row.
 */
export interface RegisterAuthorKeyRequestBody {
  readonly publicKeyBase64: string;
}

/**
 * `POST /author-keys` 200/201 response. Echoes the stored row so the
 * CLI can confirm the (subject, keyId) tuple the registry now knows.
 * 201 on first-write; 200 on idempotent re-register of the same row.
 */
export interface RegisterAuthorKeyResponseBody {
  readonly subject: string;
  readonly keyId: string;
  readonly publicKeyBase64: string;
}

/**
 * `POST /author-keys` error body — same shape as the read/search
 * error bodies; `error` is narrowed to the closed enum.
 */
export interface RegisterAuthorKeyErrorBody {
  readonly error: RegisterAuthorKeyErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * Publish-endpoint error body. `error` is narrowed to
 * {@link PublishErrorCode} so consumers get autocomplete +
 * exhaustiveness; `conformanceFailureCode` is hoisted to the TOP of
 * the body (alongside `error: 'conformance_failed'`) so callers can
 * branch without parsing nested JSON. The full per-error list stays
 * in `detail.errors` for verbose rendering.
 */
export interface PublishErrorBody {
  readonly error: PublishErrorCode;
  readonly message: string;
  /**
   * Sub-discriminator for `error: 'conformance_failed'` — the code of
   * the FIRST conformance failure (the list is in `detail.errors`).
   * Omitted for every other `error` value.
   */
  readonly conformanceFailureCode?: ConformanceFailureCode;
  readonly detail?: unknown;
}

/**
 * Read-endpoint error body. `error` narrowed to {@link ReadErrorCode}.
 */
export interface ReadErrorBody {
  readonly error: ReadErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * Search-endpoint error body. `error` narrowed to {@link SearchErrorCode}.
 */
export interface SearchErrorBody {
  readonly error: SearchErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * Discriminated union of every registry error body. Use the
 * per-endpoint shapes ({@link PublishErrorBody} / {@link ReadErrorBody}
 * / {@link SearchErrorBody}) at op + handler seams; this union exists
 * for callers that touch more than one endpoint (e.g. a transport-layer
 * logger).
 */
export type ErrorBody =
  | PublishErrorBody
  | ReadErrorBody
  | SearchErrorBody
  | RegisterAuthorKeyErrorBody
  | ListVersionsErrorBody;

// ─── Search filter ─────────────────────────────────────────────────────

/**
 * Search filter shape. Passed to {@link RegistryStorage.scanArtifacts}.
 * `limit` is clamped to [1, 200] by {@link searchArtifacts}; impls
 * should respect it as a hard ceiling. `cursor` is opaque to consumers
 * — impls choose their own encoding (DDB LastEvaluatedKey base64;
 * memory uses an integer offset; filesystem uses a last-seen artifactId).
 */
export interface ArtifactScanFilter {
  readonly q?: string;
  readonly kind?: ArtifactKind;
  readonly hook?: string;
  readonly tag?: string;
  readonly author?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Closed enum for `GET /pkg/{scope}/{name}` list-versions responses.
 *
 *   - `invalid_request` — missing or malformed `artifactId`.
 *   - `not_found`       — no metadata row for `artifactId`. Distinct
 *                         from "metadata present but every version is
 *                         private + caller unauthed" (that path returns
 *                         200 with `versions: []` — exposing 404 vs
 *                         empty would leak private-row existence).
 *   - `server_error`    — unexpected adapter failure.
 */
export const LIST_VERSIONS_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'server_error',
] as const;
export type ListVersionsErrorCode = (typeof LIST_VERSIONS_ERROR_CODES)[number];

/**
 * List-versions error body. `error` narrowed to {@link ListVersionsErrorCode}.
 * Mirrors {@link ReadErrorBody}'s shape so callers can share a renderer.
 */
export interface ListVersionsErrorBody {
  readonly error: ListVersionsErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}
