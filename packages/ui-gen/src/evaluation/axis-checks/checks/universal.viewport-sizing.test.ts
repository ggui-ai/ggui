// Pin (ggui#1075 Track A/B, receipted on #1096): `universal.viewport_sized`
// names an element sized to the viewport — `100vh` / `100dvh` / `100svh` /
// `100lvh` (bare or inside `calc()`) as a `height` / `min-height` (or the
// `h-screen` / `min-h-screen` utility classes). The frame owns the height:
// a content-sized frame is measured FROM the content, so a viewport-sized
// root can never shrink; under fullscreen the frame stretches the root
// already. RED fixtures are minted sources: an inline chat card's root
// (`<Card surface="inverted" style={{ minHeight: "100vh", … }}>`, told
// "compact", constrained arm) and a free-arm board's `<style>` rule
// (`.kb-root { width: 100%; min-height: 100vh; … }`). A `max-height` cap,
// `height: 100%`, `flex: 1` and pixel heights pass.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findViewportSizing } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.viewport_sized")!;
const input = (sourceCode: string, compiledCode: string | null = "compiled"): AxisCheckInput => ({
  sourceCode,
  compiledCode,
  originalPrompt: "a welcome card",
  classification: classifyAxes({ contract: {}, prompt: "a welcome card" }),
});

const INLINE_CARD_ROOT = `
export default function C(props: Props) {
  return (
    <Card surface="inverted" style={{ minHeight: "100vh", display: "flex", alignItems: "center" }}>
      <Heading level={1}>{props.heading}</Heading>
    </Card>
  );
}`;

const STYLE_RULE = `
export default function Board(props: Props) {
  return (
    <div className="kb-root">
      <style>{\`
        .kb-root { width: 100%; min-height: 100vh; box-sizing: border-box; padding: 24px; }
      \`}</style>
    </div>
  );
}`;

const CALC_DVH = `<section style={{ height: "calc(100dvh - 64px)" }}>{props.body}</section>`;
const UTILITY_CLASS = `<main className="min-h-screen flex flex-col">{props.body}</main>`;

const PASSES = [
  `<Card style={{ maxHeight: "100vh", overflowY: "auto" }}>{props.body}</Card>`,
  `<div style={{ height: "100%", flex: 1, minHeight: 320 }}>{props.body}</div>`,
  `<style>{\`.scroll { max-height: 100dvh; overflow: auto; } .row { line-height: 1.5; height: 48px; }\`}</style>`,
  `<div className="h-full min-h-0 flex-1">{props.body}</div>`,
];

describe("universal.viewport_sized", () => {
  it("is registered for every render value", () => {
    expect(check).toBeDefined();
    expect(check.values.length).toBeGreaterThanOrEqual(7);
  });

  it("RED: the minted inline card's root — minHeight 100vh in a style object", () => {
    expect(findViewportSizing(INLINE_CARD_ROOT)).toEqual(['minHeight: "100vh"']);
    const issues = check.run(input(INLINE_CARD_ROOT));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ tier: 0, result: "fail", subcategory: "universal.viewport_sized" });
    expect(issues[0]!.description).toContain('minHeight: "100vh"');
    expect(issues[0]!.fix).toMatch(/never to the viewport/);
  });

  it("RED: a <style> rule's min-height: 100vh, a calc(100dvh …) height, a min-h-screen class", () => {
    expect(findViewportSizing(STYLE_RULE)).toEqual(["min-height: 100vh"]);
    expect(findViewportSizing(CALC_DVH)).toEqual(['height: "calc(100dvh - 64px)"']);
    expect(findViewportSizing(UTILITY_CLASS)).toEqual(["min-h-screen"]);
    for (const src of [STYLE_RULE, CALC_DVH, UTILITY_CLASS]) expect(check.run(input(src))).toHaveLength(1);
  });

  it("a max-height cap, height 100%, flex 1, pixel heights and non-viewport utilities pass", () => {
    for (const src of PASSES) {
      expect(findViewportSizing(src)).toEqual([]);
      expect(check.run(input(src))).toEqual([]);
    }
  });

  it("stands down when the source did not compile (tier-0 build error owns that turn)", () => {
    expect(check.run(input(INLINE_CARD_ROOT, null))).toEqual([]);
  });
});
