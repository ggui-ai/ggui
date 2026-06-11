/**
 * `ggui_ops_list_blueprints` — operator-class blueprint enumeration.
 *
 * Returns metadata-only blueprint rows scoped to the caller's `appId`
 * (resolved by the upstream auth adapter). The dispatch decision
 * depends on what filters the caller supplies:
 *
 *   - **Indexed list** when the only structural filter is
 *     `contractHash` — calls `BlueprintStore.list(appId, contractHash)`
 *     directly. Cheap, fast, no scoring overhead.
 *   - **Semantic search** when `intentKeywords` or `persona` is set —
 *     calls `BlueprintSearch.search(...)` and returns the matching
 *     rows sorted by score descending. Persona normalization runs
 *     first so the search criteria's `variance.persona` matches the
 *     persisted form.
 *   - **Full app scan** when the input is empty — also dispatches
 *     through `BlueprintSearch.search(...)` with no axis criteria;
 *     the search-impl iterates every blueprint under the app. The
 *     returned rows sort by `createdAt desc` so the LLM selector
 *     ladder sees a stable order — see the `BlueprintSearch`
 *     docstring.
 *
 * The `generator` filter is applied AFTER the dispatch (post-filter
 * over the returned rows) — both the indexed list and the search
 * return any-provenance rows; the handler narrows to engine-generated
 * rows (`source.kind === 'llm'`) whose `source.generator` equals the
 * requested slug. `user`-sourced rows never match the filter (they
 * carry no engine provenance).
 *
 * ## Audience
 *
 * `['ops']` — registered on `/ops`. NOT visible to agents on `/mcp`.
 */

import { z } from 'zod';
import {
  blueprintSchema,
  opsListBlueprintsInputSchema,
  type Blueprint,
  type OpsListBlueprintsInput,
  type OpsListBlueprintsOutput,
} from '@ggui-ai/protocol';
import type {
  BlueprintSearch,
  BlueprintStore,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { normalizePersona } from './persona-normalization.js';

const opsInputSchema = opsListBlueprintsInputSchema.shape;
const opsOutputSchema = {
  blueprints: z.array(blueprintSchema),
} as const;

/**
 * Deps for `ggui_ops_list_blueprints`.
 */
export interface GguiOpsListBlueprintsDeps {
  /**
   * Multi-variant blueprint store. Read on the indexed fast path
   * (`contractHash`-only filter).
   */
  readonly blueprintStore: BlueprintStore;
  /**
   * Multi-axis search seam. Read on the semantic path
   * (`intentKeywords`/`persona`/no-filter). Required because the
   * full-app-scan branch needs `BlueprintSearch.search`'s
   * `listAllForApp`-backed enumeration — the base `BlueprintStore`
   * only supports `(appId, contractHash)` lookup.
   */
  readonly blueprintSearch: BlueprintSearch;
}

/**
 * Sort blueprints by `createdAt desc`, then `blueprintId asc` as
 * stable tiebreaker. Mirrors the `BlueprintSelector` deterministic
 * ladder ordering (see `@ggui-ai/mcp-server-core/blueprint-selector`).
 */
function sortBlueprintsByCreatedAtDesc(
  rows: readonly Blueprint[],
): Blueprint[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt < b.createdAt) return 1;
    if (a.createdAt > b.createdAt) return -1;
    if (a.blueprintId < b.blueprintId) return -1;
    if (a.blueprintId > b.blueprintId) return 1;
    return 0;
  });
}

export function createGguiOpsListBlueprintsHandler(
  deps: GguiOpsListBlueprintsDeps,
): SharedHandler<
  typeof opsInputSchema,
  typeof opsOutputSchema,
  OpsListBlueprintsOutput
> {
  return {
    name: 'ggui_ops_list_blueprints',
    title: 'List blueprints',
    audience: ['ops'],
    description:
      "Enumerate blueprint metadata under the caller's `appId`. Filters AND-compose: `contractHash` narrows to one group via the indexed lookup; `generator` post-filters to `llm`-sourced rows by engine slug; `persona` filters on normalized variance; `intentKeywords` activates semantic search via `BlueprintSearch`. Empty filter set returns every blueprint under the app, sorted by `createdAt desc`. Returns metadata only — code bodies live in the bound store, fetched via render on cache hit.",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OpsListBlueprintsOutput> {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_list_blueprints: missing caller identity (appId empty)',
        );
      }
      const parsed: OpsListBlueprintsInput =
        opsListBlueprintsInputSchema.parse(rawInput);

      const normalizedPersona = normalizePersona(parsed.persona);
      const hasSemanticFilter =
        (parsed.intentKeywords !== undefined &&
          parsed.intentKeywords.length > 0) ||
        normalizedPersona !== undefined;

      let candidates: readonly Blueprint[];

      if (parsed.contractHash !== undefined && !hasSemanticFilter) {
        // Indexed fast path — only `contractHash` (+ optional
        // `generator` post-filter) was supplied.
        candidates = await deps.blueprintStore.list(
          ctx.appId,
          parsed.contractHash,
        );
      } else {
        // Semantic path — search seam handles full-app enumeration
        // and persona/intent scoring. When `contractHash` is also
        // set, it short-circuits to score 1.0 in the search impl
        // (see `BlueprintSearch` docstring).
        const searchResults = await deps.blueprintSearch.search({
          appId: ctx.appId,
          ...(parsed.contractHash !== undefined
            ? { contractHash: parsed.contractHash }
            : {}),
          ...(parsed.intentKeywords !== undefined
            ? { intentKeywords: parsed.intentKeywords }
            : {}),
          ...(normalizedPersona !== undefined
            ? { variance: { persona: normalizedPersona } }
            : {}),
          ...(parsed.generator !== undefined
            ? { generator: parsed.generator }
            : {}),
        });
        candidates = searchResults.map((r) => r.blueprint);
      }

      // Post-filter on `generator` regardless of dispatch path —
      // the indexed `list` returns every variant in the group, and
      // even the search may surface rows from a sibling generator
      // when its weighting picked them up on a non-`generator` axis.
      // Provenance-aware: only `llm`-sourced rows can match an engine
      // slug; `user` / `curated` rows carry no engine provenance.
      let filtered: readonly Blueprint[];
      if (parsed.generator !== undefined) {
        filtered = candidates.filter(
          (row) =>
            row.source.kind === 'llm' &&
            row.source.generator === parsed.generator,
        );
      } else {
        filtered = candidates;
      }

      // The semantic path already returns rows in score-desc order
      // — preserve it. The indexed path needs explicit sort.
      const ordered =
        parsed.contractHash !== undefined && !hasSemanticFilter
          ? sortBlueprintsByCreatedAtDesc(filtered)
          : filtered;

      return { blueprints: [...ordered] };
    },
  };
}
