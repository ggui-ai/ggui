/**
 * InMemoryBlueprintIndex — reference implementation of
 * {@link BlueprintIndex}.
 *
 * Intended for tests and dev. Stores bindings in a nested Map keyed by
 * `scope` then `exactKey`. No persistence, no concurrency guarantees
 * beyond single-threaded JS. Not a production backend.
 *
 * `putId` is **first-write-wins**: a second write of an already-bound
 * `(scope, exactKey)` is a no-op, never an overwrite. That is the dedup
 * primitive the blueprint registry relies on. Production bindings
 * (SQLite, DynamoDB, …) MUST pass `runBlueprintIndexConformance` to be
 * considered compatible.
 */
import type { BlueprintIndex } from '../blueprint-index.js';

export class InMemoryBlueprintIndex implements BlueprintIndex {
  /** scope → exactKey → blueprint UUID */
  private readonly index = new Map<string, Map<string, string>>();

  async getId(scope: string, exactKey: string): Promise<string | null> {
    return this.index.get(scope)?.get(exactKey) ?? null;
  }

  async putId(
    scope: string,
    exactKey: string,
    blueprintId: string,
  ): Promise<void> {
    let bucket = this.index.get(scope);
    if (!bucket) {
      bucket = new Map();
      this.index.set(scope, bucket);
    }
    // First-write-wins — never overwrite an existing binding.
    if (!bucket.has(exactKey)) bucket.set(exactKey, blueprintId);
  }

  async deleteId(scope: string, exactKey: string): Promise<void> {
    this.index.get(scope)?.delete(exactKey);
  }
}
