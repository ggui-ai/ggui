/**
 * ManifestBlueprintProvider — `BlueprintProvider` backed by parsed
 * `ggui.ui.json` manifests.
 *
 * This is the OSS-server counterpart to {@link InMemoryBlueprintProvider}:
 *
 * - `InMemoryBlueprintProvider` seeds from full `ScreenBlueprint`
 *   records (the hosted Screen-Designer catalog shape). `get(id)`
 *   hydrates the blueprint; `list()` derives catalog entries from
 *   its fields. Designed for the hosted-runtime curated-catalog path.
 *
 * - This provider seeds from authored-UI manifests. The
 *   {@link UiManifest} shape (`id`, `name`, `description?`,
 *   `category?`) is exactly the subset `BlueprintEntry` cares about,
 *   so `list()` derives entries directly without fabricating any
 *   `ScreenBlueprintDataSource` bindings. There is no
 *   `ScreenBlueprint` to hydrate for an authored UI — `get(id)`
 *   returns `null` for every known id, which is a legitimate
 *   `BlueprintProvider.get` return. Consumers that want the full UI
 *   artifact resolve it via the `UiRegistry` seam (bundle lookup),
 *   not via this provider.
 *
 * The reason to keep these two providers separate rather than
 * reshaping `InMemoryBlueprintProvider` to accept both: mixing
 * full-blueprint seeds with manifest seeds forces every consumer to
 * branch on "this came from a ScreenBlueprint vs a UiManifest",
 * and the semantic of `get(id)` becomes "sometimes hydrates, sometimes
 * returns null for reasons you have to reverse-engineer". Two
 * narrowly-typed classes with the same interface keep each path
 * honest.
 *
 * ## Input shape is structural by design
 *
 * {@link ManifestBlueprintSeed} duck-types the subset of
 * `UiManifestV1` this provider needs. That keeps
 * `@ggui-ai/mcp-server-core` free of an import edge on
 * `@ggui-ai/project-config` (the file-format owner). Callers with a
 * parsed `UiManifestV1` pass it directly — the structural shape
 * accepts it without coercion.
 */
import type { ScreenBlueprint } from '@ggui-ai/protocol';
import type {
  BlueprintEntry,
  BlueprintFilter,
  BlueprintProvider,
} from '../blueprint-provider.js';

/**
 * Seed row for {@link ManifestBlueprintProvider}. Duck-typed to
 * `UiManifestV1` — any object carrying these fields (and no others
 * we care about) works. Optional `updatedAt` + `tags` ride along in
 * case the caller has better metadata than the default timestamp.
 */
export interface ManifestBlueprintSeed {
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** ISO timestamp. Defaults to `new Date(now()).toISOString()`. */
  updatedAt?: string;
  tags?: string[];
}

export interface ManifestBlueprintProviderOptions {
  /** Seed manifests. Provider may be empty. */
  manifests?: readonly ManifestBlueprintSeed[];
  /** Clock for the default `updatedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

export class ManifestBlueprintProvider implements BlueprintProvider {
  private readonly rows = new Map<string, BlueprintEntry>();

  private readonly now: () => number;

  constructor(opts: ManifestBlueprintProviderOptions = {}) {
    this.now = opts.now ?? Date.now;
    for (const manifest of opts.manifests ?? []) {
      this.addManifest(manifest);
    }
  }

  /**
   * Impl-specific affordance. Register (or overwrite) a single
   * manifest. Mirrors `InMemoryBlueprintProvider.add` so tests and
   * dynamic-refresh flows have a stable ergonomic.
   */
  addManifest(manifest: ManifestBlueprintSeed): void {
    const tags = mergeTags(manifest.category, manifest.tags);
    const entry: BlueprintEntry = {
      id: manifest.id,
      name: manifest.name,
      // Keep `user` as the source tag — these are author-curated UIs
      // declared in the operator's own `ggui.json`, not the hosted
      // curated catalog. `BlueprintEntry.source = 'user'` already
      // exists for exactly this case.
      source: 'user',
      updatedAt: manifest.updatedAt ?? new Date(this.now()).toISOString(),
      ...(manifest.description !== undefined
        ? { description: manifest.description }
        : {}),
      ...(tags.length > 0 ? { tags } : {}),
    };
    this.rows.set(manifest.id, entry);
  }

  async list(filter: BlueprintFilter): Promise<BlueprintEntry[]> {
    const q = filter.query?.trim().toLowerCase();
    const matches: BlueprintEntry[] = [];
    for (const entry of this.rows.values()) {
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
    // Deterministic ordering: updatedAt DESC then id ASC — same
    // contract as InMemoryBlueprintProvider so consumers that
    // branch on provider type still see stable ordering.
    matches.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? matches.length;
    return matches.slice(offset, offset + limit);
  }

  async get(_id: string): Promise<ScreenBlueprint | null> {
    // Authored-UI manifests do not carry a ScreenBlueprint recipe —
    // there is nothing to hydrate. Consumers that want the rendered
    // artifact resolve it via the `UiRegistry` seam (bundle
    // lookup), not through this provider.
    return null;
  }
}

function mergeTags(
  category: string | undefined,
  tags: readonly string[] | undefined,
): string[] {
  const merged = new Set<string>();
  if (category) merged.add(category);
  for (const tag of tags ?? []) merged.add(tag);
  return Array.from(merged);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
