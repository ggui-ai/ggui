/**
 * MCP tool bindings — the `mcpTools` search-metadata field shared by
 * both artifact-manifest kinds, plus the declared-vs-derived resolver
 * registry publish flows use to compute the effective binding set.
 *
 * A binding names an MCP tool (optionally scoped to an MCP server,
 * `serverInfo.name` semantics) that the artifact renders a UI for.
 * Bindings are search metadata ONLY:
 *
 *   - They MUST NOT enter contract canonicalization, `blueprintKey`,
 *     or any cache identity — declaring or removing bindings never
 *     re-keys an artifact.
 *   - They are publisher claims. A binding MUST NOT be presented as
 *     an endorsement by the named server or its authors.
 *
 * Precedence ({@link resolveMcpToolBindings}): a declared `mcpTools`
 * field wins entirely — derivation never runs, no merge. Blueprints
 * without the field derive bare tool-name bindings from their
 * contract (`propsSpec.properties[*].sourceTool` union
 * `streamSpec[*].source.tool`). Gadgets never derive (they carry no
 * contract).
 */
import { z } from "zod";
import type { BlueprintManifest } from "./blueprint-manifest.js";
import type { GadgetManifest } from "./gadget-manifest.js";

/**
 * Charset for both `server` and `tool` binding names — 1-128 chars
 * of `[A-Za-z0-9_.-]`, the practical MCP tool-name grammar.
 * Case-sensitive throughout (MCP tool names are). Registry search
 * input validation (`tool=` / `server=` filters) imports this via
 * the package barrel so the wire filters and the manifest field
 * stay on a single charset rule.
 */
export const MCP_TOOL_BINDING_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Shared entry-count bound for a binding list, declared OR derived —
 * one envelope, referenced everywhere a cap applies rather than a
 * second magic `16` drifting from this one. Exported so downstream
 * callers that derive a bound from this cap stay coupled by import
 * instead of a second hand-copied constant — if this cap ever
 * changes, every derived bound recomputes automatically instead of
 * silently drifting.
 */
export const MCP_TOOL_BINDING_MAX_ENTRIES = 16;

/**
 * One MCP tool binding. `server` optional — omit for a
 * server-agnostic tool-name binding.
 */
export const mcpToolBindingSchema = z.strictObject({
  server: z
    .string()
    .regex(MCP_TOOL_BINDING_NAME_RE, {
      message: "server must be 1-128 chars of `[A-Za-z0-9_.-]` (MCP server name charset).",
    })
    .optional()
    .describe(
      "MCP server identity this binding targets — `serverInfo.name` semantics, matched case-sensitively. Omit for a server-agnostic binding that matches the tool name on any server. 1-128 chars, charset `[A-Za-z0-9_.-]`."
    ),
  tool: z
    .string()
    .regex(MCP_TOOL_BINDING_NAME_RE, {
      message: "tool must be 1-128 chars of `[A-Za-z0-9_.-]` (MCP tool name charset).",
    })
    .describe(
      "MCP tool name this artifact renders. Matched case-sensitively by the registry search `tool` filter. 1-128 chars, charset `[A-Za-z0-9_.-]`."
    ),
});

/** Static TS type for one binding entry. */
export type McpToolBinding = z.infer<typeof mcpToolBindingSchema>;

/**
 * Bounded binding list. Caps protect the index and wire payload
 * size — 16 entries covers every realistic multi-tool artifact
 * while bounding worst-case spam (same rationale as the 20-tag
 * cap on `tags`). Exact-duplicate `(server, tool)` pairs are
 * rejected; the same tool under different servers (or bare +
 * server-scoped) is legal.
 */
export const mcpToolsSchema = z
  .array(mcpToolBindingSchema)
  .min(1, { message: "mcpTools must declare at least one binding." })
  .max(MCP_TOOL_BINDING_MAX_ENTRIES, {
    message: `at most ${MCP_TOOL_BINDING_MAX_ENTRIES} MCP tool bindings per artifact.`,
  })
  .readonly()
  .refine(
    (bindings) => {
      const seen = new Set<string>();
      for (const binding of bindings) {
        const key = JSON.stringify([binding.server ?? null, binding.tool]);
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: "duplicate `(server, tool)` binding pairs are not allowed." }
  );

/**
 * Provenance of a resolved binding set — declared verbatim on the
 * manifest, or derived from a blueprint contract's tool names.
 */
export type McpToolBindingSource = "declared" | "derived";

/**
 * Compute the effective binding set for a manifest. Pure.
 *
 * Precedence: a declared `mcpTools` field wins entirely (result
 * marked `declared`; derivation never runs, no merge). Otherwise,
 * blueprint manifests with a contract derive bare `{tool}` entries
 * from the union of `contract.propsSpec.properties[*].sourceTool`
 * and `contract.streamSpec[*].source.tool` (contracts carry no
 * server identity), marked `derived`. Derivation stays INSIDE the
 * same envelope a declared list is validated against — it composes
 * the envelope, it does not relax it:
 *
 *   - Every candidate tool name is filtered through
 *     {@link MCP_TOOL_BINDING_NAME_RE}; a name failing the charset
 *     (including the empty string — just one case of the charset
 *     filter) is dropped silently rather than rejected. Contract
 *     lineage is agent/tool-authored data, not an author
 *     declaration, so malformed lineage is noise to filter, not a
 *     manifest error.
 *   - Survivors are deduped first-seen — props entries in
 *     declaration order, then stream channels in declaration order —
 *     then capped at {@link MCP_TOOL_BINDING_MAX_ENTRIES} in that
 *     same first-appearance order, matching the bound a declared
 *     list is schema-capped at.
 *
 * Returns `undefined` when nothing declares or derives (gadgets
 * without `mcpTools`, contract-less blueprints, contracts naming no
 * valid tools) — such artifacts are simply not findable by tool.
 */
export function resolveMcpToolBindings(
  manifest: GadgetManifest | BlueprintManifest
): { source: McpToolBindingSource; bindings: ReadonlyArray<McpToolBinding> } | undefined {
  if (manifest.mcpTools !== undefined) {
    return { source: "declared", bindings: manifest.mcpTools };
  }
  if (manifest.kind !== "blueprint" || manifest.contract === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const tools: string[] = [];
  const add = (tool: string | undefined): void => {
    if (tool === undefined || !MCP_TOOL_BINDING_NAME_RE.test(tool) || seen.has(tool)) return;
    seen.add(tool);
    tools.push(tool);
  };
  for (const entry of Object.values(manifest.contract.propsSpec?.properties ?? {})) {
    add(entry.sourceTool);
  }
  for (const entry of Object.values(manifest.contract.streamSpec ?? {})) {
    add(entry.source?.tool);
  }
  if (tools.length === 0) return undefined;
  const capped = tools.slice(0, MCP_TOOL_BINDING_MAX_ENTRIES);
  return { source: "derived", bindings: capped.map((tool) => ({ tool })) };
}
