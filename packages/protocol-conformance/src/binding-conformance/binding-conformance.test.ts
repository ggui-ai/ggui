/**
 * Binding-conformance catalog meta-tests.
 *
 * Two jobs:
 *   1. Pin the published catalog shape (counts, load-bearing case
 *      fields, name uniqueness across both catalogs).
 *   2. Prove the catalogs are internally coherent + the runners
 *      grade honestly: faithful, spec-correct implementations pass
 *      every case; deliberately wrong ones fail exactly the cases
 *      they should.
 *
 * ## Why kit-local reference implementations, not shipping ones
 *
 * The shipping binding resolver and search-filter predicate live in
 * implementation packages. A vendor-neutral conformance kit MUST
 * NOT depend on a specific implementation. So this meta-test
 * verifies the catalogs against faithful implementations restated
 * here from the SPEC: the shared name charset, declared-wins
 * precedence, the contract-lineage derivation union
 * (`propsSpec.properties[*].sourceTool` +
 * `streamSpec[*].source.tool`), and the per-entry AND filter.
 *
 * The drift-catch against the SHIPPING implementations belongs
 * implementation-side — `.conformance.test.ts` files in the owning
 * packages grading their real functions via these runners.
 */
import { describe, expect, it } from "vitest";

import {
  bindingFilterCases,
  bindingResolutionCases,
  runBindingFilterCases,
  runBindingResolutionCases,
  type BindingManifestEntry,
  type BindingResolutionOutcome,
  type McpToolBindingDecl,
  type McpToolFilterDecl,
} from "./index.js";

/** The SPEC's shared name rule for binding `tool` and `server`. */
const MCP_TOOL_BINDING_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * A faithful minimal binding resolver. A declared `mcpTools` list is
 * validated (1–16 entries, shared charset on both names, no
 * exact-duplicate `(server, tool)` pairs) and wins entirely; absent
 * that, a blueprint contract derives bare tool names from its
 * lineage fields in first-appearance order, staying inside the same
 * envelope a declared list is validated against — a lineage name
 * failing the shared charset (including the empty string) is
 * filtered out silently rather than rejected (contract lineage is
 * agent/tool-authored data, not an author declaration), and the
 * deduped survivors are capped at 16 entries in first-appearance
 * order, the same bound `mcpTools` is schema-capped at; otherwise
 * the artifact has no bindings.
 */
function referenceResolve(entry: BindingManifestEntry): BindingResolutionOutcome {
  if (entry.mcpTools !== undefined) {
    if (entry.mcpTools.length < 1 || entry.mcpTools.length > 16) {
      return { outcome: "reject", code: "manifest_invalid" };
    }
    const seen = new Set<string>();
    for (const binding of entry.mcpTools) {
      if (!MCP_TOOL_BINDING_NAME_RE.test(binding.tool)) {
        return { outcome: "reject", code: "manifest_invalid" };
      }
      if (binding.server !== undefined && !MCP_TOOL_BINDING_NAME_RE.test(binding.server)) {
        return { outcome: "reject", code: "manifest_invalid" };
      }
      // NUL is outside the name charset, so the key cannot collide.
      const pairKey = `${binding.server ?? ""}\0${binding.tool}`;
      if (seen.has(pairKey)) {
        return { outcome: "reject", code: "manifest_invalid" };
      }
      seen.add(pairKey);
    }
    return {
      outcome: "accept",
      source: "declared",
      bindings: entry.mcpTools,
    };
  }
  if (entry.kind === "blueprint" && entry.contract !== undefined) {
    const orderedTools: string[] = [];
    const seenTools = new Set<string>();
    const addTool = (tool: string | undefined): void => {
      if (
        tool !== undefined &&
        MCP_TOOL_BINDING_NAME_RE.test(tool) &&
        !seenTools.has(tool)
      ) {
        seenTools.add(tool);
        orderedTools.push(tool);
      }
    };
    for (const prop of Object.values(entry.contract.propsSpec?.properties ?? {})) {
      addTool(prop.sourceTool);
    }
    for (const channel of Object.values(entry.contract.streamSpec ?? {})) {
      addTool(channel.source?.tool);
    }
    if (orderedTools.length > 0) {
      return {
        outcome: "accept",
        source: "derived",
        bindings: orderedTools.slice(0, 16).map((tool) => ({ tool })),
      };
    }
  }
  return { outcome: "accept" };
}

