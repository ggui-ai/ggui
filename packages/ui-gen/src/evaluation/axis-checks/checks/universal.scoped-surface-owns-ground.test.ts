// Pin (ggui#1047): `universal.scoped_surface_owns_ground` names a scoped Card /
// Box (`surface="inverted"` | `"hero"`) whose own `style` sets a background.
// RED fixture — the served Mosaic hello on candidate 15 (QA, 2026-09-12): an
// inverted card repainted with the page ground, hero text 1:1.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findScopedSurfaceBackgrounds } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.scoped_surface_owns_ground")!;

function input(sourceCode: string, extra: Partial<AxisCheckInput> = {}): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: "a greeting card",
    classification: classifyAxes({ contract: {}, prompt: "a greeting card" }),
    ...extra,
  };
}

const RED = `
export default function Component(props: Props) {
  return (
    <Card surface="inverted" padding="xl" radius="xl" style={{ background: 'var(--ggui-color-ground)', maxWidth: 560 }}>
      <Text size="xs" caps tone="emphasized">{props.eyebrow}</Text>
      <Box surface="hero" style={{ backgroundColor: 'transparent' }}>x</Box>
    </Card>
  );
}`;

const GREEN = `
export default function Component(props: Props) {
  return (
    <Card surface="inverted" padding="xl" style={{ maxWidth: 560 }}>
      <Card style={{ background: 'var(--ggui-color-ground)' }}>a default surface may repaint</Card>
      <Box surface="hero">{props.eyebrow}</Box>
      <Card surface="transparent" style={{ backgroundColor: 'red' }}>not a scoped surface</Card>
    </Card>
  );
}`;

describe("universal.scoped_surface_owns_ground", () => {
  it("is registered on every render value", () => {
    expect(check.values).toContain("static");
    expect(check.values).toContain("grid");
  });

  it("names every scoped Card / Box whose style sets a background, in source order", () => {
    expect(findScopedSurfaceBackgrounds(RED)).toEqual([["Card", "inverted"], ["Box", "hero"]]);
    expect(findScopedSurfaceBackgrounds(GREEN)).toEqual([]);
  });

  it("emits one tier-0 fail with the surface named and the removal as the fix; silent on the green source", () => {
    const issues = check.run(input(RED));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.subcategory).toBe("universal.scoped_surface_owns_ground");
    expect(issues[0]!.result).toBe("fail");
    expect(issues[0]!.description).toContain('<Card surface="inverted">');
    expect(issues[0]!.fix).toContain("Remove the background");
    expect(check.run(input(GREEN))).toEqual([]);
  });

  it("stands down in free design mode and on a source that did not compile", () => {
    expect(check.run(input(RED, { designMode: "free" }))).toEqual([]);
    expect(check.run({ ...input(RED), compiledCode: null })).toEqual([]);
  });
});
