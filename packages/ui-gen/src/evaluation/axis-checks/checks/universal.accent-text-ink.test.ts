// Pin (ggui#1039): `universal.accent_text_ink` flags text painted with a
// brand-ladder FILL stop (primary-300…600) as its `color`. RED fixture — the
// four brand-directed hello frames of 2026-09-12: every one painted its
// eyebrow + inline arrows `var(--ggui-color-primary-600)` (LvlUp 3.5:1,
// Loops 2.91:1 on their grounds). Tints as text on a primary fill (50–200),
// deep stops on a light tint (700–900), fills, borders and the `link` ink
// itself stay silent — 0 of 48 un-branded cells on disk would fire.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { UNIVERSAL_CHECKS, findLadderStopsAsText } from "./universal.js";

const check = UNIVERSAL_CHECKS.find((c) => c.id === "universal.accent_text_ink")!;

function input(sourceCode: string): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: "a greeting card",
    classification: classifyAxes({ contract: {}, prompt: "a greeting card" }),
  };
}

/** The served eyebrow, verbatim in shape: a `Text` with an inline `color`, arrows inheriting it. */
const RED = `
import { Text, Icon, Row } from '@ggui-ai/design';
export default function Component(props: Props) {
  return (
    <Row gap="sm" style={{ color: "var(--ggui-color-primary-600)" }}>
      <Text size="xs" weight="semibold" caps style={{ color: "var(--ggui-color-primary-600)" }}>{props.eyebrow}</Text>
      <Icon name="arrow-right" tone="inherit" />
      <a href="#" style={{ color: 'var(--ggui-color-primary-500)' }}>more</a>
      <style>{\`.tag { color: var(--ggui-color-primary-400); }\`}</style>
    </Row>
  );
}`;

/** The compiled spelling the runtime serves (`style:{color:"var(…)"}`). */
const RED_COMPILED = `e(Text,{size:"xs",weight:"semibold",caps:!0,style:{color:"var(--ggui-color-primary-600)"}},props.eyebrow)`;

const GREEN = `
import { Text } from '@ggui-ai/design';
export default function Component(props: Props) {
  const bubble = { background: 'var(--ggui-color-primary-600)', color: 'var(--ggui-color-primary-50)' };
  const chip = { background: 'var(--ggui-color-primary-100)', color: 'var(--ggui-color-primary-800)' };
  return (
    <div style={{ borderColor: 'var(--ggui-color-primary-600)', backgroundColor: 'var(--ggui-color-primary-500)' }}>
      <Text tone="emphasized">{props.eyebrow}</Text>
      <span style={{ color: 'var(--ggui-color-link)' }}>a link</span>
      <span style={bubble}>on fill</span>
      <span style={chip}>on tint</span>
      <style>{\`.x { border-color: var(--ggui-color-primary-600); accent-color: var(--ggui-color-primary-500); -webkit-text-fill-color: var(--ggui-color-primary-400); }\`}</style>
    </div>
  );
}`;

describe("universal.accent_text_ink", () => {
  it("is registered on every render value", () => {
    expect(check).toBeDefined();
    expect(check.values).toContain("static");
    expect(check.values).toContain("list");
  });

  it("names the fill stops painted as text, once each, in every spelling — JSX style, anchor, <style> rule, compiled", () => {
    expect(findLadderStopsAsText(RED)).toEqual(["primary-600", "primary-500", "primary-400"]);
    expect(findLadderStopsAsText(RED_COMPILED)).toEqual(["primary-600"]);
  });

  it("stays silent on tints-as-text on a fill, deep stops on a tint, fills, borders, compound color properties and the link ink", () => {
    expect(findLadderStopsAsText(GREEN)).toEqual([]);
    expect(check.run(input(GREEN))).toEqual([]);
  });

  it("emits one tier-0 fail naming the stops, with the link ink as the fix", () => {
    const issues = check.run(input(RED));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.subcategory).toBe("universal.accent_text_ink");
    expect(issues[0]!.result).toBe("fail");
    expect(issues[0]!.tier).toBe(0);
    expect(issues[0]!.description).toContain("`primary-600`");
    expect(issues[0]!.fix).toContain("var(--ggui-color-link)");
    expect(issues[0]!.fix).toContain('tone="emphasized"');
  });

  it("skips a source that did not compile (the compile error is the actionable finding)", () => {
    expect(check.run({ ...input(RED), compiledCode: null })).toEqual([]);
  });
});
