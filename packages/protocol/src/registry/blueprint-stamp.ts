import { createHash } from "node:crypto";

/** Structural shape of a tool-identity catalog (handlers' ToolIdentityCatalog is assignable to this). */
export type ToolCatalogShape = Record<string, { readonly name: string; readonly version?: string }>;

/**
 * Deterministic 16-char hex hash of a tool-identity catalog. Key order is
 * normalized so the hash is stable across deployments that build the catalog
 * in different orders.
 */
export function computeToolCatalogHash(catalog: ToolCatalogShape): string {
  const normalized = Object.keys(catalog)
    .sort()
    .map((k) => [k, catalog[k]!.name, catalog[k]!.version ?? null] as const);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
