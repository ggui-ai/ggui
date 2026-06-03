/**
 * Per-app tool-identity catalog store — the persistence seam shared by
 * the two sides of cross-runtime tool-identity canonicalization:
 *
 *   - WRITE side: `createGguiDeclareToolCatalogHandler`
 *     (`ggui_runtime_declare_tool_catalog`) — the host runtime declares
 *     its `{ bareToolName -> canonical serverInfo }` catalog on connect.
 *   - READ side (next slice): the handshake canonicalization step reads
 *     the app's catalog and feeds it to `canonicalizeToolIdentity` so a
 *     reused blueprint's tool `serverInfo` is rewritten to the canonical
 *     identity the runtime actually declared.
 *
 * Keyed by `appId`. REPLACE semantics: each `set` overwrites the app's
 * prior catalog wholesale (a runtime re-declares its full current
 * toolset on connect). Both `set` and `get` MAY be async so a hosted
 * deployment can back the store with a per-app row; the in-memory
 * reference below is synchronous.
 */
import type { ToolIdentityCatalog } from "./canonicalize-tool-identity.js";

export interface ToolIdentityCatalogStore {
  set(appId: string, catalog: ToolIdentityCatalog): void | Promise<void>;
  get(appId: string): ToolIdentityCatalog | undefined | Promise<ToolIdentityCatalog | undefined>;
}

/**
 * Reference {@link ToolIdentityCatalogStore} for OSS single-tenant
 * deployments + tests. One catalog per appId, last-write-wins. Mirrors
 * the in-memory-store pattern used elsewhere in the handler package
 * (e.g. `InMemoryAppMetadataStore`).
 */
export class InMemoryToolIdentityCatalogStore implements ToolIdentityCatalogStore {
  private readonly byApp = new Map<string, ToolIdentityCatalog>();

  set(appId: string, catalog: ToolIdentityCatalog): void {
    this.byApp.set(appId, catalog);
  }

  get(appId: string): ToolIdentityCatalog | undefined {
    return this.byApp.get(appId);
  }
}
