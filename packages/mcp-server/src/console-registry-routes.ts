/**
 * Console blueprint-catalog read/maintenance routes.
 *
 *   GET    /ggui/console/registry                  — declared-blueprint +
 *          primitive catalog (boot-time content).
 *   GET    /ggui/console/blueprints/cached         — intent-keyed
 *          generation-cache listing (legacy surface).
 *   DELETE /ggui/console/blueprints/cached/:id     — invalidate one entry.
 *   POST   /ggui/console/blueprints/cached/clear   — bulk-clear the scope.
 *   GET    /ggui/console/blueprints/registry       — contract-keyed runtime
 *          registry the matcher actually consults (per-row tier
 *          diagnostics: kind, contractKey, hitCount, lastHitAt,
 *          provenance).
 *
 * `/registry` sources:
 *   - `blueprints[]`  ← `uiRegistry?.list()` (full manifest entries;
 *     surfaces `name` + `description?` + `category?`). Same registry
 *     the `/ggui/console/blueprint/:id` endpoint resolves against, so
 *     the /registry click-through to /preview/<id> is guaranteed to
 *     hit the same dataset.
 *   - `primitives[]` ← `primitiveCatalogs` (`DiscoveredPrimitiveCatalog`
 *     shape from `@ggui-ai/project-config`). Each entry flattens
 *     one primitive per row, tagging it with its catalog's
 *     `source` ('package' | 'local') + `import` specifier.
 *
 * Scope: read-only on `/registry` (authoring happens on disk and the
 * server re-reads on boot; zero-config is an honest empty shape).
 * The cache/registry surfaces are scoped to `DEFAULT_BUILDER_APP_ID`
 * because the OSS server is single-tenant by construction — same
 * scope the render handler writes to, so list/invalidate/clear see
 * what the real cache writes.
 *
 * Enumeration gate: `listGenerationCache` + `clearGenerationCache` +
 * `listBlueprints` require an EnumerableVectorStore. Every OSS
 * default satisfies it (`InMemoryVectorStore`, `SqliteVectorStore`);
 * deployments that wire a non-enumerable backend get an honest `501`
 * with a reason code rather than a silent empty list or a runtime
 * throw.
 *
 * No bearer auth (same rule as the other console endpoints —
 * same-origin operator-facing).
 */

