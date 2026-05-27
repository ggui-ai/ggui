/**
 * `InMemoryBlueprintStore` — reference {@link BlueprintStore}.
 *
 * Intended for tests, dev, and the OSS `@ggui-ai/mcp-server`
 * zero-config path. No persistence beyond process lifetime; no S3 —
 * code bodies are kept in a per-instance `Map<codeHash, string>` so
 * cache-hit fetches stay O(1).
 *
 * Tenancy: rows are keyed under `(appId, contractHash)` for list
 * lookups via a secondary `Map<groupKey, Set<blueprintId>>`. Primary
 * key is `blueprintId`. Production adapters (`DynamoBlueprintStore`)
 * project the same indexes into DDB GSIs.
 *
 * The `putCode` / `getCode` helpers are the in-memory equivalent of
 * S3 upload + S3 GetObject. The render handler treats them as an
 * interchangeable seam: `code?: string` resolved by `codeHash` is the
 * wire-side abstraction; the storage shape behind it is the adapter's
 * choice.
 */
import type { Blueprint } from '@ggui-ai/protocol';
import {
  BlueprintAlreadyExistsError,
  BlueprintNotFoundError,
} from '../blueprint-store.js';
import type { EmbeddingProvider } from '../embedding-provider.js';
import {
  stringifyContractForEmbedding,
  type AppListableBlueprintStore,
} from './blueprint-search.js';

function groupKey(appId: string, contractHash: string): string {
  // ` ` is a deliberate sentinel — no realistic appId or hash
  // carries it, so this is a safe composite key without escaping.
  return `${appId} ${contractHash}`;
}

/**
 * Optional construction inputs for {@link InMemoryBlueprintStore}.
 * An optional {@link EmbeddingProvider} lets `put` auto-embed the
 * contract when the caller didn't supply `contractEmbedding`.
 * Zero-arg construction works too — embedding is opt-in.
 */
export interface InMemoryBlueprintStoreOptions {
  /**
   * Optional embedding provider. When wired, `put` computes
   * `blueprint.contractEmbedding` from the canonical-JSON contract
   * BEFORE persisting, when the caller didn't pre-compute one. The
   * cloud `DynamoBlueprintStore` mirrors this behavior so OSS +
   * cloud produce identically-embedded rows.
   */
  readonly embeddingProvider?: EmbeddingProvider;
}

/**
 * In-memory {@link BlueprintStore} plus the code-body
 * `Map<codeHash, string>` that production adapters back with S3.
 * Implements {@link AppListableBlueprintStore} so the in-memory
 * {@link BlueprintSearch} can scan every blueprint under an app
 * without crossing the `(appId, contractHash)` index.
 */
export class InMemoryBlueprintStore implements AppListableBlueprintStore {
  private readonly byId = new Map<string, Blueprint>();
  /** Secondary index: `(appId, contractHash)` → set of blueprint ids. */
  private readonly byGroup = new Map<string, Set<string>>();
  /** Tertiary index: `appId` → set of blueprint ids (backs the search seam). */
  private readonly byApp = new Map<string, Set<string>>();
  /** Code-body store. Production swaps this for S3. */
  private readonly codeBodies = new Map<string, string>();
  /** Optional embedding provider — see {@link InMemoryBlueprintStoreOptions}. */
  private readonly embeddingProvider: EmbeddingProvider | undefined;

  constructor(options: InMemoryBlueprintStoreOptions = {}) {
    this.embeddingProvider = options.embeddingProvider;
  }

