/**
 * Shared MCP-tool search-filter predicate — the reference semantics
 * every {@link RegistryStorage.scanArtifacts} implementation must
 * reproduce for the `tool` / `server` filter dimensions:
 *
 *   - `tool` only    → any binding entry with that tool name (with or
 *                      without a `server`).
 *   - `server` only  → any binding entry declaring that server; bare
 *                      (server-less) entries never match.
 *   - both           → a single entry with exactly that (server, tool)
 *                      pair.
 *   - neither        → always `true` (the filter is inactive).
 *
 * Matching is case-sensitive exact on both dimensions — MCP tool names
 * are case-sensitive. AND-composes with every other scan-filter
 * dimension; artifacts without bindings never match an active filter.
 */
import type { McpToolBinding } from '@ggui-ai/artifact-manifest';

export function matchesMcpToolFilters(
  bindings: ReadonlyArray<McpToolBinding> | undefined,
  filters: { tool?: string; server?: string },
): boolean {
  const { tool, server } = filters;
  if (tool === undefined && server === undefined) return true;
  if (bindings === undefined || bindings.length === 0) return false;
  return bindings.some((binding) => {
    if (tool !== undefined && binding.tool !== tool) return false;
    if (server !== undefined && binding.server !== server) return false;
    return true;
  });
}
