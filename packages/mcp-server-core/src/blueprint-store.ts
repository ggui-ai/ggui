/**
 * `BlueprintStore` — multi-variant blueprint persistence seam.
 *
 * An explicit multi-variant record store: it replaces the implicit
 * single-blueprint-per-contract assumption that previously lived
 * inside `BlueprintProvider` and the render-time cache.
 *
 * Multiple {@link Blueprint} rows MAY share `(appId, contractHash)` —
 * `contractHash` being the 16-char `blueprintKey(contract)` value
 * everywhere it appears in this file (see "The `contractHash` domain"
 * below). Rows in a group differ on {@link Blueprint.source} and/or
 * {@link Blueprint.variance}. The selector picks one at runtime: a
 * deterministic fallback ladder
 * (`isOperatorDefault → validatorScore → createdAt → blueprintId`)
 * via {@link BlueprintSelector}, with an optional LLM-driven pick
 * layered atop it that never removes the deterministic floor.
 *
 * Reference implementations:
 *   - `InMemoryBlueprintStore` (this package's `/in-memory` entry) —
 *     OSS single-app default + test fixtures. Stores code inline
 *     via a `Map<codeHash, string>` (no S3); call
 *     {@link InMemoryBlueprintStore.putCode} / `getCode` for the body.
 *   - Hosted deployments bind a database-backed adapter: row metadata
 *     in the database, code body behind a separate content-addressed
 *     store. Same interface, so consumers cannot tell the difference
 *     between it and the in-memory reference.
 *
 * Tenancy: every read path requires both `appId` and `contractHash`.
 * Two apps' contracts may coincidentally hash the same; their
 * blueprints must never cross-pollinate.
 *
 * ## The `contractHash` domain
 *
 * `contractHash` is typed `string`, but its domain is narrow and
 * load-bearing: it is the **16-character lowercase-hex
 * `blueprintKey(contract)`** value — a sha256 prefix over the RFC 8785
 * canonical form of the {@link Blueprint.contract} shape
 * (`@ggui-ai/protocol/blueprint-key`). Not the full 64-char digest,
 * not a hash of the rendered code, not an app-scoped composite.
 *
 * The narrowness matters because `string` cannot enforce it and three
 * different hashes travel near each other in this system —
 * `blueprintKey` (contract identity, 16 hex), `CodeStore` content
 * hashes (compiled bundle bytes, 64 hex), and per-variant keys. Mixing
 * them silently mis-keys a lookup: `list()` finds nothing, the caller
 * reads that as "no blueprint registered", and a cached UI is
 * regenerated from scratch — or, worse, a truncation collision groups
 * two unrelated contracts under one key. So: producers derive the
 * value from `blueprintKey(contract)` and nothing else; stores treat
 * it as an opaque key and MUST NOT re-case, truncate, pad, or re-hash
 * it on the write path. The conformance suite
 * (`contract-tests/blueprint-store.conformance.ts`) pins both the
 * 16-hex shape and the put → get → list round-trip for every
 * implementation.
 */
import type { Blueprint } from '@ggui-ai/protocol';

/**
 * Thrown by {@link BlueprintStore.setOperatorDefault} +
 * {@link BlueprintStore.delete} when the blueprint id is unknown to
 * the store. Mirrors the `ThreadNotFoundError` naming.
 */
export class BlueprintNotFoundError extends Error {
  readonly code = 'BLUEPRINT_NOT_FOUND';
  constructor(blueprintId: string) {
    super(`blueprint not found: ${blueprintId}`);
    this.name = 'BlueprintNotFoundError';
  }
}

/**
 * Thrown by {@link BlueprintStore.put} when the blueprint id is
 * already registered. Operators must explicitly {@link BlueprintStore.delete}
 * before re-inserting under the same id — preventing accidental
 * overwrite during composition.
 */
export class BlueprintAlreadyExistsError extends Error {
  readonly code = 'BLUEPRINT_ALREADY_EXISTS';
  constructor(blueprintId: string) {
    super(`blueprint already exists: ${blueprintId}`);
    this.name = 'BlueprintAlreadyExistsError';
  }
}

