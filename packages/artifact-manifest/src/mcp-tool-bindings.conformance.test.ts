/**
 * Drift-catch: the shipping mcpTools resolver conforms to the
 * binding-conformance catalog in `@ggui-ai/protocol-conformance`.
 *
 * Kit cases carry structural entries (kind / mcpTools / contract),
 * not complete manifest documents. The adapter below synthesizes a
 * complete schema-valid manifest around each entry, parses it with
 * the shipping safeParse helpers (a parse failure maps onto the
 * `manifest_invalid` reject code), then maps the shipping
 * `resolveMcpToolBindings` result onto the kit's accept outcome.
 * If this file goes red, fix the shipping resolver — the kit is
 * the arbiter, never the other way around.
 */
import {
  bindingResolutionCases,
  runBindingResolutionCases,
  type BindingManifestEntry,
  type BindingResolutionOutcome,
} from "@ggui-ai/protocol-conformance/binding-conformance";
import { describe, expect, it } from "vitest";
import { safeParseBlueprintManifest } from "./blueprint-manifest.js";
import { safeParseGadgetManifest } from "./gadget-manifest.js";
import { resolveMcpToolBindings } from "./mcp-tool-bindings.js";

function toAcceptOutcome(
  resolved: ReturnType<typeof resolveMcpToolBindings>
): BindingResolutionOutcome {
  return resolved === undefined
    ? { outcome: "accept" }
    : {
        outcome: "accept",
        source: resolved.source,
        bindings: resolved.bindings,
      };
}

/**
 * Adapter from the kit's structural entry to the shipping parse +
 * resolve pipeline. Fixed identity fields mirror the MINIMAL
 * fixtures in gadget-manifest.test.ts / blueprint-manifest.test.ts
 * so the only parse-relevant variables are the kit-supplied
 * `mcpTools` and `contract`.
 */
function shippingResolve(entry: BindingManifestEntry): BindingResolutionOutcome {
  if (entry.kind === "gadget") {
    const parsed = safeParseGadgetManifest({
      kind: "gadget",
      scope: "@my-org",
      name: "weather-card",
      version: "0.1.0",
      bundle: "src/index.ts",
      visibility: "public",
      description: "Renders a weather card.",
      exports: [
        {
          hook: "useWeatherCard",
          description: "Renders a weather card.",
          usage: "Use to display current weather conditions.",
          example: { city: "Berlin" },
        },
      ],
      ...(entry.mcpTools !== undefined ? { mcpTools: entry.mcpTools } : {}),
    });
    if (!parsed.success) {
      return { outcome: "reject", code: "manifest_invalid" };
    }
    return toAcceptOutcome(resolveMcpToolBindings(parsed.data));
  }
  const parsed = safeParseBlueprintManifest({
    kind: "blueprint",
    scope: "@my-org",
    name: "weather-card",
    version: "0.1.0",
    visibility: "public",
    source: "export default function Card() { return null; }",
    ...(entry.contract !== undefined ? { contract: entry.contract } : {}),
    ...(entry.mcpTools !== undefined ? { mcpTools: entry.mcpTools } : {}),
  });
  if (!parsed.success) {
    return { outcome: "reject", code: "manifest_invalid" };
  }
  return toAcceptOutcome(resolveMcpToolBindings(parsed.data));
}

describe("the shipping mcpTools resolver conforms to the binding-conformance catalog", () => {
  it("resolves every catalog case exactly as the SPEC requires", () => {
    const result = runBindingResolutionCases(shippingResolve);
    expect(
      result.failed,
      `the shipping resolveMcpToolBindings drifted from the binding-conformance catalog:\n${result.failed
        .map(
          (f) =>
            `  - ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`
        )
        .join("\n")}`
    ).toEqual([]);
    // Sanity: the runner actually exercised the full catalog — a
    // resolver that graded zero cases would also report zero failures.
    expect(bindingResolutionCases.length).toBeGreaterThan(0);
    expect(result.passed.length).toBe(bindingResolutionCases.length);
  });
});
