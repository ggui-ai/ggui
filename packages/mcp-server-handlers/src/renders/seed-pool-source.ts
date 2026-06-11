/**
 * A source of portable-blueprint records for a read-only shared pool.
 * The OSS adapter reads a directory artifact; a future cloud adapter
 * reads its own store. `buildSeedPool` consumes this port only.
 *
 * Records are UNVALIDATED (`unknown`): the artifact bytes are an
 * untrusted input, and the trust boundary is `fromPortableBlueprint`
 * inside `buildSeedPool` — sources just load bytes, they never vouch
 * for shape.
 */
export interface SeedPoolSource {
  /** Human label for the pool (diagnostics / pool.label). */
  readonly label: string;
  /** Load all raw records this source provides. */
  loadAll(): Promise<readonly unknown[]>;
}
