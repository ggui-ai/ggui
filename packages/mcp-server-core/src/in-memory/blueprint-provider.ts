/**
 * InMemoryBlueprintProvider — reference implementation of the narrowed
 * {@link BlueprintProvider} (2026-04-18 lock).
 *
 * Surface is deliberately two read methods only: `list` + `get`. Source
 * writes belong to {@link UiRegistry} in `@ggui-ai/ui-registry`; vector
 * search belongs to {@link VectorStore}. Do NOT extend this back toward
 * the old surface.
 *
 * Constructor accepts a seed array of `ScreenBlueprint` objects. The
 * `BlueprintEntry` rows returned by `list()` are derived from each
 * blueprint's fields — `displayName → name`, `intent → description`,
 * `source → source` (defaulting to `curated` when the blueprint omits
 * it), `updatedAt` pulled from an overlay map or stamped at construction.
 */
import type { ScreenBlueprint } from '@ggui-ai/protocol';
import type {
  BlueprintEntry,
  BlueprintFilter,
  BlueprintProvider,
} from '../blueprint-provider.js';

/**
 * Seed row — pair a blueprint with the optional metadata that isn't on
 * the `ScreenBlueprint` type today (`updatedAt`, `tags`). Callers that
 * only have blueprints can pass them directly; the adapter fills in
 * sensible defaults.
 */
export interface BlueprintSeed {
  blueprint: ScreenBlueprint;
  /** ISO timestamp. Defaults to `new Date(now()).toISOString()`. */
  updatedAt?: string;
  tags?: string[];
}

export interface InMemoryBlueprintProviderOptions {
  /** Seed catalog. Provider may be empty. */
  seeds?: Array<BlueprintSeed | ScreenBlueprint>;
  /** Clock for the default `updatedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

export class InMemoryBlueprintProvider implements BlueprintProvider {
  private readonly rows = new Map<
    string,
    { blueprint: ScreenBlueprint; entry: BlueprintEntry }
  >();

  private readonly now: () => number;

  constructor(opts: InMemoryBlueprintProviderOptions = {}) {
    this.now = opts.now ?? Date.now;
    for (const raw of opts.seeds ?? []) {
      const seed: BlueprintSeed =
        'blueprint' in raw ? raw : { blueprint: raw as ScreenBlueprint };
      this.add(seed);
    }
  }

  /**
   * Impl-specific affordance. Register (or overwrite) a single seed.
   * Mirrors the pattern used by `InMemoryAuthAdapter.registerToken`.
   */
  add(seed: BlueprintSeed | ScreenBlueprint): void {
    const resolved: BlueprintSeed =
      'blueprint' in seed ? seed : { blueprint: seed as ScreenBlueprint };
    const { blueprint } = resolved;
    const entry: BlueprintEntry = {
      id: blueprint.id,
      name: blueprint.displayName,
      description: blueprint.intent,
      source: blueprint.source ?? 'curated',
      updatedAt: resolved.updatedAt ?? new Date(this.now()).toISOString(),
      ...(resolved.tags ? { tags: resolved.tags.slice() } : {}),
    };
    this.rows.set(blueprint.id, { blueprint, entry });
  }

  async list(filter: BlueprintFilter): Promise<BlueprintEntry[]> {
    const q = filter.query?.trim().toLowerCase();
    const matches: BlueprintEntry[] = [];
    for (const { entry } of this.rows.values()) {
      if (filter.source !== undefined && entry.source !== filter.source) continue;
      if (filter.tag !== undefined && !(entry.tags ?? []).includes(filter.tag)) continue;
      if (q) {
        const haystack = `${entry.name} ${entry.description ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      matches.push({
        ...entry,
        ...(entry.tags ? { tags: entry.tags.slice() } : {}),
      });
    }
    // Deterministic ordering: updatedAt DESC then id ASC.
    matches.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? matches.length;
    return matches.slice(offset, offset + limit);
  }

  async get(id: string): Promise<ScreenBlueprint | null> {
    const row = this.rows.get(id);
    return row ? cloneBlueprint(row.blueprint) : null;
  }
}

function cloneBlueprint(b: ScreenBlueprint): ScreenBlueprint {
  return {
    ...b,
    data: { ...b.data },
    ...(b.actions ? { actions: { ...b.actions } } : {}),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
