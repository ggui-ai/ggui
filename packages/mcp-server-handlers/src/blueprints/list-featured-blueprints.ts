/**
 * ggui_list_featured_blueprints — builder-curated featured blueprints.
 *
 * Factory over `BlueprintProvider.list`. When a provider is supplied,
 * the handler enumerates the provider's catalog and returns
 * `BlueprintEntry[]` wrapped in the tool's output shape. When no
 * provider is supplied, the handler returns an empty list — the
 * default for zero-config servers that haven't declared any
 * blueprints.
 *
 * `@ggui-ai/mcp-server`'s `createGguiServer` bridges a
 * `ManifestBlueprintProvider` (seeded from `ggui.json#blueprints.include`
 * at boot) into this factory, so every UI declared in the operator's
 * manifest becomes discoverable through this tool.
 */
import {
  gguiListFeaturedBlueprintsOutputSchema,
  listFeaturedBlueprintsInputShape,
} from '@ggui-ai/protocol';
import type { BlueprintProvider } from '@ggui-ai/mcp-server-core';
import { defineHandler, type ShapeOutput } from '../types.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`). Intentionally EMPTY: the pre-launch No-Backcompat
// scrub deleted the filter vocabulary; filters re-enter when a real
// consumer passes them.
const inputSchema = listFeaturedBlueprintsInputShape;

// The protocol owns this wire shape (#817): the provider's row composes the
// protocol's `blueprintSourceSchema`, so `source` is the object union, never a record.
const outputSchema = gguiListFeaturedBlueprintsOutputSchema.shape;

/** The wire shape — derived from the registered schema (#817). */
export type ListFeaturedBlueprintsOutput = ShapeOutput<typeof outputSchema>;

export interface ListFeaturedBlueprintsDeps {
  /**
   * Blueprint catalog source. Omitted = handler returns
   * `{blueprints: [], total: 0}` — the zero-config behavior for
   * servers that haven't declared any blueprints.
   */
  readonly blueprints?: BlueprintProvider;
}

export function createListFeaturedBlueprintsHandler(deps: ListFeaturedBlueprintsDeps = {}) {
  return defineHandler({
    name: 'ggui_list_featured_blueprints',
    title: 'List featured blueprints',
    audience: ['agent'],
    description:
      "Builder-curated featured blueprints. Returns entries declared via the server's blueprint catalog (typically ggui.json's `blueprints.include` for OSS deployments). Empty when no catalog is wired.",
    inputSchema,
    outputSchema,
    async handler() {
      const provider = deps.blueprints;
      if (!provider) {
        return { blueprints: [], total: 0 };
      }
      const entries = await provider.list({});
      // Project the provider rows onto the wire — the registered shape's keys,
      // as fresh values (`tags` copied; nothing beyond the schema travels).
      return {
        blueprints: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          source: entry.source,
          updatedAt: entry.updatedAt,
          ...(entry.tags !== undefined ? { tags: [...entry.tags] } : {}),
        })),
        total: entries.length,
      };
    },
  });
}
