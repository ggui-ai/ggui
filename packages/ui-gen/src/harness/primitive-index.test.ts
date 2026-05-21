// core/src/harness/primitive-index.test.ts
import { describe, expect, it } from "vitest";
import { buildPrimitiveIndex } from "./primitive-index.js";
import { PRIMITIVES_DOCUMENTATION } from "../validation/index.js";

describe("buildPrimitiveIndex", () => {
  it("names-only mode dramatically reduces byte size", () => {
    const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, "names-only");
    const reduction = 1 - idx.length / PRIMITIVES_DOCUMENTATION.length;
    expect(reduction).toBeGreaterThan(0.9);
    expect(idx.length).toBeLessThan(10_000);
  });

  it("with-props mode reduces byte size while keeping prop signatures", () => {
    const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, "with-props");
    const reduction = 1 - idx.length / PRIMITIVES_DOCUMENTATION.length;
    expect(reduction).toBeGreaterThan(0.9);
    expect(idx.length).toBeLessThan(12_000);
    // Signature includes parens and a prop name we know exists
    expect(idx).toMatch(/`Card\(.*shadow.*\)`/);
  });

  it("preserves System Conventions verbatim in both modes", () => {
    for (const mode of ["names-only", "with-props"] as const) {
      const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, mode);
      expect(idx).toContain("## System Conventions");
      expect(idx).toContain("### onChange Behavior (CRITICAL)");
      expect(idx).toContain("### Import Constraints");
      expect(idx).toContain("Applies to: Input, TextArea, Select, Checkbox");
    }
  });

  it("emits get_components_info hint line", () => {
    const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, "names-only");
    expect(idx).toMatch(/get_components_info.*names/);
  });

  it("lists every primitive/component/composition section name", () => {
    const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, "names-only");
    const mustHave = [
      "Container", "Card", "Stack", "Button", "Input", "Badge",
      "Table", "Tabs", "SearchField", "FormField", "Modal", "Header",
    ];
    for (const name of mustHave) {
      expect(idx).toContain(`\`${name}\``);
    }
  });

  it("drops support-type subsections from the index", () => {
    const idx = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, "names-only");
    // Support Types is a ### under ## Primitives — should NOT appear as an
    // index entry (no `- \`Support Types\`` line)
    expect(idx).not.toMatch(/^- `Support Types`/m);
  });
});
