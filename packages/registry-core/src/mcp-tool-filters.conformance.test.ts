/**
 * Drift-catch: the shipping mcpTools search-filter predicate
 * conforms to the binding-conformance filter catalog in
 * `@ggui-ai/protocol-conformance`. The memory, filesystem, and
 * cloud storage impls all share this predicate's reference
 * semantics — pinning it here pins all consumers. If this file
 * goes red, fix the shipping predicate — the kit is the arbiter,
 * never the other way around.
 */
import {
  bindingFilterCases,
  runBindingFilterCases,
  type McpToolBindingDecl,
  type McpToolFilterDecl,
} from "@ggui-ai/protocol-conformance/binding-conformance";
import { describe, expect, it } from "vitest";
import { matchesMcpToolFilters } from "./mcp-tool-filters.js";

/**
 * Pass-through adapter — exists so the decoupling between the
 * kit's declared shapes and the shipping predicate's signature
 * stays a compile-time-checked seam.
 */
function shippingMatches(
  bindings: readonly McpToolBindingDecl[] | undefined,
  filters: McpToolFilterDecl
): boolean {
  return matchesMcpToolFilters(bindings, filters);
}

describe("the shipping mcpTools filter predicate conforms to the binding-conformance catalog", () => {
  it("matches every catalog case exactly as the SPEC requires", () => {
    const result = runBindingFilterCases(shippingMatches);
    expect(
      result.failed,
      `the shipping matchesMcpToolFilters drifted from the binding-conformance catalog:\n${result.failed
        .map(
          (f) =>
            `  - ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`
        )
        .join("\n")}`
    ).toEqual([]);
    // Sanity: the runner actually exercised the full catalog — a
    // predicate that graded zero cases would also report zero failures.
    expect(bindingFilterCases.length).toBeGreaterThan(0);
    expect(result.passed.length).toBe(bindingFilterCases.length);
  });
});