/**
 * A faithful minimal filter predicate: no filters passes every
 * artifact; with filters, some SINGLE entry must satisfy every
 * given dimension — tool exact, server exact (bare entries declare
 * no server, so they never satisfy a server dimension).
 */
function referenceMatches(
  bindings: readonly McpToolBindingDecl[] | undefined,
  filters: McpToolFilterDecl
): boolean {
  if (filters.tool === undefined && filters.server === undefined) {
    return true;
  }
  if (bindings === undefined) return false;
  return bindings.some(
    (binding) =>
      (filters.tool === undefined || binding.tool === filters.tool) &&
      (filters.server === undefined || binding.server === filters.server)
  );
}

describe("binding-conformance catalogs", () => {
  it("ships 15 resolution cases and 13 filter cases", () => {
    expect(bindingResolutionCases.length).toBe(15);
    expect(bindingFilterCases.length).toBe(13);
  });

  it("every case has the load-bearing fields and a unique name across both catalogs", () => {
    const names = new Set<string>();
    for (const testCase of bindingResolutionCases) {
      expect(typeof testCase.name).toBe("string");
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe("string");
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(typeof testCase.entry).toBe("object");
      expect(typeof testCase.expect).toBe("object");
    }
    for (const testCase of bindingFilterCases) {
      expect(typeof testCase.name).toBe("string");
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(names.has(testCase.name)).toBe(false); // unique
      names.add(testCase.name);
      expect(typeof testCase.description).toBe("string");
      expect(testCase.description.length).toBeGreaterThan(0);
      expect(typeof testCase.filters).toBe("object");
      expect(typeof testCase.expect).toBe("boolean");
    }
  });

  it("a spec-correct binding resolver passes every resolution case (catalog is coherent)", () => {
    const result = runBindingResolutionCases(referenceResolve);
    // Zero mismatches — a non-empty `failed` means a case carries a
    // mis-authored `expect`.
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(bindingResolutionCases.length);
  });

  it("a spec-correct filter predicate passes every filter case (catalog is coherent)", () => {
    const result = runBindingFilterCases(referenceMatches);
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(bindingFilterCases.length);
  });

  it("a bindings-blind resolver fails exactly the declaring, deriving, and rejecting cases (runner grades)", () => {
    // A resolver that always accepts with no bindings must fail every
    // case whose expect is not the bare accept — proves the runner
    // grades source, bindings, AND reject codes, while genuinely
    // binding-less manifests still pass.
    const result = runBindingResolutionCases(() => ({ outcome: "accept" }));
    const nonTrivialCases = bindingResolutionCases.filter(
      (c) => !(c.expect.outcome === "accept" && c.expect.source === undefined)
    );
    expect(result.failed.length).toBe(nonTrivialCases.length);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      nonTrivialCases.map((c) => c.name).sort()
    );
  });

  it("an always-true predicate fails exactly the expect-false filter cases (runner grades)", () => {
    const result = runBindingFilterCases(() => true);
    const rejectingCases = bindingFilterCases.filter((c) => !c.expect);
    expect(result.failed.length).toBe(rejectingCases.length);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      rejectingCases.map((c) => c.name).sort()
    );
  });

  it("an always-false predicate fails exactly the expect-true filter cases", () => {
    const result = runBindingFilterCases(() => false);
    const matchingCases = bindingFilterCases.filter((c) => c.expect);
    expect(result.failed.length).toBe(matchingCases.length);
    expect(result.failed.map((f) => f.name).sort()).toEqual(
      matchingCases.map((c) => c.name).sort()
    );
  });
});