  async list(
    appId: string,
    contractHash: string,
  ): Promise<readonly Blueprint[]> {
    const ids = this.byGroup.get(groupKey(appId, contractHash));
    if (!ids) return [];
    const out: Blueprint[] = [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  async get(blueprintId: string): Promise<Blueprint | null> {
    return this.byId.get(blueprintId) ?? null;
  }

  async put(blueprint: Blueprint): Promise<void> {
    if (this.byId.has(blueprint.blueprintId)) {
      throw new BlueprintAlreadyExistsError(blueprint.blueprintId);
    }
    // Auto-embed when the store has an EmbeddingProvider wired AND
    // the caller didn't supply a pre-computed vector.
    // Failures degrade silently (the embed axis carries zero in
    // search); the surrounding handler's telemetry captures the throw.
    let rowToPersist = blueprint;
    if (
      this.embeddingProvider &&
      blueprint.contractEmbedding === undefined &&
      blueprint.contract
    ) {
      try {
        const vec = await this.embeddingProvider.embed(
          stringifyContractForEmbedding(blueprint.contract),
        );
        rowToPersist = { ...blueprint, contractEmbedding: vec };
      } catch {
        // Embedding failed — persist without it. Search degrades to
        // hash + structural + variance + intent axes for this row.
        rowToPersist = blueprint;
      }
    }
    this.byId.set(rowToPersist.blueprintId, rowToPersist);
    const key = groupKey(rowToPersist.appId, rowToPersist.contractHash);
    let groupSet = this.byGroup.get(key);
    if (!groupSet) {
      groupSet = new Set();
      this.byGroup.set(key, groupSet);
    }
    groupSet.add(rowToPersist.blueprintId);
    let appSet = this.byApp.get(rowToPersist.appId);
    if (!appSet) {
      appSet = new Set();
      this.byApp.set(rowToPersist.appId, appSet);
    }
    appSet.add(rowToPersist.blueprintId);
  }

  /**
   * Enumerate every blueprint under `appId`, regardless of
   * `contractHash`. Backs the search seam — see
   * {@link AppListableBlueprintStore}.
   */
  async listAllForApp(appId: string): Promise<readonly Blueprint[]> {
    const ids = this.byApp.get(appId);
    if (!ids) return [];
    const out: Blueprint[] = [];
    for (const id of ids) {
      const row = this.byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  async setOperatorDefault(blueprintId: string): Promise<void> {
    const target = this.byId.get(blueprintId);
    if (!target) throw new BlueprintNotFoundError(blueprintId);
    const key = groupKey(target.appId, target.contractHash);
    const groupIds = this.byGroup.get(key);
    // Clear the flag on any prior default for the same group.
    if (groupIds) {
      for (const id of groupIds) {
        const row = this.byId.get(id);
        if (!row) continue;
        if (row.isOperatorDefault && id !== blueprintId) {
          // Rebuild without the flag — Blueprint is readonly so we
          // copy + omit the optional field.
          const { isOperatorDefault: _omit, ...rest } = row;
          void _omit;
          this.byId.set(id, rest);
        }
      }
    }
    // Set the flag on the target.
    if (!target.isOperatorDefault) {
      this.byId.set(blueprintId, { ...target, isOperatorDefault: true });
    }
  }

  async delete(blueprintId: string): Promise<void> {
    const existing = this.byId.get(blueprintId);
    if (!existing) return; // Idempotent.
    this.byId.delete(blueprintId);
    const key = groupKey(existing.appId, existing.contractHash);
    const set = this.byGroup.get(key);
    if (set) {
      set.delete(blueprintId);
      if (set.size === 0) this.byGroup.delete(key);
    }
    // Keep the `byApp` tertiary index consistent.
    const appSet = this.byApp.get(existing.appId);
    if (appSet) {
      appSet.delete(blueprintId);
      if (appSet.size === 0) this.byApp.delete(existing.appId);
    }
    // GC the code body when no other row references the same hash.
    if (existing.codeHash) {
      let stillReferenced = false;
      for (const row of this.byId.values()) {
        if (row.codeHash === existing.codeHash) {
          stillReferenced = true;
          break;
        }
      }
      if (!stillReferenced) this.codeBodies.delete(existing.codeHash);
    }
  }

  /**
   * Store the code body under `codeHash`. Production adapter
   * equivalent: PutObject to S3 at `s3://<bucket>/blueprints/code/<codeHash>`.
   * Re-puts are idempotent (last write wins; identical content is a
   * no-op).
   */
  putCode(codeHash: string, body: string): void {
    this.codeBodies.set(codeHash, body);
  }

  /**
   * Retrieve the code body for `codeHash`, or `null` when absent.
   * Production adapter equivalent: S3 GetObject → text.
   */
  getCode(codeHash: string): string | null {
    return this.codeBodies.get(codeHash) ?? null;
  }
}
