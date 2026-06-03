import type { PortableBlueprint } from '@ggui-ai/protocol';

/**
 * A source of portable blueprint records for a read-only shared pool.
 * The OSS adapter reads a directory artifact; a future cloud adapter
 * reads its own store. `buildSeedPool` consumes this port only.
 */
export interface BlueprintSource {
  /** Human label for the pool (diagnostics / pool.label). */
  readonly label: string;
  /** Load all records this source provides. */
  loadAll(): Promise<readonly PortableBlueprint[]>;
}
