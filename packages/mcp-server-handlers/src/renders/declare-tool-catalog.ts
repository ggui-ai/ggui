/**
 * `ggui_runtime_declare_tool_catalog` — the host runtime declares its
 * per-app canonical tool-identity catalog.
 *
 * The input is a `{ bareToolName -> { name, version? } }` map, where the
 * value is the canonical `serverInfo` the tool's MCP server announced in
 * its real `initialize` reply. The handler persists it under `ctx.appId`
 * via {@link ToolIdentityCatalogStore}. The next slice wires the store's
 * READ side into the handshake step so `canonicalizeToolIdentity` rewrites
 * a reused blueprint's `agentCapabilities.tools[*].serverInfo` to the
 * canonical identity — making blueprint reuse identity-stable across
 * runtimes regardless of how the inbound contract named each tool's
 * server (config-key name, fabricated name, or omitted).
 *
 * ## Audience: `['runtime']` — non-LLM host-runtime caller
 *
 * The declaring caller is the host RUNTIME (the backend library that
 * also drives the agent's handshake), NOT the LLM, NOT the iframe, NOT a
 * human operator. It calls on the SAME endpoint + credential the agent
 * uses, so ggui resolves the SAME `appId` — exactly what this handler
 * needs to scope the write.
 *
 * Why `runtime` (vs `agent`) — ROUTE PLACEMENT:
 *   - `runtime`-tagged handlers ARE routed on the agent endpoint:
 *     `filterHandlersByAudience(handlers, ["agent", "runtime"])`
 *     (`@ggui-ai/mcp-server` server.ts:4621), mounted at the universal
 *     `/mcp` path (server.ts:4640-4641) with `appId` resolved from the
 *     same auth identity (server.ts:4629-4632). So the runtime library's
 *     call lands on the same route + resolves the same `appId` as the
 *     agent's `ggui_handshake`.
 *   - The `audience` tag controls ROUTE PLACEMENT ONLY. It does NOT
 *     hide the tool from the LLM's `tools/list`, and there is NO
 *     call-time gate rejecting any caller class (server.ts:4336-4343).
 *
 * Why `_meta.ui.visibility: ['app']` IS set here — LLM-LIST HIDING:
 *   - LLM-`tools/list` hiding is done by `_meta.ui.visibility: ['app']`,
 *     NOT by the `runtime` audience tag (types.ts:219-222; the two
 *     sibling runtime handlers both carry it — submit-action.ts:237,
 *     sync-context.ts:135). Without the marker this tool would appear on
 *     the agent's `tools/list`, and an LLM could call it and poison the
 *     per-app catalog. With it, spec-compliant hosts (claude.ai, Claude
 *     Desktop) filter it out of the MODEL's list.
 *   - The marker is ADVISORY for direct callers: ggui's own canonical
 *     `/mcp` dispatch executes a `visibility:['app']` tool for ANY
 *     credentialed caller — it never rejects. The only server-ENFORCED
 *     visibility gate (403 `visibility_denied`,
 *     mcp-apps-inbound.ts:280-285) lives on the SEPARATE `/mcp-apps/
 *     tools-call` iframe-proxy route, which gates iframe-originated
 *     calls against a DOWNSTREAM connector's `tools/list` — never the
 *     canonical `/mcp` route. So Task 4's backend-LIBRARY direct call
 *     (its own credential, not an iframe relay) is NOT blocked by the
 *     marker. It is set purely to keep the tool off the LLM's list.
 */
import {
  declareToolCatalogInputSchema,
  declareToolCatalogOutputSchema,
  type DeclareToolCatalogOutput,
} from "@ggui-ai/protocol";
import type { HandlerContext, SharedHandler } from "../types.js";
import type { ToolIdentityCatalogStore } from "./tool-identity-catalog-store.js";

const declareInputSchema = declareToolCatalogInputSchema.shape;
const declareOutputSchema = declareToolCatalogOutputSchema.shape;

/**
 * Deps for `ggui_runtime_declare_tool_catalog`.
 */
export interface GguiDeclareToolCatalogDeps {
  /**
   * Per-app tool-identity catalog persistence seam (write side). The
   * same instance the handshake canonicalization step reads in the next
   * slice. REPLACE semantics — each declaration overwrites the app's
   * prior catalog.
   */
  readonly catalogStore: ToolIdentityCatalogStore;
}

export function createGguiDeclareToolCatalogHandler(
  deps: GguiDeclareToolCatalogDeps,
): SharedHandler<typeof declareInputSchema, typeof declareOutputSchema, DeclareToolCatalogOutput> {
  return {
    name: "ggui_runtime_declare_tool_catalog",
    title: "Declare tool catalog",
    audience: ["runtime"],
    // `_meta.ui.visibility: ['app']` keeps this tool off the LLM's
    // `tools/list` (spec-compliant hosts filter `app`-visible tools out
    // of the MODEL's list) so an agent can't call it and poison the
    // per-app catalog. It is ADVISORY for direct callers — ggui's
    // canonical `/mcp` dispatch executes it for any credentialed caller
    // (the backend library that declares the catalog), never rejecting.
    // See the handler docstring for the full enforcement trace.
    _meta: {
      ui: { visibility: ["app"] as const },
    },
    description:
      "Declare this app's canonical tool-identity catalog: a map of bare tool name -> the serverInfo its MCP server announced at initialize. The catalog is persisted per-app and folded into the handshake step so reused UI blueprints carry identity-stable tool references regardless of how the inbound contract named each tool's server. Host/library-supplied on connect (not an agent action); REPLACE semantics (overwrites the app's prior catalog). Returns `{saved, appId}`.",
    inputSchema: declareInputSchema,
    outputSchema: declareOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<DeclareToolCatalogOutput> {
      if (!ctx.appId) {
        throw new Error(
          "ggui_runtime_declare_tool_catalog: missing caller identity (appId empty)",
        );
      }
      const parsed = declareToolCatalogInputSchema.parse(rawInput);
      await deps.catalogStore.set(ctx.appId, parsed.toolCatalog);
      return { saved: true, appId: ctx.appId };
    },
  };
}
