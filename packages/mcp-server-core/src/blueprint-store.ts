/**
 * `BlueprintStore` — multi-variant blueprint persistence seam.
 *
 * An explicit multi-variant record store: it replaces the implicit
 * single-blueprint-per-contract assumption that previously lived
 * inside `BlueprintProvider` and the render-time cache.
 *
 * Multiple {@link Blueprint} rows MAY share `(appId, contractHash)`.
 * They differ on {@link Blueprint.source} and/or
 * {@link Blueprint.variance}. The selector picks one at runtime: a
 * deterministic fallback ladder
 * (`isOperatorDefault → validatorScore → createdAt → blueprintId`)
 * via {@link BlueprintSelector}, with an optional LLM-driven pick
 * layered atop it that never removes the deterministic floor.
 *
 * Reference implementations:
 *   - `InMemoryBlueprintStore` (this package's `/in-memory` entry) —
 *     OSS single-tenant default + test fixtures. Stores code inline
 *     via a `Map<codeHash, string>` (no S3); call
 *     {@link InMemoryBlueprintStore.putCode} / `getCode` for the body.
 *   - `DynamoBlueprintStore` (cloud subtree
 *     `cloud/ggui-protocol-pod/src/adapters/dynamo-blueprint-store.ts`)
 *     — DDB metadata + S3 code body via the companion `S3CodeStore`.
 *
 * Tenancy: every read path requires both `appId` and `contractHash`.
 * Two apps' contracts may coincidentally hash the same; their
 * blueprints must never cross-pollinate.
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
 * `(appId, contractHash)`. Implementations MUST NOT cross-leak
 * between apps even when contract hashes coincide.
 *
 * No list+filter — lookups MUST go through indexed access. The
 * conformance suite asserts this by requiring O(1) scaling on row
 * count when only one `(appId, contractHash)` group exists.
 */
export interface BlueprintStore {
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
   * losslessly. The cloud DDB adapter normalizes optional `undefined`
   * fields to "absent column" at the row projection site so reads
   * round-trip.
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
   * row's fields; callers don't pass them explicitly. Cleaner than
   * threading them through every call site.
   */
  setOperatorDefault(blueprintId: string): Promise<void>;

  /**
   * Remove a blueprint row. Implementations SHOULD also delete the
   * associated code body (in-memory `Map` entry or S3 object) when
   * no other row references the same `codeHash`. Idempotent: a
   * second delete for the same id is a no-op (does NOT throw).
   */
  delete(blueprintId: string): Promise<void>;
}
