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
import { z } from 'zod';
import { listFeaturedBlueprintsInputShape } from '@ggui-ai/protocol';
import type {
  BlueprintEntry,
  BlueprintProvider,
} from '@ggui-ai/mcp-server-core';
import type { SharedHandler } from '../types.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`). Intentionally EMPTY: the pre-launch No-Backcompat
// scrub deleted the filter vocabulary; filters re-enter when a real
// consumer passes them.
const inputSchema = listFeaturedBlueprintsInputShape;

const outputSchema = {
  // Two-arg `z.record(z.string(), z.unknown())` — zod v4 dropped the
  // single-arg form. Keeping the explicit key/value pair so schema
  // construction works under both zod majors; see
  // `search-blueprints.ts` for the same rationale.
  blueprints: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nonnegative(),
};

export interface ListFeaturedBlueprintsDeps {
  /**
   * Blueprint catalog source. Omitted = handler returns
   * `{blueprints: [], total: 0}` — the zero-config behavior for
   * servers that haven't declared any blueprints.
   */
  readonly blueprints?: BlueprintProvider;
}

/**
 * Concrete return shape of {@link createListFeaturedBlueprintsHandler}'s
 * handler. Mirrors {@link outputSchema} without laundering through
 * `z.record(z.unknown())` — `blueprints` entries are `BlueprintEntry`
 * (the provider's canonical row shape) so callers get real field
 * typing instead of `unknown`.
 */
export interface ListFeaturedBlueprintsOutput {
  readonly blueprints: BlueprintEntry[];
  readonly total: number;
}

export function createListFeaturedBlueprintsHandler(
  deps: ListFeaturedBlueprintsDeps = {},
): SharedHandler<typeof inputSchema, typeof outputSchema, ListFeaturedBlueprintsOutput> {
  return {
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
      return {
        blueprints: entries.map((entry) => ({ ...entry })),
        total: entries.length,
      };
    },
  };
}