import type { VectorStore } from "@ggui-ai/mcp-server-core";
import { isEnumerableVectorStore } from "@ggui-ai/mcp-server-core";
import {
  clearGenerationCache,
  invalidateGenerationCache,
  listBlueprints,
  listGenerationCache,
  type GenerationCacheEntry,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { DiscoveredPrimitiveCatalog } from "@ggui-ai/project-config/node";
import type { UiRegistry } from "@ggui-ai/ui-registry";
import type { Express } from "express";
import { DEFAULT_BUILDER_APP_ID } from "./auth.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Declared-blueprint registry (absent = empty `blueprints[]`). */
  readonly uiRegistry?: UiRegistry;
  /** Discovered primitive catalogs (absent = empty `primitives[]`). */
  readonly primitiveCatalogs?: ReadonlyArray<DiscoveredPrimitiveCatalog>;
  /** Vector store backing the generation cache + runtime registry. */
  readonly vectors: VectorStore;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount the console catalog routes onto the express app. Returns
 * nothing — the routes self-register.
 */
export function mountConsoleRegistryRoutes(opts: MountOptions): void {
  const { app, uiRegistry, primitiveCatalogs, vectors, logger } = opts;

  // GET /ggui/console/registry — declared catalog. Output is
  // stable-sorted by id / name so the SPA's filter-as-you-type UI
  // doesn't need a second sort pass.
  app.get("/ggui/console/registry", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    interface BlueprintSummary {
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly category?: string;
    }
    interface PrimitiveSummary {
      readonly name: string;
      readonly source: "package" | "local";
      readonly catalog: string;
    }

    const blueprints: BlueprintSummary[] = [];
    if (uiRegistry) {
      try {
        const entries = await uiRegistry.list();
        for (const entry of entries) {
          const summary: BlueprintSummary = {
            id: entry.id,
            name: entry.manifest.name,
            ...(entry.manifest.description !== undefined
              ? { description: entry.manifest.description }
              : {}),
            ...(entry.manifest.category !== undefined ? { category: entry.manifest.category } : {}),
          };
          blueprints.push(summary);
        }
        blueprints.sort((a, b) => a.id.localeCompare(b.id));
      } catch (err) {
        logger.warn("console_registry_blueprint_list_failed", {
          error: String(err),
        });
        res.status(500).json({
          error: "registry_unavailable",
          message:
            err instanceof Error
              ? `Blueprint registry failed to list — ${err.message}`
              : `Blueprint registry failed to list — ${String(err)}`,
        });
        return;
      }
    }

    const primitives: PrimitiveSummary[] = [];
    for (const catalog of primitiveCatalogs ?? []) {
      for (const primitive of catalog.manifest.primitives) {
        primitives.push({
          name: primitive.name,
          source: catalog.source,
          catalog: catalog.import,
        });
      }
    }
    // Stable sort: primary by catalog import (packages first, then
    // locals under their own groups), secondary by primitive name.
    // Operator reads "everything from @ggui-ai/design" as one block
    // rather than having @ggui-ai/design's Button interleaved with
    // a local-catalog Button at the letter-b slot.
    primitives.sort((a, b) => {
      const byCatalog = a.catalog.localeCompare(b.catalog);
      if (byCatalog !== 0) return byCatalog;
      return a.name.localeCompare(b.name);
    });

    res.json({ blueprints, primitives });
  });

  // GET /ggui/console/blueprints/cached — list cached generation
  // entries. Rejects with 501 when the vector store doesn't
  // support enumeration. Empty scope returns
  // `{entries: [], total: 0}` — not an error.
  app.get("/ggui/console/blueprints/cached", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    if (!isEnumerableVectorStore(vectors)) {
      res.status(501).json({
        error: "enumeration_unsupported",
        message:
          "The configured vector store does not support enumeration. " +
          "Wire an EnumerableVectorStore (default InMemoryVectorStore " +
          "or SqliteVectorStore) to surface the cache in the console.",
      });
      return;
    }
    try {
      const entries = await listGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID);
      const payload: readonly GenerationCacheEntry[] = entries;
      res.json({ entries: payload, total: payload.length });
    } catch (err) {
      logger.warn("console_blueprints_cached_list_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "cache_unavailable",
        message:
          err instanceof Error
            ? `Generation cache failed to list — ${err.message}`
            : `Generation cache failed to list — ${String(err)}`,
      });
    }
  });

  // DELETE /ggui/console/blueprints/cached/:id — invalidate one
  // cached entry. Idempotent — 204 whether the id was present or
  // not (same contract as VectorStore.deleteVector). No enumerable
  // gate — delete works on every vector-store implementation.
  app.delete("/ggui/console/blueprints/cached/:id", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const id = req.params.id;
    if (!id || id.length === 0) {
      res.status(400).json({
        error: "missing_id",
        message: "Cache entry id required in path segment.",
      });
      return;
    }
    try {
      await invalidateGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID, id);
      res.status(204).end();
    } catch (err) {
      logger.warn("console_blueprints_cached_invalidate_failed", {
        error: String(err),
        id,
      });
      res.status(500).json({
        error: "cache_invalidate_failed",
        message:
          err instanceof Error
            ? `Invalidate failed — ${err.message}`
            : `Invalidate failed — ${String(err)}`,
      });
    }
  });

  // POST /ggui/console/blueprints/cached/clear — bulk-delete every
  // cached entry in the scope. Returns the count. Requires
  // EnumerableVectorStore (we enumerate to find keys to delete).
  app.post("/ggui/console/blueprints/cached/clear", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    if (!isEnumerableVectorStore(vectors)) {
      res.status(501).json({
        error: "enumeration_unsupported",
        message:
          "Bulk-clear requires a vector store that supports " +
          "enumeration. Invalidate entries individually via " +
          "DELETE /ggui/console/blueprints/cached/:id, or wire an " +
          "EnumerableVectorStore to unlock bulk-clear.",
      });
      return;
    }
    try {
      const result = await clearGenerationCache({ vectorStore: vectors }, DEFAULT_BUILDER_APP_ID);
      res.json(result);
    } catch (err) {
      logger.warn("console_blueprints_cached_clear_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "cache_clear_failed",
        message:
          err instanceof Error ? `Clear failed — ${err.message}` : `Clear failed — ${String(err)}`,
      });
    }
  });

  // GET /ggui/console/blueprints/registry — list every blueprint
  // registered in the three-tier matcher's storage.
  // Sibling of `/blueprints/cached` and intentionally distinct from
  // the declared-blueprint catalog at `/ggui/console/registry`:
  //   - `/registry` (above) — operator-declared static catalog
  //     (uiRegistry sources + primitiveCatalogs). Boot-time content.
  //   - `/blueprints/cached` (legacy) — intent-keyed generation
  //     cache. Retired.
  //   - `/blueprints/registry` (this) — contract-keyed runtime
  //     registry the matcher actually consults. Per-row tier
  //     diagnostics: kind, contractKey, hitCount, lastHitAt.
  //
  // Optional `?kind=template|organism|molecule|atom` filter narrows
  // by atomic-design level — kindless query returns everything.
  app.get("/ggui/console/blueprints/registry", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    if (!isEnumerableVectorStore(vectors)) {
      res.status(501).json({
        error: "enumeration_unsupported",
        message:
          "The configured vector store does not support enumeration. " +
          "Wire an EnumerableVectorStore (default InMemoryVectorStore " +
          "or SqliteVectorStore) to surface the registry in the console.",
      });
      return;
    }
    const rawKind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const allowedKinds = ["template", "organism", "molecule", "atom"] as const;
    type AllowedKind = (typeof allowedKinds)[number];
    const kind: AllowedKind | undefined =
      rawKind !== undefined
        ? (allowedKinds.find((k) => k === rawKind) as AllowedKind | undefined)
        : undefined;
    if (rawKind !== undefined && kind === undefined) {
      res.status(400).json({
        error: "invalid_kind",
        message: `kind must be one of ${allowedKinds.join(", ")}; got '${rawKind}'.`,
      });
      return;
    }
    try {
      const blueprints = await listBlueprints(
        { vectorStore: vectors },
        DEFAULT_BUILDER_APP_ID,
        kind
      );
      // Project to a wire-friendly view — `componentCode` is large
      // and not load-bearing for the operator listing; surface a
      // length signal instead so the UI can show "12 KB" without
      // parsing 12 KB.
      const entries = blueprints.map((bp) => ({
        id: bp.id,
        kind: bp.kind,
        contractKey: bp.contractKey,
        intent: bp.intent,
        createdAt: bp.createdAt,
        hitCount: bp.hitCount,
        ...(bp.lastHitAt !== undefined ? { lastHitAt: bp.lastHitAt } : {}),
        // Surface provenance (the BlueprintSource union — llm rows
        // carry engine slug + model) plus the install-bridge
        // lifecycle marker so operators can distinguish cold-gen vs.
        // operator-registered vs. marketplace-installed rows on
        // `/ggui/console/blueprints/registry`. Matcher behaviour is
        // unchanged — provenance is purely informational.
        source: bp.source,
        ...(bp.installed === true ? { installed: true } : {}),
        componentCodeBytes: bp.componentCode.length,
      }));
      res.json({ entries, total: entries.length });
    } catch (err) {
      logger.warn("console_registry_list_failed", { error: String(err) });
      res.status(500).json({
        error: "registry_unavailable",
        message:
          err instanceof Error
            ? `Registry list failed — ${err.message}`
            : `Registry list failed — ${String(err)}`,
      });
    }
  });
}