/**
 * Persistence seam for {@link Blueprint} rows.
 *
 * Tenancy: scoped per `(appId, contractHash)` on the read path. The
 * primary key is `blueprintId`; the lookup index is composite
 * `(appId, contractHash)` — `contractHash` being the 16-char
 * `blueprintKey` value (file docstring, "The `contractHash` domain").
 * Implementations MUST NOT cross-leak between apps even when contract
 * hashes coincide.
 *
 * No list+filter — lookups MUST go through indexed access. The
 * conformance suite asserts this by requiring O(1) scaling on row
 * count when only one `(appId, contractHash)` group exists.
 */
export interface BlueprintStore {
  /**
   * Whether records written through this store survive a process
   * restart. The substrate gate treats anything not `'durable'` as
   * unbound: the wire must never promise restorability an
   * implementation cannot keep (#457 — NOT_SUPPORTED derives from
   * DECLARED durability, not from mere binding).
   */
  readonly durability: 'durable' | 'ephemeral';

  /**
   * Enumerate every blueprint registered under
   * `(appId, contractHash)`. Returns an empty array — never null —
   * when no rows exist. Order is implementation-defined; the
   * deterministic selector handles ordering itself.
   *
   * Production impls MUST be backed by an indexed lookup
   * (DDB GSI Query, SQL composite index, etc.). The conformance
   * suite documents this expectation; per-row scans are a
   * regression worth surfacing.
   *
   * @param appId Tenancy scope. Never crossed, even on key collision.
   * @param contractHash The 16-char lowercase-hex
   *   `blueprintKey(contract)` value — see the file docstring, "The
   *   `contractHash` domain". Passing any other digest here is a
   *   silent miss, not an error.
   */
  list(
    appId: string,
    contractHash: string,
  ): Promise<readonly Blueprint[]>;

  /**
   * Return the blueprint row by id, or `null` when no row exists.
   * Implementations SHOULD be O(1) — primary-key fetch only.
   */
  get(blueprintId: string): Promise<Blueprint | null>;

  /**
   * Insert a blueprint. Throws {@link BlueprintAlreadyExistsError}
   * when the id is already registered. Updating an existing
   * blueprint goes through {@link setOperatorDefault} or the
   * `ggui_ops_update_blueprint` tool (which composes `delete` +
   * `put` under the hood).
   *
   * Implementations MUST persist every field of {@link Blueprint}
   * losslessly, with ONE carve-out: {@link Blueprint.codeS3Url}. A
   * database-backed adapter normalizes optional `undefined` fields to
   * "absent column" at the row projection site so reads round-trip.
   *
   * `codeS3Url` is a derived, deployment-scoped projection, and an
   * implementation MAY recompute it on read from
   * {@link Blueprint.codeHash} rather than storing what the caller
   * passed. A blueprint row can outlive the bucket it was written
   * against — renamed, moved between accounts — and a row that
   * hard-coded a location would go quietly wrong at exactly the moment
   * it was needed. What MUST survive is `codeHash`: the content
   * address is the durable fact, the URL is one deployment's rendering
   * of it. An implementation that stores the URL verbatim is equally
   * conformant; callers MUST NOT depend on either behavior beyond
   * "present iff a body is stored".
   *
   * `blueprint.contractHash` MUST already be the 16-char
   * `blueprintKey(blueprint.contract)` value — the store keys the
   * lookup index off it verbatim and MUST NOT re-case, truncate, pad,
   * or re-derive it. See the file docstring, "The `contractHash`
   * domain".
   */
  put(blueprint: Blueprint): Promise<void>;

  /**
   * Pin one blueprint as the operator default for its
   * `(appId, contractHash)` group. The store MUST clear the flag
   * on any prior default for the same group so the
   * `isOperatorDefault: true` invariant ("at most one row per
   * group") holds. Throws {@link BlueprintNotFoundError} when the
   * id is unknown.
   *
   * The (appId, contractHash) group is derived from the target
   * row's own fields — the stored 16-char `blueprintKey` value, not a
   * re-derivation from {@link Blueprint.contract} — so callers don't
   * pass them explicitly. Cleaner than threading them through every
   * call site.
   */
  setOperatorDefault(blueprintId: string): Promise<void>;

  /**
   * Remove a blueprint row. Implementations SHOULD also delete the
   * associated code body when no other row references the same
   * `codeHash` — the content hash of the compiled bundle (64-hex, the
   * {@link Blueprint.codeHash} / `CodeStore` domain), a DIFFERENT
   * value from this seam's 16-char `contractHash`. Idempotent: a
   * second delete for the same id is a no-op (does NOT throw).
   */
  delete(blueprintId: string): Promise<void>;
}
